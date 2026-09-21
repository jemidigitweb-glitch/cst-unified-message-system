import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Standing guard: Phase 1 must contain nothing capable of transmitting a reply
 * to a customer. This fails the build if such code is ever introduced.
 *
 * Comments and string-free prose are stripped first, so a doc-comment explaining
 * *why* sending is out of scope does not trip the guard. Generic framework
 * vocabulary (an HTTP "response", `res.send`) is not in scope; the patterns below
 * target CST customer-reply transmission semantically.
 */

const ROOT = join(__dirname, "..", "..");
const SCANNED_DIRS = ["app", "lib"];
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs"]);

const FORBIDDEN_IDENTIFIERS = [
  /\bsendReply\b/i,
  /\bsendMessage\b/i,
  /\bsendToMarketplace\b/i,
  /\btransmitReply\b/i,
  /\bsendQueue\b/i,
  /\bsendRetry\b/i,
  /\bsendAttempt/i,
  /\boutboundConnector\b/i,
  /\bmarketplaceCredentials\b/i,
  /\bbackgroundSender\b/i,
  /\bsimulateSend\b/i,
  /\bcopyReply\b/i,
  /\bopenMarketplace\b/i,
];

const FORBIDDEN_STATES = [
  /["'`]approved["'`]/,
  /["'`]sending["'`]/,
  /["'`]sent["'`]/,
  /["'`]manual_handoff["'`]/,
];

/**
 * The post-dispatch automation, and only it, may use the literal `'sent'`.
 *
 * WHY THE EXEMPTION EXISTS. That automation was specified with a five-value
 * lifecycle — scheduled, sent, skipped, failed, cancelled — and `sent` is its
 * word for "processed successfully". The alternative was a private synonym that
 * every screen, query and report would have to translate, which trades a real
 * risk of misreading a status for a certain one.
 *
 * WHY IT DOES NOT WEAKEN ANYTHING. The prohibition this guard exists for is on
 * a CAPABILITY, not on a spelling, and the capability is checked harder than
 * before in `automation-no-transport.test.ts`: no marketplace or mail host, no
 * credential, no outbound URL, no sender of any kind. On top of that, 0011's
 * `ck_automation_items_sent_requires_test_mode` means the database itself
 * refuses a `sent` row that is not a test-mode row, so the word cannot become a
 * claim about a customer without that constraint being deliberately removed.
 *
 * EXACT PATHS, NOT A PREFIX. A new file under `lib/domain/automation/` does not
 * inherit this; it has to be added here, deliberately, with a reason.
 */
const SENT_LITERAL_EXEMPT = new Set(
  [
    join("lib", "domain", "automation", "automation-types.ts"),
    join("lib", "domain", "automation", "automation-runner.ts"),
    join("lib", "domain", "automation", "automation-work-item-service.ts"),
    join("lib", "repositories", "automation-repository.ts"),
    join("app", "api", "automations", "route.ts"),
  ].map((relative) => join(ROOT, relative)),
);

function forbiddenStatesFor(file: string): RegExp[] {
  return SENT_LITERAL_EXEMPT.has(file)
    ? FORBIDDEN_STATES.filter((pattern) => pattern.source !== /["'`]sent["'`]/.source)
    : FORBIDDEN_STATES;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (CODE_EXTENSIONS.has(extname(entry))) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

const files = SCANNED_DIRS.flatMap((dir) => {
  const full = join(ROOT, dir);
  return statSync(full).isDirectory() ? walk(full) : [];
});

describe("Phase 2 prohibition", () => {
  it("scans a non-empty set of source files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("declares no reply-transmission function", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const pattern of FORBIDDEN_IDENTIFIERS) {
        if (pattern.test(code)) offenders.push(`${file.replace(ROOT + sep, "")} :: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares no post-review workflow state", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const pattern of forbiddenStatesFor(file)) {
        if (pattern.test(code)) offenders.push(`${file.replace(ROOT + sep, "")} :: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The exemption, pinned.
   *
   * Every exempt path must exist — a stale entry would silently widen the
   * allowance to nothing, or worse, be copied — and every one of them must
   * carry the test-mode guarantee alongside the word it is allowed to use.
   */
  it("exempts only files that also carry the test-mode guarantee", () => {
    for (const file of SENT_LITERAL_EXEMPT) {
      expect(existsSync(file), `${file} is exempt but does not exist`).toBe(true);
    }
    const migration = readFileSync(
      join(ROOT, "migrations", "0011_post_dispatch_automation.up.sql"),
      "utf8",
    );
    expect(migration).toMatch(/CHECK \(status <> 'sent' OR test_mode\)/);
  });

  it("exposes no send route handler", () => {
    const sendRoutes = files.filter((file) => /\bsend\b/i.test(file.replace(ROOT, "")));
    expect(sendRoutes).toEqual([]);
  });
});
