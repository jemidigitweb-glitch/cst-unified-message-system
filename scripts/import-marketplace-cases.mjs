/**
 * Standalone import of the marketplace case snapshot from MySQL `message_app`
 * into `cst_app.marketplace_cases` (migration 0022).
 *
 *   npm run import:marketplace-cases                  report only, write nothing
 *   npm run import:marketplace-cases -- --apply       write to varmen_db.cst_app
 *   npm run import:marketplace-cases -- --tables=inquiries,payment_disputes
 *
 * DRY RUN IS THE DEFAULT, AND IT WRITES NOTHING ANYWHERE. Without `--apply` this
 * reads MySQL, resolves storefronts and orders, collapses every store into cases,
 * prints exactly what would land and what would be rejected and why, and opens no
 * write transaction and no run row. 0022 has no dry-run state for the ledger to
 * record, so "a rehearsal changes no database" is structural rather than a branch.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A SYNC, AND NOTHING SCHEDULES IT
 * ---------------------------------------------------------------------------
 * There is no watermark, no `sync_state` row, no cron entry, no registered
 * Windows task and no `vercel.json` change. The rows it writes are a snapshot
 * until another import is explicitly approved — which is why every row carries
 * `imported_at` and `import_run_id`, so staleness is visible rather than assumed
 * away, and why freshness is answered per store from the run ledger.
 *
 * IT STORES CASES. IT DISPLAYS NOTHING. No panel, no reader, no draft input and
 * no API route is added by this import. A successful run changes nothing an agent
 * sees; the Case Detection Indicator is separate work that has not been built.
 *
 * ---------------------------------------------------------------------------
 * MYSQL: ONE CONNECTION, NO POOL, NO RETRY, CLOSED IN `finally`
 * ---------------------------------------------------------------------------
 * The account allows 100 QUERIES and 50 CONNECTIONS PER HOUR, shared with every
 * other consumer including the message sync. So:
 *
 *   * exactly one `createConnection`, never a pool;
 *   * every statement counted through one wrapper, so none is uncounted;
 *   * each store read WHOLE in one query — paging would be the expensive
 *     mistake, spending the hourly budget to re-read tables smaller than a page;
 *   * NO automatic retry. A connection failure stops the run. Reconnecting is a
 *     decision for a person, who can see how much budget is left.
 *
 * Twelve queries for a full nine-store run: one statement timeout, one
 * `SHOW GRANTS`, and one per store... minus one, because `cases` and `inquiries`
 * are both read. Counted and printed against the allowance either way.
 *
 * CONNECTION ORDER IS STRICTLY SEQUENTIAL, and never two servers at once:
 *   MySQL opened, read, CLOSED  ->  ledsone opened, read, CLOSED  ->  varmen_db
 * Peak concurrency is one per server. `varmen_user` shares a 25-connection limit
 * with production, and a concurrent probe hit `53300` during discovery, which is
 * why this is an ordering rule rather than a tidiness preference.
 *
 * ---------------------------------------------------------------------------
 * THE PUBLICATION PROTOCOL
 * ---------------------------------------------------------------------------
 *   TX1  record the attempt as 'in_progress' and COMMIT.
 *   TX2  every upsert AND the publish statement, in ONE transaction.
 *   TX3  on failure only, mark the run failed — TX2 has already rolled back, so
 *        no case row from this run exists to be read.
 *
 * Resumability is traded for atomicity deliberately: a failed run is repeated
 * from the beginning, which is affordable because the extraction costs one
 * connection and twelve queries.
 *
 * It decides nothing. What a case is, which row wins, what counts as closed,
 * which rows are duplicates and how an order is matched all live in
 * `lib/domain/marketplace-case.ts` and `lib/domain/marketplace-case-extract.ts`;
 * this file moves rows and reports.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import mysql from "mysql2/promise";
import pg from "pg";

const ROOT = join(import.meta.dirname, "..");

/**
 * The same `.env` loader the other importers use, and it must run BEFORE the
 * dynamic imports below: `appDbConfig()` memoises on first call, so a module that
 * read configuration during import would cache an empty one. A real environment
 * variable always wins over the file.
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
const { fetchAccountLimits, fetchCaseSourceRows } = await load(
  "lib/db/message-app-case-source.ts",
);
const { CASE_SOURCE_TABLES, caseRejectionSummary, marketplaceFor } = await load(
  "lib/domain/marketplace-case.ts",
);
const {
  collapseCaseEvents,
  coverageInconsistencies,
  destinationInvariantViolations,
  orderLookupRequests,
  resolveOrderFor,
} = await load("lib/domain/marketplace-case-extract.ts");
const { findEbaySubSourceIds } = await load("lib/repositories/order-context-repository.ts");
const {
  findOrdersByLineKey,
  findVerifiedStorefronts,
  orderLineKeyOf,
  orderRefKeyOf,
  verifyOrderRefs,
} = await load("lib/repositories/order-line-lookup-repository.ts");
const {
  failImportRun,
  lastPublishedByStore,
  openImportRun,
  publishImportRun,
  upsertMarketplaceCases,
} = await load("lib/sync/marketplace-case-writer.ts");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const APPLY = argv.includes("--apply");
const TABLES = flag("tables", "")
  .split(",")
  .map((t) => t.trim())
  .filter((t) => t !== "");

for (const table of TABLES) {
  if (!CASE_SOURCE_TABLES.includes(table)) {
    console.error(`--tables names an unknown store: ${table}`);
    console.error(`known stores: ${CASE_SOURCE_TABLES.join(", ")}`);
    process.exit(2);
  }
}
const STORES = TABLES.length > 0 ? TABLES : [...CASE_SOURCE_TABLES];

if (!process.env.DB_HOST) {
  console.error("DB_HOST is not set — the message application source is not configured.");
  process.exit(2);
}

const line = (s) => {
  console.log(s);
};

/** Counted so the source allowance is auditable, and stored on the run row. */
const budget = { spent: 0 };
const connections = { mysqlAttempts: 0, mysqlPeak: 0 };

/**
 * `inquiries` FIRST, and the order is load-bearing. 69 of the formal-case store's
 * 127 ids are the same cases as inquiry rows, so the inquiry ids must be known
 * before `cases` is collapsed, letting the duplicates be dropped and counted
 * rather than stored twice. 0022's unique key includes `source_table` precisely
 * because the id spaces overlap, so the database would accept both rows.
 */
const READ_ORDER = [...CASE_SOURCE_TABLES].sort((a, b) => {
  const rank = (t) => (t === "inquiries" ? 0 : t === "cases" ? 1 : 2);
  return rank(a) - rank(b);
});
const ORDERED_STORES = READ_ORDER.filter((t) => STORES.includes(t));

let failed = 0;
const rawRows = new Map();

// ---------------------------------------------------------------------------
// 1. MySQL. ONE connection, read-only, closed before PostgreSQL is touched.
// ---------------------------------------------------------------------------
let connection;
connections.mysqlAttempts += 1;
try {
  connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    database: process.env.DB_DATABASE,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    // Case ids are 20-digit integers at source. A rounded id is a case nobody
    // can find again.
    supportBigNumbers: true,
    bigNumberStrings: true,
    /*
     * DATETIME COMES BACK AS THE RAW STRING, AND THIS IS NOT OPTIONAL.
     *
     * Without it mysql2 parses a DATETIME into a JavaScript Date, which is a
     * value in the PROCESS timezone. 0021's first dry run proved the damage: a
     * naive source datetime arrived carrying an offset it never had, and those
     * strings also sort by WEEKDAY NAME, so the reported date span was wrong too.
     * `dateStrings` keeps 'YYYY-MM-DD HH:MM:SS' exactly as written, which is what
     * 0022's naive timestamp columns must receive and what sorts correctly.
     */
    dateStrings: true,
    connectTimeout: 15_000,
  });
  connections.mysqlPeak = 1;
  line("mysql: 1 connection open (no pool)");

  /*
   * A server-side statement timeout, so a query that hangs cannot hold the one
   * connection open indefinitely. MariaDB spells this `max_statement_time`, in
   * SECONDS; MySQL spells it `max_execution_time`, in milliseconds. Both are
   * tried rather than assuming which server answered, and a server supporting
   * neither is REPORTED rather than silently left unbounded.
   */
  let timeoutSet = "none";
  for (const [sql, label] of [
    ["SET SESSION max_statement_time=30", "max_statement_time=30s"],
    ["SET SESSION max_execution_time=30000", "max_execution_time=30s"],
  ]) {
    try {
      await connection.query(sql);
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

  await assertOrderSourceReadOnly(connection);
  budget.spent += 1;
  line("mysql: read-only verified (USAGE/SELECT only, no write privilege)");

  /*
   * BUDGET PRE-FLIGHT, BEFORE THE FIRST DATA QUERY.
   *
   * The planned spend is the two statements already made, this one, and one per
   * store. If that does not fit inside the allowance the credential itself states,
   * the run stops here rather than part-way through a nine-store read.
   *
   * It cannot prove the allowance is still unspent — MariaDB exposes the limits
   * through SHOW GRANTS and current hourly consumption to no statement this
   * account can run. That gap is covered by refusing to retry: an exhausted
   * allowance answers with error 1226 and this run stops on it.
   */
  const limits = await fetchAccountLimits(connection, { budget });
  const planned = budget.spent + ORDERED_STORES.length;
  line(
    `mysql: account allowance — queries/hour ${limits.maxQueriesPerHour ?? "not stated"}, ` +
      `connections/hour ${limits.maxConnectionsPerHour ?? "not stated"}`,
  );
  line(`mysql: planned spend for this run — ${planned} quer${planned === 1 ? "y" : "ies"}`);
  if (limits.maxQueriesPerHour !== null && planned > limits.maxQueriesPerHour) {
    throw new Error(
      `planned spend of ${planned} queries exceeds the stated allowance of ${limits.maxQueriesPerHour} per hour — refusing to proceed`,
    );
  }
  line(
    "mysql: NOTE — current hourly consumption is not readable through this account. " +
      "The protection against an already-spent allowance is that this run never retries.",
  );

  for (const table of ORDERED_STORES) {
    const rows = await fetchCaseSourceRows(connection, table, { budget });
    rawRows.set(table, rows);
    line(`mysql: ${table} -> ${rows.length} case rows`);
  }
} catch (cause) {
  failed += 1;
  console.error(`\nFAILED reading MySQL: ${cause.message}`);
} finally {
  if (connection) await connection.end().catch(() => {});
  line(
    `mysql: connection closed — ${connections.mysqlAttempts} attempt(s), peak ${connections.mysqlPeak} simultaneous, ${budget.spent} of 100 queries/hour`,
  );
}

if (failed > 0) process.exit(1);

// ---------------------------------------------------------------------------
// 2. The marketplace source. Read-only, opened and closed on its own so it is
//    never concurrent with the write connection.
//
//    Two jobs: the verified storefront allowlist, and the order resolutions.
// ---------------------------------------------------------------------------
const resolutionsByStore = new Map();
const verifiedSubSources = new Map();
let ambiguousOrders = 0;

const sourceClient = new pg.Client({
  ...sourceDbConfig(),
  ssl: { rejectUnauthorized: false },
  options: "-c default_transaction_read_only=on",
  application_name: "cst-import-marketplace-cases-source-ro",
  statement_timeout: 60_000,
});

try {
  await sourceClient.connect();
  const { rows: ro } = await sourceClient.query("SHOW default_transaction_read_only");
  if (ro[0].default_transaction_read_only !== "on") {
    throw new Error("the marketplace source session is not read-only — refusing to proceed");
  }

  /*
   * THE STOREFRONT ALLOWLIST, FOR EVERY MARKETPLACE.
   *
   * The nine stores carry a `sub_source` and no platform column, and 0022 makes
   * `marketplace` NOT NULL, so there is no honest NULL to fall back on and
   * writing a platform because "these look like eBay tables" is the guess this
   * codebase rejects. The list comes from `sub_source.source_id -> source.id`
   * and the mapping from a platform id to a CST marketplace is
   * `channelForSourceId`, which the post-dispatch automation already owns.
   *
   * A storefront under a platform this application has no channel for — Wayfair,
   * the internal REPLACEMENT platform, and nine others — is ABSENT from the
   * allowlist, so a case against it is rejected as `unverified_storefront`
   * rather than labelled on trust. Widening the allowlist did not weaken that
   * rule; it only stopped it rejecting Amazon and Shopify wholesale.
   */
  const allowlist = await findVerifiedStorefronts(sourceClient);
  for (const [marketplace, storefronts] of allowlist.byMarketplace) {
    verifiedSubSources.set(marketplace, storefronts);
  }
  line("\nsource: read-only verified; storefront allowlist resolved from the order source");
  for (const [marketplace, storefronts] of [...allowlist.byMarketplace].sort()) {
    line(`  ${marketplace.padEnd(10)}${String(storefronts.size).padStart(4)} storefront(s)`);
  }
  if (allowlist.unmappedPlatforms.size > 0) {
    const dropped = [...allowlist.unmappedPlatforms]
      .sort((a, b) => a[0] - b[0])
      .map(([id, n]) => `${id}:${n}`)
      .join(" ");
    line(`  platforms this application has no channel for (id:storefronts): ${dropped}`);
  }

  /*
   * A cross-check against the eBay reader the historical import already uses. If
   * the two ever disagree, the platform mapping has drifted and the run stops —
   * rather than importing against whichever answer happened to be reached first.
   */
  const ebayDirect = new Set(await findEbaySubSourceIds(sourceClient));
  const ebayFromAllowlist = verifiedSubSources.get("ebay") ?? new Set();
  const sameEbay =
    ebayDirect.size === ebayFromAllowlist.size &&
    [...ebayDirect].every((id) => ebayFromAllowlist.has(id));
  if (!sameEbay) {
    throw new Error(
      `the eBay allowlist disagrees with findEbaySubSourceIds (${ebayFromAllowlist.size} vs ${ebayDirect.size}) — refusing to proceed`,
    );
  }
  line(`  eBay allowlist agrees with findEbaySubSourceIds (${ebayDirect.size} storefronts)`);

  for (const table of ORDERED_STORES) {
    const rows = rawRows.get(table) ?? [];
    const requests = orderLookupRequests(rows);

    // Which source-recorded references name a real order on their storefront.
    const refKeys = requests
      .filter((r) => r.sourceOrderRef !== null)
      .map((r) => ({ orderRef: r.sourceOrderRef, subSourceId: r.subSourceId }));
    const verified = await verifyOrderRefs(sourceClient, refKeys);

    // And which cases can derive one from the marketplace line key.
    const lineKeys = requests
      .filter((r) => r.sourceOrderRef === null && r.itemRef !== null && r.txnRef !== null)
      .map((r) => ({ itemRef: r.itemRef, txnRef: r.txnRef, subSourceId: r.subSourceId }));
    const byLine = await findOrdersByLineKey(sourceClient, lineKeys);

    const resolutions = new Map();
    for (const request of requests) {
      const matched =
        request.itemRef !== null && request.txnRef !== null
          ? (byLine.get(orderLineKeyOf(request.itemRef, request.txnRef, request.subSourceId)) ?? [])
          : [];
      const { resolution, ambiguous } = resolveOrderFor({
        sourceOrderRef: request.sourceOrderRef,
        sourceOrderVerified:
          request.sourceOrderRef !== null &&
          verified.has(orderRefKeyOf(request.sourceOrderRef, request.subSourceId)),
        matchedOrderRefs: matched,
      });
      if (ambiguous) ambiguousOrders += 1;
      // Keyed by (store, case id), which is what the collapse groups on: the id
      // spaces overlap across stores and keying on the id alone would hand one
      // case's order to another's.
      resolutions.set(request.caseKey, resolution);
    }
    resolutionsByStore.set(table, resolutions);
    line(`source: ${table} -> ${resolutions.size} case(s) resolved for an order`);
  }
} catch (cause) {
  failed += 1;
  console.error(`\nFAILED resolving orders: ${cause.message}`);
} finally {
  await sourceClient.end().catch(() => {});
  line("source: connection closed");
}

if (failed > 0) process.exit(1);

// ---------------------------------------------------------------------------
// 3. Collapse. Pure, in memory, no connection held.
// ---------------------------------------------------------------------------
const inquiryCaseIds = new Set(
  (rawRows.get("inquiries") ?? []).map((row) => row.caseId).filter((id) => id !== null),
);

const perStore = [];
const allRecords = [];
const allRejections = [];
const unmappedLifecycle = [];
let casesRead = 0;
let refundAmountsWithoutCurrency = 0;

for (const table of ORDERED_STORES) {
  const rows = rawRows.get(table) ?? [];
  const outcome = collapseCaseEvents(rows, {
    verifiedSubSources: verifiedSubSources.get(marketplaceFor(table)) ?? new Set(),
    supersededCaseIds: table === "cases" ? inquiryCaseIds : new Set(),
    orderResolutions: resolutionsByStore.get(table) ?? new Map(),
  });
  perStore.push({
    table,
    eventRows: rows.length,
    cases: outcome.records.length,
    rejected: outcome.rejections.length,
  });
  allRecords.push(...outcome.records);
  allRejections.push(...outcome.rejections);
  unmappedLifecycle.push(...outcome.unmappedLifecycleValues);
  refundAmountsWithoutCurrency += outcome.refundAmountsWithoutCurrency;
  casesRead += outcome.records.length + outcome.rejections.length;
}

line("\n  store                   event rows    cases   rejected");
line("  ----------------------------------------------------------");
for (const r of perStore) {
  line(
    `  ${r.table.padEnd(24)}${String(r.eventRows).padStart(10)}` +
      `${String(r.cases).padStart(9)}${String(r.rejected).padStart(11)}`,
  );
}
line(
  `  ${"TOTAL".padEnd(24)}${String(perStore.reduce((s, r) => s + r.eventRows, 0)).padStart(10)}` +
    `${String(allRecords.length).padStart(9)}${String(allRejections.length).padStart(11)}`,
);

const rejectionSummary = caseRejectionSummary(allRejections);
line("\n  rejected, by reason:");
if (Object.keys(rejectionSummary).length === 0) line("    (none)");
for (const [reason, counts] of Object.entries(rejectionSummary).sort(
  (a, b) => b[1].cases - a[1].cases,
)) {
  line(
    `    ${reason.padEnd(26)} ${String(counts.cases).padStart(5)} cases  ${String(counts.rows).padStart(6)} source rows`,
  );
}

/*
 * AN UNREVIEWED LIFECYCLE VALUE FAILS THE WHOLE RUN. A status outside the
 * measured vocabulary means the source has changed shape, and importing the rest
 * as though nothing happened would hide that behind a rejection count nobody
 * reads.
 */
if (unmappedLifecycle.length > 0) {
  console.error("\nrefusing to proceed: unreviewed lifecycle value(s) at source:");
  for (const value of [...new Set(unmappedLifecycle)]) console.error(`    ${value}`);
  process.exit(1);
}

/*
 * A local duplicate check BEFORE the database sees anything. The unique index
 * would absorb a collision as an upsert, which is silent — a collapse bug that
 * merged two cases would look like a successful import with a lower count.
 */
const identities = new Set(allRecords.map((r) => `${r.sourceTable} ${r.sourceCaseId}`));
line(`\n  distinct source identities in the batch: ${identities.size} of ${allRecords.length}`);
if (identities.size !== allRecords.length) {
  console.error("refusing to proceed: the collapsed batch contains duplicate source identities");
  process.exit(1);
}

/*
 * THE NAIVE-DATETIME GUARD, and 0021's first dry run is why it exists. If the
 * driver ever hands back a parsed Date — a `dateStrings` regression, a driver
 * upgrade, a copied connection block — the value becomes a locale string carrying
 * the process timezone, and PostgreSQL would either reject it or, worse, accept a
 * shifted one. This refuses the whole run rather than writing a single
 * timezone-shifted date, because a wrong date is indistinguishable from a right
 * one once stored.
 */
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2})?/;
const malformed = allRecords.filter((r) => !NAIVE_DATETIME.test(r.openedAt));
if (malformed.length > 0) {
  console.error(
    `refusing to proceed: ${malformed.length} record(s) carry an opened_at that is not a naive ` +
      `source datetime — first was ${JSON.stringify(malformed[0].openedAt)}. ` +
      "The MySQL driver is parsing datetimes; `dateStrings: true` is required.",
  );
  process.exit(1);
}
line(`  opened_at format: all ${allRecords.length} are naive source datetimes`);

/*
 * COVERAGE, CHECKED ONE WAY ONLY. Every store that produced a record must be in
 * the declared coverage, or freshness would understate itself. The CONVERSE is
 * deliberately not checked: a store read successfully that legitimately contained
 * no importable case still counts as covered, and demanding a record from it would
 * make an empty store look like an unread one.
 */
const inconsistent = coverageInconsistencies(allRecords, ORDERED_STORES);
if (inconsistent.length > 0) {
  console.error(
    `refusing to proceed: records produced for store(s) not in the declared coverage: ${inconsistent.join(", ")}`,
  );
  process.exit(1);
}
line(`  declared coverage: ${ORDERED_STORES.join(", ")}`);

/*
 * DESTINATION INVARIANTS, CHECKED BEFORE THE DATABASE IS ASKED.
 *
 * A dry run writes nothing and therefore exercises no CHECK constraint, which is
 * how the first apply run reached transaction 2 before the database rejected a
 * refund amount with no currency. This mirror of 0022's constraints refuses here
 * instead, so a rehearsal fails for the same reason the real thing would. The
 * database remains the authority; this only moves the discovery earlier.
 */
const violations = destinationInvariantViolations(allRecords);
if (violations.length > 0) {
  console.error(
    `\nrefusing to proceed: ${violations.length} record(s) would violate a destination constraint:`,
  );
  for (const violation of violations.slice(0, 20)) console.error(`    ${violation}`);
  if (violations.length > 20) console.error(`    ... and ${violations.length - 20} more`);
  process.exit(1);
}
line(`  destination invariants: all ${allRecords.length} records satisfy 0022's constraints`);

/*
 * An amount with no currency cannot distinguish pounds from dollars, so it is the
 * shape of a fact rather than one. The CASE is kept and the number refused —
 * counted here so the loss is reported rather than silent. Measured on the
 * source: 1,367 Amazon return rows of the 9,760 carrying an amount.
 */
if (refundAmountsWithoutCurrency > 0) {
  line(
    `  refund amounts refused for having no currency (case kept, number dropped): ${refundAmountsWithoutCurrency}`,
  );
}

const byType = new Map();
const byLifecycle = new Map();
const byMatch = new Map();
for (const record of allRecords) {
  byType.set(record.caseType, (byType.get(record.caseType) ?? 0) + 1);
  byLifecycle.set(record.lifecycle, (byLifecycle.get(record.lifecycle) ?? 0) + 1);
  byMatch.set(record.orderMatchMethod, (byMatch.get(record.orderMatchMethod) ?? 0) + 1);
}
const tally = (m) =>
  [...m]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
line(`  case_type:          ${tally(byType)}`);
line(`  lifecycle:          ${tally(byLifecycle)}`);
line(`  order_match_method: ${tally(byMatch)}`);
line(`  ambiguous order matches (stored as unmatched, never chosen): ${ambiguousOrders}`);
line(`  damage reported:        ${allRecords.filter((r) => r.damageReported).length}`);
line(`  replacement confirmed:  ${allRecords.filter((r) => r.replacementConfirmed).length}`);
line(`  escalated:              ${allRecords.filter((r) => r.escalation === "escalated").length}`);

// ---------------------------------------------------------------------------
// 4. PostgreSQL. One write connection, opened last.
// ---------------------------------------------------------------------------
const { schema, ...appConfig } = appDbConfig();
const appClient = new pg.Client({
  ...appConfig,
  ssl: { rejectUnauthorized: false },
  options: `-c search_path=${schema}`,
  application_name: "cst-import-marketplace-cases",
  statement_timeout: 300_000,
});

/** The same identity guard every cst_app writer in this repository performs. */
async function assertApplicationDatabase(client) {
  const { rows } = await client.query(
    `SELECT current_database() AS db, current_user AS usr,
            to_regclass('cst_app.marketplace_cases') IS NOT NULL AS cases_ok,
            to_regclass('cst_app.case_import_runs')  IS NOT NULL AS runs_ok`,
  );
  const { db, usr, cases_ok, runs_ok } = rows[0];
  if (db !== "varmen_db") throw new Error(`refusing to write: current_database() is ${db}`);
  if (usr !== "varmen_user") throw new Error(`refusing to write: current_user is ${usr}`);
  if (!cases_ok || !runs_ok) {
    throw new Error("cst_app.marketplace_cases or case_import_runs is missing — apply 0022 first");
  }
}

let runId = null;
let inserted = 0;
let updated = 0;
let publishedAt = null;

try {
  await appClient.connect();
  line("\npostgres: 1 write connection open");
  await assertApplicationDatabase(appClient);
  line("postgres: destination verified (varmen_db / varmen_user / both tables present)");

  if (APPLY) {
    // TX1 — record the attempt. Commits at once, so a run that dies is on record.
    await appClient.query("BEGIN");
    runId = await openImportRun(appClient, {
      sourceTables: ORDERED_STORES,
      mysqlConnections: connections.mysqlAttempts,
      mysqlQueries: budget.spent,
    });
    await appClient.query("COMMIT");
    line(`postgres: import run ${runId} opened as in_progress`);

    // TX2 — every case AND the publication, together. Either all or none.
    await appClient.query("BEGIN");
    try {
      const outcome = await upsertMarketplaceCases(appClient, allRecords, runId);
      inserted = outcome.inserted;
      updated = outcome.updated;
      publishedAt = await publishImportRun(appClient, runId, {
        casesRead,
        casesInserted: inserted,
        casesUpdated: updated,
        casesRejected: allRejections.length,
        rejectionSummary,
      });
      await appClient.query("COMMIT");
      line(
        `postgres: PUBLISHED at ${publishedAt} — ${inserted} inserted, ${updated} updated, in one transaction`,
      );
    } catch (cause) {
      await appClient.query("ROLLBACK").catch(() => {});
      line("postgres: transaction 2 ROLLED BACK — no case row from this run exists");
      // TX3 — record the failure. Nothing was published, so nothing is readable.
      await failImportRun(appClient, runId, cause.message).catch(() => {});
      throw cause;
    }
  }

  // -------------------------------------------------------------------------
  // 5. Verification, read back from the database rather than from memory.
  // -------------------------------------------------------------------------
  const { rows: verify } = await appClient.query(
    `SELECT count(*)::int                                        AS rows_total,
            count(DISTINCT (source_table, source_case_id))::int  AS distinct_identities,
            count(DISTINCT source_table)::int                   AS stores,
            count(*) FILTER (WHERE order_ref IS NOT NULL)::int   AS with_order_ref,
            count(*) FILTER (WHERE counterparty_ref IS NOT NULL)::int AS with_customer,
            min(opened_at)::text                                AS opened_min,
            max(opened_at)::text                                AS opened_max
     FROM cst_app.marketplace_cases`,
  );
  const { rows: runs } = await appClient.query(
    `SELECT status, count(*)::int AS n, max(published_at)::text AS latest_published
     FROM cst_app.case_import_runs GROUP BY 1 ORDER BY 1`,
  );
  const freshness = await lastPublishedByStore(appClient);
  const { rows: neighbours } = await appClient.query(
    `SELECT (SELECT count(*)::int FROM cst_app.customer_case_history) AS case_history,
            (SELECT count(*)::int FROM cst_app.conversations)         AS conversations,
            (SELECT count(*)::int FROM cst_app.context_snapshots)     AS context_snapshots,
            (SELECT count(*)::int FROM cst_app.sync_state)            AS sync_state_rows`,
  );

  const v = verify[0];
  line(`\n  ${APPLY ? "APPLIED" : "DRY RUN — nothing written, no run row created"}`);

  line("\n  cst_app.marketplace_cases, read back from the database:");
  line(`    rows                  ${v.rows_total}`);
  line(
    `    distinct identities   ${v.distinct_identities}  ${v.rows_total === v.distinct_identities ? "(no duplicates)" : "*** DUPLICATES PRESENT ***"}`,
  );
  line(`    source stores         ${v.stores}`);
  line(`    with an order ref     ${v.with_order_ref}`);
  line(`    with a customer ref   ${v.with_customer}`);
  line(`    opened_at span        ${v.opened_min} .. ${v.opened_max}`);

  line("\n  cst_app.case_import_runs:");
  for (const row of runs) {
    line(`    ${row.status.padEnd(14)}${String(row.n).padStart(5)}   latest published: ${row.latest_published ?? "(none)"}`);
  }

  line("\n  freshness, per source store, from published runs only:");
  if (freshness.size === 0) line("    (nothing published — CST must report every store as never imported)");
  for (const store of CASE_SOURCE_TABLES) {
    const at = freshness.get(store);
    line(`    ${store.padEnd(24)}${at ?? "NEVER IMPORTED"}`);
  }

  const n = neighbours[0];
  line("\n  neighbouring tables (must be unchanged by this import):");
  line(
    `    customer_case_history ${n.case_history}, conversations ${n.conversations}, context_snapshots ${n.context_snapshots}, sync_state ${n.sync_state_rows}`,
  );
  line("    (customer_case_history must still be 1098 — the Repeat-Customer Warning reads it)");
  line("    (sync_state must NOT have gained a row — this import registers no feed)");
} catch (cause) {
  failed += 1;
  console.error(`\nFAILED: ${cause.message}`);
} finally {
  await appClient.end().catch(() => {});
  line("\npostgres: connection closed");
}

line(`\n  mysql connection attempts : ${connections.mysqlAttempts} of 50/hour`);
line(`  mysql peak simultaneous   : ${connections.mysqlPeak}`);
line(`  mysql queries spent       : ${budget.spent} of 100/hour`);
line("  postgres peak concurrent connections : 1 per server, never two at once");

process.exit(failed > 0 ? 1 : 0);
