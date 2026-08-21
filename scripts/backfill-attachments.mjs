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
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";

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
    max: 4,
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
