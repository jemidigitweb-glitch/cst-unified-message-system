import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { generateDraft } from "@/lib/ai/draft-generator";
import { getDraftModelClient } from "@/lib/ai/gemini-client";
import { loadRulesForConversation } from "@/lib/knowledge/cst-rules-files";
import { loadEnvFile } from "@/tests/support/load-env";

/**
 * One real call to Gemini, end to end: local rule files -> whole corpus ->
 * prompt -> model -> validated draft.
 *
 * OPT-IN. Skipped unless RUN_LIVE_GEMINI=1, because it costs a token spend and
 * needs the network; the rest of the suite covers the same wiring with a fake
 * client. Run it with:
 *
 *   RUN_LIVE_GEMINI=1 npx vitest run tests/ai/draft-live-gemini.test.ts
 *
 * The conversation below is invented. No real customer message is used.
 */

loadEnvFile();

const DIRECTORY = join(__dirname, "..", "..", "Knowledge-source");
const ready =
  process.env.RUN_LIVE_GEMINI === "1" &&
  existsSync(DIRECTORY) &&
  readdirSync(DIRECTORY).some((name) => name.endsWith(".xlsx")) &&
  getDraftModelClient() !== undefined;

describe.skipIf(!ready)("a real draft, grounded in the local rule files", () => {
  const messages = [
    {
      id: "1",
      direction: "inbound" as const,
      sourceTimestamp: "2026-08-19 10:00:00",
      bodyText:
        "Hi, the ceiling light I ordered turned up with the glass shade cracked. " +
        "Pretty disappointed. What can you do about it?",
      bodyDecodeStatus: "decoded" as const,
    },
  ];

  it("is given the damage rules and returns a usable draft", async () => {
    const client = getDraftModelClient()!;
    const { knowledge, corpus } = loadRulesForConversation("ebay");

    expect(knowledge.state).toBe("available");
    expect(corpus?.categories).toContain("Damage");

    const generated = await generateDraft(client, {
      messages,
      facts: [],
      knowledge,
      marketplace: "ebay",
    });

    // A reply exists and is addressed to a person, not a placeholder.
    expect(generated.result.draft_reply.length).toBeGreaterThan(60);
    expect(generated.model).toMatch(/^gemini/);

    // No order was resolved for this conversation, so the model was given no
    // verified facts. It must therefore ask rather than assert, and say so.
    expect(generated.requiresReview).toBe(true);
    expect(generated.missingInformation.length).toBeGreaterThan(0);

    // Every citation resolves to a rule that was actually supplied. The
    // generator drops invented refs, so a surviving one is real.
    if (knowledge.state !== "available") throw new Error("unreachable");
    const supplied = new Set(knowledge.rules.map((rule) => rule.ref));
    for (const source of generated.result.sources_used) {
      if (source.kind === "cst_document") expect(supplied).toContain(source.ref);
    }

    console.log("\n--- draft ---\n" + generated.result.draft_reply);
    console.log("\n--- sources ---", generated.result.sources_used.map((s) => s.ref).join(", ") || "(none)");
    console.log("--- missing ---", generated.missingInformation.join(" | "));
    console.log("--- areas ---", corpus?.categories.join(", "));
    console.log("--- rules supplied ---", corpus?.rules.length, "\n");
  }, 90_000);

  it("invents no order number, tracking number or refund promise", async () => {
    const client = getDraftModelClient()!;
    const { knowledge } = loadRulesForConversation("ebay");
    const generated = await generateDraft(client, {
      messages,
      facts: [],
      knowledge,
      marketplace: "ebay",
    });
    const reply = generated.result.draft_reply;

    // Nothing in the input carried any of these, so anything matching is made up.
    expect(reply).not.toMatch(/\b\d{2}-\d{5}-\d{5}\b/); // eBay order number
    expect(reply).not.toMatch(/\b\d{3}-\d{7}-\d{7}\b/); // Amazon order number
    expect(reply).not.toMatch(/\b[A-Z]{2}\d{9}[A-Z]{2}\b/); // tracking number
    // A refund it has no authority to approve.
    expect(reply).not.toMatch(/we have (issued|processed|approved) (a|your) (refund|replacement)/i);
  }, 90_000);
});
