import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Standing guard against committing customer data.
 *
 * Real message content may be rendered from the application database at
 * runtime, but it must never reach a repository file, snapshot, or fixture.
 * This scans what git actually tracks, so an untracked scratch file cannot mask
 * a problem and a newly added fixture cannot slip through.
 */

const ROOT = join(__dirname, "..", "..");

const trackedFiles = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/)
  .filter((line) => line.trim() !== "");

const SKIP = /package-lock\.json$|\.ico$|\.svg$|\.png$|\.jpg$/;

const PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "email address", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  // eBay-style order number, excluding the all-zero placeholder used in tests.
  { name: "marketplace order number", pattern: /\b(?!00-00000-00000)\d{2}-\d{5}-\d{5}\b/ },
  { name: "amazon order number", pattern: /\b\d{3}-\d{7}-\d{7}\b/ },
  { name: "connection string", pattern: /postgres(ql)?:\/\// },
  { name: "ip address", pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  { name: "private key", pattern: /BEGIN [A-Z ]*PRIVATE KEY/ },
];

describe("committed content hygiene", () => {
  it("tracks a non-empty file set", () => {
    expect(trackedFiles.length).toBeGreaterThan(0);
  });

  it("contains no email, order number, connection string, IP or key", () => {
    const offenders: string[] = [];
    for (const relative of trackedFiles) {
      if (SKIP.test(relative)) continue;
      const full = join(ROOT, relative);
      let content: string;
      try {
        if (!statSync(full).isFile()) continue;
        content = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      for (const { name, pattern } of PATTERNS) {
        if (pattern.test(content)) offenders.push(`${relative} :: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("commits no exported source-row fixture", () => {
    const offenders = trackedFiles.filter((relative) => {
      if (!relative.endsWith(".json")) return false;
      if (/package(-lock)?\.json$|tsconfig.*\.json$/.test(relative)) return false;
      try {
        const content = readFileSync(join(ROOT, relative), "utf8");
        // A row export carries the source identity columns.
        return /"source_pk"|"receive_date"|"ext_message_id"|"sender_id"|"body_raw"/.test(content);
      } catch {
        return false;
      }
    });
    expect(offenders).toEqual([]);
  });

  it("does not track .env or any real environment file", () => {
    const offenders = trackedFiles.filter(
      (relative) => relative === ".env" || (/(^|\/)\.env\./.test(relative) && !relative.endsWith(".env.example")),
    );
    expect(offenders).toEqual([]);
  });
});
