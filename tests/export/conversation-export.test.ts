import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ConversationDetail, ConversationMessageView, InboxItem } from "@/lib/domain/inbox";
import {
  CONVERSATION_EXPORT_LABEL,
  buildConversationTextExport,
} from "@/lib/export/conversation-export";
import { NO_RULE_HEADING, NO_RULE_REASON } from "@/components/no-rule-flag";

/**
 * The one export this application has, and everything it must not become.
 *
 * It exists for a single case: no CST rule matched the draft, so the reviewer
 * needs the conversation itself. It writes one conversation, complete, oldest
 * message first. It cannot write a rule, and it cannot write a second
 * conversation, because it is never given either.
 *
 * Synthetic data throughout. No real customer content appears in any fixture.
 */

const EXPORTED_AT = "2026-08-24T09:00:00.000Z";
const ROOT = join(__dirname, "..", "..");

function conversation(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "1627",
    marketplace: "ebay",
    subSourceId: 7,
    counterpartyRef: "counterparty-a",
    listingItemRef: "listing-1",
    workflowState: "pending_review",
    needsContext: false,
    inboxPlacement: "reply_inbox",
    firstSourceTimestamp: "2026-08-01 09:00:00",
    lastSourceTimestamp: "2026-08-03 17:30:00",
    messageCount: 3,
    inboundCount: 2,
    lastDirection: "outbound",
    category: null,
    // Additive field on `InboxItem`. Null here on purpose: the export writes a
    // conversation, and priority is not part of it — see the assertion below
    // that the exported text names no priority at all.
    priority: null,
    ...overrides,
  };
}

function message(overrides: Partial<ConversationMessageView> = {}): ConversationMessageView {
  return {
    id: "10",
    direction: "inbound",
    sourceTimestamp: "2026-08-01 09:00:00",
    bodyText: "synthetic customer body",
    bodyDecodeStatus: "decoded",
    attachments: [],
    ...overrides,
  };
}

function detail(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    conversation: conversation(),
    messages: [
      message({ id: "10", sourceTimestamp: "2026-08-01 09:00:00", bodyText: "first message" }),
      message({
        id: "11",
        direction: "outbound",
        sourceTimestamp: "2026-08-02 11:15:00",
        bodyText: "second message",
      }),
      message({ id: "12", sourceTimestamp: "2026-08-03 17:30:00", bodyText: "third message" }),
    ],
    ...overrides,
  };
}

const file = buildConversationTextExport({ detail: detail(), exportedAt: EXPORTED_AT });

/* ------------------------------------------------------------------ *
 * There is no rule export, and no way to add one by accident.
 * ------------------------------------------------------------------ */

describe("no rule export exists", () => {
  const source = readFileSync(join(ROOT, "lib", "export", "conversation-export.ts"), "utf8");
  const panel = readFileSync(join(ROOT, "components", "draft-evidence-panel.tsx"), "utf8");
  const button = readFileSync(join(ROOT, "components", "conversation-export-button.tsx"), "utf8");
  const workspace = readFileSync(join(ROOT, "components", "workspace.tsx"), "utf8");

  /**
   * Structural, not a count assertion.
   *
   * A test that checks "no rules came out" passes just as happily on a builder
   * that accepts rules and happens to be handed none. This builder takes a
   * conversation and a timestamp; there is no argument through which a rule,
   * or the corpus, could enter the file.
   */
  it("accepts no rules, and loads no corpus", () => {
    expect(source).not.toMatch(/loadRulesForConversation|loadCstRules|readFileSync|readdirSync/);
    expect(source).not.toMatch(/Knowledge-source/i);
    expect(source).not.toMatch(/\brules\s*:/);
    expect(source).not.toMatch(/RuleEvidence/);
  });

  it("offers exactly one export, and it is the conversation", () => {
    const exported = [...source.matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1]);
    expect(exported.filter((name) => /build/i.test(name!))).toEqual([
      "buildConversationTextExport",
    ]);
    expect(CONVERSATION_EXPORT_LABEL).toBe("Export complete conversation");
    expect(CONVERSATION_EXPORT_LABEL).not.toMatch(/rule/i);
  });

  it("wires no rules export into the sidebar", () => {
    for (const file of [panel, button, workspace]) {
      expect(file).not.toMatch(/Export relevant CST rules/);
      expect(file).not.toMatch(/cst-rules-conversation/);
      expect(file).not.toMatch(/matchedRules/);
    }
    // One download call site in the whole interface, so there is no second
    // path to audit.
    expect(button.match(/link\.download/g)).toHaveLength(1);
    expect(panel).not.toContain("link.download");
  });

  /**
   * The export belongs to ONE case: no applicable rule was found.
   *
   * That is what the file is for — the team reads it to write the rule that was
   * missing — so it is offered inside the no-rule branch and nowhere else.
   */
  it("is offered only where no rule matched", () => {
    expect(button).toContain("CONVERSATION_EXPORT_LABEL");

    const start = panel.indexOf("cited.length === 0 ?");
    const otherwise = panel.indexOf(") : (", start);
    expect(start).toBeGreaterThan(-1);
    expect(panel.slice(start, otherwise)).toContain("<ConversationExportButton");
    expect(panel.slice(otherwise)).not.toContain("<ConversationExportButton");
    // Not mounted anywhere else in the interface either.
    expect(workspace).not.toContain("ConversationExportButton");
  });

  it("creates or edits no CST rule", () => {
    for (const file of [button, source]) {
      expect(file).not.toMatch(/writeRule|createRule|updateRule|saveRule/i);
      expect(file).not.toMatch(/\.xlsx/);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The conversation export itself.
 * ------------------------------------------------------------------ */

describe("the conversation export", () => {
  it("downloads as a text file named for the conversation", () => {
    expect(file.filename).toBe("cst-conversation-1627.txt");
    expect(file.mimeType).toBe("text/plain;charset=utf-8");
  });

  it("is not JSON, and carries no rule material", () => {
    expect(() => JSON.parse(file.content)).toThrow();
    expect(file.content).not.toMatch(/matchedRules|ruleText|sourceSheet/);
    expect(file.content).not.toMatch(/\b[A-Z]{4,8}-[A-Z0-9]{2,6}-\d+\b/);
  });

  /**
   * The export is the conversation, not our reading of it. It has never written
   * the category and it must not start writing the priority: both are derived
   * on read, neither is a fact about the thread, and an exported file that
   * carried one would be shipping a machine opinion as evidence.
   */
  it("writes neither our category nor our priority", () => {
    const ranked = buildConversationTextExport({
      detail: { conversation: conversation({ category: "Delivery queries", priority: "HIGH" }), messages: [] },
      exportedAt: EXPORTED_AT,
    });
    for (const derived of ["Delivery queries", "HIGH", "MEDIUM", "LOW", "Priority", "priority"]) {
      expect(ranked.content, derived).not.toContain(derived);
    }
  });

  it("states the marketplace, account, customer and references", () => {
    expect(file.content).toContain("Conversation:       1627");
    expect(file.content).toContain("Marketplace:        eBay");
    expect(file.content).toContain("Account:            7");
    expect(file.content).toContain("Customer:           counterparty-a");
    expect(file.content).toContain("Item reference:     listing-1");
  });

  it("reports an order reference where the marketplace's reference is one", () => {
    const bandq = buildConversationTextExport({
      detail: detail({
        conversation: conversation({
          marketplace: "bandq",
          counterpartyRef: "BQ-ORDER-A",
          listingItemRef: null,
        }),
      }),
      exportedAt: EXPORTED_AT,
    });
    expect(bandq.content).toContain("Order reference:    BQ-ORDER-A");
  });

  it("says 'not recorded' rather than leaving a field blank", () => {
    const temu = buildConversationTextExport({
      detail: detail({
        conversation: conversation({
          marketplace: "temu",
          counterpartyRef: "unresolved:8891",
          listingItemRef: null,
          subSourceId: null,
        }),
      }),
      exportedAt: EXPORTED_AT,
    });
    expect(temu.content).toContain("Customer:           not recorded");
    expect(temu.content).toContain("Account:            not recorded");
    expect(temu.content).toContain("Item reference:     not recorded");
    // The internal ungrouped sentinel is never written into a file a person reads.
    expect(temu.content).not.toContain("unresolved:8891");
  });

  it("contains every message, complete", () => {
    expect(file.content).toContain("MESSAGES (3) - oldest first");
    expect(file.content).toContain("first message");
    expect(file.content).toContain("second message");
    expect(file.content).toContain("third message");
  });

  it("orders messages oldest to newest, whatever order they arrive in", () => {
    const shuffled = buildConversationTextExport({
      detail: detail({
        messages: [
          message({ id: "12", sourceTimestamp: "2026-08-03 17:30:00", bodyText: "third message" }),
          message({ id: "10", sourceTimestamp: "2026-08-01 09:00:00", bodyText: "first message" }),
          message({ id: "11", sourceTimestamp: "2026-08-02 11:15:00", bodyText: "second message" }),
        ],
      }),
      exportedAt: EXPORTED_AT,
    });
    const positions = ["first message", "second message", "third message"].map((text) =>
      shuffled.content.indexOf(text),
    );
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("ties equal timestamps by message id, so ordering is stable", () => {
    const tied = buildConversationTextExport({
      detail: detail({
        messages: [
          message({ id: "21", sourceTimestamp: "2026-08-01 09:00:00", bodyText: "later id" }),
          message({ id: "20", sourceTimestamp: "2026-08-01 09:00:00", bodyText: "earlier id" }),
        ],
      }),
      exportedAt: EXPORTED_AT,
    });
    expect(tied.content.indexOf("earlier id")).toBeLessThan(tied.content.indexOf("later id"));
  });

  it("labels the sender and prints the source time unconverted", () => {
    expect(file.content).toContain("[1] CUSTOMER  2026-08-01 09:00:00");
    expect(file.content).toContain("[2] CST REPLY  2026-08-02 11:15:00");
    expect(file.content).toContain("unconverted");
  });

  it("lists an attachment's filename and URL", () => {
    const withFile = buildConversationTextExport({
      detail: detail({
        messages: [
          message({
            attachments: [
              {
                url: "https://files.example.com/image001.jpg",
                kind: "image",
                label: "image001.jpg",
              },
              { url: "https://files.example.com/note.pdf", kind: "document", label: "note.pdf" },
            ],
          }),
        ],
      }),
      exportedAt: EXPORTED_AT,
    });
    expect(withFile.content).toContain("Attachments (2):");
    expect(withFile.content).toContain("- image001.jpg [image]");
    expect(withFile.content).toContain("https://files.example.com/image001.jpg");
    expect(withFile.content).toContain("- note.pdf [document]");
    expect(withFile.content).toContain("https://files.example.com/note.pdf");
  });

  it("says so plainly when a body could not be decoded", () => {
    const undecodable = buildConversationTextExport({
      detail: detail({ messages: [message({ bodyText: null, bodyDecodeStatus: "failed" })] }),
      exportedAt: EXPORTED_AT,
    });
    expect(undecodable.content).toContain("Message content unavailable");
  });

  it("does not claim messages it does not have", () => {
    const empty = buildConversationTextExport({
      detail: detail({ messages: [] }),
      exportedAt: EXPORTED_AT,
    });
    expect(empty.content).toContain("MESSAGES (0) - oldest first");
    expect(empty.content).toContain("No messages are stored for this conversation.");
  });

  it("writes only the conversation it was handed", () => {
    expect(file.content).toContain("1627");
    expect(file.content).not.toContain("9999");

    const other = buildConversationTextExport({
      detail: detail({ conversation: conversation({ id: "9999" }) }),
      exportedAt: EXPORTED_AT,
    });
    expect(other.filename).toBe("cst-conversation-9999.txt");
    expect(other.content).not.toContain("1627");
  });

  it("has the same shape for every marketplace", () => {
    for (const marketplace of ["ebay", "amazon", "shopify", "bandq", "temu"] as const) {
      const each = buildConversationTextExport({
        detail: detail({ conversation: conversation({ marketplace }) }),
        exportedAt: EXPORTED_AT,
      });
      expect(each.mimeType).toBe("text/plain;charset=utf-8");
      for (const heading of [
        "Conversation:",
        "Marketplace:",
        "Account:",
        "Customer:",
        "Messages:",
        "MESSAGES (3) - oldest first",
      ]) {
        expect(each.content).toContain(heading);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Exporting is a download. Nothing else.
 * ------------------------------------------------------------------ */

describe("exporting neither generates nor transmits", () => {
  const panel = readFileSync(join(ROOT, "components", "draft-evidence-panel.tsx"), "utf8");
  const button = readFileSync(join(ROOT, "components", "conversation-export-button.tsx"), "utf8");
  const builder = readFileSync(join(ROOT, "lib", "export", "conversation-export.ts"), "utf8");

  it("issues no request from the export button", () => {
    expect(button).not.toContain("fetch(");
    expect(button).not.toMatch(/POST|PUT|PATCH|DELETE/);
    expect(button).not.toMatch(/\/api\//);
    expect(button).not.toMatch(/useEffect|useState/);
  });

  it("builds the file without touching the network at all", () => {
    expect(builder).not.toContain("fetch(");
    expect(builder).not.toContain("XMLHttpRequest");
    expect(builder).not.toMatch(/https?:\/\//);
  });

  it("writes the file locally and nowhere else", () => {
    expect(button).toContain("URL.createObjectURL");
    expect(button).toContain("link.download = file.filename");
    expect(button).toContain("URL.revokeObjectURL");
  });

  it("flags the case rather than presenting a normal draft", () => {
    expect(NO_RULE_HEADING).toBe("NO CST RULE / TEMPLATE AVAILABLE");
    expect(panel).toContain("<NoRuleFlag");
  });
});

/* ------------------------------------------------------------------ *
 * The file carries what the CST team needs to write the missing rule.
 * ------------------------------------------------------------------ */

describe("the export states why it exists", () => {
  const flagged = buildConversationTextExport({
    detail: detail(),
    caseType: "Customer requesting an invoice, receipt or proof of purchase",
    reason: NO_RULE_REASON,
    exportedAt: EXPORTED_AT,
  });

  it("names the identified message type and the reason", () => {
    expect(flagged.content).toContain(
      "Message type:       Customer requesting an invoice, receipt or proof of purchase",
    );
    expect(flagged.content).toContain(`Reason:             ${NO_RULE_REASON}`);
    expect(flagged.content).toContain("write the missing rule");
  });

  it("says 'not recorded' rather than guessing when nothing was passed", () => {
    expect(file.content).toContain("Message type:       not recorded");
    expect(file.content).toContain("Reason:             not recorded");
  });
});
