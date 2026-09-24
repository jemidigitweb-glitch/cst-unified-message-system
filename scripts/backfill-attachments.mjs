/**
 * Copies attachment URLs from the source messages into cst_app.
 *
 *   node scripts/backfill-attachments.mjs            report only, write nothing
 *   node scripts/backfill-attachments.mjs --apply    write to varmen_db.cst_app
 *
 * DRY RUN IS THE DEFAULT. Without `--apply` this reads both databases, reports
 * what it would set, and exits without a write.
 *
 * A SEPARATE PASS, deliberately. The URLs could have been threaded through the
 * adapters and the conversation writer, and that would have meant editing the
 * code that decides message direction and conversation grouping — for a display
 * feature. Threading logic is load-bearing and correct; showing a photograph is
 * not worth the risk of disturbing it.
 *
 * WRITES cst_app.conversation_messages ONLY, and only the `attachments` column.
 * The source is opened through a session that is read-only at the server
 * (`default_transaction_read_only=on`), so it cannot be written even by
 * mistake. No file is copied anywhere: this stores links to storage the
 * business already runs.
 *
 * IDEMPOTENT. The UPDATE skips rows that already hold the right value, so a
 * second run reports zero changes.
 *
 * ONLY THE SOURCES THAT HAVE ATTACHMENTS. eBay messages are platform messages
 * with no attachment column, and `amazon_messages` has none either. Their rows
 * keep NULL.
 *
 * ---------------------------------------------------------------------------
 * TURNED OFF BY CST ON 2026-09-24. IT DOES NOT RUN.
 * ---------------------------------------------------------------------------
 * See `ENABLED` below. Nothing here opens a database until that check passes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";

/**
 * Whether this script may run at all.
 *
 * ---------------------------------------------------------------------------
 * OFF, BY CST'S INSTRUCTION, BECAUSE OF THE CONNECTION BUDGET
 * ---------------------------------------------------------------------------
 * `varmen_user` has `rolconnlimit = 25` — a cap on the ROLE, shared by the
 * deployed application, the message sync, the automation worker and any SQL
 * client somebody has open. Exhausting it returns `53300 too many connections`
 * and takes the live inbox down with it, which is what happened on 2026-09-24.
 *
 * This is a MANUAL, ONE-OFF backfill of a display feature — attachment URLs.
 * Nobody is waiting on it and nothing depends on it running today, so it is the
 * cheapest thing to switch off and the last thing that should be competing with
 * the inbox for a connection.
 *
 * `repair-message-bodies.mjs` was deliberately left ON for the same review: it
 * keeps a reduced pool (`max: 1`) rather than being disabled.
 *
 * ---------------------------------------------------------------------------
 * A CONSTANT, NOT AN ENVIRONMENT VARIABLE
 * ---------------------------------------------------------------------------
 * Matching `performanceDashboardAccess` and `URGENT_WHEN_ORDER_STATE_UNVERIFIED`
 * elsewhere in this project: a variable is a thing somebody sets in a hurry and
 * nobody reviews. Turning this back on is a one-line edit that shows up in a
 * diff and gets read — which is the point.
 *
 * It refuses BEFORE any pool is constructed, so a disabled run costs zero
 * connections rather than opening two and then declining to work.
 */
const ENABLED = false;

if (!ENABLED) {
  console.error(
    [
      "backfill-attachments is DISABLED and did nothing.",
      "",
      "Turned off on 2026-09-24 to protect the shared PostgreSQL connection",
      'budget: role "varmen_user" is capped at 25 connections and exhausting it',
      "takes the live inbox down (SQLSTATE 53300).",
      "",
      "To run it again, set ENABLED = true at the top of this file.",
    ].join("\n"),
  );
  // Not a failure — a deliberate refusal that did no work. Exit 0 so a caller
  // does not treat it as a crash, with the reason on stderr where it is seen.
  process.exit(0);
}

const ROOT = join(import.meta.dirname, "..");
const APPLY = process.argv.includes("--apply");
const CHUNK = 2000;

/** Sources that record attachments, and the table each lives in. */
const ATTACHMENT_SOURCES = [
  { marketplace: "shopify", table: "shopify_messages" },
  { marketplace: "bandq", table: "bandq_messages" },
  { marketplace: "temu", table: "temu_messages" },
];

function loadEnv() {
  let text;
  try {
    text = readFileSync(join(ROOT, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
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
    /*
     * ONE CONNECTION, NOT FOUR.
     *
     * `varmen_user` has `rolconnlimit = 25` — a cap on the ROLE, shared by the
     * deployed app, the message sync, the automation worker and anybody with a
     * SQL client open. This script opens TWO pools, so `max: 4` reserved eight
     * of those 25 for a manual one-off backfill, and exhausting that budget is
     * what takes the live inbox down with `53300 too many connections`.
     *
     * A backfill is not latency-sensitive and nobody is waiting on it, so it is
     * the right thing to make slow and cheap rather than fast and greedy. It
     * still runs; it just queues its own work instead of the inbox's.
     *
     * The message sync and the automation worker deliberately keep their larger
     * pools — they are scheduled, they finish quickly, and CST wants them on.
     */
    max: 1,
    ...extra,
  });
}

/** Refuses to write anywhere that is not the application database. */
async function assertApplicationDatabase(app) {
  const { rows } = await app.query(
    `SELECT current_database() AS db,
            EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema='cst_app' AND table_name='conversation_messages'
                       AND column_name='attachments') AS has_column`,
  );
  const row = rows[0];
  if (!row?.has_column) {
    throw new Error(
      `${row?.db ?? "this database"} has no cst_app.conversation_messages.attachments — apply migration 0007 first.`,
    );
  }
  return row.db;
}

const MESSAGE_KEYS = `
SELECT m.id::text AS message_id, m.source_pk
FROM cst_app.conversation_messages m
JOIN cst_app.conversations c ON c.id = m.conversation_id
WHERE c.marketplace = $1 AND m.source_table = $2`;

const UPDATE_ATTACHMENTS = `
UPDATE cst_app.conversation_messages AS m
SET attachments = v.attachments::jsonb
FROM unnest($1::bigint[], $2::text[]) AS v(message_id, attachments)
WHERE m.id = v.message_id
  AND m.attachments IS DISTINCT FROM v.attachments::jsonb
RETURNING m.id`;

const chunked = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** Only https URLs are stored; the reader would drop anything else anyway. */
function usableUrls(raw) {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => /^https:\/\//i.test(entry)),
    ),
  ];
}

async function run() {
  loadEnv();
  const app = pool("APP");
  const source = pool("SOURCE", { options: "-c default_transaction_read_only=on" });

  try {
    console.log(`application database : ${await assertApplicationDatabase(app)}`);
    console.log(`mode                 : ${APPLY ? "APPLY (writes cst_app)" : "dry run"}\n`);

    let totalWith = 0;
    let totalUpdated = 0;

    for (const { marketplace, table } of ATTACHMENT_SOURCES) {
      const keys = (await app.query({ text: MESSAGE_KEYS, values: [marketplace, table] })).rows;
      if (keys.length === 0) {
        console.log(`${marketplace.padEnd(8)} no ingested messages from ${table}`);
        continue;
      }

      const found = new Map();
      for (const batch of chunked(keys.map((k) => k.source_pk), CHUNK)) {
        const { rows } = await source.query({
          text: `SELECT id::text AS id, attachments
                   FROM customer_service.${table}
                  WHERE id = ANY($1::bigint[]) AND attachments IS NOT NULL`,
          values: [batch],
        });
        for (const row of rows) found.set(row.id, row.attachments);
      }

      const updates = [];
      let images = 0;
      for (const key of keys) {
        const urls = usableUrls(found.get(key.source_pk));
        if (urls.length === 0) continue;
        images += urls.filter((u) => /\.(jpe?g|png|gif|webp|bmp|heic|heif)(\?|$)/i.test(u)).length;
        updates.push({ id: key.message_id, json: JSON.stringify(urls) });
      }
      totalWith += updates.length;

      console.log(
        `${marketplace.padEnd(8)} messages=${String(keys.length).padStart(6)}` +
          ` with attachments=${String(updates.length).padStart(5)}` +
          ` images=${String(images).padStart(5)}`,
      );

      if (APPLY) {
        for (const batch of chunked(updates, CHUNK)) {
          const { rows } = await app.query({
            text: UPDATE_ATTACHMENTS,
            values: [batch.map((u) => u.id), batch.map((u) => u.json)],
          });
          totalUpdated += rows.length;
        }
      }
    }

    console.log(
      `\nmessages with attachments: ${totalWith}` +
        (APPLY ? `, updated ${totalUpdated}` : " — dry run, nothing written"),
    );
    if (!APPLY) console.log("re-run with --apply to write.");
  } finally {
    await app.end();
    await source.end();
  }
}

try {
  await run();
} catch (cause) {
  console.error(`\nbackfill failed: ${cause.message}`);
  process.exitCode = 1;
}
