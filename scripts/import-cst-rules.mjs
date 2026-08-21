/**
 * CST knowledge rule importer — command line entry point.
 *
 *   node scripts/import-cst-rules.mjs              parse and report, write nothing
 *   node scripts/import-cst-rules.mjs --apply      write to varmen_db.cst_app
 *   node scripts/import-cst-rules.mjs --apply --force
 *                                                  re-write rows whose checksum
 *                                                  is unchanged
 *
 * DRY RUN IS THE DEFAULT. `--apply` is the only thing that opens a connection;
 * without it this reads spreadsheets and prints counts. That ordering is
 * deliberate — the interesting failure in an importer is a bad mapping, and it
 * is much cheaper to see that in a report than to find it in a table.
 *
 * WRITES cst_app ONLY, inside ONE transaction, after confirming the connection
 * really is the application database. The marketplace source databases are
 * read-only for this project and are never opened here.
 *
 * Nothing imported is approved. Sources land as draft/inactive and cannot be
 * used for grounding until a human signs them off — see rule-importer.ts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The library modules are TypeScript, loaded through Node's built-in type
// stripping so the import logic lives in one place rather than being duplicated
// in JavaScript here. They are imported by path because the `@/` alias is a
// Next/vitest resolution, not a Node one.
const ROOT = join(import.meta.dirname, "..");
const SOURCE_DIR = join(ROOT, "Knowledge-source");
const EXPECTED_DATABASE = "varmen_db";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const FORCE = args.has("--force");

function loadEnv() {
  const env = {};
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // No .env: only matters for --apply, which fails with a clear error below.
  }
  return env;
}

const { readWorkbook } = await import(pathToFileURL(join(ROOT, "lib/knowledge/workbook-reader.ts")));
const { extractWorkbook, deduplicate, CATEGORY_BY_FILE, EXCLUDED_FILES } = await import(
  pathToFileURL(join(ROOT, "lib/knowledge/rule-extraction.ts"))
);

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

const files = readdirSync(SOURCE_DIR)
  .filter((name) => name.endsWith(".xlsx") && !name.startsWith("~$"))
  .sort();

const allRules = [];
const allSkipped = [];
let scrubbed = 0;
const perFile = [];

for (const file of files) {
  const workbook = readWorkbook(readFileSync(join(SOURCE_DIR, file)));
  const result = extractWorkbook(file, workbook);
  allRules.push(...result.rules);
  allSkipped.push(...result.skipped);
  scrubbed += result.scrubbed;
  perFile.push({
    file,
    category: CATEGORY_BY_FILE.get(file) ?? null,
    excluded: EXCLUDED_FILES.get(file) ?? null,
    sheets: workbook.size,
    rules: result.rules.length,
    triggers: result.rules.reduce((n, r) => n + r.triggers.length, 0),
    examples: result.rules.reduce((n, r) => n + r.examples.length, 0),
  });
}

const { unique, duplicates } = deduplicate(allRules);
const categories = [...new Set(unique.map((r) => r.categoryName))].sort();
const triggers = unique.reduce((n, r) => n + r.triggers.length, 0);
const examples = unique.reduce((n, r) => n + r.examples.length, 0);
const escalations = unique.filter((r) => r.escalationRequired).length;

const byType = {};
for (const rule of unique) byType[rule.ruleType] = (byType[rule.ruleType] ?? 0) + 1;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\nCST KNOWLEDGE IMPORT — ${APPLY ? "APPLY" : "DRY RUN (no writes)"}\n`);
console.log("Per workbook:");
for (const entry of perFile) {
  if (entry.excluded) {
    console.log(`  ${entry.file.padEnd(52)} EXCLUDED — ${entry.excluded}`);
    continue;
  }
  if (!entry.category) {
    console.log(`  ${entry.file.padEnd(52)} no category mapping — not imported`);
    continue;
  }
  console.log(
    `  ${entry.file.padEnd(52)} ${String(entry.category).padEnd(30)} ` +
      `sheets=${String(entry.sheets).padStart(3)} rules=${String(entry.rules).padStart(4)} ` +
      `triggers=${String(entry.triggers).padStart(4)} examples=${String(entry.examples).padStart(4)}`,
  );
}

console.log("\nRule types:");
for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type.padEnd(18)} ${count}`);
}

console.log("\nTotals:");
console.log(`  categories            ${categories.length}  (${categories.join(", ")})`);
console.log(`  rules                 ${unique.length}`);
console.log(`  triggers              ${triggers}`);
console.log(`  examples              ${examples}`);
console.log(`  escalation rules      ${escalations}`);
console.log(`  duplicates dropped    ${duplicates}`);
console.log(`  rows scrubbed         ${scrubbed}  (looked like customer/order data)`);
console.log(`  sheets skipped        ${allSkipped.length}  (no recognised rule table)`);

if (args.has("--verbose")) {
  console.log("\nSkipped sheets:");
  for (const entry of allSkipped) {
    console.log(`  ${entry.sourceFile} :: ${entry.sourceSheet} — ${entry.reason}`);
  }
  console.log("\nSample rules:");
  for (const rule of unique.slice(0, 12)) {
    console.log(
      `  [${rule.ruleType}] ${rule.categoryName} / ${rule.sourceSheet} r${rule.sourceRow} — ${rule.ruleName.slice(0, 70)}`,
    );
  }
}

if (!APPLY) {
  console.log("\nNo database connection was opened. Re-run with --apply to write.\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

const env = loadEnv();
const { default: pg } = await import("pg");
const { importRules, assertApplicationDatabase } = await import(
  pathToFileURL(join(ROOT, "lib/knowledge/rule-importer.ts"))
);

const client = new pg.Client({
  host: env.APP_DB_HOST,
  port: Number(env.APP_DB_PORT || 5432),
  database: env.APP_DB_NAME,
  user: env.APP_DB_USER,
  password: env.APP_DB_PASSWORD,
  ssl: (env.DB_SSL_MODE ?? "require") === "disable" ? undefined : { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

await client.connect();
try {
  const identity = await assertApplicationDatabase(client, EXPECTED_DATABASE);
  console.log(`\nConnected to ${identity.database} as ${identity.user}. Writing cst_app only.`);

  await client.query("BEGIN");
  const counts = await importRules(client, unique, { force: FORCE });
  await client.query("COMMIT");

  console.log("\nWrites performed:");
  for (const [key, value] of Object.entries(counts)) {
    console.log(`  ${key.padEnd(22)} ${value}`);
  }
  console.log("\nAll sources imported as status='draft', active=false — inert until signed off.\n");
} catch (cause) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("\nImport failed and was rolled back:", cause.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
