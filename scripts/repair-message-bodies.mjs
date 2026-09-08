/**
 * Repairs marketplace messages that were stored without a usable body.
 *
 *   npm run repair:bodies                          report only, write nothing
 *   npm run repair:bodies -- --apply               write to varmen_db.cst_app
 *   npm run repair:bodies -- --apply --marketplace=ebay
 *   npm run repair:bodies -- --apply --limit=1000 --batch-size=200
 *
 * DRY RUN IS THE DEFAULT. Without `--apply` this reads both databases, reports
 * exactly which messages would be repaired and why the rest would not, and opens
 * no transaction.
 *
 * WHY THIS EXISTS. Some sources write a message header before its text. eBay
 * lands the header in `ebay_message_headers` and the body in `ebay_messages`
 * later; a header synced in that gap is stored honestly as `empty` and shows a
 * blank bubble. The sync reads strictly forward of its watermark and can never
 * revisit it. This re-reads those specific rows by primary key.
 *
 * NO CURSOR IS TOUCHED. Nothing here reads, writes or advances `sync_state`, so
 * it is safe to run at any time, including alongside a sync.
 *
 * READS the marketplace source through a session that is read-only at the
 * server; WRITES `cst_app.conversation_messages` only, through the sync's own
 * upsert. The database identity is checked before any write.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

const ROOT = join(import.meta.dirname, "..");

const { runBodyRepair, REPAIR_SKIP_REASONS } = await import(
  pathToFileURL(join(ROOT, "lib/sync/body-repair.ts")).href
);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const APPLY = argv.includes("--apply");
const ONLY = flag("marketplace", null);
const LIMIT = Number(flag("limit", "500"));
const BATCH_SIZE = Number(flag("batch-size", "500"));

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

/** Refuses to write anywhere that is not the application database. */
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
    console.log(`candidates / batch   : ${LIMIT} / ${BATCH_SIZE}`);
    console.log(`marketplaces         : ${ONLY ?? "all"}\n`);

    /** One transaction per batch, committed before the next source read. */
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

    const outcome = await runBodyRepair(
      app,
      source,
      {
        marketplaces: ONLY === null ? undefined : [ONLY],
        limit: LIMIT,
        batchSize: BATCH_SIZE,
        dryRun: !APPLY,
        onBatch: () => process.stdout.write("."),
      },
      begin,
    );

    console.log(`\n\nexamined : ${outcome.examined}`);
    console.log(`repaired : ${outcome.repaired}`);
    console.log(`skipped  : ${outcome.skipped}`);

    for (const reason of REPAIR_SKIP_REASONS) {
      const count = outcome.skippedByReason[reason];
      if (count) console.log(`  ${reason.padEnd(26)} ${count}`);
    }

    console.log();
    for (const summary of outcome.byMarketplace) {
      console.log(
        `${summary.marketplace.padEnd(8)} examined=${summary.examined}` +
          ` repaired=${summary.repaired} skipped=${summary.skipped}`,
      );
    }

    if (outcome.unexpectedInserts > 0) {
      console.log(
        `\nWARNING: ${outcome.unexpectedInserts} row(s) were inserted rather than updated —` +
          ` a stored message disappeared mid-run.`,
      );
    }
    if (outcome.moreAvailable) {
      console.log("\nMORE AVAILABLE — the limit was reached. Re-run to continue.");
    }
    if (!APPLY) {
      console.log("\ndry run — nothing written. Re-run with --apply.");
    }
  } finally {
    await app.end();
    await source.end();
  }
}

try {
  await run();
} catch (cause) {
  console.error(`\nrepair failed: ${cause.message}`);
  process.exitCode = 1;
}
