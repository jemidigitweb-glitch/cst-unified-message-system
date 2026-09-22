import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The always-running automation worker.
 *
 * TWO KINDS OF CHECK, deliberately.
 *
 *   1. The DECISIONS, tested directly. `waitPlan` and `planFromRow` decide when
 *      the worker wakes and which record it is waiting on, and they are exported
 *      pure functions for exactly this reason — a fake clock is a better test of
 *      "does an earlier job take over" than a real one, and it is instant.
 *
 *   2. The GUARANTEES, pinned as text. The worker is the newest thing in this
 *      codebase that runs unattended, which is the shape of code that grows a
 *      transport or a source write one commit at a time. The rest of this file is
 *      the price of that: no write to the source, no outbound request, and no
 *      second copy of the processing logic.
 *
 * The worker is a `.mjs` script, so the pure functions are imported through the
 * same alias hook everything else uses rather than being duplicated here.
 */

const ROOT = join(__dirname, "..", "..");
const WORKER_PATH = join(ROOT, "scripts", "run-automation-worker.mjs");
const WORKER = readFileSync(WORKER_PATH, "utf8");
const HOOKS = readFileSync(join(ROOT, "scripts", "alias-hooks.mjs"), "utf8");
const REGISTER = readFileSync(join(ROOT, "scripts", "register-automation-worker.ps1"), "utf8");
const MIGRATION = readFileSync(
  join(ROOT, "migrations", "0015_automation_worker_wake.up.sql"),
  "utf8",
);

const worker = await import(WORKER_PATH);

/**
 * IMPORTING THE WORKER DOES NOT START IT.
 *
 * Asserted here, first, because it is the difference between a test run and a
 * resident process: the stub pool below answers `nextScheduledItem` in the shape
 * the ROUTE's repository returns — `scheduled_at` is a literal column name there
 * — and a worker that acted on that would read it as "due now" and spin.
 */
const WORKER_LOG = join(ROOT, "logs", `automation-worker-${new Date().toISOString().slice(0, 7)}.log`);
const logLines = existsSync(WORKER_LOG)
  ? readFileSync(WORKER_LOG, "utf8").split(/\r?\n/).filter((line) => line !== "").length
  : 0;

/** Comments removed, so prose may name a host without failing a scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

const CODE = stripComments(WORKER);

const T0 = Date.parse("2026-09-21T12:00:00.000Z");

describe("importing the worker does not start it", () => {
  it("exports its decisions without running the loop", () => {
    expect(typeof worker.waitPlan).toBe("function");
    expect(typeof worker.planFromRow).toBe("function");
    // A module that started the loop would have already exited or be blocking.
    expect(worker.DAY_MS).toBe(86_400_000);
  });

  it("starts only when Node was told to run this file", () => {
    // The guard, and the reason it is a guard rather than a flag.
    expect(WORKER).toMatch(/if \(wasInvokedDirectly\(\)\) await main\(\);/);
    expect(WORKER).toMatch(/function wasInvokedDirectly\(\)/);
    expect(WORKER).toMatch(/const entry = process\.argv\[1\];/);
  });

  /**
   * AND THE LOG IS EVIDENCE, not decoration. A worker that started from this
   * import would have written a line to the real log during the import above;
   * counting lines before and after is what makes "it does not start" a fact
   * rather than a reading of the source.
   */
  it("writes nothing to the worker's log on import", () => {
    const after = existsSync(WORKER_LOG)
      ? readFileSync(WORKER_LOG, "utf8").split(/\r?\n/).filter((line) => line !== "").length
      : 0;
    expect(after).toBe(logLines);
  });
});

describe("the worker waits until the moment a record is due", () => {
  it("sleeps until the scheduled time, and no longer than the stage", () => {
    const plan = worker.waitPlan("2026-09-21T12:00:30.000Z", T0);
    expect(plan.sleepMs).toBe(30_000);
    expect(plan.overdueByMs).toBe(0);
  });

  /**
   * A record twenty minutes out is waited for in stages rather than in one
   * timer, so a laptop that suspends and resumes does not wake up to a timer
   * that was set for a wall-clock instant that has already gone by unnoticed.
   */
  it("stages a long wait rather than holding one timer open", () => {
    const plan = worker.waitPlan("2026-09-21T13:00:00.000Z", T0);
    expect(plan.sleepMs).toBe(60_000);
    expect(plan.wakeAt).toBe(Date.parse("2026-09-21T13:00:00.000Z"));
  });

  it("claims an already-due record instead of sleeping through it", () => {
    const plan = worker.waitPlan("2026-09-21T11:00:00.000Z", T0);
    expect(plan.sleepMs).toBe(1_000);
    expect(plan.overdueByMs).toBe(3_600_000);
  });

  /**
   * NOTHING WAITING IS NOT ZERO. A `null` plan means "there is no moment", which
   * the loop answers with its recheck interval; a zero would spin the loop hot
   * against an empty table.
   */
  it("reports nothing to wait for when no record is scheduled", () => {
    expect(worker.waitPlan(null, T0).sleepMs).toBeNull();
    expect(worker.waitPlan(undefined, T0).sleepMs).toBeNull();
  });

  it("treats an unreadable timestamp as nothing to wait for, not as due now", () => {
    expect(worker.waitPlan("not-a-date", T0).sleepMs).toBeNull();
  });
});

describe("an earlier new record becomes the new target", () => {
  /**
   * THE EARLIER-JOB RULE. The worker does not track "the record I started
   * waiting on"; it re-asks which record is soonest, so a record inserted with an
   * earlier `scheduled_at` is the target on the very next evaluation — and the
   * INSERT is what triggers that evaluation.
   */
  it("picks the soonest record out of the table, not the one it was waiting on", () => {
    const waitingOn = { id: "7", scheduled_at: "2026-09-21T18:00:00.000Z" };
    const earlier = { id: "8", scheduled_at: "2026-09-21T12:05:00.000Z" };

    // Six hours out: staged at a minute, so the target and the wake-up are two
    // different numbers. Conflating them is what the next case pins down.
    const originally = worker.planFromRow(waitingOn, T0);
    expect(originally.wakeAt).toBe(Date.parse("2026-09-21T18:00:00.000Z"));
    expect(originally.sleepMs).toBe(60_000);

    const replanned = worker.planFromRow(earlier, T0);
    expect(replanned.row.id).toBe("8");
    expect(replanned.wakeAt).toBe(Date.parse("2026-09-21T12:05:00.000Z"));
    // Five minutes out is INSIDE the one-minute stage, so the worker still sleeps
    // a minute and re-reads -- that staging is the mechanism that lets it notice
    // an even earlier record arriving. What moved is the TARGET: the wait is now
    // bounded by five minutes rather than six hours.
    expect(replanned.sleepMs).toBe(60_000);
    expect(replanned.wakeAt - T0).toBe(5 * 60_000);
    expect(replanned.wakeAt - T0).toBeLessThan(originally.wakeAt - T0);
  });

  it("re-stages a target that is further away than the stage", () => {
    // The earlier record is the target even when its moment is hours out: what
    // changes is where the worker waits, not how long one timer is held.
    const far = worker.planFromRow({ id: "9", scheduled_at: "2026-09-21T20:00:00.000Z" }, T0);
    expect(far.row.id).toBe("9");
    expect(far.sleepMs).toBe(60_000);
    expect(far.wakeAt).toBe(Date.parse("2026-09-21T20:00:00.000Z"));
  });

  it("waits on nothing when the table has nothing scheduled", () => {
    expect(worker.planFromRow(undefined, T0)).toEqual({ row: null, sleepMs: null });
  });

  /**
   * The wake-up itself: 0012's insert trigger is what makes the recalculation
   * immediate rather than up to a recheck interval late, so the trigger and the
   * channel have to agree with the worker.
   */
  it("listens on the exact channel 0012 notifies on", () => {
    expect(WORKER).toMatch(/const WAKE_CHANNEL = "cst_automation_wake"/);
    expect(MIGRATION).toMatch(/pg_notify\('cst_automation_wake', payload\)/);
    expect(WORKER).toMatch(/LISTEN \$\{WAKE_CHANNEL\}/);
  });
});

describe("the worker cannot transmit anything", () => {
  const FORBIDDEN_HOSTS = [
    /ebay\.com/i,
    /sellingpartnerapi/i,
    /amazonaws\.com/i,
    /myshopify\.com/i,
    /sendgrid/i,
    /mailgun/i,
    /postmark/i,
    /smtp\./i,
    /nodemailer/i,
    /openai\.com/i,
    /generativelanguage/i,
  ];

  const FORBIDDEN_CREDENTIALS = [
    /EBAY_[A-Z_]*TOKEN/,
    /EBAY_[A-Z_]*SECRET/,
    /AMAZON_[A-Z_]*(TOKEN|SECRET)/,
    /SHOPIFY_[A-Z_]*(TOKEN|SECRET)/,
    /SMTP_[A-Z_]+/,
    /MAIL_[A-Z_]*(PASSWORD|KEY)/,
    /OPENAI_API_KEY/,
    /GEMINI_API_KEY/,
    /ROYAL_MAIL_[A-Z_]+/,
  ];

  it("names no marketplace, mail or model host", () => {
    for (const host of FORBIDDEN_HOSTS) expect(CODE).not.toMatch(host);
  });

  it("reads no marketplace, mail or model credential", () => {
    for (const credential of FORBIDDEN_CREDENTIALS) expect(CODE).not.toMatch(credential);
  });

  /** Stricter than the route, which is allowed to answer its own caller. */
  it("makes no outbound request at all, not even to this application", () => {
    expect(CODE).not.toMatch(/\bfetch\s*\(/);
    expect(CODE).not.toMatch(/https?:\/\//);
    expect(CODE).not.toMatch(/\brequire\(["']http/);
    expect(CODE).not.toMatch(/from ["']node:(http|https|net|dgram|tls)["']/);
  });

  it("declares no sender, queue or retry", () => {
    for (const pattern of [
      /\bMessageSender\b/,
      /\bsenderService\b/i,
      /\bsendQueue\b/i,
      /\bsendRetry\b/i,
      /\bdeliveryAttempt/i,
      /\bdispatchMessage\b/i,
    ]) {
      expect(CODE).not.toMatch(pattern);
    }
  });

  /**
   * THE WORKER WRITES NOTHING ITSELF. It calls the reviewed runner and reads
   * rows; there is no UPDATE, INSERT or DELETE in the file, so it cannot move a
   * record or a setting even by mistake. Test mode therefore cannot be turned
   * off from here — 0011's CHECK refuses a non-test `sent` row at the database.
   */
  it("issues no write of its own", () => {
    for (const pattern of [
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+cst_app\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bALTER\s+TABLE\b/i,
      /\bTRUNCATE\b/i,
    ]) {
      expect(CODE).not.toMatch(pattern);
    }
  });

  it("processes through the route's own claim, not a second copy of it", () => {
    expect(WORKER).toMatch(/claimAndProcessDue/);
    // The recheck, the template rules and the duplicate key belong to the
    // runner. If any of these appeared here, the two would drift.
    for (const duplicated of [
      /dispatchEventForShipment/,
      /eligibilityForPostDispatch/,
      /markItemProcessed/,
      /selectDueItems/,
      /renderTemplate/,
    ]) {
      expect(CODE).not.toMatch(duplicated);
    }
  });
});

describe("the worker never writes to the source database", () => {
  it("takes the read-only source pool, which the server enforces", () => {
    const pools = readFileSync(join(ROOT, "lib", "db", "app-connection.ts"), "utf8");
    expect(pools).toMatch(/default_transaction_read_only=on/);
    expect(pools).toMatch(/createSourcePool/);
    expect(WORKER).toMatch(/createSourcePool\(\)/);
  });

  it("runs the same two safety checks the cron route runs, before any work", () => {
    expect(WORKER).toMatch(/assertApplicationDatabase\(app\)/);
    expect(WORKER).toMatch(/assertSourceReadOnly\(source\)/);

    const guard = readFileSync(join(ROOT, "lib", "sync", "guard.ts"), "utf8");
    // One definition of "safe to write", imported by both entry points.
    expect(guard).toMatch(/export async function assertApplicationDatabase/);
    expect(guard).toMatch(/export async function assertSourceReadOnly/);
  });

  it("refuses to start rather than starting unsafely", () => {
    expect(WORKER).toMatch(/REFUSING TO/);
    expect(WORKER).toMatch(/shutdown\(app, source, 1\)/);
  });
});

describe("the worker idles instead of exiting when there is nothing to do", () => {
  /**
   * A worker that exited when the automation was switched off would be a worker
   * an operator has to remember to restart — and the switch is exactly what 0012
   * notifies on. "Off" must mean "wait", never "stop".
   */
  it("treats a switched-off automation as a reason to wait", () => {
    expect(WORKER).toMatch(/scanRefusal\(settings\)/);
    expect(WORKER).toMatch(/const reason = settings === undefined \? /);
    expect(WORKER).toMatch(/continue;/);
    expect(CODE).not.toMatch(/process\.exit\(0\)[\s\S]{0,200}refusal/);
  });

  it("keeps a running worker alive across a failed pass", () => {
    expect(WORKER).toMatch(/pass failed/);
    // The recheck interval is the guarantee; LISTEN is the speed.
    expect(WORKER).toMatch(/const RECHECK_SECONDS = /);
    expect(WORKER).toMatch(/falling back to the \$\{RECHECK_SECONDS\}s recheck/);
  });
});

describe("the worker runs under plain Node", () => {
  /**
   * THE `server-only` REDIRECT IS LOAD-BEARING. Every `lib/` module the worker
   * imports carries the marker, and its default export THROWS — only the
   * `react-server` condition resolves it to the empty file, and Node does not
   * set that condition. Without this the worker does not start at all.
   */
  it("resolves server-only to the empty module the bundler uses", () => {
    expect(HOOKS).toMatch(/specifier === "server-only"/);
    expect(HOOKS).toMatch(/server-only", "empty\.js"/);
  });

  it("registers the alias hook in package.json, before the module graph loads", () => {
    const pkg = readFileSync(join(ROOT, "package.json"), "utf8");
    expect(pkg).toMatch(/worker:automation": "node --import \.\/scripts\/register-hooks\.mjs/);
    expect(pkg).toMatch(/worker:automation:once/);
    expect(pkg).toMatch(/worker:schedule/);
  });

  /**
   * THE MODULE SPECIFIERS ARE `@/…`, NOT `../…`.
   *
   * A relative path needs the `.ts` extension to resolve under Node, and that
   * extension is a file that does not exist after `next build` — which is exactly
   * the packaging trap the alias hook exists to route around. Naming it here
   * stops a future edit from "simplifying" these back into broken paths.
   */
  it("imports the reviewed modules through the alias, not by relative path", () => {
    for (const imported of [
      "@/lib/db/app-connection",
      "@/lib/sync/guard",
      "@/lib/repositories/automation-repository",
      "@/lib/domain/automation/automation-runner",
      "@/lib/domain/automation/automation-settings-service",
      "@/lib/domain/automation/automation-types",
    ]) {
      expect(WORKER, `worker should import ${imported}`).toContain(`"${imported}"`);
    }
    expect(WORKER).not.toMatch(/import\("\.\.\/lib\//);
    // ...and the worker is started by the hook, so the application is untouched.
    expect(MIGRATION).toMatch(/cst_automation_wake/);
  });
});

describe("Windows starts the worker once, not on a timer", () => {
  /**
   * THE REQUIREMENT, PINNED. A repeating trigger is what the automation must NOT
   * have any more: the whole point of a resident worker is that it runs once and
   * then waits on the database, rather than being woken every fifteen minutes to
   * see whether anything is due.
   */
  it("registers an at-logon trigger with no repetition", () => {
    // The header explains the removal by name, which would fail a naive scan for
    // the flag itself -- so the check is on what the task is actually built with.
    expect(REGISTER).toMatch(/New-ScheduledTaskTrigger -AtLogOn/);
    // Anchored on the parameter form, because the header names both flags while
    // explaining what it removed -- a bare flag scan would fail on its own prose.
    expect(REGISTER).not.toMatch(/New-ScheduledTaskTrigger[\s\S]{0,120}-RepetitionInterval/);
    expect(REGISTER).not.toMatch(/-RepetitionDuration\s+\(/);
    expect(REGISTER).not.toMatch(/New-ScheduledTaskTrigger -Once/);
  });

  it("does not stop the worker when the machine goes on battery", () => {
    expect(REGISTER).toMatch(/-DontStopIfGoingOnBatteries/);
    expect(REGISTER).toMatch(/-AllowStartIfOnBatteries/);
  });

  it("takes the task's own interval flag away", () => {
    // No `param([int]$IntervalMinutes)` -- but the header says "15-minute" while
    // explaining what it replaced, so the scan is anchored on the param block.
    expect(REGISTER).not.toMatch(/\$IntervalMinutes/);
    const paramBlock = REGISTER.slice(REGISTER.indexOf("param("), REGISTER.indexOf("$ErrorActionPreference"));
    expect(paramBlock).not.toMatch(/Interval/);
    // ...and points the removed timer out rather than leaving a reader to guess.
    expect(REGISTER).toMatch(/register-post-dispatch-automation\.ps1 -Remove/);
  });

  it("runs hidden, in the project root, as the current user", () => {
    expect(REGISTER).toMatch(/wscript\.exe/);
    expect(REGISTER).toMatch(/run-automation-worker-hidden\.vbs/);
    expect(REGISTER).toMatch(/-WorkingDirectory \$root/);
  });

  it("supports removal, and says so in the header", () => {
    expect(REGISTER).toMatch(/\$Remove/);
    expect(REGISTER).toMatch(/Unregister-ScheduledTask/);
  });
});
