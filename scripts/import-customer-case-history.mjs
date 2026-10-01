/**
 * ONE-TIME import of historical customer case history from MySQL `message_app`
 * into `cst_app.customer_case_history` (migration 0021).
 *
 *   npm run import:case-history                 report only, write nothing
 *   npm run import:case-history -- --apply      write to varmen_db.cst_app
 *   npm run import:case-history -- --apply --batch-size=200
 *
 * DRY RUN IS THE DEFAULT. Without `--apply` this reads MySQL, resolves the
 * verified storefront list, collapses every event log into cases, prints
 * exactly what would land and what would be rejected and why, and opens no
 * transaction.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A SYNC, AND NOTHING SCHEDULES IT
 * ---------------------------------------------------------------------------
 * There is no watermark, no `sync_state` row, no cron entry and no registered
 * Windows task. `vercel.json` is untouched. The rows it writes are a FIXED
 * HISTORICAL SNAPSHOT until another import is explicitly approved — which is
 * why `imported_at` exists on every row, so staleness is visible rather than
 * assumed away.
 *
 * It is re-runnable, which is a different thing from scheduled: the upsert is
 * keyed on 0021's unique index, so a second run reports updates rather than
 * inserts and changes no row count. That is what makes a failed run safe to
 * resume — restart it from the beginning.
 *
 * ---------------------------------------------------------------------------
 * IT STORES HISTORY. IT DISPLAYS NOTHING
 * ---------------------------------------------------------------------------
 * No panel, no reader, no draft input and no API route is added by this import.
 * A successful run changes nothing an agent sees. The Repeat-Customer Warning
 * is separate work that has not been built.
 *
 * ---------------------------------------------------------------------------
 * FIVE MYSQL QUERIES, AGAINST AN ACCOUNT CAPPED AT 100 PER HOUR
 * ---------------------------------------------------------------------------
 *   1  SET SESSION max_statement_time       a statement timeout at the server
 *   2  SHOW GRANTS FOR CURRENT_USER()       proves the credential cannot write
 *   3  inquiries           8,052 rows, one query, no paging
 *   4  cases               1,038 rows, one query
 *   5  payment_disputes       37 rows, one query
 *
 * PAGING WOULD BE THE EXPENSIVE MISTAKE here, not the safe one: no date column
 * on any of the three tables is indexed, so a bounded WHERE costs the same full
 * scan and paging would spend the hourly budget re-reading tables smaller than
 * one page. See `fetchCaseHistoryEvents` for the measurement.
 *
 * ---------------------------------------------------------------------------
 * CONNECTIONS: ONE AT A TIME, NEVER TWO
 * ---------------------------------------------------------------------------
 *   MySQL        1 connection, opened once, closed in `finally` BEFORE any
 *                PostgreSQL connection is opened.
 *   PostgreSQL   1 connection at a time, and never concurrently: the read-only
 *                `ledsone` session that verifies the storefront list is CLOSED
 *                before the `varmen_db` write session is opened.
 *
 * Peak concurrency is therefore 1 per server. `varmen_user` has
 * `rolconnlimit = 25` shared with production, and the MySQL account allows 50
 * connections per hour; this run takes one of each.
 *
 * ---------------------------------------------------------------------------
 * WHY `ledsone` IS CONSULTED AT ALL
 * ---------------------------------------------------------------------------
 * The three MySQL tables carry a `sub_source` and no platform column. 0021
 * makes `marketplace` NOT NULL, so there is no honest NULL to fall back on, and
 * writing 'ebay' because "these look like eBay tables" is the guess this
 * codebase rejects. The allowlist comes from
 * `order_management.sub_source.source_id = 2` — one query, read-only — and a
 * storefront outside it is rejected and counted.
 *
 * It decides nothing. What a case is, which row wins, what counts as escalated
 * and which rows are duplicates of each other all live in
 * `lib/domain/customer-case-history.ts`; this file moves rows and reports.
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
 * that read configuration during import would cache an empty one. A real
 * environment variable always wins over the file.
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

const { appDbConfig, sourceDbConfig } = await load("lib/config/env.ts");
const { assertOrderSourceReadOnly } = await load("lib/db/order-source.ts");
const { fetchCaseHistoryEvents } = await load("lib/db/message-app-source.ts");
const { collapseCaseEvents, rejectionSummary } = await load(
  "lib/domain/customer-case-history.ts",
);
const { findEbaySubSourceIds } = await load("lib/repositories/order-context-repository.ts");
const { upsertCustomerCaseHistory } = await load("lib/sync/customer-case-history-writer.ts");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const APPLY = argv.includes("--apply");
const BATCH_SIZE = Number(flag("batch-size", "200"));

if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE < 1) {
  console.error("--batch-size must be a positive integer");
  process.exit(2);
}
if (!process.env.DB_HOST) {
  console.error("DB_HOST is not set — the message application source is not configured.");
  process.exit(2);
}

const line = (s) => { console.log(s); };
const budget = { spent: 0 };

/** The three tables, in the order they must be read. */
const TABLES = ["inquiries", "cases", "payment_disputes"];

/**
 * `inquiries` FIRST, and the order is load-bearing.
 *
 * 69 of `cases`' 127 case ids are the same cases as `inquiries` rows — measured
 * agreement on buyer, storefront, type and req_date to the second. The
 * `inquiries` ids must therefore be known before `cases` is collapsed, so the
 * duplicates can be dropped and counted rather than stored twice. 0021's unique
 * key includes `source_table` precisely because the id spaces overlap, so the
 * database would accept both rows without complaint.
 */
function supersededFor(table, inquiryCaseIds) {
  return table === "cases" ? inquiryCaseIds : new Set();
}

// ---------------------------------------------------------------------------
// 1. MySQL. One connection, read-only, closed before PostgreSQL is touched.
// ---------------------------------------------------------------------------
const rawRows = new Map();
let mysqlConnection;
let failed = 0;

try {
  mysqlConnection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    database: process.env.DB_DATABASE,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    // Bigints arrive as strings rather than lossy numbers. Case ids are
    // bigint(20) at source and a rounded id is a case nobody can find again.
    supportBigNumbers: true,
    bigNumberStrings: true,
    /*
     * DATETIME COMES BACK AS THE RAW STRING, AND THIS IS NOT OPTIONAL.
     *
     * Without it mysql2 parses a DATETIME into a JavaScript Date, which is a
     * value in the PROCESS timezone. The first dry run of this importer
     * proved the damage: `req_date` arrived as
     * "Fri Apr 03 2026 03:47:24 GMT+0530 (India Standard Time)" — a naive
     * source datetime silently given an offset it never had, exactly what
     * 0021's `event_at` column promises not to do. Those strings also sort by
     * WEEKDAY NAME, so the reported date span was wrong as well.
     *
     * `dateStrings` keeps 'YYYY-MM-DD HH:MM:SS' as written at source, which is
     * what a naive `timestamp` column must receive and what sorts correctly.
     */
    dateStrings: true,
    connectTimeout: 15_000,
  });
  line("mysql: 1 connection open");

  /*
   * A server-side statement timeout, so a query that hangs cannot hold the
   * connection open indefinitely. MariaDB spells this `max_statement_time`, in
   * SECONDS; MySQL spells it `max_execution_time`, in milliseconds. The
   * fallback tries both rather than assuming which server answered, and a
   * server that supports neither is reported rather than silently left
   * unbounded.
   */
  let timeoutSet = "none";
  for (const [sql, label] of [
    ["SET SESSION max_statement_time=30", "max_statement_time=30s"],
    ["SET SESSION max_execution_time=30000", "max_execution_time=30s"],
  ]) {
    try {
      await mysqlConnection.query(sql);
      budget.spent += 1;
      timeoutSet = label;
      break;
    } catch {
      budget.spent += 1;
    }
  }
  line(`mysql: statement timeout ${timeoutSet}`);
  if (timeoutSet === "none") {
    line("mysql: WARNING — no server-side statement timeout available on this server");
  }

  await assertOrderSourceReadOnly(mysqlConnection);
  budget.spent += 1;
  line("mysql: read-only verified (USAGE/SELECT only, no write privilege)");

  for (const table of TABLES) {
    const rows = await fetchCaseHistoryEvents(mysqlConnection, table, { budget });
    rawRows.set(table, rows);
    line(`mysql: ${table} -> ${rows.length} event rows`);
  }
} catch (cause) {
  failed += 1;
  console.error(`\nFAILED reading MySQL: ${cause.message}`);
} finally {
  if (mysqlConnection) await mysqlConnection.end().catch(() => {});
  line(`mysql: connection closed (${budget.spent} queries of 100/hour)`);
}

if (failed > 0) process.exit(1);

// ---------------------------------------------------------------------------
// 2. The verified eBay storefront list, from ledsone. Opened and closed on its
//    own so it is never concurrent with the write connection.
// ---------------------------------------------------------------------------
let ebaySubSources = new Set();
const sourceClient = new pg.Client({
  ...sourceDbConfig(),
  ssl: { rejectUnauthorized: false },
  options: "-c default_transaction_read_only=on",
  application_name: "cst-import-case-history-source-ro",
  statement_timeout: 30_000,
});

try {
  await sourceClient.connect();
  const { rows: ro } = await sourceClient.query("SHOW default_transaction_read_only");
  if (ro[0].default_transaction_read_only !== "on") {
    throw new Error("ledsone session is not read-only — refusing to proceed");
  }
  const ids = await findEbaySubSourceIds(sourceClient);
  ebaySubSources = new Set(ids);
  line(`\nledsone: read-only verified; ${ebaySubSources.size} eBay storefronts (source_id = 2)`);
} catch (cause) {
  failed += 1;
  console.error(`\nFAILED verifying storefronts: ${cause.message}`);
} finally {
  await sourceClient.end().catch(() => {});
  line("ledsone: connection closed");
}

if (failed > 0) process.exit(1);
if (ebaySubSources.size === 0) {
  console.error("refusing to proceed: the verified eBay storefront list is empty");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Collapse. Pure, in memory, no connection held.
// ---------------------------------------------------------------------------
const toDomainRow = (table) => (row) => ({
  sourceTable: table,
  caseId: row.case_id === null ? null : String(row.case_id),
  eventSeq: row.event_seq === null ? null : Number(row.event_seq),
  rowId: String(row.row_id),
  buyer: row.buyer,
  subSource: row.sub_source === null ? null : Number(row.sub_source),
  caseType: row.case_type,
  status: row.status,
  isCase: row.is_case === null ? null : Number(row.is_case),
  escDate: row.esc_date === null ? null : String(row.esc_date),
  orderId: row.order_id,
  reqDate: row.req_date === null ? null : String(row.req_date),
});

const inquiryCaseIds = new Set(
  (rawRows.get("inquiries") ?? [])
    .map((row) => (row.case_id === null ? null : String(row.case_id)))
    .filter((id) => id !== null),
);

const perTable = [];
const allRecords = [];
const allRejections = [];

for (const table of TABLES) {
  const rows = (rawRows.get(table) ?? []).map(toDomainRow(table));
  const { records, rejections } = collapseCaseEvents(rows, {
    verifiedEbaySubSources: ebaySubSources,
    supersededCaseIds: supersededFor(table, inquiryCaseIds),
  });
  perTable.push({ table, eventRows: rows.length, records: records.length, rejected: rejections.length });
  allRecords.push(...records);
  allRejections.push(...rejections);
}

line("\n  table                event rows   cases   rejected");
line("  ---------------------------------------------------");
for (const r of perTable) {
  line(
    `  ${r.table.padEnd(20)}${String(r.eventRows).padStart(10)}` +
    `${String(r.records).padStart(8)}${String(r.rejected).padStart(11)}`,
  );
}
line(
  `  ${"TOTAL".padEnd(20)}${String(perTable.reduce((s, r) => s + r.eventRows, 0)).padStart(10)}` +
  `${String(allRecords.length).padStart(8)}${String(allRejections.length).padStart(11)}`,
);

line("\n  rejected, by reason:");
const summary = rejectionSummary(allRejections);
if (summary.size === 0) line("    (none)");
for (const [reason, counts] of [...summary].sort((a, b) => b[1].cases - a[1].cases)) {
  line(`    ${reason.padEnd(26)} ${String(counts.cases).padStart(5)} cases  ${String(counts.rows).padStart(6)} source rows`);
}

/*
 * A local duplicate check BEFORE the database sees anything. The unique index
 * would catch a collision as an upsert, which is silent — a collapse bug that
 * merged two cases would look like a successful import with a lower count.
 */
const identities = new Set(allRecords.map((r) => `${r.sourceTable} ${r.sourceCaseId}`));
line(`\n  distinct source identities in the batch: ${identities.size} of ${allRecords.length}`);
if (identities.size !== allRecords.length) {
  console.error("refusing to proceed: the collapsed batch contains duplicate source identities");
  process.exit(1);
}

/*
 * THE NAIVE-DATETIME GUARD, and it exists because the first dry run failed it.
 *
 * `event_at` is a naive `timestamp` holding a source value byte-for-byte. If
 * the driver ever hands back a parsed Date again — a `dateStrings` regression,
 * a driver upgrade, a copied connection block — the value becomes a locale
 * string carrying the process timezone, and PostgreSQL would either reject it
 * or, worse, accept a shifted one. This refuses the whole run rather than
 * writing a single timezone-shifted date, because a wrong date in a history
 * table is indistinguishable from a right one once stored.
 */
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const malformed = allRecords.filter((r) => !NAIVE_DATETIME.test(r.eventAt));
if (malformed.length > 0) {
  console.error(
    `refusing to proceed: ${malformed.length} record(s) carry an event_at that is not a naive ` +
    `'YYYY-MM-DD HH:MM:SS' source value — first was ${JSON.stringify(malformed[0].eventAt)}. ` +
    "The MySQL driver is parsing datetimes; `dateStrings: true` is required.",
  );
  process.exit(1);
}
line(`  event_at format: all ${allRecords.length} are naive source datetimes`);

const eventTypes = new Map();
const escalations = new Map();
for (const record of allRecords) {
  eventTypes.set(record.eventType, (eventTypes.get(record.eventType) ?? 0) + 1);
  escalations.set(record.escalation, (escalations.get(record.escalation) ?? 0) + 1);
}
line(`  event_type: ${[...eventTypes].map(([k, v]) => `${k}=${v}`).join(", ")}`);
line(`  escalation: ${[...escalations].map(([k, v]) => `${k}=${v}`).join(", ")}`);
line(`  with a status: ${allRecords.filter((r) => r.eventStatus !== null).length}` +
     `, with an order ref: ${allRecords.filter((r) => r.orderRef !== null).length}`);
const dates = allRecords.map((r) => r.eventAt).sort();
line(`  event_at span: ${dates[0]} .. ${dates[dates.length - 1]}`);

// ---------------------------------------------------------------------------
// 4. PostgreSQL. One write connection, opened last.
// ---------------------------------------------------------------------------
const { schema, ...appConfig } = appDbConfig();
const appClient = new pg.Client({
  ...appConfig,
  ssl: { rejectUnauthorized: false },
  options: `-c search_path=${schema}`,
  application_name: "cst-import-case-history",
  statement_timeout: 60_000,
});

/** The same identity guard every cst_app writer in this repository performs. */
async function assertApplicationDatabase(client) {
  const { rows } = await client.query(
    `SELECT current_database() AS db, current_user AS usr,
            to_regclass('cst_app.customer_case_history') IS NOT NULL AS ok`,
  );
  const { db, usr, ok } = rows[0];
  if (db !== "varmen_db") throw new Error(`refusing to write: current_database() is ${db}`);
  if (usr !== "varmen_user") throw new Error(`refusing to write: current_user is ${usr}`);
  if (!ok) throw new Error("cst_app.customer_case_history is missing — apply migration 0021 first");
}

let inserted = 0;
let updated = 0;

try {
  await appClient.connect();
  line("\npostgres: 1 write connection open");
  await assertApplicationDatabase(appClient);
  line("postgres: destination verified (varmen_db / varmen_user / table present)");

  if (APPLY) {
    /*
     * Bounded batches, each its own transaction. A failure leaves the batches
     * already committed in place and the rest absent — which is safe precisely
     * because the upsert is idempotent: re-running from the start updates what
     * landed and inserts what did not.
     */
    for (let i = 0; i < allRecords.length; i += BATCH_SIZE) {
      const batch = allRecords.slice(i, i + BATCH_SIZE);
      await appClient.query("BEGIN");
      try {
        const outcome = await upsertCustomerCaseHistory(appClient, batch);
        await appClient.query("COMMIT");
        inserted += outcome.inserted;
        updated += outcome.updated;
        line(`postgres: batch ${i / BATCH_SIZE + 1} committed (${outcome.inserted} inserted, ${outcome.updated} updated)`);
      } catch (cause) {
        await appClient.query("ROLLBACK").catch(() => {});
        throw cause;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. Verification, read back from the database rather than from memory.
  // -------------------------------------------------------------------------
  const { rows: verify } = await appClient.query(
    `SELECT count(*)::int                                   AS rows_total,
            count(DISTINCT (source_table, source_case_id))::int AS distinct_identities,
            count(DISTINCT counterparty_ref)::int           AS distinct_buyers,
            count(DISTINCT marketplace)::int                AS distinct_marketplaces,
            sum(source_row_count)::int                      AS source_events_covered,
            count(*) FILTER (WHERE event_status IS NULL)::int AS without_status,
            count(*) FILTER (WHERE order_ref IS NOT NULL)::int AS with_order_ref,
            min(event_at)::text                             AS event_at_min,
            max(event_at)::text                             AS event_at_max,
            min(imported_at)::text                          AS imported_min,
            max(imported_at)::text                          AS imported_max
     FROM cst_app.customer_case_history`,
  );
  const { rows: byTable } = await appClient.query(
    `SELECT source_table, event_type, escalation, count(*)::int AS n
     FROM cst_app.customer_case_history
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  );
  const { rows: neighbours } = await appClient.query(
    `SELECT (SELECT count(*)::int FROM cst_app.conversations)         AS conversations,
            (SELECT count(*)::int FROM cst_app.agent_activity)        AS agent_activity,
            (SELECT count(*)::int FROM cst_app.context_snapshots)     AS context_snapshots,
            (SELECT count(*)::int FROM cst_app.sync_state)            AS sync_state_rows`,
  );

  const v = verify[0];
  line(`\n  ${APPLY ? "APPLIED" : "DRY RUN — nothing written"}`);
  if (APPLY) line(`  upsert: ${inserted} inserted, ${updated} updated`);

  line("\n  cst_app.customer_case_history, read back from the database:");
  line(`    rows                    ${v.rows_total}`);
  line(`    distinct identities     ${v.distinct_identities}  ${v.rows_total === v.distinct_identities ? "(no duplicates)" : "*** DUPLICATES PRESENT ***"}`);
  line(`    distinct buyers         ${v.distinct_buyers}`);
  line(`    distinct marketplaces   ${v.distinct_marketplaces}`);
  line(`    source events covered   ${v.source_events_covered}`);
  line(`    without a status        ${v.without_status}`);
  line(`    with an order ref       ${v.with_order_ref}`);
  line(`    event_at span           ${v.event_at_min} .. ${v.event_at_max}`);
  line(`    imported_at span        ${v.imported_min} .. ${v.imported_max}`);

  line("\n    source_table / event_type / escalation:");
  for (const row of byTable) {
    line(`      ${row.source_table.padEnd(18)}${row.event_type.padEnd(20)}${row.escalation.padEnd(16)}${String(row.n).padStart(6)}`);
  }

  line("\n  neighbouring tables (must be unchanged by this import):");
  const n = neighbours[0];
  line(`    conversations ${n.conversations}, agent_activity ${n.agent_activity}, context_snapshots ${n.context_snapshots}, sync_state ${n.sync_state_rows}`);
  line("    (sync_state must NOT have gained a row — this import registers no feed)");
} catch (cause) {
  failed += 1;
  console.error(`\nFAILED: ${cause.message}`);
} finally {
  await appClient.end().catch(() => {});
  line("\npostgres: connection closed");
}

line(`\n  mysql queries spent : ${budget.spent} of 100/hour`);
line("  mysql connections   : 1 of 50/hour");
line("  postgres peak concurrent connections : 1");

process.exit(failed > 0 ? 1 : 0);
