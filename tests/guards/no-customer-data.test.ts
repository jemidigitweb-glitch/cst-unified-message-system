import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COMPANY_EMAIL_DOMAINS } from "@/lib/domain/company-domains";

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

/**
 * Domains that cannot belong to a real person.
 *
 * RFC 2606 and RFC 6761 reserve these precisely so documentation and tests can
 * use an address without it ever reaching someone. Exempting them keeps the
 * guard aimed at what it is for — a real customer address in a fixture — rather
 * than at every test that needs to name a sender.
 *
 * The company's own domains are exempt for a different reason: they are ours,
 * they are already an explicit reviewable constant in
 * `lib/domain/company-domains.ts`, and the direction logic cannot be tested
 * without naming them.
 */
const SAFE_EMAIL_DOMAINS = [
  "example.com",
  "example.net",
  "example.org",
  "example.invalid",
  "example.test",
  "invalid",
  "test",
  "localhost",
  ...COMPANY_EMAIL_DOMAINS,
];

/**
 * Named test fixtures on REAL domains.
 *
 * A short, exact-match list, and it has to be exact rather than by domain.
 * These two tests exercise logic that reads the sender's domain — the Shopify
 * inbox filter classifies a consumer mailbox differently from a company one,
 * and swapping in a reserved domain changes the behaviour under test (it broke
 * eleven assertions when tried). So the fixtures legitimately need a real
 * domain, and the guard exempts the two exact strings rather than the domains
 * behind them: `gmail.com` stays guarded, `buyer@gmail.com` does not.
 *
 * A genuine customer address will not be one of these literals.
 */
const FIXTURE_ADDRESSES = [
  // Consumer mailboxes — the Shopify filter classifies these differently from
  // a company one, so the test cannot use a reserved domain.
  "buyer@gmail.com",
  "x@gmail.com",
  // Marketplace relay and platform senders — direction and filtering logic
  // reads these domains specifically.
  "a1b2c3@marketplace.amazon.co.uk",
  "x@marketplace.amazon.co.uk",
  "name@amazon.com",
  "no-reply@amazon.com",
  "r@amazon.com",
  "relay@amazon.com",
  "someone@amazon.com",
  // Courier and mail-server senders used to test inbox filtering.
  "noreply@evri.com",
  "mailer@kundenserver.de",
];

function isSafeAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (FIXTURE_ADDRESSES.includes(lower)) return true;
  const domain = lower.slice(lower.lastIndexOf("@") + 1);
  return SAFE_EMAIL_DOMAINS.some((safe) => domain === safe || domain.endsWith(`.${safe}`));
}

/**
 * Order numbers that are visibly not real.
 *
 * Both are sequential or all-zero placeholders used in NEGATIVE assertions —
 * "a draft must not contain a number of this shape". The test needs a literal
 * of the right shape to assert against, and a documented list of two is far
 * safer than loosening the pattern that catches a genuine one.
 */
const PLACEHOLDER_ORDER_NUMBERS = ["00-00000-00000", "12-34567-89012"];

const PATTERNS: { name: string; pattern: RegExp; safe?: (match: string) => boolean }[] = [
  {
    name: "email address",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    safe: isSafeAddress,
  },
  {
    name: "marketplace order number",
    pattern: /\b\d{2}-\d{5}-\d{5}\b/g,
    safe: (match) => PLACEHOLDER_ORDER_NUMBERS.includes(match),
  },
  { name: "amazon order number", pattern: /\b\d{3}-\d{7}-\d{7}\b/g },
  { name: "connection string", pattern: /postgres(ql)?:\/\//g },
  { name: "ip address", pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  { name: "private key", pattern: /BEGIN [A-Z ]*PRIVATE KEY/g },
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
      // Every match is examined, not just the first: a file can hold one
      // documented placeholder and one genuine leak, and a boolean `test()`
      // cannot tell those apart.
      for (const { name, pattern, safe } of PATTERNS) {
        for (const [match] of content.matchAll(pattern)) {
          if (safe?.(match)) continue;
          offenders.push(`${relative} :: ${name} :: ${match}`);
          break;
        }
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
