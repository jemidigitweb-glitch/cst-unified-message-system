import { NextResponse } from "next/server";
import type { Pool, PoolClient } from "pg";

import { getAppPool, getSourcePool } from "@/lib/db/pools";
import { runBodyRepair } from "@/lib/sync/body-repair";
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
 * How many stored-blank messages one invocation re-checks, after the feeds.
 *
 * WHY THE SYNC ALONE LEAVES BLANK MESSAGES. eBay writes a message in two places:
 * the header lands in `ebay_message_headers` immediately, the text arrives in
 * `ebay_messages` later. `syncFeed` reads strictly forward of its
 * `(timestamp, pk)` watermark, so a header ingested in that gap is stored
 * honestly as `empty` and the cursor never looks at it again — the customer's
 * words exist in the source and never reach the reviewer.
 *
 * The watermark is not the defect; it is what makes the sync cheap and
 * resumable. The defect was that the repair pass, which reads by primary key and
 * consults no cursor at all, only ever ran when someone remembered to run a
 * script — so production never ran it.
 *
 * DELIBERATELY SMALL. This shares a 60-second budget with five feeds. Candidates
 * are ordered newest-first, so a bounded pass spends itself where a body is most
 * likely to have just arrived, and anything it does not reach is still a
 * candidate on the next tick. There is no cursor to leave inconsistent.
 */
const REPAIR_CANDIDATE_LIMIT = 200;

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

  // Bodies that arrived after their header did. Runs after the feeds so a
  // message ingested blank moments ago is already a candidate, and outside the
  // loop because it consults no watermark and belongs to no single feed.
  //
  // Its failure is reported, never fatal: a sync that stored messages correctly
  // has done its job even if the repair pass could not run.
  let repair: Record<string, unknown>;
  try {
    const outcome = await runBodyRepair(
      app,
      source,
      { limit: REPAIR_CANDIDATE_LIMIT, dryRun: false },
      begin,
    );
    repair = {
      examined: outcome.examined,
      repaired: outcome.repaired,
      skipped: outcome.skipped,
      skippedByReason: outcome.skippedByReason,
      moreAvailable: outcome.moreAvailable,
    };
  } catch (cause) {
    console.error("[cron/sync] body repair failed", cause);
    repair = { error: "body repair failed — see server logs" };
  }

  return NextResponse.json({ ranAt: new Date().toISOString(), results, repair });
}
