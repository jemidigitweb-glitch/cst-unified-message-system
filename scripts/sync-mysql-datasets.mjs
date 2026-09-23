/**
 * One incremental sync for the three MariaDB-sourced datasets in cst_app.
 *
 *   npm run sync:mysql                      report only, write nothing
 *   npm run sync:mysql -- --apply           write to varmen_db.cst_app
 *   npm run sync:mysql -- --apply --only=directory,activity,media
 *   npm run sync:mysql -- --apply --lookback=1000 --page-size=2000
 *   npm run sync:mysql -- --apply --reconcile-limit=2000 --sweep=200
 *
 * DRY RUN IS THE DEFAULT. Without `--apply` it reads everything, resolves
 * everything, reports exactly what would change, opens no transaction and
 * advances no checkpoint.
 *
 * AUTOMATIC EXECUTION IS NOT ENABLED. Nothing schedules this: `vercel.json` is
 * untouched and no Windows task is registered. See the end of this comment for
 * the two ways to turn it on once connection limits and credentials are
 * approved.
 *
 * WHAT IT DOES, in one pass:
 *   1. directory  full idempotent upsert of 234 staff rows (no watermark — see
 *                 lib/sync/mysql-sync-state.ts for why it has no sync_state row)
 *   2. activity   new message_app_logs rows since the watermark, minus a lookback
 *   3. media      new files rows since the watermark, minus a lookback
 *   4. reconcile  retry unmatched activity (costs NO MariaDB queries), then
 *                 fetch media for eBay messages CST has newly ingested
 *
 * IT REUSES EVERYTHING. Mapping, validation and every write belong to the same
 * modules the three one-off importers call — `lib/domain/*`,
 * `lib/db/message-app-source.ts`, `lib/repositories/*`, `lib/sync/*-writer.ts`.
 * Nothing about what a name means, what a match means or how a row is written
 * is restated here; this file is scheduling, checkpoints and reporting.
 *
 * QUERY BUDGET. The MariaDB account allows 100 queries and 50 connections per
 * hour. A steady-state pass costs 1 (grants) + 1 (directory) + 1-2 (activity)
 * + 1-2 (media) + 0-2 (reconcile) — typically 5-8. ONE MariaDB connection is
 * opened for the whole run and closed at the end.
 *
 * TO ENABLE LATER (not done here, deliberately):
 *   Vercel  — add {"path":"/api/cron/sync-mysql","schedule":"..."} to
 *             vercel.json and wrap this in a route guarded by CRON_SECRET,
 *             exactly as /api/cron/sync is.
 *   Windows — register a task pointing at `npm run sync:mysql -- --apply`,
 *             the shape scripts/register-message-sync.ps1 already uses.
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

const { appDbConfig, sourceDbConfig, orderDbConfig } = await load("lib/config/env.ts");
const { assertOrderSourceReadOnly, fetchStaffPage } = await load("lib/db/order-source.ts");
const { fetchEbayActivityPage, fetchEbayMediaPage, fetchEbayMediaByRefIds, MAX_MEDIA_REF_LOOKUP } =
  await load("lib/db/message-app-source.ts");
const { mapStaffRow } = await load("lib/domain/agent-directory.ts");
const { mapActivityRow, usableExtMessageId } = await load("lib/domain/agent-activity.ts");
const { mapMediaRow, usableSourceRefId } = await load("lib/domain/conversation-message-media.ts");
const { resolveMessagesByExtMessageId } = await load(
  "lib/repositories/ebay-message-link-repository.ts",
);
const {
  findUnmatchedActivity, findNewEbayMessages, findEbayMessagesWithoutMedia, promoteMatchedActivity,
} = await load("lib/repositories/mysql-reconcile-repository.ts");
const { upsertAgentDirectory } = await load("lib/sync/agent-directory-writer.ts");
const { upsertAgentActivity } = await load("lib/sync/agent-activity-writer.ts");
const { upsertMessageMedia } = await load("lib/sync/conversation-message-media-writer.ts");
const { MYSQL_FEEDS, readWatermark, writeWatermark, startFrom, DEFAULT_LOOKBACK } = await load(
  "lib/sync/mysql-sync-state.ts",
);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const APPLY = argv.includes("--apply");
const PAGE_SIZE = Number(flag("page-size", "2000"));
const MAX_PAGES = Number(flag("pages", "10"));
const LOOKBACK = Number(flag("lookback", String(DEFAULT_LOOKBACK)));
const RECONCILE_LIMIT = Number(flag("reconcile-limit", "4000"));
const SWEEP = Number(flag("sweep", "200"));
const ONLY = (flag("only", "directory,activity,media") ?? "").split(",").map((s) => s.trim());

for (const [name, value] of [
  ["page-size", PAGE_SIZE], ["pages", MAX_PAGES], ["reconcile-limit", RECONCILE_LIMIT],
]) {
  if (!Number.isInteger(value) || value < 1) {
    console.error(`--${name} must be a positive integer`);
    process.exit(2);
  }
}
for (const [name, value] of [["lookback", LOOKBACK], ["sweep", SWEEP]]) {
  if (!Number.isInteger(value) || value < 0) {
    console.error(`--${name} must be a non-negative integer`);
    process.exit(2);
  }
}

const budget = { spent: 0 };
const report = [];
const line = (s) => { console.log(s); };

/**
 * Whether the forward media pass reached the end of `files`.
 *
 * It matters for the reconciliation cursor. That cursor walks CST message ids
 * looking for messages whose images were skipped — but a forward pass that read
 * the WHOLE table has already offered every image to every message CST holds.
 * Crawling the cursor up from 0 afterwards would spend runs re-asking a
 * question already answered, 500 messages at a time, for no new rows.
 *
 * So when the scan is exhausted, the cursor jumps to the newest eBay message
 * CST currently holds. Nothing below it can still be waiting.
 */
let mediaScanExhausted = false;

async function assertApplicationDatabase(client) {
  const { rows } = await client.query(
    `SELECT current_database() AS db, current_user AS usr,
            to_regclass('cst_app.agent_directory')          IS NOT NULL AS d,
            to_regclass('cst_app.agent_activity')           IS NOT NULL AS a,
            to_regclass('cst_app.conversation_message_media') IS NOT NULL AS m`,
  );
  const r = rows[0];
  if (r.db !== "varmen_db") throw new Error(`refusing to write: current_database() is ${r.db}`);
  if (r.usr !== "varmen_user") throw new Error(`refusing to write: current_user is ${r.usr}`);
  if (!r.d || !r.a || !r.m) throw new Error("a target table is missing — apply 0016-0018 first");
}

const orderConfig = orderDbConfig();
if (!orderConfig) { console.error("DB_ORDER_HOST is not set."); process.exit(2); }
if (!process.env.DB_HOST) { console.error("DB_HOST is not set."); process.exit(2); }

/** ONE connection per MariaDB host for the whole run. */
const orderConn = await mysql.createConnection({
  host: orderConfig.host, port: orderConfig.port, database: orderConfig.database,
  user: orderConfig.user, password: orderConfig.password,
  supportBigNumbers: true, bigNumberStrings: true, connectTimeout: 15_000,
});
const msgConn = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_DATABASE, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD,
  supportBigNumbers: true, bigNumberStrings: true, connectTimeout: 15_000,
});

const { schema, ...appConfig } = appDbConfig();
const appClient = new pg.Client({
  ...appConfig, ssl: { rejectUnauthorized: false },
  options: `-c search_path=${schema}`, application_name: "cst-sync-mysql",
});
const sourceClient = new pg.Client({
  ...sourceDbConfig(), ssl: { rejectUnauthorized: false },
  options: "-c default_transaction_read_only=on", application_name: "cst-sync-mysql-source-ro",
});

let failed = 0;
/**
 * Whether the application client actually connected.
 *
 * The closing summary queries cst_app, and a run that fails in pre-flight —
 * an exhausted MariaDB query budget, for instance — never reaches `connect()`.
 * Without this the summary awaits a client that will never answer and the
 * process hangs on an unsettled top-level await instead of reporting the
 * failure it already knows about.
 */
let appConnected = false;

try {
  await assertOrderSourceReadOnly(orderConn);
  await assertOrderSourceReadOnly(msgConn);
  budget.spent += 1; // one of the two is the budgeted host
  line("read-only verified: order_management and message_app (SELECT/USAGE only)");

  await sourceClient.connect();
  const { rows: ro } = await sourceClient.query("SHOW default_transaction_read_only");
  if (ro[0].default_transaction_read_only !== "on") {
    throw new Error("ledsone session is not read-only — refusing to proceed");
  }
  line("read-only verified: ledsone session");

  await appClient.connect();
  appConnected = true;
  if (APPLY) {
    await assertApplicationDatabase(appClient);
    line("destination verified: varmen_db / varmen_user / all three tables present");
  }

  const knownUserIds = new Set(
    (await appClient.query(
      "SELECT source_user_id FROM cst_app.agent_directory WHERE source_system = 'order_management'",
    )).rows.map((r) => Number(r.source_user_id)),
  );

  // ---------------------------------------------------------------- directory
  if (ONLY.includes("directory")) {
    const rows = await fetchStaffPage(orderConn, { afterUserId: 0, limit: 5000 });
    const entries = [];
    let rejected = 0;
    let unknownStatus = 0;
    for (const row of rows) {
      const mapped = mapStaffRow(row);
      if (!mapped.ok) { rejected += 1; continue; }
      if (!mapped.statusRecognised) unknownStatus += 1;
      entries.push(mapped.entry);
    }
    let inserted = 0, updated = 0;
    if (APPLY && entries.length > 0) {
      await appClient.query("BEGIN");
      ({ inserted, updated } = await upsertAgentDirectory(appClient, entries));
      await appClient.query("COMMIT");
      for (const id of entries.map((e) => e.sourceUserId)) knownUserIds.add(id);
    }
    report.push({
      feed: "directory", read: rows.length, imported: inserted, updated,
      unmatched: 0, failed: rejected, note: unknownStatus ? `${unknownStatus} unknown status` : "",
    });
  }

  // ----------------------------------------------------------------- activity
  if (ONLY.includes("activity")) {
    const feed = MYSQL_FEEDS.agentActivity;
    const watermark = await readWatermark(appClient, feed);
    let afterId = startFrom(watermark, LOOKBACK);
    const from = afterId;
    let read = 0, inserted = 0, updated = 0, matched = 0, unmatched = 0, noRef = 0, pages = 0;
    let highest = watermark;

    try {
      if (APPLY) await appClient.query("BEGIN");
      while (pages < MAX_PAGES) {
        const rows = await fetchEbayActivityPage(msgConn, { afterId, limit: PAGE_SIZE, budget });
        if (rows.length === 0) break;
        pages += 1; read += rows.length;
        afterId = Number(rows[rows.length - 1].sourcePk);
        highest = Math.max(highest, afterId);

        const extIds = [];
        for (const r of rows) {
          const e = usableExtMessageId(r.extMessageId);
          if (e !== null) extIds.push(e);
        }
        const links = await resolveMessagesByExtMessageId(sourceClient, appClient, extIds);

        const records = [];
        for (const r of rows) {
          const e = usableExtMessageId(r.extMessageId);
          const conversationId = e === null ? null : (links.get(e)?.conversationId ?? null);
          const mapped = mapActivityRow(r, conversationId, knownUserIds);
          if (mapped.record.matchStatus === "matched") matched += 1;
          else if (mapped.record.matchStatus === "unmatched") unmatched += 1;
          else noRef += 1;
          records.push(mapped.record);
        }
        if (APPLY) {
          const o = await upsertAgentActivity(appClient, records);
          inserted += o.inserted; updated += o.updated;
        }
        if (rows.length < PAGE_SIZE) break;
      }
      if (APPLY) {
        await writeWatermark(appClient, feed, { watermark: highest, status: "ok" });
        await appClient.query("COMMIT");
      }
    } catch (cause) {
      if (APPLY) {
        await appClient.query("ROLLBACK").catch(() => {});
        await writeWatermark(appClient, feed, {
          watermark: null, status: "error", error: cause.message.slice(0, 500),
        }).catch(() => {});
      }
      failed += 1;
      report.push({ feed: "activity", read, imported: 0, updated: 0, unmatched: 0, failed: read, note: cause.message });
      throw cause;
    }
    report.push({
      feed: "activity", read, imported: inserted, updated, unmatched, failed: 0,
      note: `from id ${from} (watermark ${watermark} - lookback ${LOOKBACK}) -> ${highest}; ${matched} matched, ${noRef} no_reference`,
    });
  }

  // -------------------------------------------------------------------- media
  if (ONLY.includes("media")) {
    const feed = MYSQL_FEEDS.messageMedia;
    const watermark = await readWatermark(appClient, feed);
    let afterId = startFrom(watermark, LOOKBACK);
    const from = afterId;
    let read = 0, inserted = 0, updated = 0, skipped = 0, pages = 0;
    let highest = watermark;

    try {
      if (APPLY) await appClient.query("BEGIN");
      while (pages < MAX_PAGES) {
        const rows = await fetchEbayMediaPage(msgConn, { afterId, limit: PAGE_SIZE, budget });
        if (rows.length === 0) { mediaScanExhausted = true; break; }
        pages += 1; read += rows.length;
        afterId = Number(rows[rows.length - 1].sourcePk);
        highest = Math.max(highest, afterId);

        const refs = [];
        for (const r of rows) {
          const ref = usableSourceRefId(r.sourceRefId);
          if (ref !== null) refs.push(ref);
        }
        const links = await resolveMessagesByExtMessageId(sourceClient, appClient, refs);

        const records = [];
        for (const r of rows) {
          const ref = usableSourceRefId(r.sourceRefId);
          const mapped = mapMediaRow(r, ref === null ? null : (links.get(ref) ?? null));
          if (mapped.ok) records.push(mapped.record);
          else skipped += 1;
        }
        if (APPLY && records.length > 0) {
          const o = await upsertMessageMedia(appClient, records);
          inserted += o.inserted; updated += o.updated;
        }
        if (rows.length < PAGE_SIZE) { mediaScanExhausted = true; break; }
      }
      if (APPLY) {
        await writeWatermark(appClient, feed, { watermark: highest, status: "ok" });
        await appClient.query("COMMIT");
      }
    } catch (cause) {
      if (APPLY) {
        await appClient.query("ROLLBACK").catch(() => {});
        await writeWatermark(appClient, feed, {
          watermark: null, status: "error", error: cause.message.slice(0, 500),
        }).catch(() => {});
      }
      failed += 1;
      report.push({ feed: "media", read, imported: 0, updated: 0, unmatched: 0, failed: read, note: cause.message });
      throw cause;
    }
    report.push({
      feed: "media", read, imported: inserted, updated, unmatched: skipped, failed: 0,
      note: `from id ${from} (watermark ${watermark} - lookback ${LOOKBACK}) -> ${highest}`,
    });
  }

  // -------------------------------------------- reconcile: unmatched activity
  if (ONLY.includes("activity")) {
    const pending = await findUnmatchedActivity(appClient, RECONCILE_LIMIT);
    let promoted = 0;
    if (pending.length > 0) {
      const links = await resolveMessagesByExtMessageId(
        sourceClient, appClient, pending.map((p) => p.externalMessageId),
      );
      const resolved = [];
      for (const p of pending) {
        const link = links.get(p.externalMessageId);
        if (link) resolved.push({ id: p.id, conversationId: link.conversationId });
      }
      if (APPLY && resolved.length > 0) {
        await appClient.query("BEGIN");
        promoted = await promoteMatchedActivity(appClient, resolved);
        await appClient.query("COMMIT");
      } else {
        promoted = resolved.length;
      }
    }
    report.push({
      feed: "reconcile:activity", read: pending.length, imported: 0, updated: promoted,
      unmatched: pending.length - promoted, failed: 0,
      note: "0 MariaDB queries — references are already stored in cst_app",
    });
  }

  // ------------------------------------------------ reconcile: missing images
  if (ONLY.includes("media")) {
    const feed = MYSQL_FEEDS.messageMediaReconcile;
    const cursor = await readWatermark(appClient, feed);

    const fresh = await findNewEbayMessages(appClient, { afterId: cursor, limit: MAX_MEDIA_REF_LOOKUP });
    // Safety net: messages ingested before this cursor ever ran sit below it
    // forever, so a bounded sweep of older media-less messages runs alongside.
    const sweep = SWEEP > 0
      ? await findEbayMessagesWithoutMedia(appClient, { upToId: cursor, limit: SWEEP })
      : [];

    const candidates = [...fresh, ...sweep];
    let read = 0, inserted = 0, updated = 0, skipped = 0;
    let newCursor = cursor;
    for (const m of fresh) newCursor = Math.max(newCursor, m.id);

    // The forward pass read every `files` row, so every message CST currently
    // holds has already been offered its images. Nothing below the newest one
    // can still be waiting, and crawling up to it would waste runs.
    let jumpedTo = null;
    if (mediaScanExhausted) {
      const { rows: mx } = await appClient.query(
        "SELECT COALESCE(max(id), 0) AS id FROM cst_app.conversation_messages WHERE source_table = 'ebay_message_headers'",
      );
      const maxEbayMessageId = Number(mx[0].id);
      if (maxEbayMessageId > newCursor) {
        jumpedTo = maxEbayMessageId;
        newCursor = maxEbayMessageId;
      }
    }

    if (candidates.length > 0) {
      // CST stores the header's `message_id`; MariaDB's `files.ref_id` is the
      // header's `ext_message_id`. This is the reverse of the forward hop, so
      // MariaDB can be asked for exactly these messages and no others.
      const { rows: refRows } = await sourceClient.query({
        text: `SELECT message_id, ext_message_id::text AS ext_message_id
               FROM customer_service.ebay_message_headers
               WHERE message_id = ANY($1::text[]) AND ext_message_id IS NOT NULL`,
        values: [candidates.map((c) => c.externalMessageId)],
      });
      const refIds = refRows.map((r) => r.ext_message_id);

      for (let i = 0; i < refIds.length; i += MAX_MEDIA_REF_LOOKUP) {
        const chunk = refIds.slice(i, i + MAX_MEDIA_REF_LOOKUP);
        const rows = await fetchEbayMediaByRefIds(msgConn, { refIds: chunk, budget });
        read += rows.length;
        if (rows.length === 0) continue;

        const links = await resolveMessagesByExtMessageId(
          sourceClient, appClient, rows.map((r) => usableSourceRefId(r.sourceRefId)).filter(Boolean),
        );
        const records = [];
        for (const r of rows) {
          const ref = usableSourceRefId(r.sourceRefId);
          const mapped = mapMediaRow(r, ref === null ? null : (links.get(ref) ?? null));
          if (mapped.ok) records.push(mapped.record);
          else skipped += 1;
        }
        if (APPLY && records.length > 0) {
          await appClient.query("BEGIN");
          const o = await upsertMessageMedia(appClient, records);
          await appClient.query("COMMIT");
          inserted += o.inserted; updated += o.updated;
        }
      }
    }

    if (APPLY) {
      await writeWatermark(appClient, feed, { watermark: newCursor, status: "ok" });
    }
    report.push({
      feed: "reconcile:media", read, imported: inserted, updated, unmatched: skipped, failed: 0,
      note:
        `${fresh.length} new + ${sweep.length} swept CST messages; cursor ${cursor} -> ${newCursor}` +
        (jumpedTo === null ? "" : " (jumped: forward pass read all of files)"),
    });
  }
} catch (cause) {
  failed += 1;
  console.error(`\nFAILED: ${cause.message}`);
} finally {
  await orderConn.end().catch(() => {});
  await msgConn.end().catch(() => {});
}

line(`\n${APPLY ? (failed > 0 ? "PARTIAL — see failures below" : "APPLIED") : "DRY RUN — nothing written, no checkpoint advanced"}`);
line("");
line("  feed                  read  imported  updated  unmatched  failed");
line("  ------------------------------------------------------------------");
for (const r of report) {
  line(
    `  ${r.feed.padEnd(20)}${String(r.read).padStart(5)}${String(r.imported).padStart(10)}` +
    `${String(r.updated).padStart(9)}${String(r.unmatched).padStart(11)}${String(r.failed).padStart(8)}`,
  );
  if (r.note) line(`      ${r.note}`);
}
line(`\n  MariaDB queries spent : ${budget.spent} of 100/hour`);
line(`  MariaDB connections   : 2 of 50/hour (one per host, shared across all feeds)`);

if (APPLY && appConnected) {
  const { rows } = await appClient.query(
    `SELECT (SELECT count(*) FROM cst_app.agent_directory) AS directory,
            (SELECT count(*) FROM cst_app.agent_activity) AS activity,
            (SELECT count(*) FROM cst_app.agent_activity WHERE match_status='unmatched') AS activity_unmatched,
            (SELECT count(*) FROM cst_app.conversation_message_media) AS media`,
  );
  const r = rows[0];
  line(`\n  cst_app: ${r.directory} staff, ${r.activity} activity (${r.activity_unmatched} unmatched), ${r.media} images`);
  const { rows: st } = await appClient.query(
    `SELECT feed_key, watermark_source_pk, last_status, last_success_at::text
     FROM cst_app.sync_state WHERE feed_key LIKE '%message-app%' OR feed_key LIKE 'ebay-media%' ORDER BY feed_key`,
  );
  line("\n  checkpoints:");
  for (const s of st) line(`    ${s.feed_key.padEnd(40)} ${String(s.watermark_source_pk).padStart(10)}  ${s.last_status}`);
  line("    (agent_directory has no checkpoint by design — full upsert, no cursor)");
}

await sourceClient.end().catch(() => {});
await appClient.end().catch(() => {});
process.exit(failed > 0 ? 1 : 0);
