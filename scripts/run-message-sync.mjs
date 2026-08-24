/**
 * Automatic marketplace message sync -- scheduler wrapper.
 *
 * Runs on a repeating trigger (see register-message-sync.ps1), so a message
 * that lands in a source database appears in the CST inbox without anyone
 * running a command. It generates NO AI draft: syncing and drafting are
 * separate, and a new customer message must never spend a model call on its
 * own.
 *
 * Runs the EXISTING command and nothing else:
 *
 *     npm run sync:messages -- --apply
 *
 * No sync logic lives here. Watermarks, duplicate protection, thread
 * building, direction rules and the varmen_db / varmen_user identity check
 * all belong to that command and are untouched -- this only decides when it
 * runs and where the output goes.
 *
 * PLAIN NODE, NOT POWERSHELL. Task Scheduler's action runs `node.exe` on this
 * file directly (see register-message-sync.ps1) -- registration is a one-time
 * PowerShell command, but nothing PowerShell-based runs on every tick.
 *
 * ALWAYS EXITS 0, deliberately. Windows Task Scheduler records a non-zero
 * exit as a failed task, and a run of failures is one of the things that can
 * leave a task disabled or buried in retries. A sync failure is a normal,
 * expected event -- the source may be unreachable for a minute -- and it must
 * not stop the next run. The real exit code is written to the log, and the
 * log is where failures are read from.
 *
 * SAFE TO FAIL. The sync writes its watermark inside the same transaction as
 * the data it describes, so an interrupted run leaves the cursor no further
 * ahead than the rows that actually landed. The next run resumes from there.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const logDir = join(root, "logs");
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

function stamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

const logFile = join(logDir, `sync-${new Date().toISOString().slice(0, 7)}.log`);
function log(line) {
  appendFileSync(logFile, `${line}\n`, "utf8");
}

log("");
log(`===== ${stamp()}  message sync starting =====`);

try {
  // `shell: true` on Windows launches this through cmd.exe, not PowerShell --
  // required because Node refuses to exec a .cmd shim (npm's own launcher)
  // directly without it. cmd.exe is the plain built-in shell, not the thing
  // being removed here.
  //
  // `windowsHide: true` matters beyond cosmetics: without it, Task Scheduler
  // running this wrapper as node.exe directly (no console of its own) opens a
  // brand-new console for the cmd.exe/npm child, and that console closing
  // mid-run was observed sending a console-control-event that killed the
  // whole run before it finished (exit 0xC000013A, log cut off mid-line).
  // Suppressing the console avoids that entirely, not just the flash.
  const result = spawnSync("npm", ["run", "sync:messages", "--", "--apply"], {
    cwd: root,
    encoding: "utf8",
    shell: true,
    windowsHide: true,
  });

  for (const line of `${result.stdout ?? ""}${result.stderr ?? ""}`.split(/\r?\n/)) {
    if (line !== "") log(line);
  }

  if (result.status === 0) {
    log(`===== ${stamp()}  finished OK =====`);
  } else {
    // Recorded prominently, but this process still exits 0 -- see the note above.
    log(`===== ${stamp()}  FAILED exit=${result.status ?? "unknown"} =====`);
  }
} catch (cause) {
  log(`===== ${stamp()}  FAILED exception =====`);
  log(cause instanceof Error ? cause.message : String(cause));
}

// Keep a year of monthly logs and no more. Unbounded logs in a repo working
// directory are their own small problem.
const logs = readdirSync(logDir)
  .filter((name) => /^sync-\d{4}-\d{2}\.log$/.test(name))
  .map((name) => ({ name, mtime: statSync(join(logDir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
for (const { name } of logs.slice(12)) {
  try {
    unlinkSync(join(logDir, name));
  } catch {
    // Best-effort cleanup; a log file that can't be removed this run is not
    // worth failing the sync over.
  }
}

process.exit(0);
