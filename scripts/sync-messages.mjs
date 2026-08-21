/**
 * Syncs the latest marketplace messages into cst_app.
 *
 *   npm run sync:messages                      report only, write nothing
 *   npm run sync:messages -- --apply           write to varmen_db.cst_app
 *   npm run sync:messages -- --apply --marketplace=ebay
 *   npm run sync:messages -- --apply --pages=5 --page-size=1000
 *   npm run sync:messages -- --apply --bootstrap=2026-08-01
 *
 * DRY RUN IS THE DEFAULT. Without `--apply` this reads both databases, reports
 * exactly what would land, and opens no transaction.
 *
 * READS the marketplace source through a session that is read-only at the
 * server; WRITES cst_app only, through the existing reviewed writer. The
 * database identity is checked before any write — see `assertApplicationDatabase`.
 *
 * RE-RUNNABLE. Each feed resumes from its (timestamp, pk) watermark in
 * cst_app.sync_state, and the unique constraints make a repeated run an upsert
 * rather than a duplicate. Running it twice in a row is expected to report zero
 * inserts the second time.
 *
 * Nothing here normalises a message, decides a direction or groups a thread.
 * Every one of those decisions belongs to the marketplace's own reviewed code,
 * which this only calls — see lib/sync/message-sync.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

const ROOT = join(import.meta.dirname, "..");

const { SYNC_FEEDS, syncFeed } = await import(
  pathToFileURL(join(ROOT, "lib/sync/message-sync.ts")).href
);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const APPLY = argv.includes("--apply");
const ONLY = flag("marketplace", null);
const PAGE_SIZE = Number(flag("page-size", "500"));
const MAX_PAGES = Number(flag("pages", "50"));
/**
 * First-run window. Required, and deliberately not "the beginning of time":
 * a feed with no watermark must not silently pull years of history.
 */
const BOOTSTRAP_START = flag("bootstrap", "2026-08-01 00:00:00");

/** The identity this application is allowed to write as. */
const EXPECTED_DATABASE = "varmen_db";
const EXPECTED_USER = "varmen_user";

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

function pool(prefix, extra) {
  const host = process.env[`${prefix}_DB_HOST`];
  if (!host) throw new Error(`${prefix}_DB_HOST is not set — check .env`);
  return new pg.Pool({
    host,
    port: Number(process.env[`${prefix}_DB_PORT`] ?? 5432),
    database: process.env[`${prefix}_DB_NAME`],
    user: process.env[`${prefix}_DB_USER`],
    password: process.env[`${prefix}_DB_PASSWORD`],
    ssl: process.env.DB_SSL_MODE === "disable" ? undefined : { rejectUnauthorized: false },
    max: 4,
    ...extra,
  });
}

/**
 * Refuses to write anywhere that is not the application database.
 *
 * A misconfigured `.env` pointing APP_* at the live marketplace source would
 * otherwise be discovered by writing to it. The check is the one the task
 * specifies — `current_database()` and `current_user` — and it runs before any
 * transaction is opened.
 */
async function assertApplicationDatabase(app) {
  const { rows } = await app.query("SELECT current_database() AS db, current_user AS usr");
  const { db, usr } = rows[0];
  console.log(`application database : ${db}`);
  console.log(`application user     : ${usr}`);

  if (db !== EXPECTED_DATABASE) {
    throw new Error(`refusing to write: current_database() is ${db}, expected ${EXPECTED_DATABASE}`);
  }
  if (usr !== EXPECTED_USER) {
    throw new Error(`refusing to write: current_user is ${usr}, expected ${EXPECTED_USER}`);
  }

  const { rows: schema } = await app.query(
    `SELECT to_regclass('cst_app.conversations') IS NOT NULL AS ok`,
  );
  if (!schema[0]?.ok) throw new Error("cst_app.conversations is missing — apply the migrations first");
}

/** Confirms the source session cannot be written to, before reading from it. */
async function assertSourceReadOnly(source) {
  const { rows } = await source.query("SHOW default_transaction_read_only");
  const value = rows[0]?.default_transaction_read_only;
  console.log(`source read-only     : ${value}`);
  if (value !== "on") {
    throw new Error("source session is not read-only — refusing to proceed");
  }
}

async function run() {
  loadEnv();
  const app = pool("APP");
  const source = pool("SOURCE", { options: "-c default_transaction_read_only=on" });

  try {
    await assertApplicationDatabase(app);
    await assertSourceReadOnly(source);
    console.log(`mode                 : ${APPLY ? "APPLY (writes cst_app)" : "dry run"}`);
    console.log(`page size / max pages: ${PAGE_SIZE} / ${MAX_PAGES}`);
    console.log(`first-run window     : from ${BOOTSTRAP_START}\n`);

    const feeds = Object.values(SYNC_FEEDS).filter(
      (feed) => ONLY === null || feed.marketplace === ONLY,
    );
    if (feeds.length === 0) throw new Error(`unknown --marketplace=${ONLY}`);

    /** One transaction per page, committed before the next page is fetched. */
    const begin = async (work) => {
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await work(client);
        await client.query("COMMIT");
      } catch (cause) {
        await client.query("ROLLBACK").catch(() => {});
        throw cause;
      } finally {
        client.release();
      }
    };

    const results = [];
    for (const feed of feeds) {
      process.stdout.write(`${feed.marketplace.padEnd(8)} `);
      try {
        const outcome = await syncFeed(
          app,
          source,
          feed,
          {
            pageSize: PAGE_SIZE,
            maxPages: MAX_PAGES,
            bootstrapStartAt: BOOTSTRAP_START,
            dryRun: !APPLY,
            onPage: () => process.stdout.write("."),
          },
          begin,
        );
        results.push(outcome);
        console.log(
          `\n  examined=${outcome.rowsExamined} usable=${outcome.messages}` +
            ` unusable=${outcome.unusableRows} notices=${outcome.excludedSystemNotices}` +
            `\n  conversations +${outcome.conversationsInserted}/~${outcome.conversationsUpdated}` +
            `  messages +${outcome.messagesInserted}/~${outcome.messagesUpdated}` +
            `\n  watermark ${outcome.watermarkBefore?.sourceTimestamp ?? "(none)"}` +
            ` -> ${outcome.watermarkAfter?.sourceTimestamp ?? "(none)"}` +
            (outcome.moreAvailable ? "\n  MORE AVAILABLE — re-run to continue" : ""),
        );
      } catch (cause) {
        // One marketplace failing must not abandon the others; each has its own
        // watermark and its own transaction, so the rest are unaffected.
        console.log(`\n  FAILED: ${cause.message}`);
      }
      console.log();
    }

    const inserted = results.reduce((n, r) => n + r.messagesInserted, 0);
    console.log(
      APPLY
        ? `total new messages stored: ${inserted}`
        : "dry run — nothing written. Re-run with --apply.",
    );
  } finally {
    await app.end();
    await source.end();
  }
}

try {
  await run();
} catch (cause) {
  console.error(`\nsync failed: ${cause.message}`);
  process.exitCode = 1;
}
