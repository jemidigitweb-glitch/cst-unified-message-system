import { NextResponse } from "next/server";
import type { Pool, PoolClient } from "pg";

import { getAppPool, getSourcePool } from "@/lib/db/pools";
import { assertApplicationDatabase, assertSourceReadOnly } from "@/lib/sync/guard";
import { SYNC_FEEDS, type Queryable, syncFeed } from "@/lib/sync/message-sync";

/**
 * GET /api/cron/sync — the deployed equivalent of `npm run sync:messages -- --apply`.
 *
 * WHY THIS EXISTS. The CLI script only runs where someone starts it — today
 * that is a Windows Task Scheduler job on one machine. Production (Vercel)
 * never wrote to cst_app; it only read from it. This route lets a platform
 * scheduler (see vercel.json's `crons` entry) trigger the same sync from the
 * deployment itself, so ingestion does not depend on that one machine staying
 * on.
 *
 * REUSES THE SAME REVIEWED CODE. Every decision — normalisation, direction,
 * threading, the idempotent writer, the read-only source guarantee — lives in
 * `lib/sync/*`, exactly as it does for the CLI. This route is only wiring:
 * pick up the pools, run the same `syncFeed` loop, apply. Nothing here
 * duplicates that logic and nothing here can be reached without the secret
 * below.
 *
 * BOUNDED PER INVOCATION. A serverless function has a hard time limit, so each
 * call caps itself well under it rather than draining the whole backlog. This
 * is safe because the sync is incremental: whatever a call does not finish, a
 * later call — the next scheduled tick, or this route hit again — resumes
 * from the watermark exactly where this one left off.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PAGE_SIZE = 300;
const MAX_PAGES_PER_FEED = 3;
const BOOTSTRAP_START = "2026-08-01 00:00:00";

/**
 * Vercel Cron Jobs send `Authorization: Bearer $CRON_SECRET` automatically
 * once `CRON_SECRET` is set as a project environment variable. Failing closed
 * when it is not set: an unauthenticated route that writes to production is
 * not an acceptable default, so a missing secret refuses every request rather
 * than accepting them.
 */
function isAuthorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/** One transaction per page, committed before the next page is fetched. */
function beginOn(app: Pool) {
  return async (work: (tx: Queryable) => Promise<void>) => {
    const client: PoolClient = await app.connect();
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
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const app = getAppPool();
  const source = getSourcePool();

  try {
    await assertApplicationDatabase(app);
    await assertSourceReadOnly(source);
  } catch (cause) {
    console.error("[cron/sync] safety check failed", cause);
    return NextResponse.json({ error: "Sync refused: safety check failed" }, { status: 500 });
  }

  const begin = beginOn(app);
  const results: Array<{
    marketplace: string;
    messagesInserted?: number;
    conversationsInserted?: number;
    moreAvailable?: boolean;
    error?: string;
  }> = [];

  for (const feed of Object.values(SYNC_FEEDS)) {
    try {
      const outcome = await syncFeed(
        app,
        source,
        feed,
        {
          pageSize: PAGE_SIZE,
          maxPages: MAX_PAGES_PER_FEED,
          bootstrapStartAt: BOOTSTRAP_START,
          dryRun: false,
        },
        begin,
      );
      results.push({
        marketplace: outcome.marketplace,
        messagesInserted: outcome.messagesInserted,
        conversationsInserted: outcome.conversationsInserted,
        moreAvailable: outcome.moreAvailable,
      });
    } catch (cause) {
      // One marketplace failing must not abandon the others; each has its own
      // watermark and its own transaction, so the rest are unaffected.
      console.error(`[cron/sync] ${feed.marketplace} failed`, cause);
      results.push({ marketplace: feed.marketplace, error: "sync failed — see server logs" });
    }
  }

  return NextResponse.json({ ranAt: new Date().toISOString(), results });
}
