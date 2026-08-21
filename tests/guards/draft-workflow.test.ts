import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { DRAFT_ORIGINS } from "@/lib/domain/draft";
import { RESTRICTED_INSTRUCTIONS, FULL_INSTRUCTIONS } from "@/lib/ai/draft-generator";
import { TERMINAL_STATE, WORKFLOW_STATES, canTransition, nextStates } from "@/lib/domain/workflow";

/**
 * Standing guard on the draft feature.
 *
 * Drafting is the one thing this phase writes, and the boundary it must not
 * cross is transmission. These checks fail the build if a send capability, a
 * post-review state, or a marketplace credential ever appears.
 */

const ROOT = join(__dirname, "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return [".ts", ".tsx", ".sql"].includes(extname(entry)) ? [full] : [];
  });
}

const sources = [
  ...walk(join(ROOT, "lib")),
  ...walk(join(ROOT, "app")),
  ...walk(join(ROOT, "components")),
  ...walk(join(ROOT, "migrations")),
];

describe("the workflow terminates at reviewed", () => {
  it("declares exactly the four Phase 1 states", () => {
    expect(WORKFLOW_STATES).toEqual(["received", "drafting", "pending_review", "reviewed"]);
  });

  it("permits nothing after reviewed", () => {
    expect(TERMINAL_STATE).toBe("reviewed");
    expect(nextStates("reviewed")).toEqual([]);
    for (const state of WORKFLOW_STATES) {
      expect(canTransition("reviewed", state)).toBe(false);
    }
  });

  it("offers no origin that implies a reply left the building", () => {
    expect(DRAFT_ORIGINS).toEqual(["generated", "edited"]);
  });
});

describe("no send capability anywhere in the draft feature", () => {
  it("declares no post-review state, in code or in SQL", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/--[^\n]*/g, " ")
        .replace(/\/\/.*$/gm, " ");
      for (const state of ["'approved'", "'sending'", "'sent'", "'manual_handoff'", '"sent"', '"sending"']) {
        // The knowledge corpus signs OFF a rule document; it does not advance a
        // conversation. `'approved'` there is the sign-off state of a spreadsheet
        // row, and reaches no reply and no customer. The exemption is this one
        // literal in this one file — every other state stays forbidden here, and
        // `'approved'` stays forbidden everywhere else.
        if (state === "'approved'" && file.endsWith("0005_cst_knowledge_base.up.sql")) continue;
        if (code.includes(state)) offenders.push(`${file} :: ${state}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the knowledge sign-off away from the conversation workflow", () => {
    // Guards the exemption above: the knowledge migration may say 'approved',
    // but not about a conversation, a draft, or a workflow state.
    const migration = readFileSync(
      join(ROOT, "migrations", "0005_cst_knowledge_base.up.sql"),
      "utf8",
    ).replace(/--[^\n]*/g, " ");
    expect(migration).not.toMatch(/workflow_state/i);
    expect(migration).not.toMatch(/REFERENCES\s+cst_app\.(conversations|conversation_messages|draft_)/i);
    // The only thing it approves is a knowledge source.
    expect(migration).toMatch(/ck_cst_knowledge_sources_status[\s\S]{0,200}'approved'/);
  });

  it("declares no transmission function or marketplace credential", () => {
    const forbidden = [
      /\bsendReply\b/i,
      /\bsendDraft\b/i,
      /\btransmit\w*\b/i,
      /\bdispatchReply\b/i,
      /\bmarketplaceCredentials\b/i,
      /\boutboundConnector\b/i,
      /\bsendQueue\b/i,
      /\bretrySend\b/i,
    ];
    const offenders: string[] = [];
    for (const file of sources) {
      // Strip all three comment forms, as the sibling check above does. This
      // test is about a transmission FUNCTION or CREDENTIAL existing in code —
      // prose describing what the system deliberately does not do is the
      // opposite of a violation, and a migration comment reading "this phase
      // transmits nothing" was failing while the same sentence in a TypeScript
      // JSDoc block passed, purely because only `/* */` was being removed.
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/--[^\n]*/g, " ")
        .replace(/\/\/.*$/gm, " ");
      for (const pattern of forbidden) {
        if (pattern.test(code)) offenders.push(`${file} :: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("stores no recipient address on a draft", () => {
    const migration = readFileSync(
      join(ROOT, "migrations", "0004_draft_workflow.up.sql"),
      "utf8",
    ).replace(/--[^\n]*/g, " ");
    for (const column of ["recipient", "to_address", "sent_at", "delivery", "queue", "retry"]) {
      expect(migration.toLowerCase()).not.toContain(column);
    }
  });

  /**
   * ONE permitted host, down from two.
   *
   * `sheets.googleapis.com` was allowed for the Google Sheet rule reader. That
   * reader is gone — the rules are read from local workbooks — so the host is
   * no longer allowed either. An allowlist that keeps entries for deleted
   * features stops being an allowlist: it grants reach nothing needs, and the
   * next thing to call that host would pass the guard silently.
   */
  it("reaches only the model over the network", () => {
    const hosts = new Set<string>();
    for (const file of sources) {
      for (const [, host] of readFileSync(file, "utf8").matchAll(/https:\/\/([a-z0-9.-]+)/gi)) {
        hosts.add(host.toLowerCase());
      }
    }
    for (const host of hosts) {
      expect(
        ["generativelanguage.googleapis.com"],
        `unexpected outbound host: ${host}`,
      ).toContain(host);
    }
  });
});

describe("the model is told what it may not do", () => {
  it("forbids inventing an order, SKU, tracking or approval in both modes", () => {
    for (const instructions of [FULL_INSTRUCTIONS, RESTRICTED_INSTRUCTIONS]) {
      const lower = instructions.toLowerCase();
      for (const forbidden of [
        "order number",
        "sku",
        "tracking number",
        "delivery date",
        "refund",
        "replacement",
      ]) {
        expect(lower).toContain(forbidden);
      }
    }
  });

  it("tells the model it never sends", () => {
    for (const instructions of [FULL_INSTRUCTIONS, RESTRICTED_INSTRUCTIONS]) {
      expect(instructions).toMatch(/never send/i);
    }
  });
});
