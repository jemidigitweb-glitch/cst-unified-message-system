import { displayBody } from "@/lib/domain/inbox";
import type { ConversationMessageView } from "@/lib/domain/inbox";

/**
 * What kind of request a customer made, for a case the rule base cannot answer.
 *
 * WHY THIS EXISTS. When retrieval returns no applicable rule, the conversation
 * is handed to the CST team so they can write the missing one. "Here is an
 * unanswered conversation" is a much weaker starting point than "here is an
 * unanswered conversation about a business invoice" — the second can be sorted,
 * grouped with its neighbours, and assigned.
 *
 * WHY IT IS NOT THE MODEL'S JOB. Asking the generator to name the case type
 * would change the draft flow and add a field nobody can check. This reads the
 * customer's own words against an explicit, reviewable phrase table and reports
 * the phrase it matched on, so the label always comes with its evidence and a
 * person can see in one glance whether it is right.
 *
 * IT REFUSES RATHER THAN GUESSES. Two signals of equal strength, or none at
 * all, produce `Unclassified / New Case Type`. That is the honest answer for a
 * case type the system has never seen — which, by definition, is what an
 * unmatched conversation usually is. A confident wrong label would send the
 * team to write the wrong rule.
 *
 * PURE. No network, no model, no database.
 */

export const UNCLASSIFIED_CASE_TYPE = "Unclassified / New Case Type";

export type CaseType = {
  /** What to show. Always safe to print. */
  readonly label: string;
  /** The customer phrase that produced the label, or null when unclassified. */
  readonly matchedPhrase: string | null;
};

/**
 * The phrase table.
 *
 * Deliberately literal and deliberately short. Each label is phrased as an
 * observation about the customer's message ("Customer reporting…"), never as a
 * decision about what should happen — deciding is the team's job, and this is
 * a filing aid.
 *
 * Phrases are matched on word boundaries against the customer's messages only.
 * A CST reply mentioning "refund" says what we wrote, not what they asked.
 */
const SIGNALS: readonly { readonly label: string; readonly phrases: readonly string[] }[] = [
  {
    label: "Customer requesting an invoice, receipt or proof of purchase",
    phrases: ["vat invoice", "business invoice", "invoice", "receipt", "proof of purchase"],
  },
  {
    label: "Customer requesting a cancellation",
    phrases: ["cancel my order", "cancel the order", "cancel this", "cancellation", "cancel"],
  },
  {
    label: "Customer requesting a return or refund",
    phrases: ["refund", "return this", "send it back", "money back", "return the"],
  },
  {
    label: "Customer requesting a replacement",
    phrases: ["replacement", "replace it", "send another"],
  },
  {
    label: "Customer reporting a delivery or tracking problem",
    phrases: [
      "not arrived",
      "hasn't arrived",
      "has not arrived",
      "still waiting",
      "where is my order",
      "not received",
      "tracking",
      "delayed",
      "late delivery",
    ],
  },
  {
    label: "Customer reporting damaged goods",
    phrases: ["damaged", "broken", "smashed", "cracked", "dented"],
  },
  {
    label: "Customer reporting a faulty or defective item",
    phrases: ["faulty", "defective", "not working", "stopped working", "doesn't work"],
  },
  {
    label: "Customer reporting missing parts",
    phrases: ["missing part", "missing parts", "parts missing", "missing piece", "no screws"],
  },
  {
    label: "Customer reporting the wrong item sent",
    phrases: ["wrong item", "wrong product", "wrong colour", "wrong color", "not what i ordered"],
  },
  {
    label: "Customer reporting the wrong quantity",
    phrases: ["wrong quantity", "only received", "fewer than", "short by"],
  },
  {
    label: "Customer reporting the item does not match the description",
    phrases: ["not as described", "not as advertised", "listing says", "misleading"],
  },
  {
    label: "Customer asking a pre-sales question",
    phrases: ["in stock", "before i buy", "does it fit", "dimensions", "compatible with"],
  },
];

/** Word-boundary match, so "cancel" does not fire on "cancellation policy link". */
function contains(haystack: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * Reads the customer's messages and names the request, or declines to.
 *
 * Only inbound messages are read: an outbound CST reply is our words, and
 * classifying a case by what we already said would describe the reply rather
 * than the request. A body that could not be decoded contributes nothing —
 * `displayBody` returns placeholder copy for it, which is skipped.
 */
export function classifyCaseType(
  messages: readonly ConversationMessageView[],
): CaseType {
  const text = messages
    .filter((message) => message.direction === "inbound")
    .map((message) => {
      const body = displayBody(message);
      return body.available ? body.text : "";
    })
    .join("\n")
    .toLowerCase();

  if (text.trim() === "") return { label: UNCLASSIFIED_CASE_TYPE, matchedPhrase: null };

  const scored = SIGNALS.map((signal) => {
    const hits = signal.phrases.filter((phrase) => contains(text, phrase));
    return { label: signal.label, hits: hits.length, first: hits[0] ?? null };
  }).filter((entry) => entry.hits > 0);

  if (scored.length === 0) return { label: UNCLASSIFIED_CASE_TYPE, matchedPhrase: null };

  scored.sort((a, b) => b.hits - a.hits);
  const [best, runnerUp] = scored;

  // A tie is genuine ambiguity — a message about a damaged item AND a refund is
  // both, and picking one would be a coin toss presented as a finding.
  if (runnerUp !== undefined && runnerUp.hits === best!.hits) {
    return { label: UNCLASSIFIED_CASE_TYPE, matchedPhrase: null };
  }

  return { label: best!.label, matchedPhrase: best!.first };
}
