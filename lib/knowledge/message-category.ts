/**
 * Which of the eleven CST case areas a conversation's messages are about, for
 * inbox filtering.
 *
 * WHY A SEPARATE FUNCTION FROM `classifyCaseType`. That classifier exists for
 * one purpose only — naming the request behind a conversation the rule base
 * could NOT ground a reply for, so it can join `cst_app.conversation_rule_analysis`
 * and the No Rule list. Reusing it here would mean either changing its label
 * vocabulary (breaking that stored, compared-against data) or accepting a
 * mismatch between what this filter calls something and what the No Rule tab
 * calls the same thing. This is a second, independent classifier with its own
 * vocabulary — the eleven CST rule areas — built the same way for the same
 * reason: a phrase table a reviewer can read and challenge, not a model call.
 *
 * REUSES THE SAME PHRASE SIGNALS `classifyCaseType` already proved out —
 * delivery, damage, defective, missing parts, wrong item/quantity/description,
 * pre-sales, return/refund — split and relabelled to the exact eleven category
 * names, with "Admin related issues" (invoice/receipt/account requests) and
 * "Order change, before shipping queries" (cancellation and amendment before
 * dispatch) added as their own signals, since `classifyCaseType` never named
 * either separately.
 *
 * SAME "REFUSE RATHER THAN GUESS" DISCIPLINE. A tie between two equally-strong
 * signals returns `null` (uncategorised), never a coin toss presented as a
 * finding.
 *
 * NO DATABASE, NO STORAGE. This runs at list-fetch time, over customer text
 * the query already reads — nothing here is persisted, so a phrase-table
 * change takes effect on the next request rather than needing a backfill.
 *
 * PURE. No network, no model, no database.
 */

export const MESSAGE_CATEGORIES = [
  "Delivery queries",
  "Pre sales queries",
  "Admin related issues",
  "Order change, before shipping queries",
  "Defective items",
  "Damage queries",
  "Wrong item sent messages",
  "Parts missing queries",
  "Wrong quantity sent issues",
  "Wrong description issues",
  "Return and refunds",
] as const;

export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];

const SIGNALS: readonly { readonly label: MessageCategory; readonly phrases: readonly string[] }[] = [
  {
    label: "Delivery queries",
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
      // German
      "nicht angekommen",
      "noch nicht erhalten",
      "wo ist meine bestellung",
      "sendungsverfolgung",
      "lieferung verspätet",
    ],
  },
  {
    label: "Pre sales queries",
    phrases: [
      "in stock",
      "before i buy",
      "does it fit",
      "dimensions",
      "compatible with",
      // German
      "auf lager",
      "bevor ich kaufe",
      "abmessungen",
      "kompatibel mit",
    ],
  },
  {
    label: "Admin related issues",
    phrases: [
      "vat invoice",
      "business invoice",
      "invoice",
      "receipt",
      "proof of purchase",
      "business account",
      // German
      "mehrwertsteuerrechnung",
      "rechnung",
      "kaufbeleg",
    ],
  },
  {
    label: "Order change, before shipping queries",
    phrases: [
      "cancel my order",
      "cancel the order",
      "cancel this",
      "cancellation",
      "before it ships",
      "before dispatch",
      "change my order",
      "change the address",
      "amend my order",
      // German
      "bestellung stornieren",
      "stornierung",
      "vor dem versand",
      "bestellung ändern",
      "adresse ändern",
    ],
  },
  {
    label: "Defective items",
    phrases: [
      "faulty",
      "defective",
      "not working",
      "stopped working",
      "doesn't work",
      // German
      "defekt",
      "funktioniert nicht",
      "geht nicht mehr",
    ],
  },
  {
    label: "Damage queries",
    phrases: [
      "damaged",
      "broken",
      "smashed",
      "cracked",
      "dented",
      // German
      "beschädigt",
      "zerbrochen",
      "gesprungen",
    ],
  },
  {
    label: "Wrong item sent messages",
    phrases: [
      "wrong item",
      "wrong product",
      "wrong colour",
      "wrong color",
      "not what i ordered",
      // German
      "falscher artikel",
      "falsche farbe",
      "nicht das was ich bestellt habe",
    ],
  },
  {
    label: "Parts missing queries",
    phrases: [
      "missing part",
      "missing parts",
      "parts missing",
      "missing piece",
      "no screws",
      // German
      "fehlende teile",
      "teile fehlen",
      "keine schrauben",
    ],
  },
  {
    label: "Wrong quantity sent issues",
    phrases: [
      "wrong quantity",
      "only received",
      "fewer than",
      "short by",
      // German
      "falsche menge",
      "zu wenig erhalten",
    ],
  },
  {
    label: "Wrong description issues",
    phrases: [
      "not as described",
      "not as advertised",
      "listing says",
      "misleading",
      // German
      "nicht wie beschrieben",
      "irreführend",
    ],
  },
  {
    label: "Return and refunds",
    phrases: [
      "refund",
      "return this",
      "send it back",
      "money back",
      "return the",
      "replacement",
      "replace it",
      "send another",
      // German
      "rückerstattung",
      "geld zurück",
      "zurücksenden",
      "ersatzlieferung",
    ],
  },
];

/** Word-boundary match, so "cancel" does not fire on "cancellation policy link". */
function contains(haystack: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * Names the CST category a conversation's customer text falls under, or
 * declines to.
 *
 * Takes already-assembled customer text (lower-cased or not — matching is
 * case-insensitive) rather than a message list, so the caller can source it
 * from a single aggregated SQL column instead of fetching every message body
 * back into the application to re-derive the same string `classifyCaseType`
 * already knows how to build.
 */
export function classifyMessageCategory(customerText: string | null): MessageCategory | null {
  const text = customerText?.trim() ?? "";
  if (text === "") return null;

  const scored = SIGNALS.map((signal) => ({
    label: signal.label,
    hits: signal.phrases.filter((phrase) => contains(text, phrase)).length,
  })).filter((entry) => entry.hits > 0);

  if (scored.length === 0) return null;

  scored.sort((a, b) => b.hits - a.hits);
  const [best, runnerUp] = scored;

  // A tie is genuine ambiguity, same as `classifyCaseType` — picking one would
  // be a coin toss presented as a finding.
  if (runnerUp !== undefined && runnerUp.hits === best!.hits) return null;

  return best!.label;
}
