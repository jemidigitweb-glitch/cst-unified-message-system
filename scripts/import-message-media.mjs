/**
 * Imports eBay customer message images from message_app.files (type = 0) into
 * cst_app.conversation_message_media.
 *
 *   npm run import:message-media                   report only, write nothing
 *   npm run import:message-media -- --apply        write to varmen_db.cst_app
 *   npm run import:message-media -- --apply --page-size=2000 --pages=20
 *   npm run import:message-media -- --limit=500
 *
 * DRY RUN IS THE DEFAULT. Without `--apply` this reads all three databases,
 * resolves every parent message, reports exactly what would land, and opens no
 * transaction.
 *
 * NO IMAGE IS DOWNLOADED. This moves URLs and nothing else: there is no fetch,
 * no HEAD, no proxy and no eBay API call anywhere in this path. Whether a URL
 * still resolves is deliberately NOT checked — see the expiry note in the
 * report rather than a silent probe of 12,965 customer photographs.
 *
 * MIND THE QUERY BUDGET. The MariaDB account carries MAX_QUERIES_PER_HOUR 100
 * and MAX_CONNECTIONS_PER_HOUR 50. 12,965 rows at the default 2,000/page is 7
 * queries; at 200/page it would be 65. The run reports what it spent.
 *
 * RE-RUNNABLE, AND MEANT TO BE RE-RUN. Only the images whose message CST has
 * already ingested can land; the rest are skipped and counted. As the eBay
 * history deepens, running this again imports them with no change to anything
 * already stored.
 *
 * It decides nothing. What counts as a usable URL and who attached an image
 * live in `lib/domain/conversation-message-media.ts`; the two-hop lookup lives
 * in `lib/repositories/ebay-message-link-repository.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import mysql from "mysql2/promise";
import pg from "pg";

const ROOT = join(import.meta.dirname, "..");

function loadEnv() {
  let text;
  try {
    text = readFileSync(join(ROOT, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const { appDbConfig, sourceDbConfig } = await load("lib/config/env.ts");
const { assertOrderSourceReadOnly } = await load("lib/db/order-source.ts");
const { fetchEbayMediaPage } = await load("lib/db/message-app-source.ts");
const { mapMediaRow, usableSourceRefId, authorshipOf } = await load(
  "lib/domain/conversation-message-media.ts",
);
const { resolveMessagesByExtMessageId } = await load(
  "lib/repositories/ebay-message-link-repository.ts",
);
const { upsertMessageMedia } = await load("lib/sync/conversation-message-media-writer.ts");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const APPLY = argv.includes("--apply");
const PAGE_SIZE = Number(flag("page-size", "2000"));
const MAX_PAGES = Number(flag("pages", "30"));
const LIMIT = Number(flag("limit", "0"));

for (const [name, value] of [["page-size", PAGE_SIZE], ["pages", MAX_PAGES]]) {
  if (!Number.isInteger(value) || value < 1) {
    console.error(`--${name} must be a positive integer`);
    process.exit(2);
  }
}

async function assertApplicationDatabase(client) {
  const { rows } = await client.query(
    "SELECT current_database() AS db, current_user AS usr, to_regclass('cst_app.conversation_message_media') IS NOT NULL AS ok",
  );
  const { db, usr, ok } = rows[0];
  if (db !== "varmen_db") throw new Error(`refusing to write: current_database() is ${db}`);
  if (usr !== "varmen_user") throw new Error(`refusing to write: current_user is ${usr}`);
  if (!ok) throw new Error("cst_app.conversation_message_media is missing — apply migration 0016 first");
}

if (!process.env.DB_HOST) {
  console.error("DB_HOST is not set — the message application source is not configured.");
  process.exit(2);
}

const mysqlConnection = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  supportBigNumbers: true,
  bigNumberStrings: true,
  connectTimeout: 15_000,
});

const { schema, ...appConfig } = appDbConfig();
const appClient = new pg.Client({
  ...appConfig,
  ssl: { rejectUnauthorized: false },
  options: `-c search_path=${schema}`,
  application_name: "cst-import-message-media",
});

const sourceClient = new pg.Client({
  ...sourceDbConfig(),
  ssl: { rejectUnauthorized: false },
  options: "-c default_transaction_read_only=on",
  application_name: "cst-import-message-media-source-ro",
});

const budget = { spent: 0 };
const stats = {
  read: 0, pages: 0, inserted: 0, updated: 0,
  mapped: 0, customer: 0, cst: 0,
  messagesSeen: new Set(), messagesResolved: new Set(),
};
const rejected = new Map();
const unmatchedMessages = new Set();

try {
  await assertOrderSourceReadOnly(mysqlConnection);
  budget.spent += 1;
  console.log("source credential verified read-only (SELECT/USAGE only)");

  await sourceClient.connect();
  const { rows: ro } = await sourceClient.query("SHOW default_transaction_read_only");
  if (ro[0].default_transaction_read_only !== "on") {
    throw new Error("ledsone session is not read-only — refusing to proceed");
  }
  console.log("ledsone session verified read-only");

  await appClient.connect();
  if (APPLY) {
    await assertApplicationDatabase(appClient);
    console.log("destination verified: varmen_db / varmen_user / cst_app.conversation_message_media present");
    await appClient.query("BEGIN");
  }

  let afterId = 0;
  while (stats.pages < MAX_PAGES) {
    const remaining = LIMIT > 0 ? LIMIT - stats.read : Number.POSITIVE_INFINITY;
    if (remaining <= 0) break;
    const size = Math.min(PAGE_SIZE, remaining);

    const rows = await fetchEbayMediaPage(mysqlConnection, { afterId, limit: size, budget });
    if (rows.length === 0) break;
    stats.pages += 1;
    stats.read += rows.length;
    afterId = Number(rows[rows.length - 1].sourcePk);

    // One batched two-hop lookup per page, never per row.
    const extIds = [];
    for (const row of rows) {
      const ref = usableSourceRefId(row.sourceRefId);
      if (ref !== null) {
        extIds.push(ref);
        stats.messagesSeen.add(ref);
      }
    }
    const links = await resolveMessagesByExtMessageId(sourceClient, appClient, extIds);
    for (const ext of links.keys()) stats.messagesResolved.add(ext);

    const records = [];
    for (const row of rows) {
      const ref = usableSourceRefId(row.sourceRefId);
      const link = ref === null ? null : (links.get(ref) ?? null);
      const mapped = mapMediaRow(row, link);

      if (!mapped.ok) {
        rejected.set(mapped.reason, (rejected.get(mapped.reason) ?? 0) + 1);
        if (mapped.reason === "message_not_in_cst" && ref !== null) unmatchedMessages.add(ref);
        continue;
      }

      stats.mapped += 1;
      if (authorshipOf(mapped.direction) === "customer") stats.customer += 1;
      else stats.cst += 1;
      records.push(mapped.record);
    }

    if (APPLY && records.length > 0) {
      const outcome = await upsertMessageMedia(appClient, records);
      stats.inserted += outcome.inserted;
      stats.updated += outcome.updated;
    }

    if (rows.length < size) break;
  }

  if (APPLY) await appClient.query("COMMIT");
} catch (cause) {
  if (APPLY) await appClient.query("ROLLBACK").catch(() => {});
  console.error(`\nFAILED: ${cause.message}`);
  await mysqlConnection.end().catch(() => {});
  await sourceClient.end().catch(() => {});
  await appClient.end().catch(() => {});
  process.exit(1);
} finally {
  await mysqlConnection.end().catch(() => {});
}

const pct = (n) => (stats.read === 0 ? "0.0" : ((n / stats.read) * 100).toFixed(1));

console.log(`\n${APPLY ? "APPLIED" : "DRY RUN — nothing written"}`);
console.log(`  pages read              : ${stats.pages}`);
console.log(`  source media rows read  : ${stats.read}`);
console.log(`  distinct source messages: ${stats.messagesSeen.size}`);
console.log(`  importable (parent in CST): ${stats.mapped} (${pct(stats.mapped)}%)`);
if (APPLY) {
  console.log(`  inserted                : ${stats.inserted}`);
  console.log(`  updated                 : ${stats.updated}`);
}

console.log(`\n  AUTHORSHIP (from the parent message's direction, never files.submitter)`);
console.log(`    customer-sent images  : ${stats.customer}`);
console.log(`    CST-sent images       : ${stats.cst}`);

console.log(`\n  SKIPPED — kept at source for a later run`);
const REASONS = {
  message_not_in_cst: "parent message not ingested by CST yet",
  no_source_ref: "no usable files.ref_id",
  no_media_url: "empty real_url",
  insecure_media_url: "real_url is not https",
  invalid_view_order: "view_order missing or negative",
};
let skipped = 0;
for (const [reason, label] of Object.entries(REASONS)) {
  const n = rejected.get(reason) ?? 0;
  skipped += n;
  if (n > 0) console.log(`    ${label.padEnd(42)}: ${n}`);
}
if (skipped === 0) console.log("    none");
else if (unmatchedMessages.size > 0) {
  console.log(`    (${unmatchedMessages.size} distinct source messages await CST history; re-run then)`);
}

console.log(`\n  MariaDB queries spent   : ${budget.spent} of 100/hour`);

if (APPLY) {
  const { rows } = await appClient.query(
    `SELECT count(*)::int AS total,
            count(DISTINCT conversation_message_id)::int AS messages,
            count(*) FILTER (WHERE m.direction = 'inbound')::int AS customer_images,
            count(*) FILTER (WHERE m.direction = 'outbound')::int AS cst_images,
            count(DISTINCT m.conversation_id)::int AS conversations
     FROM cst_app.conversation_message_media med
     JOIN cst_app.conversation_messages m ON m.id = med.conversation_message_id`,
  );
  const r = rows[0];
  console.log(`\n  cst_app.conversation_message_media now: ${r.total} images on ${r.messages} messages across ${r.conversations} conversations`);
  console.log(`    ${r.customer_images} customer-sent, ${r.cst_images} CST-sent`);
}

await sourceClient.end();
await appClient.end();
