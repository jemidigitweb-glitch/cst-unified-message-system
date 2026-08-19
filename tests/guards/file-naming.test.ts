import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Standing guard on permanent file and directory names.
 *
 * Names must describe domain, capability, responsibility, or technical purpose —
 * not the sequence in which work happened. A file called `day2_openai.ts` is
 * meaningless six months later; `knowledge_sources.ts` is not.
 *
 * Migration sequence numbers (0001, 0002, ...) are explicitly fine: they order
 * migrations, they do not describe a project timeline.
 *
 * Only directories this project authors are scanned. Third-party names in
 * node_modules and package-lock.json are outside our control.
 */

const ROOT = join(__dirname, "..", "..");
const OWNED_DIRS = ["app", "lib", "tests", "migrations"];

/** Timeline/sequencing terminology that must not appear in a permanent name. */
const FORBIDDEN_NAME_PATTERNS: readonly RegExp[] = [
  /\bday[\s_-]?\d/i,
  /\bphase[\s_-]?\d/i,
  /\btask[\s_-]?\d/i,
  /\bstep[\s_-]?\d/i,
  /\bsprint[\s_-]?\d/i,
  /\btoday\b/i,
  /(^|[\s_-])new([\s_-]|\.|$)/i,
  /(^|[\s_-])final([\s_-]|\.|$)/i,
  /(^|[\s_-])latest([\s_-]|\.|$)/i,
  /(^|[\s_-])old([\s_-]|\.|$)/i,
  /(^|[\s_-])temp([\s_-]|\.|$)/i,
  /(^|[\s_-])tmp([\s_-]|\.|$)/i,
  /(^|[\s_-])copy([\s_-]|\.|$)/i,
];

type Entry = { relative: string; name: string };

function walk(dir: string): Entry[] {
  const out: Entry[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    out.push({ relative: full.replace(ROOT + sep, ""), name });
    if (statSync(full).isDirectory()) out.push(...walk(full));
  }
  return out;
}

const entries = OWNED_DIRS.flatMap((dir) => {
  const full = join(ROOT, dir);
  return statSync(full).isDirectory() ? walk(full) : [];
});

describe("permanent file and directory naming", () => {
  it("scans a non-empty set of project-owned paths", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("names nothing after a project timeline, task number, or freshness", () => {
    const offenders: string[] = [];
    for (const entry of entries) {
      for (const pattern of FORBIDDEN_NAME_PATTERNS) {
        if (pattern.test(entry.name)) offenders.push(`${entry.relative} :: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still allows numeric migration sequence prefixes", () => {
    const migrations = entries.filter((e) => e.name.endsWith(".sql")).map((e) => e.name);
    expect(migrations.length).toBeGreaterThan(0);
    for (const name of migrations) {
      expect(name).toMatch(/^\d{4}_[a-z0-9_]+\.(up|down)\.sql$/);
    }
  });
});
