/**
 * Automatic post-dispatch automation -- scheduler wrapper.
 *
 * Runs on a repeating trigger (see register-post-dispatch-automation.ps1), so a
 * shipment that came due an hour ago is processed without anyone pressing
 * anything. This is the whole reason the "Run now" button was removed: a
 * schedule is what makes an automation automatic, and a button on a page is
 * what makes it manual.
 *
 * IT CALLS THE SAME URL VERCEL'S CRON CALLS, and nothing else:
 *
 *     GET /api/cron/automation      Authorization: Bearer $CRON_SECRET
 *
 * No automation logic lives here. Discovery, the `not_before` floor, the
 * recheck against the source, template rendering, the duplicate key and the
 * varmen_db / varmen_user identity check all belong to that route and are
 * untouched -- this only decides WHEN it runs and where the output goes. One
 * code path, whether the trigger is this machine or the deployment.
 *
 * IT CANNOT SEND ANYTHING, and neither can what it calls. Every processed
 * record is written with `test_mode = true`, and the database refuses a `sent`
 * row that is not one. Scheduling this does not change that in any way.
 *
 * WHY HTTP RATHER THAN IMPORTING THE RUNNER, unlike run-message-sync.mjs which
 * shells into its own CLI. The reviewed entry point for this automation is the
 * route: it performs the two safety assertions before doing any work, and
 * Vercel will call exactly that. Importing the runner directly would be a
 * second entry point with its own copy of those checks to keep in step.
 *
 * THE CAVEAT, stated plainly: this needs the app to be serving on BASE_URL.
 * On this machine that means `npm run dev` (or `npm start`) is running. If it
 * is not, the run logs a connection failure and the next slot tries again --
 * nothing is lost, because a due record stays due.
 *
 * ALWAYS EXITS 0, deliberately, for the same reason the sync wrapper does:
 * Windows Task Scheduler records a non-zero exit as a failed task, and a run
 * of failures can leave a task disabled or buried in retries. A failed tick is
 * a normal event -- the server may be restarting -- and it must not stop the
 * next one. The real outcome is in the log.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const logDir = join(root, "logs");
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const logFile = join(logDir, `post-dispatch-${new Date().toISOString().slice(0, 7)}.log`);
const log = (line) => {
  appendFileSync(logFile, `${line}\n`);
  console.log(line);
};

/**
 * Reads CRON_SECRET from .env.
 *
 * The same file the application reads, parsed here rather than required in the
 * task's environment -- a scheduled task started by wscript.exe inherits very
 * little, and a secret that has to be set in two places is a secret that goes
 * stale in one of them.
 */
function secretFromEnvFile() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^\s*CRON_SECRET\s*=\s*(.*)$/.exec(line);
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

const baseUrl = process.env.CST_BASE_URL?.trim() || "http://localhost:3000";
const secret = process.env.CRON_SECRET?.trim() || secretFromEnvFile();

log(`===== ${stamp()}  post-dispatch run =====`);

if (!secret) {
  // Fails closed and says which variable to set, rather than calling the route
  // unauthenticated and reporting a puzzling 401.
  log("CRON_SECRET is not set in the environment or .env -- refusing to call the route.");
  process.exit(0);
}

try {
  const response = await fetch(`${baseUrl}/api/cron/automation`, {
    headers: { authorization: `Bearer ${secret}` },
    // Generous: the route is bounded but a cold start plus a scan is not fast.
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.text();

  if (!response.ok) {
    log(`FAILED http=${response.status} ${body.slice(0, 300)}`);
  } else {
    // One line per run, holding the counts an operator would otherwise open
    // the admin page for.
    let summary = body;
    try {
      const parsed = JSON.parse(body);
      summary =
        parsed.scan?.ran === false
          ? `not running: ${parsed.scan.reason}`
          : `scheduled ${parsed.scan?.created ?? 0} new (${parsed.scan?.duplicates ?? 0} already queued), ` +
            `processed ${parsed.due?.processed ?? 0}, skipped ${parsed.due?.skipped ?? 0}, failed ${parsed.due?.failed ?? 0}`;
    } catch {
      /* Not JSON; the raw body is logged as-is. */
    }
    log(`OK ${summary}`);
  }
} catch (cause) {
  log(`FAILED ${cause instanceof Error ? cause.message : String(cause)}`);
}

// Keep a year of monthly logs and no more, matching the sync wrapper.
const logs = readdirSync(logDir)
  .filter((name) => /^post-dispatch-\d{4}-\d{2}\.log$/.test(name))
  .map((name) => ({ name, mtime: statSync(join(logDir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
for (const { name } of logs.slice(12)) {
  try {
    unlinkSync(join(logDir, name));
  } catch {
    // Best-effort cleanup; a log that cannot be removed is not worth failing on.
  }
}

process.exit(0);
