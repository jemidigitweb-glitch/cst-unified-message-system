/**
 * Imports eBay agent activity from message_app.message_app_logs into
 * cst_app.agent_activity.
 *
 *   npm run import:agent-activity                   report only, write nothing
 *   npm run import:agent-activity -- --apply        write to varmen_db.cst_app
 *   npm run import:agent-activity -- --apply --page-size=2000 --pages=20
 *   npm run import:agent-activity -- --apply --limit=500
 *
 * DRY RUN IS THE DEFAULT. Without `--apply` this reads all three databases,
 * resolves every conversation, reports exactly what would land, and opens no
 * transaction.
 *
 * MIND THE QUERY BUDGET. The MariaDB account carries MAX_QUERIES_PER_HOUR 100
 * and MAX_CONNECTIONS_PER_HOUR 50. Small pages are the EXPENSIVE choice here:
 * 17,815 rows at 200/page is 90 queries and nearly the whole hour; at 2,000 it
 * is 9. The default is large on purpose and the run reports what it spent.
 *
 * READS MariaDB through a credential proven read-only before the first SELECT,
 * and `ledsone` through the session-level read-only source pool. WRITES
 * cst_app.agent_activity only, after the standard database identity check.
 *
 * RE-RUNNABLE. Keyed on the unique index 0017 created, so a second run reports
 * updates rather than inserts — and a row that could not be matched last time
 * is re-resolved and updated in place once its conversation has arrived.
 *
 * It decides nothing. Match semantics and actor attribution live in
 * `lib/domain/agent-activity.ts`; the two-hop lookup lives in
 * `lib/repositories/ebay-message-link-repository.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import mysql from "mysql2/promise";
import pg from "pg";

const ROOT = join(import.meta.dirname, "..");

/** Same loader `sync-messages.mjs` uses. Must run before the dynamic imports. */
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
const { fetchEbayActivityPage } = await load("lib/db/message-app-source.ts");
const { mapActivityRow, usableExtMessageId } = await load("lib/domain/agent-activity.ts");
const { resolveConversationsByExtMessageId } = await load(
  "lib/repositories/ebay-message-link-repository.ts",
);
const { upsertAgentActivity } = await load("lib/sync/agent-activity-writer.ts");

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
    "SELECT current_database() AS db, current_user AS usr, to_regclass('cst_app.agent_activity') IS NOT NULL AS ok",
  );
  const { db, usr, ok } = rows[0];
  if (db !== "varmen_db") throw new Error(`refusing to write: current_database() is ${db}`);
  if (usr !== "varmen_user") throw new Error(`refusing to write: current_user is ${usr}`);
  if (!ok) throw new Error("cst_app.agent_activity is missing — apply migration 0017 first");
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
  application_name: "cst-import-agent-activity",
});

/** READ-ONLY at the server: the session refuses a write, not just this code. */
const sourceClient = new pg.Client({
  ...sourceDbConfig(),
  ssl: { rejectUnauthorized: false },
  options: "-c default_transaction_read_only=on",
  application_name: "cst-import-agent-activity-source-ro",
});

const budget = { spent: 0 };
const stats = {
  read: 0, pages: 0, inserted: 0, updated: 0,
  matched: 0, unmatched: 0, noReference: 0,
  attributed: 0, sharedAccount: 0, unknownActor: 0, noActor: 0,
};
const unknownActorIds = new Set();
const sharedActorIds = new Set();

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
    console.log("destination verified: varmen_db / varmen_user / cst_app.agent_activity present");
  }

  // The directory decides which ids can be named. Loaded once, not per row.
  const { rows: dir } = await appClient.query(
    "SELECT source_user_id FROM cst_app.agent_directory WHERE source_system = 'order_management'",
  );
  const knownUserIds = new Set(dir.map((r) => Number(r.source_user_id)));
  console.log(`agent_directory: ${knownUserIds.size} known ids`);

  if (APPLY) await appClient.query("BEGIN");

  let afterId = 0;
  while (stats.pages < MAX_PAGES) {
    const remaining = LIMIT > 0 ? LIMIT - stats.read : Number.POSITIVE_INFINITY;
    if (remaining <= 0) break;
    const size = Math.min(PAGE_SIZE, remaining);

    const rows = await fetchEbayActivityPage(mysqlConnection, { afterId, limit: size, budget });
    if (rows.length === 0) break;
    stats.pages += 1;
    stats.read += rows.length;
    afterId = Number(rows[rows.length - 1].sourcePk);

    // One batched two-hop lookup for the whole page, never per row.
    const extIds = [];
    for (const row of rows) {
      const ext = usableExtMessageId(row.extMessageId);
      if (ext !== null) extIds.push(ext);
    }
    const resolved = await resolveConversationsByExtMessageId(sourceClient, appClient, extIds);

    const records = [];
    for (const row of rows) {
      const ext = usableExtMessageId(row.extMessageId);
      const conversationId = ext === null ? null : (resolved.get(ext) ?? null);
      const mapped = mapActivityRow(row, conversationId, knownUserIds);

      stats[
        mapped.record.matchStatus === "matched" ? "matched"
        : mapped.record.matchStatus === "unmatched" ? "unmatched" : "noReference"
      ] += 1;

      if (mapped.attribution === "attributed") stats.attributed += 1;
      else if (mapped.attribution === "shared_account") {
        stats.sharedAccount += 1;
        sharedActorIds.add(mapped.record.sourceUserId);
      } else if (mapped.attribution === "unknown_actor") {
        stats.unknownActor += 1;
        unknownActorIds.add(mapped.record.sourceUserId);
      } else stats.noActor += 1;

      records.push(mapped.record);
    }

    if (APPLY) {
      const outcome = await upsertAgentActivity(appClient, records);
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
console.log(`  source rows read        : ${stats.read}`);
if (APPLY) {
  console.log(`  inserted                : ${stats.inserted}`);
  console.log(`  updated                 : ${stats.updated}`);
}
console.log(`\n  CONVERSATION MATCHING`);
console.log(`    matched               : ${stats.matched} (${pct(stats.matched)}%)`);
console.log(`    unmatched             : ${stats.unmatched} (${pct(stats.unmatched)}%)  reference did not resolve`);
console.log(`    no_reference          : ${stats.noReference} (${pct(stats.noReference)}%)  action identified no message`);
console.log(`\n  ACTOR ATTRIBUTION`);
console.log(`    attributed            : ${stats.attributed} (${pct(stats.attributed)}%)`);
console.log(`    shared account        : ${stats.sharedAccount}${sharedActorIds.size ? ` (ids ${[...sharedActorIds].join(", ")})` : ""}`);
console.log(`    unknown actor         : ${stats.unknownActor}${unknownActorIds.size ? ` (ids ${[...unknownActorIds].join(", ")})` : ""}`);
console.log(`    no actor recorded     : ${stats.noActor}`);
if (stats.sharedAccount + stats.unknownActor + stats.noActor > 0) {
  console.log("    These are UNATTRIBUTED: the work is stored, the person is not named.");
}
console.log(`\n  MariaDB queries spent   : ${budget.spent} of 100/hour`);

if (APPLY) {
  const { rows } = await appClient.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE match_status = 'matched')::int AS matched,
            count(DISTINCT conversation_id)::int AS conversations,
            count(DISTINCT source_user_id)::int AS agents
     FROM cst_app.agent_activity`,
  );
  const r = rows[0];
  console.log(`\n  cst_app.agent_activity now: ${r.total} rows, ${r.matched} matched, ${r.conversations} conversations, ${r.agents} agents`);
}

await sourceClient.end();
await appClient.end();
