/**
 * The post-dispatch automation worker: ALWAYS RUNNING, never polled.
 *
 *   npm run worker:automation
 *   npm run worker:automation:once              one pass and exit
 *   npm run worker:automation --recheck-seconds=20
 *
 * WHAT IT REPLACES. Until now the only local triggers were a Task Scheduler job
 * that called the HTTP route every 15 minutes, and the deployed cron. A 15-minute
 * tick is not wrong so much as beside the point: a record comes due at one
 * specific instant, `dispatched_at + delay_hours`, and the tick decides when that
 * instant is noticed. This process starts once and then sits on the exact moment.
 *
 * HOW IT WAITS. Between ticks it does not poll the table. It reads the soonest
 * `scheduled_at`, sleeps until it, and is WOKEN EARLY by anything that would
 * change the answer:
 *
 *   * a new record with an EARLIER `scheduled_at` than the one being waited on
 *   * the automation being switched on, switched off, or re-scoped
 *   * a record being cancelled, or one becoming overdue
 *   * the recheck interval elapsing, so an external edit is never missed by more
 *     than that interval however the wake-up is delivered
 *
 * WHY THAT MATTERS AND WHERE THE WAKES COME FROM. A record is created by the
 * SCAN, and the scan belongs to the route (`POST /api/cron/automation` is not
 * the only caller — `runPostDispatchAutomation` is). Two mechanisms deliver the
 * wake-up, deliberately, because the honest answer is that this process cannot
 * see a row appear without watching for it:
 *
 *   1. LISTEN/NOTIFY. Every statement that can change the answer — the insert,
 *      the status changes, a settings update, a cancellation — performs
 *      `pg_notify('cst_automation_wake', reason)` ONCE, added by
 *      `migrations/0015_automation_worker_wake.up.sql`. The notification is sent
 *      inside the writer's transaction, so it arrives only if that transaction
 *      commits: a rolled-back insert wakes nobody, which is correct. This is the
 *      exact wake-up, and it costs the writer one function call.
 *   2. One tiny SELECT on the recheck interval, by default every 15 seconds. If
 *      0012 has not been applied — or a path in this application writes a record
 *      without the trigger, or an operator cancels a record directly in SQL —
 *      this is what still finds it. It is the guarantee; LISTEN is the speed.
 *
 * The second is a single-row index scan on `ix_automation_items_due`, the partial
 * index that exists for exactly this shape of question. It is not a scan of the
 * table and it is not a tick of the automation: NOTHING IS PROCESSED EARLY
 * because of it.
 *
 * THE MOMENT ITSELF. When `scheduled_at` arrives, the worker does not "run the
 * automation" — it claims that record, in one transaction, through
 * `claimAndProcessDue`, which is the same reviewed code the deployed route runs:
 * a fresh source read, the eligibility recheck that skips a cancelled, refunded
 * or returned order, the template the record was queued against, and the
 * test-mode assertion. Duplicate processing is prevented by `FOR UPDATE SKIP
 * LOCKED` on the claim plus the transaction the outcome is written in, so a
 * second worker, the route, or the deployment's cron cannot process the same
 * record twice — and the worker being woken twice in one second cannot either.
 *
 * OVERDUE AFTER A RESTART. `scheduled_at <= now()` is the claim's own condition,
 * so every record that came due while this process was not running is due the
 * moment it starts. There is no catch-up loop and no special case: the first
 * pass claims them oldest-first, in the same order the 15-minute task would have.
 *
 * TEST MODE IS ON and cannot be otherwise from here: the worker never writes a
 * status, a result or a setting. It calls the runner and reads rows. Every
 * processed record is written `processed_mode = 'test_mode'`, and 0011's
 * `ck_automation_items_sent_requires_test_mode` refuses any other kind of `sent`
 * row at the database.
 *
 * NO TRANSPORT. No marketplace client, no mail client, no credential read, no
 * outbound request. The only network this process opens is the two Postgres
 * connections. `tests/guards/automation-worker.test.ts` pins that.
 *
 * WHY IT NEEDS NO SERVER. It talks to the databases directly, so unlike
 * `scripts/run-post-dispatch-automation.mjs` it does not need `npm run dev` to be
 * serving. That wrapper still exists for the deployment-shaped case and is
 * unchanged; this one does not depend on it.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * .env is read here rather than required in the task's environment, for the same
 * reason the sync wrapper does it: a task started by wscript.exe inherits very
 * little, and a credential that has to be set in two places goes stale in one of
 * them. A variable already present in the environment always wins.
 */
function loadEnv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv();

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

/** One pass, report, exit. For a smoke test and for CI. */
const ONCE = argv.includes("--once");

/**
 * How long the worker may go without re-reading the soonest `scheduled_at`, and
 * so the longest an external edit can go unnoticed if LISTEN/NOTIFY never
 * delivers. It is NOT how often the automation runs.
 */
const RECHECK_SECONDS = Math.max(5, Number(flag("recheck-seconds", "15")) || 15);

/** The name 0012's triggers notify on. One channel, one meaning. */
const WAKE_CHANNEL = "cst_automation_wake";

/**
 * The wait is re-evaluated this often while asleep, and clamped either way.
 *
 * The lower bound is what makes a long sleep safe: `setTimeout` on Windows is
 * not reliable to the minute across a sleep/hibernate/resume, and a laptop that
 * wakes up an hour later must find its overdue records promptly rather than
 * whenever the original timer was due. The upper bound keeps a very distant
 * record from holding one timer open for a day — a record 24 hours out is
 * re-checked in 60-second stages, which costs one indexed SELECT a minute and
 * cannot drift.
 */
const SLEEP_STAGE_MS = 60_000;
const MIN_SLEEP_MS = 1_000;

const logDir = join(ROOT, "logs");
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
let logFile = join(logDir, `automation-worker-${new Date().toISOString().slice(0, 7)}.log`);

/** One line per event, flushed, so a killed worker still has a usable log. */
function log(line) {
  const text = `${stamp()} ${line}`;
  try {
    appendFileSync(logFile, `${text}\n`);
  } catch {
    /* A log that cannot be written is not worth stopping a worker over. */
  }
  console.log(text);
}

/** A year of monthly logs and no more, matching the other wrappers. */
function pruneLogs() {
  try {
    const logs = readdirSync(logDir)
      .filter((name) => /^automation-worker-\d{4}-\d{2}\.log$/.test(name))
      .map((name) => ({ name, mtime: statSync(join(logDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { name } of logs.slice(12)) {
      try {
        unlinkSync(join(logDir, name));
      } catch {
        /* Best effort. */
      }
    }
  } catch {
    /* Best effort. */
  }
}

// ---------------------------------------------------------------------------
// The decision, kept pure so it can be tested without a database or a timer.
// ---------------------------------------------------------------------------

export const DAY_MS = 86_400_000;

/**
 * How long to sleep, given the soonest scheduled moment and the clock.
 *
 * `null` means "nothing is waiting" — a closed automation, no scheduled record,
 * or a record whose `scheduled_at` could not be read as a date. It is not an
 * error: it is the state this worker spends most of its life in, and it must not
 * be confused with "sleep for zero", which would spin.
 *
 * A moment already in the past gives MIN_SLEEP_MS rather than a negative number:
 * an overdue record is claimed on the next pass, not now, so the loop cannot
 * recurse into itself on a table full of overdue rows.
 */
export function waitPlan(scheduledAt, nowMs, stageMs = SLEEP_STAGE_MS) {
  if (scheduledAt === null || scheduledAt === undefined) return { sleepMs: null };
  const target = Date.parse(scheduledAt);
  if (Number.isNaN(target)) return { sleepMs: null };

  const remaining = target - nowMs;
  if (remaining <= 0) return { sleepMs: MIN_SLEEP_MS, overdueByMs: -remaining, wakeAt: target };
  return {
    sleepMs: Math.min(remaining, Math.max(MIN_SLEEP_MS, stageMs)),
    overdueByMs: 0,
    wakeAt: target,
  };
}

/**
 * Which record the worker should be waiting on.
 *
 * THE EARLIER-JOB RULE, stated once: between two scheduled records the worker
 * waits on the one that comes due first, whatever order they were created in. A
 * record inserted just now with an earlier `scheduled_at` — a shipment dispatched
 * yesterday, discovered this minute — is therefore the new target on the very
 * next evaluation, and the wake-up that matters is the INSERT, which is why 0012
 * notifies on it.
 *
 * A record whose time has arrived is still "the one to wait on", and returns
 * MIN_SLEEP_MS, so the caller claims rather than waits. That is deliberate: it
 * keeps the overdue case in the same code path as the ordinary one, which is the
 * only way a restart with a day of backlog behaves like any other pass.
 */
export function planFromRow(row, nowMs, stageMs = SLEEP_STAGE_MS) {
  if (row === undefined || row === null) return { row: null, sleepMs: null };
  return { row, ...waitPlan(row.scheduled_at, nowMs, stageMs) };
}

// ---------------------------------------------------------------------------
// Waking
// ---------------------------------------------------------------------------

/**
 * A promise that resolves when the worker should re-evaluate, and says why.
 *
 * The reason is logged and is the whole diagnostic value of this design: "woke
 * because a new earlier record was inserted" and "woke because the recheck
 * interval elapsed" mean very different things to whoever is reading the log.
 */
function makeWaker() {
  let resolve = null;
  let promise = new Promise((r) => {
    resolve = r;
  });
  let armed = true;

  return {
    /** Fire once, from any source. A second fire is ignored until re-armed. */
    fire(reason) {
      if (!armed) return;
      armed = false;
      resolve(reason);
    },
    wait() {
      promise = new Promise((r) => {
        resolve = r;
      });
      armed = true;
      return promise;
    },
  };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * IMPORTS THIS FILE WITHOUT STARTING IT, when a test loads it.
 *
 * WHY THIS GUARD HAS TO EXIST. A `.mjs` script cannot be imported for a single
 * pure function — importing it RUNS it. That is what a test of `waitPlan` wants
 * to avoid, and what actually happened the first time this was written: the test
 * imported the module, the worker started, `nextScheduledItem` answered from the
 * test's fake pool with a row whose `scheduled_at` was the column name rather
 * than a timestamp, `waitPlan` read that as "due now", and a resident worker span
 * on the fake table for as long as the test process lived, writing to the real
 * log the whole time.
 *
 * The honest fix is not a flag the test passes. It is this: the process does not
 * start unless it was ASKED to. `process.argv[1]` is the script Node was told to
 * run, and it is absent when a test imports the module, so an import is inert —
 * always, for a test, a bundler or an editor tooling pass alike. That is worth
 * more than the few lines it costs, because the failure it prevents is a worker
 * nobody knows is running.
 */
function wasInvokedDirectly() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return fileURLToPath(import.meta.url) === entry;
}

async function main() {
  const { createAppPool, createSourcePool } = await import("@/lib/db/app-connection");
  const { assertApplicationDatabase, assertSourceReadOnly } = await import("@/lib/sync/guard");
  const { automationSettings, nextScheduledItem } = await import(
    "@/lib/repositories/automation-repository"
  );
  const { POST_DISPATCH_AUTOMATION_KEY } = await import("@/lib/domain/automation/automation-types");
  const { scanRefusal } = await import("@/lib/domain/automation/automation-settings-service");
  const { claimAndProcessDue } = await import("@/lib/domain/automation/automation-runner");

  const app = createAppPool();
  const source = createSourcePool();

  log(`===== automation worker starting (pid ${process.pid}) =====`);

  /**
   * THE SAME TWO CHECKS THE ROUTE RUNS, before anything is written.
   *
   * A worker started by a scheduled task with a stale `.env` is exactly the
   * situation this is for: pointing the "app" connection at the marketplace
   * source would otherwise be discovered by writing to it. Here it refuses to
   * start, loudly, and the task's log says why.
   */
  try {
    await assertApplicationDatabase(app);
    await assertSourceReadOnly(source);
  } catch (cause) {
    log(`REFUSING TO START: ${cause instanceof Error ? cause.message : String(cause)}`);
    await shutdown(app, source, 1);
    return;
  }
  log("safety checks passed: application database confirmed, source session is read-only");

  const waker = makeWaker();

  /**
   * LISTEN, on a connection of its own.
   *
   * Not from the pool: a listener holds its connection for the life of the
   * process, so borrowing one from a pool sized for queries would starve them. A
   * dropped notification connection is not fatal — the recheck interval still
   * bounds how long an edit goes unnoticed — so a failure here is logged and the
   * worker carries on with the interval alone.
   */
  let listener = null;
  try {
    const { Client } = await import("pg");
    const { appDbConfig } = await import("@/lib/config/env");
    // `schema` is this process's `search_path`, not a node-postgres option, so it
    // is dropped rather than handed to Client -- which would reject it.
    const { schema, ...connection } = appDbConfig();
    void schema;
    listener = new Client({
      ...connection,
      ssl: process.env.DB_SSL_MODE === "disable" ? undefined : { rejectUnauthorized: false },
      application_name: "cst-automation-worker-listen",
    });
    listener.on("notification", (message) => {
      if (message.channel === WAKE_CHANNEL) waker.fire(`notify(${message.payload || "unspecified"})`);
    });
    listener.on("error", (cause) => {
      log(`LISTEN connection error, interval-only from here: ${cause.message}`);
    });
    await listener.connect();
    await listener.query(`LISTEN ${WAKE_CHANNEL}`);
    log(`listening on '${WAKE_CHANNEL}'`);
  } catch (cause) {
    log(
      `LISTEN unavailable (${cause instanceof Error ? cause.message : String(cause)}) — ` +
        `falling back to the ${RECHECK_SECONDS}s recheck, which is correct but slower. ` +
        `Has migration 0012 been applied?`,
    );
    listener = null;
  }

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log("stop requested — finishing the current pass");
    waker.fire("shutdown");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let passes = 0;
  try {
    while (!stopping) {
      const settings = await automationSettings(app, POST_DISPATCH_AUTOMATION_KEY);
      const refusal = settings === undefined ? null : scanRefusal(settings);

      /**
       * The automation being off is a REASON TO WAIT, not a reason to exit. A
       * worker that exited on "switched off" would be a worker an operator has to
       * remember to restart after switching it back on — and the switch is
       * precisely what 0012 notifies on, so the wake arrives within a second.
       */
      if (settings === undefined || refusal !== null) {
        const reason = settings === undefined ? "not configured (migration 0011 unseeded)" : refusal.reason;
        log(`idle: ${ reason }`);
        if (ONCE) break;
        await sleepOrWake(waker, RECHECK_SECONDS * 1000);
        continue;
      }

      // A read only, no lock: the claim that matters is the one inside the
      // transaction the processing runs in.
      const soonest = await nextScheduledItem(app, { automationKey: POST_DISPATCH_AUTOMATION_KEY });
      const plan = planFromRow(soonest, Date.now());

      if (plan.row === null) {
        log("idle: no scheduled record is waiting");
        if (ONCE) break;
        await sleepOrWake(waker, RECHECK_SECONDS * 1000);
        continue;
      }

      const waitingOn = `#${ plan.row.id } at ${ plan.row.scheduled_at }`;

      if (plan.overdueByMs > 0) {
        log(`claiming ${ waitingOn } — overdue by ${ Math.round(plan.overdueByMs / 1000) }s`);
      } else {
        const seconds = Math.round(plan.sleepMs / 1000);
        log(`waiting on ${ waitingOn }(${ seconds }s)${ ONCE? " [--once: one pass only]": "" }`);
        if (ONCE) break;
        const woke = await sleepOrWake(waker, plan.sleepMs);
        // Re-evaluate from the top: the table may have changed while asleep, and
        // a claim made against a stale row is exactly what must not happen.
        if (woke !== "timeout") continue;
      }

      /**
       * THE CLAIM, in one transaction, through the route's own code.
       *
       * `limit: 1` is not a limitation of the worker, it is its shape: it waits on
       * one moment, so it claims the records whose moment has arrived. During a
       * restart there may be many, and they are claimed oldest-first on
       * successive passes, which keeps each transaction short and lets a stop
       * request be honoured between them.
       */
      passes += 1;
      const connection = await app.connect();
      let outcome;
      try {
        outcome = await claimAndProcessDue(
          { app, source, limit: 50 },
          settings,
          connection,
        );
      } finally {
        connection.release();
      }

      if (outcome.claimed === 0) {
        // The record was cancelled, or claimed by the route, between the read and
        // the claim. Nothing is wrong; the next pass picks up whatever is really
        // there.
        log(`nothing claimed for ${ waitingOn }(already handled elsewhere)`);
      } else {
        log(
          `claimed ${ outcome.claimed }: processed ${ outcome.processed }, ` +
            `skipped ${ outcome.skipped }, failed ${ outcome.failed } `,
        );
      }

      if (ONCE) break;
    }
  } catch (cause) {
    // A database that is down, a migration missing, a network reset: logged, and
    // the loop's next pass tries again. The worker does not exit on a failed pass,
    // because a worker that exits is a worker nobody is running.
    log(`pass failed: ${ cause instanceof Error ? cause.message : String(cause) } `);
    if (ONCE) {
      await shutdown(app, source, 1);
      return;
    }
    await sleepOrWake(waker, RECHECK_SECONDS * 1000);
  }

  log(`worker stopped after ${ passes } processing pass(es)`);
  await shutdown(app, source, 0);
}

/**
 * Sleeps, wakes early on a notification, and never oversleeps the recheck
 * interval — the interval is the guarantee and the notification is the speed.
 */
async function sleepOrWake(waker, sleepMs) {
  const bounded = Math.max(MIN_SLEEP_MS, Math.min(sleepMs, RECHECK_SECONDS * 1000));
  const waited = waker.wait();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), bounded);
  });
  try {
    const reason = await Promise.race([waited, timeout]);
    if (reason !== "timeout") log(`woke early: ${ reason } `);
    return reason;
  } finally {
    clearTimeout(timer);
  }
}

async function shutdown(app, source, code) {
  try {
    await Promise.all([app.end(), source.end()]);
  } catch {
    /* Closing a pool is best effort at exit. */
  }
  pruneLogs();
  process.exit(code);
}

if (wasInvokedDirectly()) await main();
