import { readFileSync, readdirSync, statSync } from "node:fs";
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
      for (const pattern of FORBIDDEN_STATES) {
        if (pattern.test(code)) offenders.push(`${file.replace(ROOT + sep, "")} :: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("exposes no send route handler", () => {
    const sendRoutes = files.filter((file) => /\bsend\b/i.test(file.replace(ROOT, "")));
    expect(sendRoutes).toEqual([]);
  });
});
