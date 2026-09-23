/**
 * Imports the response-time policy from message_app.sla_configs into
 * cst_app.response_sla_policy.
 *
 *   npm run import:sla-policy                report only, write nothing
 *   npm run import:sla-policy -- --apply     write to varmen_db.cst_app
 *
 * DRY RUN IS THE DEFAULT. Without `--apply` this reads MariaDB, maps and
 * collapses every row, prints exactly what would land and what would be left
 * uncovered, and opens no transaction.
 *
 * ---------------------------------------------------------------------------
 * IT COPIES A POLICY. IT DOES NOT APPLY ONE.
 * ---------------------------------------------------------------------------
 * Nothing here compares an interval to a target or computes a compliance
 * percentage. CST's own 24-hour rule is untouched, the two targets disagree,
 * and which governs is an open business decision. A successful run changes no
 * displayed number — the SLA tile stays `unavailable`.
 *
 * ---------------------------------------------------------------------------
 * THREE QUERIES, AGAINST AN ACCOUNT CAPPED AT 100 PER HOUR
 * ---------------------------------------------------------------------------
 *   1  SHOW GRANTS FOR CURRENT_USER()   proves the credential cannot write
 *   2  sla_configs WHERE type='response'  42 rows, one query, no paging
 *   3  mails                              11 rows, one query
 *
 * ONE MariaDB connection for the whole run, closed at the end, against an
 * account also capped at 50 connections per hour. The budget is counted and
 * printed so it can be checked rather than assumed.
 *
 * READS MariaDB through a credential proven read-only before the first SELECT
 * (`assertOrderSourceReadOnly`); WRITES cst_app only, after the same database
 * identity check every other writer in this repository performs.
 *
 * RE-RUNNABLE. The upsert is keyed on the unique index 0019 created, so a
 * second run reports updates rather than inserts and changes no row count.
 *
 * ALL OR NOTHING. If two source rows collapsing to one seller account disagree
 * on the target, the run refuses before opening a transaction — a partial
 * policy gives some accounts a target and leaves their neighbours without one,
 * which reads as a coverage gap rather than as a failed import.
 *
 * It decides nothing. Which rows are policy, which account a target belongs to
 * and what to do about a collision all live in `lib/domain/sla-policy.ts`; this
 * only moves rows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import mysql from "mysql2/promise";
import pg from "pg";

const ROOT = join(import.meta.dirname, "..");

/**
 * Same `.env` loader the other importers use, and it must run BEFORE the
 * dynamic imports below: `appDbConfig()` memoises on first call, so a module
 * that read configuration during import would cache an empty one.
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

const { appDbConfig } = await load("lib/config/env.ts");
const { assertOrderSourceReadOnly } = await load("lib/db/order-source.ts");
const { fetchResponseSlaConfigs, fetchMailAccounts } = await load("lib/db/message-app-source.ts");
const { buildMailIndex, mapPolicyRow, collapsePolicies, uncoveredAccounts, scopeKey } =
  await load("lib/domain/sla-policy.ts");
const { upsertResponseSlaPolicy, cstSellerAccounts } = await load("lib/sync/sla-policy-writer.ts");

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");

/** The same identity guard every cst_app writer uses. */
async function assertApplicationDatabase(client) {
  const { rows } = await client.query(
    "SELECT current_database() AS db, current_user AS usr, to_regclass('cst_app.response_sla_policy') IS NOT NULL AS ok",
  );
  const { db, usr, ok } = rows[0];
  if (db !== "varmen_db") throw new Error(`refusing to write: current_database() is ${db}`);
  if (usr !== "varmen_user") throw new Error(`refusing to write: current_user is ${usr}`);
  if (!ok) throw new Error("cst_app.response_sla_policy is missing — apply migration 0019 first");
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
  application_name: "cst-import-sla-policy",
});

const budget = { spent: 0 };
const rejected = [];
let policies = [];
let conflicts = [];
let read = 0;
let mailRows = 0;
let inserted = 0;
let updated = 0;

try {
  // Prove the credential cannot write BEFORE the first SELECT.
  await assertOrderSourceReadOnly(mysqlConnection);
  budget.spent += 1;
  console.log("source credential verified read-only (SELECT/USAGE only)");

  const mails = await fetchMailAccounts(mysqlConnection, { budget });
  mailRows = mails.length;
  const mailIndex = buildMailIndex(mails);

  const rows = await fetchResponseSlaConfigs(mysqlConnection, { budget });
  read = rows.length;

  const entries = [];
  for (const row of rows) {
    const mapped = mapPolicyRow(row, mailIndex);
    if (!mapped.ok) {
      rejected.push(mapped);
      continue;
    }
    entries.push(mapped.entry);
  }

  const outcome = collapsePolicies(entries);
  policies = outcome.policies;
  conflicts = outcome.conflicts;

  // Refuse BEFORE opening a transaction. A conflict means two source rows claim
  // one seller account with different targets, and picking either would store a
  // promise nobody approved.
  if (conflicts.length > 0) {
    console.error(`\nREFUSING THE RUN — ${conflicts.length} scope(s) with disagreeing targets:`);
    for (const c of conflicts) {
      console.error(`  ${c.scope}: hours ${c.targets.join(" vs ")} (sla_configs.id ${c.sourcePks.join(", ")})`);
    }
    console.error("\n  Nothing was written. Fix the disagreement at source and re-run.");
    await mysqlConnection.end().catch(() => {});
    await appClient.end().catch(() => {});
    process.exit(1);
  }

  await appClient.connect();
  if (APPLY) {
    await assertApplicationDatabase(appClient);
    console.log("destination verified: varmen_db / varmen_user / cst_app.response_sla_policy present");
    await appClient.query("BEGIN");
    const result = await upsertResponseSlaPolicy(appClient, policies);
    inserted = result.inserted;
    updated = result.updated;
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

console.log(`\n${APPLY ? "APPLIED" : "DRY RUN — nothing written"}`);
console.log(`  mysql queries spent   : ${budget.spent} (cap 100/hour, 1 connection of 50/hour)`);
console.log(`  mails rows read       : ${mailRows}`);
console.log(`  sla_configs read      : ${read}  (type='response' only)`);
console.log(`  mapped to entries     : ${read - rejected.length}`);
console.log(`  policy rows after collapse : ${policies.length}`);
if (APPLY) {
  console.log(`  inserted              : ${inserted}`);
  console.log(`  updated               : ${updated}`);
}

const collapsed = policies.filter((p) => p.sourceRows > 1);
if (collapsed.length > 0) {
  console.log(`\n  COLLAPSED — several agreeing source rows per scope (${collapsed.length}):`);
  for (const p of collapsed) {
    console.log(`    ${scopeKey(p)}: ${p.sourceRows} rows agreed on ${p.targetHours}h, kept sla_configs.id ${p.sourcePk}`);
  }
}

if (rejected.length > 0) {
  console.log(`\n  REPORTED, NOT IMPORTED (${rejected.length}):`);
  for (const r of rejected) {
    console.log(`    sla_configs.id ${r.sourcePk}: ${r.reason} — ${r.detail}`);
  }
  console.log("    An account is never guessed. Fix these at source and re-run.");
}

console.log(`\n  policy to be stored (${policies.length}):`);
for (const p of policies) {
  const account = p.subSourceId === null ? "whole channel" : `account ${p.subSourceId}`;
  const via = p.sourceMailId === null ? "" : ` via mail_id ${p.sourceMailId}`;
  console.log(`    ${p.marketplace.padEnd(8)} ${account.padEnd(15)} ${p.weekScope.padEnd(8)} ${String(p.targetHours).padStart(2)}h${via}`);
}

/**
 * COVERAGE. The gap is the most useful thing this script prints: a seller
 * account with no policy row has NO approved target, and a reader must return
 * "missing" for it rather than borrowing a neighbour's number.
 */
try {
  // Already connected in the main block, on both the dry-run and --apply paths.
  const accounts = await cstSellerAccounts(appClient);
  const uncovered = uncoveredAccounts(accounts, policies);

  console.log(`\n  CST seller accounts: ${accounts.length}, covered ${accounts.length - uncovered.length}, UNCOVERED ${uncovered.length}`);
  for (const a of uncovered) {
    const conversations = accounts.find(
      (x) => x.marketplace === a.marketplace && x.subSourceId === a.subSourceId,
    )?.conversations ?? 0;
    console.log(`    ${a.marketplace.padEnd(8)} account ${String(a.subSourceId).padEnd(5)} — ${conversations} conversations, NO approved target`);
  }
  if (uncovered.length > 0) {
    console.log("    Reported, never filled. These resolve to no policy, not to a default.");
  }
} catch (cause) {
  console.log(`\n  coverage report unavailable: ${cause.message}`);
}

if (APPLY) {
  const { rows } = await appClient.query(
    `SELECT count(*)::int AS total,
            count(DISTINCT marketplace)::int AS marketplaces,
            count(*) FILTER (WHERE sub_source_id IS NULL)::int AS channel_wide
     FROM cst_app.response_sla_policy`,
  );
  const r = rows[0];
  console.log(`\n  cst_app.response_sla_policy now: ${r.total} rows across ${r.marketplaces} marketplaces (${r.channel_wide} channel-wide)`);
} else {
  console.log("\n  Re-run with --apply to write. Migration 0019 must be applied first.");
}

await appClient.end();
