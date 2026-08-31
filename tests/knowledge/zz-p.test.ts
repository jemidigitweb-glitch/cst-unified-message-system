import { describe, expect, it } from "vitest";
import { classifyConversationCategory, explainMessageCategory } from "@/lib/knowledge/message-category";
const M = ["Connected to 12v led light and it is pulsing - what say you?",
  "I need constant current, yours is constant voltage which is probably causing the led to pulse on off per sec."];
describe("p", () => { it("x", () => {
  for (const t of M) { const e = explainMessageCategory(t);
    console.log(`${e.category} | ${e.reason} | fault=${e.semantics.claims.functional_fault} | journey=${e.semantics.journey} | ${e.intents.join(",")}`); }
  console.log("THREAD ->", classifyConversationCategory(M));
  expect(true).toBe(true);
}); });
