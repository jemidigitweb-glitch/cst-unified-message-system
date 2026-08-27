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

/**
 * The phrase table, exported so a test can check its shape rather than a
 * reviewer having to eyeball it.
 *
 * ONE INVARIANT MATTERS MOST: no phrase here may also match a more general
 * phrase in the SAME category. Scoring counts matched phrases, so a message
 * saying one thing once would score that category twice and beat a genuine
 * tie with another category. Four such pairs predate this table's growth and
 * are left as they are; nothing new should join them.
 */
export const SIGNALS: readonly { readonly label: MessageCategory; readonly phrases: readonly string[] }[] = [
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
      // Measured against live customer text: each of these newly classified
      // conversations the table already missed, with few or no ties created.
      "been dispatched",
      "not been delivered",
      "when will it",
      "when will my",
      "any update on",
      // eBay/Shopify wording measured in a second sweep. "out for delivery" alone
      // named 41 conversations the table had missed.
      "out for delivery",
      "was not delivered",
      "when are you sending",
      "no updates",
      "did not get my",
      "signature on delivery",
      "delivery instructions",
      // From CST-reviewed eBay cases: a chase phrased as "yet to receive", and a
      // failed delivery attempt — including the customer's own typo, which is how
      // they actually wrote it.
      "yet to receive",
      "tried to deliver",
      "no delivered",
      "where is my item",
      "delivery attempt",
      "return to sender",
      // German
      "nicht angekommen",
      "noch nicht erhalten",
      "wo ist meine bestellung",
      "sendungsverfolgung",
      "lieferung verspätet",
      "lieferzeit",
      "zustellung",
      // German delivery chases seen on eBay: nothing received yet, asking for a
      // dispatch confirmation, or for the processing status.
      "nichts bekommen",
      "versandbestätigung",
      "bearbeitungsstatus",
      "ware angekommen",
      "paket ankommen",
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
      // Spec questions are pre-sales in practice, and the single biggest gap
      // the analysis found (129 conversations).
      "voltage",
      "wattage",
      "suitable for",
      "what size",
      "can i use",
      // Fit/spec questions asked before buying — the commonest genuine eBay
      // enquiry, and almost none of it was matching before.
      "the diameter of",
      "what length",
      "how wide",
      "out of stock",
      "will this work",
      "can this be used",
      "do you have the same",
      "looking to buy",
      "would like to order",
      "can i purchase",
      "do you offer",
      "before i order",
      // Pre-purchase colour and compatibility questions, as eBay customers phrase
      // them when asking about a listing they have not bought.
      "do you do this in",
      "would it work",
      "can it work",
      "thinking of buying",
      // What is in the box, whether it fits, what rating is needed, and when it
      // will be back — the four things eBay customers ask before buying.
      "does this purchase include",
      "does this come as",
      "will fit",
      "what watt",
      "what pattern",
      "can you recommend",
      "stock arrive",
      "anytime soon",
      // German
      "auf lager",
      "bevor ich kaufe",
      "abmessungen",
      "kompatibel mit",
      "welche größe",
      "in verschiedene farben",
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
      "amend the order",
      "change the delivery address",
      "wrong address",
      "cancel order",
      "haven't sent yet",
      // German
      "bestellung stornieren",
      "stornierung",
      "vor dem versand",
      "bestellung ändern",
      "adresse ändern",
      "kaufabbruch",
      // The customer telling us THEY got the order wrong — a different thing from
      // us getting it wrong, and the distinction the table could not previously
      // make. No product wording here: what identifies this is the reference to
      // their own ordering or selection, not what was ordered.
      "by mistake",
      "made a mistake",
      "not clear when",
      "when i placed",
      "selected the wrong",
      "ordered the wrong",
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
      "does not work",
      "flickering",
      "dead on arrival",
      "turned back on",
      // German
      "defekt",
      "funktioniert nicht",
      "geht nicht mehr",
      "kaputt",
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
      "scratched",
      "kratzer",
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
      "not the one i ordered",
      "send me the wrong",
      "sent the wrong",
      // German
      "falscher artikel",
      "falsche farbe",
      "nicht das was ich bestellt habe",
      "falsch geliefert",
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
      "missing screws",
      "no earth",
      "nothing to hang",
      // How a customer reports an absent component, rather than what the
      // component is called. Product nouns are deliberately not listed — nuts,
      // brackets and shades appear in plenty of conversations that are not
      // about anything missing, so the intent has to carry the signal.
      "is missing",
      "appears to be missing",
      "appear to be missing",
      "seems to be missing",
      "received without",
      "arrived without",
      "not included",
      // German
      "fehlende teile",
      "teile fehlen",
      "keine schrauben",
      "fehlt",
      "fehlen",
      "unvollständig",
      "nicht enthalten",
    ],
  },
  {
    label: "Wrong quantity sent issues",
    phrases: [
      "wrong quantity",
      "only received",
      "fewer than",
      "short by",
      "short delivery",
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
      "described as",
      "advert said",
      "laut beschreibung",
      "non corrisponde",
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
      // The remedy the customer asks for, which CST treats as the category even
      // when a fault is what prompted it.
      "send me a new one",
      "send me a return",
      "send a return",
      "refunded",
      "return label",
      "return it",
      "returns process",
      "reimburse",
      // Return wording, including the German and Italian actually present.
      "need to return",
      "like to return",
      "wish to return",
      "have to return",
      "send this back",
      "returning this",
      // German
      "rückerstattung",
      "geld zurück",
      "zurücksenden",
      "ersatzlieferung",
      "retoure",
      "zurückschicken",
      "erstattung",
      "rücksendung",
      "rücksendeetikett",
      "rücksendeadresse",
      "restituirlo",
      "rimborso",
    ],
  },
];

/**
 * What the customer typed, made comparable with what the table holds.
 *
 * TWO REAL DEFECTS THIS FIXES, both found in live message bodies:
 *
 *   curly apostrophes   Customers type “doesn’t work”; the table holds
 *                       "doesn't work". Every apostrophe phrase in the table
 *                       — doesn't work, hasn't arrived — was silently dead
 *                       against most real text.
 *   HTML entities       eBay stores bodies with &amp; and &apos; undecoded,
 *                       so a phrase spanning one could never match.
 *
 * Deliberately nothing else: no lower-casing (matching is already
 * case-insensitive), no punctuation stripping, no stemming. Each rule here
 * exists because a phrase provably failed without it.
 */
function normalise(text: string): string {
  return text
    .replace(/&apos;|&#39;|&rsquo;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"');
}

/**
 * Where two categories tie, the pair whose winner is not a coin toss.
 *
 * A tie normally returns null, and that stays the default. This list is the
 * short set of collisions where the same words reliably mean one of the two,
 * confirmed against real conversations rather than assumed:
 *
 *   Admin over Parts missing — German invoice requests say "uns fehlt die
 *   Rechnung" ("we are missing the invoice"). `fehlt` fires Parts missing and
 *   `rechnung` fires Admin, so every one of them tied and fell to null. Of the
 *   conversations where exactly this pair tied, all six were invoice requests.
 *
 * Nothing joins this list on reasoning alone; each entry needs conversations
 * behind it, and every pair NOT listed still refuses.
 */
const TIE_PRECEDENCE: readonly (readonly [MessageCategory, MessageCategory])[] = [
  ["Admin related issues", "Parts missing queries"],
];

function precedenceWinner(a: MessageCategory, b: MessageCategory): MessageCategory | null {
  for (const [winner, loser] of TIE_PRECEDENCE) {
    if ((a === winner && b === loser) || (b === winner && a === loser)) return winner;
  }
  return null;
}

/**
 * The one shape that is safe to name when NO phrase matched at all.
 *
 * WHY A SHAPE RULE AND NOT MORE PHRASES. Of the eBay conversations the table
 * leaves unnamed, the great majority match no phrase whatever, and the
 * commonest thing among them is a customer asking about a product before
 * buying it. There is no wording to add for that: the recurring n-grams across
 * those conversations are "thank you", "can you", "do you have" — the shape of
 * a question, not a vocabulary. Enumerating the tail is not possible; naming
 * the shape is.
 *
 * FOUR CONDITIONS, ALL REQUIRED, and each one earns its place by what it keeps
 * out:
 *
 *   asks something      A statement is not an enquiry.
 *   names a product     A closed spec vocabulary — voltage, size, fitting,
 *      attribute        bulb type. Without it "can you help?" would qualify.
 *   nothing bought yet  The decisive one. A customer who has ALREADY received
 *                       the item is not making a pre-sales enquiry however
 *                       much specification they discuss, and that confusion
 *                       was the single commonest misreading this rule had to
 *                       design against.
 *   short               A long thread has usually moved on to a problem. The
 *                       length bound is what lifted this from 86% to 91%
 *                       agreement against the reviewed sample.
 *
 * Applied ONLY where no phrase matched, so it can never override or dilute a
 * signal the table already found.
 */
const ASKS_SOMETHING =
  /\?|(^|[.!?]\s)\s*(do|does|did|can|could|would|will|is|are|have|has|what|which|how|when|where|hab(?:en|t)|k(?:ö|oe)nn(?:en|t)|ist|sind|wie|was|welche)\b/i;

/** Attributes a buyer asks about. Closed, so an unrelated question cannot qualify. */
const PRODUCT_ATTRIBUTE =
  /\b(volt|volts|voltage|watt|watts|wattage|amp|amps|dimmable|dimmer|colour|color|size|sizes|length|width|diameter|height|mm|cm|metre|meter|bulb|bulbs|fitting|fittings|socket|holder|shade|e27|e14|b22|gu10|ip44|ip65|kelvin|lumen|lumens|material|brass|chrome|compatible|suitable|waterproof|outdoor|indoor|thread|dimensions|specification)\b/i;

/**
 * Any sign the customer already has the goods, in English or German.
 *
 * The contracted forms are here because they were missed: "I've ordered the
 * wrong size brackets, can I send them back?" slipped past a pattern that only
 * knew "i ordered", and was named a pre-sales enquiry.
 */
const ALREADY_PURCHASED =
  /\b(arrived|arrival|received|delivered|turned up|came today|came yesterday|i ?'?ve (?:ordered|bought|purchased|received|got)|i have (?:ordered|bought|purchased|received|got)|i bought|i purchased|i ordered|my order|installed|fitted|unbox|opened the box|erhalten|bekommen|geliefert|angekommen|bestellt)\b/i;

/**
 * Any hint of a problem or a remedy, whether or not the phrase table knows it.
 *
 * The guard that took this rule from 86% to 97% agreement. A pre-sales enquiry
 * is a question about a product and nothing else; the moment a cancellation, a
 * return, a fault or a description mismatch is mentioned, the conversation is a
 * case and belongs to whichever category the table names — or to none.
 *
 * Deliberately BROADER than the phrase table, so wording the table has never
 * seen still stops this rule from guessing. It costs a little coverage and buys
 * back most of the errors.
 */
const MENTIONS_A_PROBLEM =
  /\b(cancel|refund|return|returns|faulty|defect|defective|broken|damaged|missing|wrong|not working|ghosting|description|send (?:them|it|these) back)\b/i;

/** Chasing something outstanding — a delivery matter, not a pre-sales one. */
const AWAITING_SOMETHING = /\b(still|yet|waiting|when will|when is|how long|noch nicht|wann)\b/i;

/** Longer than a buyer's question; by this length the thread is usually a case. */
const MAX_ENQUIRY_LENGTH = 250;

function looksPreSales(text: string): boolean {
  return (
    text.length < MAX_ENQUIRY_LENGTH &&
    ASKS_SOMETHING.test(text) &&
    PRODUCT_ATTRIBUTE.test(text) &&
    !ALREADY_PURCHASED.test(text) &&
    !AWAITING_SOMETHING.test(text) &&
    !MENTIONS_A_PROBLEM.test(text)
  );
}

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
  const text = normalise(customerText?.trim() ?? "");
  if (text === "") return null;

  const scored = SIGNALS.map((signal) => ({
    label: signal.label,
    hits: signal.phrases.filter((phrase) => contains(text, phrase)).length,
  })).filter((entry) => entry.hits > 0);

  // No phrase matched. One shape is still safe to name — see `looksPreSales`.
  if (scored.length === 0) {
    return looksPreSales(text) ? "Pre sales queries" : null;
  }

  scored.sort((a, b) => b.hits - a.hits);
  const [best, runnerUp] = scored;

  if (runnerUp !== undefined && runnerUp.hits === best!.hits) {
    // A tie is genuine ambiguity and normally returns null. The exception is a
    // pair where the same words routinely mean one of them — see
    // `TIE_PRECEDENCE`. Anything not listed there still refuses.
    return precedenceWinner(best!.label, runnerUp.label);
  }

  return best!.label;
}
