/**
 * Imports the staff directory from order_management.user into
 * cst_app.agent_directory.
 *
 *   npm run import:agent-directory                  report only, write nothing
 *   npm run import:agent-directory -- --apply       write to varmen_db.cst_app
 *   npm run import:agent-directory -- --apply --page-size=100 --pages=5
 *   npm run import:agent-directory -- --apply --limit=50
 *
 * DRY RUN IS THE DEFAULT. Without `--apply` this reads MariaDB, maps every row,
 * reports exactly what would land, and opens no transaction.
 *
 * READS MariaDB through a credential proven read-only before the first SELECT
 * (`assertOrderSourceReadOnly`); WRITES cst_app only, after the same database
 * identity check every other writer in this repository performs
 * (`assertApplicationDatabase`).
 *
 * RE-RUNNABLE. The upsert is keyed on the unique index 0018 created, so a
 * second run reports updates rather than inserts and changes no row count.
 *
 * BOUNDED. One MariaDB connection for the whole run, closed at the end, and a
 * page cap so a runaway loop cannot spend an account that is rate-limited by
 * connections per hour.
 *
 * It decides nothing. What a name is and what a status means live in
 * `lib/domain/agent-directory.ts`; this only moves rows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import mysql from "mysql2/promise";
import pg from "pg";

const ROOT = join(import.meta.dirname, "..");

/**
 * Same `.env` loader `sync-messages.mjs` uses, and it must run BEFORE the
 * dynamic imports below: `appDbConfig()` memoises on first call, so a module
 * that reads configuration during import would cache an empty one.
 * A real environment variable always wins over the file.
 */
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

const { orderDbConfig, appDbConfig } = await load("lib/config/env.ts");
const { assertOrderSourceReadOnly, fetchStaffPage } = await load("lib/db/order-source.ts");
const { mapStaffRow } = await load("lib/domain/agent-directory.ts");
const { upsertAgentDirectory } = await load("lib/sync/agent-directory-writer.ts");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const APPLY = argv.includes("--apply");
const PAGE_SIZE = Number(flag("page-size", "200"));
const MAX_PAGES = Number(flag("pages", "20"));
const LIMIT = Number(flag("limit", "0")); // 0 = no cap beyond pages * page-size

for (const [name, value] of [["page-size", PAGE_SIZE], ["pages", MAX_PAGES]]) {
  if (!Number.isInteger(value) || value < 1) {
    console.error(`--${name} must be a positive integer`);
    process.exit(2);
  }
}

/** The same identity guard every cst_app writer uses. */
async function assertApplicationDatabase(client) {
  const { rows } = await client.query(
    "SELECT current_database() AS db, current_user AS usr, to_regclass('cst_app.agent_directory') IS NOT NULL AS ok",
  );
  const { db, usr, ok } = rows[0];
  if (db !== "varmen_db") throw new Error(`refusing to write: current_database() is ${db}`);
  if (usr !== "varmen_user") throw new Error(`refusing to write: current_user is ${usr}`);
  if (!ok) throw new Error("cst_app.agent_directory is missing — apply migration 0018 first");
}

const orderConfig = orderDbConfig();
if (!orderConfig) {
  console.error("DB_ORDER_HOST is not set — the staff directory source is not configured.");
  process.exit(2);
}

const mysqlConnection = await mysql.createConnection({
  host: orderConfig.host,
  port: orderConfig.port,
  database: orderConfig.database,
  user: orderConfig.user,
  password: orderConfig.password,
  // Bigints arrive as strings rather than lossy numbers. The ids here are small,
  // but the reader must not be the place that decides they always will be.
  supportBigNumbers: true,
  bigNumberStrings: true,
  connectTimeout: 15_000,
});

const { schema, ...appConfig } = appDbConfig();
const appClient = new pg.Client({
  ...appConfig,
  ssl: { rejectUnauthorized: false },
  options: `-c search_path=${schema}`,
  application_name: "cst-import-agent-directory",
});

const rejected = [];
const unrecognisedStatus = [];
let read = 0;
let inserted = 0;
let updated = 0;
let pages = 0;

try {
  // Prove the credential cannot write BEFORE the first SELECT.
  await assertOrderSourceReadOnly(mysqlConnection);
  console.log("source credential verified read-only (SELECT/USAGE only)");

  await appClient.connect();
  if (APPLY) {
    await assertApplicationDatabase(appClient);
    console.log("destination verified: varmen_db / varmen_user / cst_app.agent_directory present");
    await appClient.query("BEGIN");
  }

  let afterUserId = 0;
  while (pages < MAX_PAGES) {
    const remaining = LIMIT > 0 ? LIMIT - read : Number.POSITIVE_INFINITY;
    if (remaining <= 0) break;
    const size = Math.min(PAGE_SIZE, remaining);

    const rows = await fetchStaffPage(mysqlConnection, { afterUserId, limit: size });
    if (rows.length === 0) break;
    pages += 1;
    read += rows.length;
    afterUserId = Number(rows[rows.length - 1].sourceUserId);

    const entries = [];
    for (const row of rows) {
      const mapped = mapStaffRow(row);
      if (!mapped.ok) {
        rejected.push(mapped.sourceUserId);
        continue;
      }
      if (!mapped.statusRecognised) {
        unrecognisedStatus.push({ id: mapped.entry.sourceUserId, status: mapped.entry.sourceStatus });
      }
      entries.push(mapped.entry);
    }

    if (APPLY && entries.length > 0) {
      const outcome = await upsertAgentDirectory(appClient, entries);
      inserted += outcome.inserted;
      updated += outcome.updated;
    }

    if (rows.length < size) break;
  }

  if (APPLY) {
    await appClient.query("COMMIT");
  }
} catch (cause) {
  if (APPLY) await appClient.query("ROLLBACK").catch(() => {});
  console.error(`\nFAILED: ${cause.message}`);
  await mysqlConnection.end().catch(() => {});
  await appClient.end().catch(() => {});
  process.exit(1);
} finally {
  await mysqlConnection.end().catch(() => {});
}

const mapped = read - rejected.length;
console.log(`\n${APPLY ? "APPLIED" : "DRY RUN — nothing written"}`);
console.log(`  pages read            : ${pages}`);
console.log(`  source rows read      : ${read}`);
console.log(`  mapped to entries     : ${mapped}`);
if (APPLY) {
  console.log(`  inserted              : ${inserted}`);
  console.log(`  updated               : ${updated}`);
}

if (rejected.length > 0) {
  console.log(`\n  REPORTED, NOT IMPORTED — no usable display name (${rejected.length}):`);
  console.log(`    source_user_id: ${rejected.join(", ")}`);
  console.log("    A name is never invented. Fix these at source and re-run.");
}
if (unrecognisedStatus.length > 0) {
  console.log(`\n  UNRECOGNISED STATUS — stored as active = false (${unrecognisedStatus.length}):`);
  for (const u of unrecognisedStatus) {
    console.log(`    source_user_id ${u.id}: ${u.status === null ? "NULL" : `"${u.status}"`}`);
  }
  console.log("    Conservative by design; the raw value is kept in source_status.");
}

if (APPLY) {
  const { rows } = await appClient.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE active)::int AS active,
            count(*) FILTER (WHERE NOT active)::int AS inactive
     FROM cst_app.agent_directory`,
  );
  const r = rows[0];
  console.log(`\n  cst_app.agent_directory now: ${r.total} rows (${r.active} active, ${r.inactive} inactive)`);
}

await appClient.end();
