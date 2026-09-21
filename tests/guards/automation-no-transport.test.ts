import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { AUTOMATION_ITEM_STATUSES } from "@/lib/domain/automation/automation-types";

/**
 * Standing guard on the post-dispatch automation.
 *
 * `tests/guards/no-send-capability.test.ts` exempts these files from one
 * literal — `'sent'`, the lifecycle word this automation was specified with.
 * THIS FILE IS THE PRICE OF THAT EXEMPTION, and it checks the thing that
 * actually matters: the automation has no way to reach anybody. No marketplace
 * host, no mail host, no credential, no outbound URL at all, and no sender.
 *
 * It is aimed at the specific way a scheduled job goes wrong: it is exactly the
 * shape of code that grows a transport, a credential and a real `sent` flag,
 * one commit at a time.
 */

const ROOT = join(__dirname, "..", "..");

const AUTOMATION_PATHS = [
  join(ROOT, "lib", "domain", "automation"),
  join(ROOT, "lib", "repositories", "automation-repository.ts"),
  join(ROOT, "lib", "repositories", "dispatch-event-repository.ts"),
  join(ROOT, "app", "api", "automations"),
  join(ROOT, "app", "api", "cron", "automation"),
  join(ROOT, "app", "automations"),
  join(ROOT, "components", "automation-admin.tsx"),
  join(ROOT, "components", "automation-status-badge.tsx"),
];

const CODE_EXTENSIONS = new Set([".ts", ".tsx"]);

function walk(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return CODE_EXTENSIONS.has(extname(path)) ? [path] : [];
  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
}

const files = AUTOMATION_PATHS.flatMap(walk);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

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
  /googleapis\.com/i,
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
];

describe("the post-dispatch automation has no transport", () => {
  it("scans the automation's own files", () => {
    expect(files.length).toBeGreaterThan(6);
  });

  it("has exactly the five specified statuses", () => {
    expect([...AUTOMATION_ITEM_STATUSES]).toEqual([
      "scheduled",
      "sent",
      "skipped",
      "failed",
      "cancelled",
    ]);
  });

  it("names no marketplace, mail or model host", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const host of FORBIDDEN_HOSTS) {
        if (host.test(code)) offenders.push(`${file.replace(ROOT + sep, "")} :: ${host}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reads no marketplace, mail or model credential", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const credential of FORBIDDEN_CREDENTIALS) {
        if (credential.test(code)) {
          offenders.push(`${file.replace(ROOT + sep, "")} :: ${credential}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * NO OUTBOUND URL AT ALL, which is stricter than this guard used to be.
   *
   * While the automation drafted with a model it needed one permitted host.
   * It does not draft any more — it renders a saved template — so the honest
   * bound is zero, and anything that appears here later has to justify itself.
   */
  it("contains no outbound URL whatsoever", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const [url] of code.matchAll(/https?:\/\/[^\s"'`]+/g)) {
        offenders.push(`${file.replace(ROOT + sep, "")} :: ${url}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("calls fetch nowhere", () => {
    const offenders: string[] = [];
    for (const file of files) {
      // The browser component legitimately calls this application's own API.
      if (file.endsWith("automation-admin.tsx")) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (/\bfetch\s*\(/.test(code)) offenders.push(file.replace(ROOT + sep, ""));
    }
    expect(offenders).toEqual([]);
  });

  it("declares no sender, queue or retry", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const pattern of [
        /\bMessageSender\b/,
        /\bsenderService\b/i,
        /\bsendQueue\b/i,
        /\bsendRetry\b/i,
        /\bdeliveryAttempt/i,
        /\bdispatchMessage\b/i,
      ]) {
        if (pattern.test(code)) offenders.push(`${file.replace(ROOT + sep, "")} :: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("offers no send control, and says what test mode means", () => {
    const ui = readFileSync(join(ROOT, "components", "automation-admin.tsx"), "utf8");
    for (const pattern of [/>\s*Send\b/, /\bonSend\b/, /Copy Reply/, /Open Marketplace/]) {
      expect(ui).not.toMatch(pattern);
    }
    // Whitespace-flexible: JSX wraps prose across lines, and a denial that
    // stops being detected because the file was reformatted is a guard that
    // quietly stopped guarding.
    const flexible = (phrase: string) => new RegExp(phrase.split(/\s+/).join("\\s+"), "i");
    expect(ui).toMatch(flexible("nothing is transmitted"));
    expect(ui).toMatch(flexible("Not delivered to anyone."));
  });

  /**
   * A TEST-MODE ROW MUST NEVER BE SHOWN AS THE BARE WORD "Sent".
   *
   * The label is conditional on the row's own `test_mode`, so that the day a
   * real transport is connected the interface is already correct — and rows
   * processed before that day keep saying "Processed (test)" for ever. This
   * pins the condition, not just the string, because a constant that happened
   * to read "Processed (test)" would pass while being wrong in the other
   * direction later.
   */
  it("labels a test-mode result as such, and only a real one as sent", async () => {
    const badge = readFileSync(join(ROOT, "components", "automation-status-badge.tsx"), "utf8");
    expect(badge).toMatch(
      /status === "sent" && testMode \? "Processed \(test\)" : LABEL\[status\]/,
    );

    const { statusLabel } = await import("@/components/automation-status-badge");
    expect(statusLabel("sent", true)).toBe("Processed (test)");
    expect(statusLabel("sent", false)).toBe("Sent");
    // Test mode changes nothing about any other state.
    for (const status of ["scheduled", "skipped", "failed", "cancelled"] as const) {
      expect(statusLabel(status, true)).toBe(statusLabel(status, false));
    }
  });

  /**
   * And the only reachable label today is the test-mode one.
   *
   * `statusLabel("sent", false)` returns "Sent", but nothing can produce a row
   * that asks for it: 0011 refuses a non-test `sent` row and the settings API
   * refuses to leave test mode. This asserts that pairing rather than trusting
   * the comment above it.
   */
  it("cannot reach the sent label while no transport exists", () => {
    const migration = readFileSync(
      join(ROOT, "migrations", "0011_post_dispatch_automation.up.sql"),
      "utf8",
    );
    expect(migration).toMatch(/CHECK \(status <> 'sent' OR test_mode\)/);

    const settingsService = readFileSync(
      join(ROOT, "lib", "domain", "automation", "automation-settings-service.ts"),
      "utf8",
    );
    expect(settingsService).toMatch(/patch\.testMode === false/);
  });
});

describe("the post-dispatch automation does no AI drafting", () => {
  it("imports nothing from the CST draft layer", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = readFileSync(file, "utf8");
      for (const pattern of [
        /@\/lib\/ai\//,
        /@\/lib\/knowledge\//,
        /@\/lib\/sync\/draft-writer/,
        /\bgenerateDraft\b/,
        /\bDraftProvider\b/,
        /\bdraft_revisions\b/,
        /\bdraftItem\b/,
      ]) {
        if (pattern.test(code)) offenders.push(`${file.replace(ROOT + sep, "")} :: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has removed the automation draft, client and writer modules", () => {
    for (const removed of [
      join(ROOT, "lib", "ai", "automation-draft-generator.ts"),
      join(ROOT, "lib", "ai", "automation-draft-client.ts"),
      join(ROOT, "lib", "sync", "automation-draft-writer.ts"),
      join(ROOT, "components", "automation-message-view.tsx"),
    ]) {
      expect(existsSync(removed), `${removed} should have been removed`).toBe(false);
    }
  });

  /**
   * THE CST CONVERSATION DRAFT WORKFLOW IS A DIFFERENT FEATURE and must be
   * untouched by this refactor. It is checked here because "we simplified the
   * automation" is exactly the change that takes a shared module with it.
   */
  it("leaves the CST reply draft workflow intact", () => {
    for (const kept of [
      join(ROOT, "lib", "ai", "draft-generator.ts"),
      join(ROOT, "lib", "ai", "draft-service.ts"),
      join(ROOT, "lib", "ai", "provider.ts"),
      join(ROOT, "lib", "sync", "draft-writer.ts"),
      join(ROOT, "lib", "repositories", "draft-repository.ts"),
      join(ROOT, "components", "draft-panel.tsx"),
      join(ROOT, "app", "api", "conversations", "[conversationId]", "draft", "route.ts"),
      join(ROOT, "app", "api", "conversations", "[conversationId]", "workflow", "route.ts"),
      join(ROOT, "migrations", "0004_draft_workflow.up.sql"),
    ]) {
      expect(existsSync(kept), `${kept} must not be removed by this refactor`).toBe(true);
    }
  });
});

describe("the migration adds no transport", () => {
  const raw = readFileSync(
    join(ROOT, "migrations", "0011_post_dispatch_automation.up.sql"),
    "utf8",
  );
  /** Comments stripped, as the sibling guards do: prose may name source tables. */
  const up = raw.replace(/--[^\n]*/g, " ");

  it("creates tables only in cst_app", () => {
    const creates = [...up.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_.]+)/gi)].map((m) => m[1]!);
    expect(creates.length).toBe(3);
    for (const name of creates) expect(name.startsWith("cst_app.")).toBe(true);
  });

  it("references neither the source database nor another project's schema", () => {
    for (const forbidden of [
      /order_management\./i,
      /customer_service\./i,
      /\bcustomers\./i,
      /issue_tracking\./i,
      /poc_listing\./i,
    ]) {
      expect(up).not.toMatch(forbidden);
    }
  });

  it("uses no ALTER or TRUNCATE", () => {
    expect(up).not.toMatch(/\bALTER\b/i);
    expect(up).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("constrains the status column to the five specified states", () => {
    const check = /status IN \(([^)]+)\)/.exec(up)?.[1] ?? "";
    for (const status of AUTOMATION_ITEM_STATUSES) expect(check).toContain(`'${status}'`);
    for (const forbidden of ["sending", "drafting", "pending_review", "reviewed"]) {
      expect(check).not.toContain(`'${forbidden}'`);
    }
  });

  /** The constraint the `'sent'` exemption is paid for with. */
  it("refuses a sent row that is not a test-mode row", () => {
    expect(up).toMatch(/CHECK \(status <> 'sent' OR test_mode\)/);
    expect(up).toMatch(/processed_mode IS NULL OR processed_mode = 'test_mode'/);
  });

  it("makes the shipment natural key unique", () => {
    expect(up).toMatch(
      /CREATE UNIQUE INDEX[^;]*automation_items\s*\(automation_key,\s*sub_source_id,\s*source_shipment_id\)/i,
    );
  });

  it("stores the source dispatch time as a naive timestamp", () => {
    expect(up).toMatch(/dispatched_at\s+timestamp\s+NOT NULL/i);
    expect(up).not.toMatch(/dispatched_at\s+timestamptz/i);
  });

  it("seeds the automation switched off, with no floor and no storefront", () => {
    expect(up).toMatch(/'post_dispatch_message',\s*false,\s*24,\s*'\{\}',\s*NULL/i);
  });

  it("holds no revision or citation table", () => {
    expect(up).not.toMatch(/automation_draft_revisions/i);
    expect(up).not.toMatch(/revision_sources/i);
  });
});
