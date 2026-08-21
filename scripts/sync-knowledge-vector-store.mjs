/**
 * Publishes the approved CST knowledge to an OpenAI vector store.
 *
 *   node scripts/sync-knowledge-vector-store.mjs            report only, upload nothing
 *   node scripts/sync-knowledge-vector-store.mjs --apply    create/refresh the store
 *
 * DRY RUN IS THE DEFAULT, and here that matters more than usual. Uploading to a
 * third-party vector store is not a mistake you can take back — you can delete
 * the file afterwards, but you cannot un-send it. So without `--apply` this
 * parses the workbooks, renders the documents, prints exactly what would be
 * uploaded, and exits without opening a connection.
 *
 * AN ALLOWLIST DECIDES WHAT GOES. `lib/knowledge/knowledge-files.ts` names the
 * twelve approved workbooks. Anything not named there — including
 * "B2B  customers .xlsx", which holds customer contact data — is not uploaded,
 * and a new file dropped into the folder is excluded by default rather than
 * included by default.
 *
 * WHAT IS UPLOADED IS NOT THE WORKBOOKS. `.xlsx` cannot be indexed by File
 * Search, and a spreadsheet chunks badly — a rule's condition and its action
 * can land in different chunks. Each workbook is rendered to Markdown, one
 * document per CST area, every rule kept whole and carrying its [REF] so a
 * citation still traces back to a sheet and row.
 *
 * Reads the marketplace source? No. Writes a database? No. This touches the
 * local rule files and the OpenAI API, nothing else.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");

// TypeScript modules loaded through Node's built-in type stripping, so the
// rendering logic lives in one place rather than being duplicated here.
const { readWorkbook } = await import(
  pathToFileURL(join(ROOT, "lib/knowledge/workbook-reader.ts")).href
);
const { extractWorkbook } = await import(
  pathToFileURL(join(ROOT, "lib/knowledge/rule-extraction.ts")).href
);
const { scopeCorpus } = await import(
  pathToFileURL(join(ROOT, "lib/knowledge/rule-scoping.ts")).href
);
const { renderKnowledgeDocuments, isApprovedForUpload, APPROVED_KNOWLEDGE_FILES } = await import(
  pathToFileURL(join(ROOT, "lib/knowledge/knowledge-files.ts")).href
);

const APPLY = process.argv.includes("--apply");
const STORE_NAME = "cst-knowledge";
const OUT_DIR = join(ROOT, ".knowledge-build");

function loadEnv() {
  let text;
  try {
    text = readFileSync(join(ROOT, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].trim();
    }
  }
}

async function api(path, init, apiKey) {
  const response = await fetch(`https://api.openai.com/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status} ${payload?.error?.message ?? ""}`.trim());
  }
  return payload;
}

async function run() {
  loadEnv();

  const directory = join(ROOT, process.env.CST_RULES_DIR?.trim() || "Knowledge-source");
  const present = readdirSync(directory).filter(
    (name) => name.endsWith(".xlsx") && !name.startsWith("~$"),
  );

  // --- what is approved, what is held back --------------------------------
  const approved = present.filter(isApprovedForUpload);
  const withheld = present.filter((name) => !isApprovedForUpload(name));
  const missing = APPROVED_KNOWLEDGE_FILES.filter(
    (name) => !present.some((f) => f.trim().toLowerCase() === name.trim().toLowerCase()),
  );

  console.log(`source folder : ${directory}`);
  console.log(`mode          : ${APPLY ? "APPLY (uploads to OpenAI)" : "dry run (uploads nothing)"}\n`);
  console.log(`approved for upload (${approved.length}):`);
  for (const name of approved) console.log(`   + ${name}`);
  console.log(`\nWITHHELD — not on the allowlist (${withheld.length}):`);
  for (const name of withheld) console.log(`   - ${name}`);
  if (missing.length > 0) {
    console.log(`\nallowlisted but NOT FOUND on disk (${missing.length}):`);
    for (const name of missing) console.log(`   ? ${name}`);
  }

  // --- render ---------------------------------------------------------------
  const rules = [];
  for (const file of approved) {
    try {
      rules.push(...extractWorkbook(file, readWorkbook(readFileSync(join(directory, file)))).rules);
    } catch (cause) {
      console.error(`   could not read ${file}: ${cause.message}`);
    }
  }

  // `null` marketplace: the store serves every marketplace, so nothing is
  // scoped out here. Isolation is enforced in the system instruction, which
  // tells the model which platform's branch of a multi-platform rule applies.
  // This also renders each rule with exactly the same code used for prompts.
  const { rules: cstRules } = scopeCorpus(rules, null);
  const documents = renderKnowledgeDocuments(cstRules);
  const totalChars = documents.reduce((sum, d) => sum + d.markdown.length, 0);

  console.log(`\ndocuments to upload (${documents.length}), ${rules.length} rules total:`);
  for (const doc of documents) {
    console.log(
      `   ${doc.name.padEnd(28)} ${String(doc.ruleCount).padStart(5)} rules  ${String(doc.markdown.length).padStart(7)} chars`,
    );
  }
  console.log(`   ${"".padEnd(28)} ${String(rules.length).padStart(5)} rules  ${String(totalChars).padStart(7)} chars`);

  if (!APPLY) {
    // Written locally so the exact upload payload can be reviewed first.
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
    for (const doc of documents) writeFileSync(join(OUT_DIR, doc.name), doc.markdown, "utf8");
    console.log(`\nrendered to ${OUT_DIR} for review — nothing uploaded.`);
    console.log("re-run with --apply to publish.");
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set — cannot upload.");

  // --- create the store -----------------------------------------------------
  let storeId = process.env.OPENAI_VECTOR_STORE_ID?.trim();
  if (!storeId) {
    const store = await api(
      "/vector_stores",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: STORE_NAME }),
      },
      apiKey,
    );
    storeId = store.id;
    console.log(`\ncreated vector store: ${storeId}`);
  } else {
    console.log(`\nusing existing vector store: ${storeId}`);
  }

  // --- upload ---------------------------------------------------------------
  let uploaded = 0;
  for (const doc of documents) {
    const form = new FormData();
    form.append("purpose", "assistants");
    form.append("file", new Blob([doc.markdown], { type: "text/markdown" }), doc.name);
    const file = await api("/files", { method: "POST", body: form }, apiKey);

    await api(
      `/vector_stores/${storeId}/files`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_id: file.id }),
      },
      apiKey,
    );
    uploaded += 1;
    console.log(`   uploaded ${doc.name}  (${file.id})`);
  }

  console.log(`\nuploaded ${uploaded} documents.`);
  console.log(`\nSet this in the server environment and in Vercel:`);
  console.log(`   OPENAI_VECTOR_STORE_ID=${storeId}`);
}

try {
  await run();
} catch (cause) {
  console.error(`\nsync failed: ${cause.message}`);
  process.exitCode = 1;
}
