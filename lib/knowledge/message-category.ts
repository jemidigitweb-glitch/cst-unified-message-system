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

import {
  type ClaimStatus,
  type SpeechAct,
  asserts,
  claimStatus,
  speechActOf,
} from "./message-semantics";
import { type RuleRole, corpusMatches } from "./cst-corpus-match";
import {
  CST_EVIDENCE,
  collectCategoryEvidence,
  type EvidenceCondition,
  type EvidenceMatch,
  NOT_A_PRODUCT_WORD,
  ORDERED_ONE_THING_RECEIVED_ANOTHER,
  type OwnershipConcept,
} from "./cst-category-evidence";

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
 * The category for a conversation whose customer messages cannot be read.
 *
 * WHAT THIS COVERS. 167 inbound messages carry `body_decode_status = 'empty'`
 * and a null body — the customer wrote, the source recorded the message, and
 * the text did not survive. The interface renders those as "Message content
 * unavailable", and until now the conversation reached the inbox with no
 * category at all, which is the one state a reviewer cannot filter, sort or
 * triage on.
 *
 * WHY ADMIN AND NOT A GUESS FROM CONTEXT. The obvious idea is to read OUR OWN
 * replies instead and take the category from those. It was measured on the
 * 1,495 conversations where both sides are readable, so the customer's own
 * category acts as the check, and it does not work: our replies agree with the
 * customer's category 50.8% of the time, and PRECISION per predicted category
 * runs 20% (Wrong description) to 61% (Damage). Only "Admin related issues"
 * reaches 65%, and that is the fallback anyway. Tagging a thousand
 * conversations from a coin flip would put a confident wrong label where a
 * blank used to be — worse than the blank, because a wrong category misroutes
 * work while a blank merely fails to route it.
 *
 * So this states the one thing that IS true: a customer wrote to us, and
 * somebody has to open it. That is an admin case.
 */
export const UNREADABLE_CONTENT_CATEGORY: MessageCategory = "Admin related issues";

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
      // From `DAMAGE DECISION GUIDE.xlsx` › "What Customer Typically Says" —
      // the same rows that give "smashed" and "broken" also give these, and the
      // table held none of them. None overlaps a phrase already listed here, so
      // the one-hit-per-meaning invariant is intact.
      "shattered",
      "chipped",
      "crushed",
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
      // The same report with the indirect object present, or the article
      // dropped — "you have sent me the wrong ones", "U sent me wrong one".
      // "sent the wrong" cannot reach either, because "me" sits in the gap.
      // 23, 3 and 31 occurrences respectively in live eBay text.
      "sent me the wrong",
      "sent me wrong",
      "received the wrong",
      // "it's the wrong one", "they are the wrong ones". The mismatch stated
      // without naming what the thing is — the only way to say it without a
      // product noun, and this table holds no product nouns.
      //
      // THE ARTICLE IS REQUIRED, and that is not incidental. Bare "wrong one"
      // also catches a customer retracting their own previous message —
      // "Wrong one, sorry — ignore that" — which is pinned in the tests as
      // something this category must never claim. "THE wrong one" is a
      // statement about the item in front of them; "wrong one, sorry" is not.
      // 57 and 27 live occurrences.
      "the wrong one",
      "the wrong ones",
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
      // The same report in the plural and the past — "the bulbs are missing",
      // "a nut was missing". The table held only the present singular, so 220
      // live messages saying exactly this were invisible to it purely on
      // inflection. No new intent here, just the rest of the verb.
      "are missing",
      "was missing",
      "were missing",
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
      // "advertised at 6mm but mine is 8.85mm" — the listing-versus-reality
      // comparison, which the table only knew in its negated form ("not as
      // advertised"). Read back over every occurrence: seven are genuine
      // description mismatches, one ("advertised as dimmable, does not work")
      // now ties with Defective and falls to null. That trade is accepted.
      "advertised as",
      "advertised at",
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
      // A return offered with no object after the verb — "I can return if
      // possible please". Every other return phrase here needs a noun ("return
      // the", "return it"), so an offer phrased this way matched nothing at
      // all. Measured over live eBay text: 209 for "can return", 61 for "can i
      // return", and the sample read back is customer return requests
      // throughout.
      "can return",
      "can i return",
      // "arrange a return" (126) and "want to return" (54). Deliberately NOT
      // "want a refund": bare "refund" already fires on it, so adding it would
      // score the same sentence twice — the one invariant this table has.
      "arrange a return",
      "want to return",
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
 * Damage predicated on the PACKAGING rather than on the goods — "the box was
 * damaged and slightly open", "arrived in a broken plastic container".
 *
 * WHY THIS EXISTS. A customer who opens a battered box and finds a component
 * absent is reporting a missing part. The state of the box is how they explain
 * it, not what they want done. Before this, the damage word and the missing
 * word scored one apiece and the conversation fell to null.
 *
 * Read against every live conversation where a packaging noun carries a damage
 * word alongside a missing one, the direction is unanimous: "the box was open
 * and battered ... the plastic inner circle is missing", "the box is very badly
 * damaged and open. It is missing X1 ceiling rose", "the box was open all
 * damaged and the bulb are missing". All are parts cases.
 *
 * The counter-examples are what keep it narrow. Damage to the GOODS names no
 * packaging: "a lot of scratches and the earth is missing", "the plastic hinge
 * is broken and the clear cover missing", "missing a whole crystal, the broken
 * piece is not present". None of those matches here, and all still refuse.
 *
 * Both word orders, because customers use both, and bounded to a single
 * sentence so it cannot reach across into an unrelated clause.
 */
const PACKAGING = "box|boxes|carton|packaging|parcel|package|container|outer|wrapping|karton|verpackung|umschlag|paket";
const DAMAGE_WORD =
  // `bashed` and `beaten up` are Delivery 9.1's own wording ("Box looks beaten
  // up", "Packaging bashed") and were missing; `scuffed` and `scratched` are the
  // surface-mark words `IS_DAMAGED` already knows, and without them here a
  // scuffed box could not be recognised AS a box complaint — "the item is not
  // damaged, the box was just scuffed" read as damage to the goods.
  "damaged|dented|crushed|crumpled|ripped|torn|battered|bashed|beaten\\s+up|scuffed|scratched|smashed|broken|squashed|open|besch(?:ä|ae)digt|zerdr(?:ü|ue)ckt|aufgerissen|ge(?:ö|oe)ffnet";

/**
 * THE WINDOW STOPS AT A CLAUSE BOUNDARY, not just at a full stop.
 *
 * An 80-character run that crossed commas reached across the sentence and
 * swallowed damage to the GOODS: "we've just opened the box for the first time
 * since receiving it, and unfortunately one shade is broken" matched "box ...
 * broken" end to end, so the shade's breakage was read as the box's and a
 * damage case became a delivery one. The customer names the box and the shade
 * in two different clauses and says nothing at all about the box being damaged.
 *
 * Commas, semicolons and newlines now end the window along with sentence
 * punctuation, which is what keeps the damage word attached to the noun it is
 * actually predicated of.
 */
/**
 * AND IT MAY NOT CROSS A CONTRAST WORD EITHER.
 *
 * "The box was fine but the glass shade inside is smashed" put a packaging noun
 * and a damage word 42 characters apart with no comma between them, and the
 * window read the shade's breakage as the box's — turning a damage case into a
 * delivery one. "But" is exactly where the customer stops talking about the box.
 */
const NOT_PAST_A_CONTRAST = "(?:(?!\\bbut\\b|\\bhowever\\b|\\balthough\\b|\\bwhereas\\b)[^.!?;,\\n])";

const PACKAGING_DAMAGE = new RegExp(
  `\\b(?:${PACKAGING})\\b${NOT_PAST_A_CONTRAST}{0,45}?\\b(?:${DAMAGE_WORD})\\b|\\b(?:${DAMAGE_WORD})\\b${NOT_PAST_A_CONTRAST}{0,30}?\\b(?:${PACKAGING})\\b`,
  "i",
);

/**
 * MONEY BACK. Not a return, not a replacement — the customer's money.
 *
 * "Return and refunds" is an OUTCOME category, not a problem category, and this
 * is the test that decides whether the outcome is actually being asked for.
 * Everything else a customer might say about sending an item back — "I can
 * return it", "send me a return label", "please send a replacement" — describes
 * a route, not a result, and a route is not a reason to take the conversation
 * away from the problem that caused it.
 *
 * The distinction matters because the two are constantly said together:
 *
 *   "you sent the wrong one, I can return it if you send the right one"
 *      -> a wrong-item case. The return is how it gets fixed.
 *   "you sent the wrong one, I want my money back"
 *      -> a refund case. The money is the point.
 *
 * Deliberately narrow: refund, reimbursement, money back and their German and
 * Italian equivalents. Nothing about labels, postage or replacements.
 */
const REFUND_INTENT =
  /\b(?:refund|refunds|refunded|refunding|reimburse|reimbursed|reimbursement|money\s+back|r(?:ü|ue)ckerstattung|erstattung|erstatten|zur(?:ü|ue)ckerstatt\w*|geld\s+zur(?:ü|ue)ck|rimborso|rimborsare)\b/i;

/**
 * The customer saying they do NOT want their money back.
 *
 * Requires an explicit verb of wanting, so it can never swallow someone chasing
 * a refund they are owed: "I have not been refunded yet" and "still no refund"
 * do not match here, while "I don't want a refund, just send the right one"
 * does.
 */
const REFUND_DECLINED =
  /\b(?:do\s?n[o']?t|does\s?n[o']?t|did\s?n[o']?t|not)\s+(?:want|wanting|need|require|after|looking\s+for|seeking|expecting|asking\s+for)\s+(?:a\s+|any\s+|the\s+|my\s+)?refund\b/i;

function wantsMoneyBack(text: string): boolean {
  return REFUND_INTENT.test(text) && !REFUND_DECLINED.test(text);
}

/**
 * The categories that describe a PROBLEM, as opposed to an outcome or an
 * enquiry.
 *
 * A conversation that names one of these has told us what went wrong. It keeps
 * that category unless the customer also asks for their money back — see the
 * gate in `classifyMessageCategory`. Pre-sales and Admin are absent because
 * neither is a problem report, so neither is something a mentioned return could
 * plausibly be stealing.
 */
const PROBLEM_CATEGORIES: readonly MessageCategory[] = [
  "Delivery queries",
  "Order change, before shipping queries",
  "Defective items",
  "Damage queries",
  "Wrong item sent messages",
  "Parts missing queries",
  "Wrong quantity sent issues",
  "Wrong description issues",
];

/**
 * A customer ASKING for a return or refund, as opposed to mentioning one.
 *
 * THE DISTINCTION THIS DRAWS IS THE WHOLE POINT, and it is visible in live text:
 *
 *   "Can you send the correct one please and I will return the one I received"
 *      -> a wrong-item report. The return is incidental; what is being asked
 *         for is the right item.
 *   "it's the wrong colour. Please could I return this item."
 *      -> a return request that happens to explain itself with a wrong item.
 *
 * Both contain the word "return", and scoring cannot tell them apart because
 * both score Return once. What separates them is grammatical mood: a request,
 * not a statement of intent. So this matches the REQUEST FORMS only —
 * "could I return", "want to return", "arrange a return", "send me a returns
 * label", "refund me" — and deliberately does not match "I will return it".
 */
const EXPLICIT_REMEDY_REQUEST = new RegExp(
  [
    // Asking permission or possibility.
    "(?:can|could|may|shall|should)\\s+i\\s+(?:please\\s+)?(?:just\\s+)?(?:return|send\\s+(?:it|them|this|these)\\s+back)",
    "i\\s+can\\s+return",
    "(?:possible|possibility)\\s+to\\s+return",
    // Stating the want.
    "(?:want|wants|wish|wishes|need|needs|like|prefer)\\s+to\\s+return",
    "(?:'d|would)\\s+like\\s+to\\s+return",
    "(?:want|wants|wish|wishes|need|needs|like|expect)\\s+(?:a|my|the|full|partial|complete)?\\s*refund",
    "(?:'d|would)\\s+like\\s+(?:a|my|the)?\\s*refund",
    // Asking for the paperwork or the arrangement.
    "arrange\\s+(?:a|the|my)\\s+(?:return|refund)",
    "returns?\\s+label",
    "(?:send|provide|issue|email|give)\\s+(?:me\\s+)?(?:a|the|my)\\s+(?:return|refund)",
    // Asking for the money.
    "refund\\s+(?:me|my|it|this|the)",
    "refund\\s+please",
    "please\\s+refund",
    "money\\s+back",
    "(?:waiting|wait|chasing)\\s+for\\s+(?:my|the|a)\\s+refund",
    // German. Each of these is already a request in ordinary use.
    "zur(?:ü|ue)ck(?:schicken|senden|geben|erstatten)",
    "r(?:ü|ue)cksende(?:etikett|adresse|schein)",
    "r(?:ü|ue)ckerstattung",
    "erstattung",
    "geld\\s+zur(?:ü|ue)ck",
    "retoure",
  ].join("|"),
  "i",
);

/**
 * The categories a return/refund REQUEST outranks — and, just as importantly,
 * the categories that outrank a return/refund that was only mentioned.
 *
 * TWO NAMED PAIRS, NOT A GLOBAL RULE. Both are reports of something the
 * customer wants PUT RIGHT, where the remedy asked for decides which of the two
 * it is:
 *
 *   Wrong item sent   "you sent me the wrong one" is a wrong-item case. It
 *                     stays one even if the customer adds that they can send
 *                     the item back — an item may well be returned without the
 *                     message being a refund request. Add "I want a refund"
 *                     and it becomes one.
 *   Order change      "I ordered the wrong one, can I have a different one" is
 *                     an amendment. Add "please refund me" and it is a return.
 *
 * Every other pairing is untouched: Damage, Defective, Delivery, Parts missing,
 * Wrong description and Wrong quantity all still contest Return on score alone
 * and still refuse on a tie. Nothing here is a general "Return wins" or a
 * general "Return loses" — there is no evidence for either, and the two
 * directions are both wrong about half the time.
 */
const REMEDY_REQUEST_DECIDES: readonly MessageCategory[] = [
  "Wrong item sent messages",
  "Order change, before shipping queries",
];

/**
 * Resolves only the two pairs above, and returns null for everything else so
 * the ordinary scoring and tie rules carry on untouched.
 */
function remedyRequestWinner(
  a: MessageCategory,
  b: MessageCategory,
  text: string,
): MessageCategory | null {
  const other = a === "Return and refunds" ? b : b === "Return and refunds" ? a : null;
  if (other === null || !REMEDY_REQUEST_DECIDES.includes(other)) return null;
  return wantsMoneyBack(text) ? "Return and refunds" : other;
}

/**
 * The customer saying they themselves ordered the wrong thing AND asking for a
 * different one — an amendment, not a complaint about what we sent.
 *
 * WHY A SHAPE RULE RATHER THAN PHRASES. The English half of this is already in
 * the table as "ordered the wrong" and "selected the wrong", because English
 * puts the two words together. German does not: "Falsches Design bestellt",
 * "die falsche Größe bestellt", "das falsche Netzteil bestellt" — the noun sits
 * between them, so no fixed phrase can span it without naming the product, and
 * naming products is the one thing this table refuses to do.
 *
 * BOTH HALVES ARE REQUIRED, and the second is what keeps it honest. Reading all
 * 27 live occurrences of the wrong-ordered pattern: those that ask for a swap
 * are amendments, those that ask to send it back are returns. So a mis-order
 * alone is not enough — the customer must also be asking for a different one,
 * and must not be asking for a return or refund, which the table would have
 * scored anyway.
 *
 * Applied ONLY where no phrase matched, so it can never override the table.
 */
const ORDERED_THE_WRONG_THING = /\bfalsch\w*\s+(?:\w+\s+){0,3}bestellt\b/i;

const WANTS_A_DIFFERENT_ONE =
  /\b(?:ander(?:e|es|en|er|em)|umtausch\w*|(?:um)?tauschen|wechseln|different|swap|exchange)\b/i;

function looksLikeOwnOrderingMistake(text: string): boolean {
  return (
    ORDERED_THE_WRONG_THING.test(text) &&
    WANTS_A_DIFFERENT_ONE.test(text) &&
    !EXPLICIT_REMEDY_REQUEST.test(text)
  );
}

/**
 * A customer ASKING for delivery — soon, or by a date — rather than thanking us
 * for one that already happened.
 *
 * THE PROBLEM THIS SOLVES. "Lieferung" cannot be a signal on its own: it
 * appears in 288 live messages, and of the 39 that pair it with "schnelle", 32
 * are "vielen Dank für die schnelle Lieferung, aber ..." opening a message
 * about an invoice, a wrong colour or a missing part. Naming those Delivery
 * would tie against the category each of them actually belongs to and destroy
 * correct labels. So the delivery noun is necessary but nowhere near sufficient.
 *
 * THREE CONDITIONS, ALL REQUIRED:
 *
 *   a delivery noun      Lieferung, Versand, Zustellung, liefern.
 *   a forward-looking    "wäre dankbar für", "bitte um", "möglichst schnell",
 *      request           "schnellstmöglich", "noch diese Woche". This is what
 *                        separates asking from thanking, and it is why the bare
 *                        adjective "schnelle" is not enough on its own.
 *   not a thank-you      "vielen Dank für ...", "danke für ..." — the formula
 *                        that opens the 32. Note "dankbar" is NOT "danke": the
 *                        subjunctive "ich wäre dankbar" is a request, and the
 *                        exclusion is written so it survives.
 *
 * Applied ONLY where no phrase matched, so it cannot dilute a category the
 * table already found — which is also why the 32 thank-yous never reach it:
 * every one of them scores something else first.
 */
const DELIVERY_NOUN = /\b(?:liefer\w*|versand\w*|zustellung|zusendung|versenden|verschicken)\b/i;

const DELIVERY_REQUESTED_SOON =
  /\b(?:w(?:ä|ae)re\s+(?:ihnen\s+)?(?:sehr\s+)?dankbar|bitte\s+um|m(?:ö|oe)glichst\s+schnell\w*|schnellstm(?:ö|oe)glich\w*|umgehend\w*|baldig\w*|so\s+schnell\s+wie\s+m(?:ö|oe)glich|noch\s+diese\s+woche|bis\s+(?:zum\s+)?(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag))\b/i;

/** The thank-you formula that opens a message about something else entirely. */
const THANKS_FOR_DELIVERY = /\b(?:vielen\s+dank|besten\s+dank|danke|dank)\s+(?:f(?:ü|ue)r|nochmals)\b/i;

function looksLikeDeliveryRequest(text: string): boolean {
  return (
    DELIVERY_NOUN.test(text) &&
    DELIVERY_REQUESTED_SOON.test(text) &&
    !THANKS_FOR_DELIVERY.test(text)
  );
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

/**
 * A QUESTION THAT DOES NOT LOOK LIKE ONE — the polite request, and the
 * interrogative that is not the first word.
 *
 * WHY `ASKS_SOMETHING` ALONE WAS NOT ENOUGH. It accepts a literal "?" or an
 * interrogative at the START of a sentence, and real buyers routinely write
 * neither. Two measured failures, both from the Admin-fallback audit:
 *
 *   "Hi there what colour is the shade underneath please"
 *      -> no question mark, and "what" sits fourth. Add a comma after "Hi
 *         there" and the identical sentence classified as Pre sales, which is
 *         not a distinction any customer intends.
 *   "can I please have the measurements of the lampshades"
 *      -> a request, not a question. `PRE-SALES QUERIES.xlsx` › B lists this
 *         shape directly: "can you send me the dimensions", "could you tell me
 *         the measurement", "please can you tell me the".
 *
 * SO THE SHAPES HERE ARE THE WORKBOOK'S OWN, not a general theory of English
 * questions. Every alternative below is lifted from a trigger row: "could you
 * advise which driver" (O), "please notify me when" (W), "I need to know if it
 * will work with my" (F), "do you sell" (G), "I'm looking for a transformer"
 * (O), "I would like to see" (H), "I'm interested in navy blue lamp shades" (N).
 *
 * THIS IS NOT SUFFICIENT ON ITS OWN, and that is what keeps it safe. It only
 * ever appears alongside a product attribute, and a message reporting any
 * problem is decided by an intent that outranks pre-sales long before this is
 * consulted — see `INTENT_OWNERSHIP`.
 */
const REQUESTS_INFORMATION = new RegExp(
  [
    // "can you send me the dimensions", "could you tell me the measurement",
    // "would you post to", "will you take less".
    "\\b(?:can|could|would|will)\\s+(?:you|i|we)\\b",
    // "please can you tell me the", "please state the size", "please advise",
    // "please notify me when", "could you please check your stock".
    "\\bplease\\s+(?:can|could|would|advise|confirm|tell|state|send|provide|check|notify|let\\s+me\\s+know)\\b",
    // "I need to know if it will work with my", "I would like to see",
    // "just need to confirm it would work".
    "\\bi\\s*(?:'d|\\s+would)?\\s*(?:want|need|like|just\\s+need)\\s+to\\s+(?:know|see|check|confirm|ask|find\\s+out)\\b",
    // "I was wondering", "just wondering".
    "\\b(?:was|am|just)\\s+wondering\\b",
    // "do you sell", "does it come with a bulb", "have you got this".
    "\\b(?:do|does)\\s+(?:you|it|this|these|they|the)\\b",
    "\\bhave\\s+you\\s+got\\b",
    // "I'm looking for a transformer for", "I'm interested in navy blue lamp
    // shades", "I am after 2 meters of cable".
    "\\bi\\s*(?:'m|\\s+am)\\s+(?:looking\\s+for|interested\\s+in|after)\\b",
    // THE MID-SENTENCE INTERROGATIVE. Bounded to an interrogative followed
    // within two words by a copula or modal, so "I know what I want" cannot
    // qualify while "what colour is the shade" does.
    "\\b(?:what|which|how|whether)\\s+(?:\\w+\\s+){0,2}?(?:is|are|was|were|does|do|can|could|would|will|should|much|many|big|wide|tall|long|deep|heavy)\\b",
  ].join("|"),
  "i",
);

/** Either route to a question. Used by both the strict shape rule and the intent layer. */
function asksOrRequests(text: string): boolean {
  return ASKS_SOMETHING.test(text) || REQUESTS_INFORMATION.test(text);
}

/**
 * Attributes a buyer asks about. Closed, so an unrelated question cannot qualify.
 *
 * THE OPENING BOUND IS NOT `\b`, AND THAT IS THE POINT. Customers write the
 * number and the unit as one token — "12volt", "240v", "8.85mm", "5watt". A
 * leading `\b` needs a word boundary before "volt", and there is none between
 * "2" and "v", so every one of those was invisible to this rule. Over live eBay
 * text 1,053 messages glue a digit to a unit this way, and 54 of them carry no
 * other attribute at all — for those, this was the sole reason a plain product
 * question went unnamed.
 *
 * `(?:^|[^a-z])` requires the preceding character to be a non-letter, which a
 * digit satisfies and a letter does not. It is therefore STRICTER than `\b` on
 * the thing `\b` was there to stop: "revolt" and "champs" fail here, as they
 * did before. The closing `\b` is unchanged.
 *
 * "wired" earns its place the same way as "dimmable" and "waterproof" — a spec
 * a buyer chooses between (hard-wired versus plug-in), not a product name. 109
 * occurrences in live text.
 */
/**
 * STEMS, NOT FULL WORDS — the plural is added once, here, rather than by hand.
 *
 * THE BUG THIS REMOVES. The old list was a flat alternation with plurals
 * written in ad hoc, and it had exactly the holes you would expect: `bulb|bulbs`
 * and `fitting|fittings` were both present, `shade` was singular only, and
 * `dimensions` was plural only. So "do you sell clear glass shades as well?"
 * reached no attribute and fell to the admin catch-all, while the same sentence
 * with "shade" was named Pre sales — a distinction that exists nowhere except in
 * this regex. `measurements` failed the same way while `dimensions` passed.
 *
 * Deriving the plural from the stem makes that class of defect unrepresentable,
 * and it is why this is a list rather than a hand-written alternation.
 *
 * EVERY STEM IS GROUNDED IN A `PRE-SALES QUERIES.xlsx` TRIGGER ROW, and the
 * sheet is named against each group. Nothing here is a product word guessed
 * from general knowledge of lighting.
 *
 * THE OPENING BOUND IS STILL `(?:^|[^a-z])`, NOT `\b`, and still for the same
 * reason: customers glue the number to the unit — "12volt", "240v", "8.85mm".
 * A digit satisfies "not a letter" where `\b` would not. It also remains
 * STRICTER than `\b` on the thing `\b` was there to stop, which is what keeps
 * "champs" off `amp`, "lamp" off `amp`, "download" off `load`, "score" off
 * `core` and "screwdriver" off `driver`.
 */
const PRODUCT_ATTRIBUTE_STEMS: readonly string[] = [
  // B — DIMENSIONS AND SPECS (INT-PS03): "what are the measurements",
  // "what is the depth", "could you send me the measurements".
  "size", "length", "width", "height", "depth", "diameter", "dimension",
  "measurement", "mm", "cm", "metre", "meter", "specification",
  // B — TECHNICAL ELECTRICAL SPECS (INT-PS04): "what wattage", "what voltage",
  // "how many amps", "what is the power consumption".
  "volt", "voltage", "watt", "wattage", "amp",
  // K — BULB QUESTIONS (INT-PS15): "what bulb does it take", "what fitting is
  // it", "is it E27 or E14", "screw fit or bayonet fitting".
  "bulb", "fitting", "socket", "holder", "bayonet", "e27", "e14", "b22",
  "gu10", "lumen", "kelvin",
  // L — DIMMABLE QUERIES (INT-PS16): "is this dimmable", "dimmer switch
  // compatible".
  "dimmable", "dimmer",
  // M — OUTDOOR AND IP RATING (INT-PS17): "is this outdoor", "is it
  // weatherproof", "can I use this outside".
  "outdoor", "indoor", "waterproof", "weatherproof",
  // N — COLOUR AND FINISH (INT-PS18): "what finish is it", "is it metal or
  // plastic", "is it enamel or powder coating", "are the nuts aluminium",
  // "is it more like a copper colour".
  // "finish" is DELIBERATELY ABSENT despite being the sheet's own word. It is a
  // verb at least as often as a noun, and it cost a real conversation: "what's
  // happening with these as we're waiting on them to finish a job" is a
  // delivery chase, and this list named it a pre-sales enquiry. The noun sense
  // is still recognised — INT-PS18 carries "what finish is it" as a shape,
  // where the interrogative disambiguates it.
  "colour", "color", "material", "brass", "chrome", "copper",
  "enamel", "aluminium",
  // O — WIRING AND INSTALLATION (INT-PS19): "what cable do I need", "2 core or
  // 3 core", "braided cable", "which flex", "which driver do I need".
  "cable", "flex", "core", "wiring", "driver", "transformer", "braided",
  "twisted", "wired", "hardwired", "thread",
  // P — SHADE COMPATIBILITY (INT-PS20): "what size lampshade", "shade ring
  // size", "I require push in adapters".
  "shade", "lampshade", "adapter", "adaptor",
  // F — COMPATIBILITY QUERIES (INT-PS08): "is this compatible with", "is this
  // suitable for my".
  "compatible", "suitable",
  // Y — WEIGHT AND LOAD: "what is the weight", "what weight can it hold",
  // "maximum load", "load capacity".
  "weight", "load",
];

const PRODUCT_ATTRIBUTE = new RegExp(
  `(?:^|[^a-z])(?:${PRODUCT_ATTRIBUTE_STEMS.join("|")})(?:e?s)?\\b`,
  "i",
);

/**
 * An ingress-protection rating, which is a number and cannot be a stem.
 *
 * `PRE-SALES QUERIES.xlsx` › M lists IP44, IP65, IP45, IP67 and IP68 as
 * separate triggers, and the old attribute list named only two of them. Reading
 * the digits generically covers the rest and any rating the sheet has not
 * enumerated, which is safe because "ip" followed by two digits is not a word.
 */
const IP_RATING = /\bip\s?\d{2}\b|\bip\s+rat(?:ing|ed)\b|\bingress\s+protection\b/i;

/* ------------------------------------------------------------------------- *
 * GERMAN, TRANSLATED TO THE CST VOCABULARY RATHER THAN DUPLICATED IN IT
 *
 * THE PROBLEM, STATED HONESTLY. THE APPROVED CORPUS IS ENGLISH ONLY — verified
 * per workbook, not assumed. `PRE-SALES QUERIES.xlsx`: zero of its 1,125 stored
 * strings contain any German, and the sole occurrence of "Germany" is "ship to
 * Germany" in the international-shipping row. `Delivery_Master_Rules final.xlsx`
 * is the same — no Lieferung, no Paket, no Sendung, no "nicht erhalten"
 * anywhere. The Returns workbook is blunter still, marking DE warehouse returns
 * out of scope and asking "does this workbook apply or create German
 * equivalent?". So there is no German trigger vocabulary in the corpus to
 * extract, and writing German trigger PHRASES would be inventing CST evidence
 * that does not exist.
 *
 * SO THE GERMAN IS TRANSLATED INTO THE APPROVED VOCABULARY INSTEAD. This maps
 * German nouns onto the English term the workbooks already approve, and the
 * classification then runs against the CST concepts unchanged. "Ist die Lampe
 * für den Aussenbereich geeignet?" is checked as an outdoor-suitability
 * question — `PRE-SALES QUERIES.xlsx` › M (INT-PS17) — and "in einer Packstation
 * hinterlegt" as a collection-point case — `Delivery_Master_Rules final.xlsx`
 * › 2.4 — rather than against German phrases nobody at CST wrote.
 *
 * WHAT THAT DOES AND DOES NOT CLAIM. It does not add a category, a concept or a
 * trigger; the CST families are exactly the ones on the English side. It claims
 * only that "Außenbereich" means "outdoor" and a Packstation is a collection
 * point, which are facts about German rather than decisions about policy.
 *
 * DELIBERATELY NOUNS AND ADJECTIVES ONLY. No verbs of wanting, no question
 * forms, no problem words — those already have measured German coverage
 * elsewhere in this file, and re-stating them here would give the same message
 * two witnesses.
 */
const GERMAN_TERMS: readonly (readonly [RegExp, string])[] = [
  // M — OUTDOOR AND IP RATING
  [/\bau(?:ß|ss)enbereich\w*|\bdrau(?:ß|ss)en\b|\bau(?:ß|ss)en\b|\bim\s+freien\b/gi, "outdoor"],
  [/\bwasserdicht\w*|\bspritzwassergesch(?:ü|ue)tzt\w*/gi, "waterproof"],
  [/\bwetterfest\w*|\bwitterungsbest(?:ä|ae)ndig\w*/gi, "weatherproof"],
  [/\binnenbereich\w*/gi, "indoor"],
  // B — TECHNICAL ELECTRICAL SPECS (INT-PS04). GERMAN COMPOUNDS, so the prefix
  // is allowed rather than bounded: the customer writes "Netzspannung",
  // "Eingangsspannung", "Betriebsspannung" — mains, input and operating
  // voltage — and a `\b` before "spannung" reaches none of them. Every compound
  // ending in -spannung is a voltage and every one ending in -leistung is a
  // power rating, which is what makes the open prefix safe here and nowhere
  // else in this map.
  [/[a-zä-ü]*spannung\w*/gi, "voltage"],
  [/[a-zä-ü]*leistung\w*/gi, "wattage"],
  // O — WIRING AND INSTALLATION
  [/\bnetzteil\w*|\btrafo\w*|\btransformator\w*/gi, "transformer"],
  [/\btreiber\b/gi, "driver"],
  [/\bkabel\w*|\bleitung\w*/gi, "cable"],
  [/\badern?\b|\badrig\b/gi, "core"],
  // B — DIMENSIONS AND SPECS
  [/\babmessung\w*|\bma(?:ß|ss)e\b|\bgr(?:ö|oe)(?:ß|ss)e\b/gi, "dimensions"],
  [/\bl(?:ä|ae)nge\b/gi, "length"],
  [/\bbreite\b/gi, "width"],
  [/\bh(?:ö|oe)he\b/gi, "height"],
  [/\bdurchmesser\b/gi, "diameter"],
  // Y — WEIGHT AND LOAD
  [/\bgewicht\w*/gi, "weight"],
  [/\bbelastbarkeit\b|\btraglast\b|\btragf(?:ä|ae)higkeit\b/gi, "load"],
  // N — COLOUR AND FINISH
  [/\bfarbe\w*|\bfarbton\w*/gi, "colour"],
  [/\bmessing\b/gi, "brass"],
  [/\bkupfer\w*/gi, "copper"],
  // K — BULB QUESTIONS
  [/\bleuchtmittel\b|\bgl(?:ü|ue)hbirne\w*|\bbirne\w*/gi, "bulb"],
  [/\bfassung\w*/gi, "holder"],
  // P — SHADE COMPATIBILITY
  [/\blampenschirm\w*|\bschirm\w*/gi, "shade"],
  // L — DIMMABLE QUERIES
  [/\bdimmbar\w*/gi, "dimmable"],
  // F — COMPATIBILITY QUERIES
  [/\bgeeignet\b|\btauglich\b/gi, "suitable"],
  [/\bkompatibel\b/gi, "compatible"],

  /* ----------------------------------------------------------------------- *
   * DELIVERY, translated the same way and for the same reason.
   *
   * `Delivery_Master_Rules final.xlsx` is English-only too — verified, not
   * assumed: zero occurrences of Lieferung, Paket, Sendung or "nicht erhalten"
   * across the workbook, and the only mention of German at all is "ship to
   * Germany" in an international-shipping row. So the same rule applies as for
   * pre-sales: no German trigger phrases are invented, and the German is
   * rendered into the vocabulary CST already approves.
   *
   * PACKSTATION IS THE CASE THAT MATTERS. The word itself is absent from the
   * workbook, but the THING is not: sheet 2.4 owns "It's at a collection
   * point", "Package at the parcel shop", "Was left at a relay point", and
   * sheet 6.3 owns "Parcel is at the depot". A Packstation is a parcel locker,
   * which is a collection point — a fact about German, not a decision about
   * policy.
   * ----------------------------------------------------------------------- */
  [/\bpackstation\w*|\bpaketshop\w*|\babholstation\w*|\bpaketstation\w*|\bpostfiliale\w*|\babholort\w*/gi, "collection point"],
  [/\babholen\b|\babholung\w*/gi, "collect"],
  [/\bzugestellt\b|\bzustellung\w*/gi, "delivered"],
  [/\bnicht\s+angekommen\b/gi, "not arrived"],
  [/\bnicht\s+erhalten\b|\bnichts\s+erhalten\b|\bnichts\s+bekommen\b/gi, "not received"],
  [/\bsendungsverfolgung\w*|\btracking\w*/gi, "tracking"],
];

/**
 * The message with its German product terms rendered as the CST attribute.
 *
 * Returns the text unchanged when there is nothing to map, which is the common
 * case and costs one failed match per term.
 */
/**
 * One test that answers "is there any German here at all".
 *
 * Built from the same sources, so it cannot drift from the map it guards. Most
 * of this inbox is English, and without this every message paid for 30-odd
 * `replace` passes that could not match.
 */
const GERMAN_ANY = new RegExp(GERMAN_TERMS.map(([german]) => german.source).join("|"), "i");

function translateGermanTerms(text: string): string {
  if (!GERMAN_ANY.test(text)) return text;

  let translated = text;
  for (const [german, english] of GERMAN_TERMS) {
    translated = translated.replace(german, english);
  }
  return translated;
}

/** Whether the message names something a buyer asks about, in either language. */
function namesAProductAttribute(text: string): boolean {
  const english = translateGermanTerms(text);
  return PRODUCT_ATTRIBUTE.test(english) || NUMERIC_SPEC.test(english) || IP_RATING.test(english);
}

/**
 * A request for paperwork is an ADMIN matter, whatever product it mentions.
 *
 * `pre_sale_question` sits directly above `admin_issue` in the ownership order,
 * so widening pre-sales recognition puts invoice requests at risk: "can you
 * send me the VAT invoice for the bulbs" asks a question and names an
 * attribute. `ADMIN.xlsx` › A — INVOICE & VAT owns that message, and this is
 * the guard that keeps it.
 */
const ASKING_FOR_PAPERWORK =
  /\b(?:invoice|vat|receipt|proof\s+of\s+purchase|rechnung|beleg|quittung|kaufbeleg)\b|\b(?:instruction|installation|user|product|assembly)\s+manual\b|\bwiring\s+diagram\b|\b(?:fitting|installation|assembly)\s+instructions\b|\b(?:ce|ukca|safety|compliance|conformity)\s+(?:certificate|declaration|mark)\b|\btest\s+report\b|\bdatasheet\b|\bdata\s+sheet\b/i;

/**
 * A RETURN ALREADY UNDER WAY — post-purchase, whatever specifications it quotes.
 *
 * `!HAS_THE_GOODS` is the usual test for "this customer has not bought yet",
 * and it misses a customer who never mentions the parcel arriving because they
 * are busy sending it back. One conversation in the audit sample did exactly
 * that and this pattern is why it stays out:
 *
 *   "Due to the physical size (160mm x 140mm x 5mm) and weight (53g) of my
 *    returning parcel, I believe the cost should be no more than a standard 1st
 *    class letter. I was intending to purchase the correct item 2 core x 5 mtrs"
 *
 * Four attributes — size, mm, weight, core — and it is a return-postage
 * negotiation, which `RETURNS & REFUNDS` owns under RETURN POSTAGE COST
 * COMPLAINT. Arguing about the postage on a parcel you are returning is not a
 * pre-sales enquiry, however much specification it quotes.
 *
 * THE ACT, NOT THE POLICY QUESTION. This matches returning something, not
 * asking what the returns policy is. That distinction matters because
 * INT-PS14 (RETURN POLICY / DELIVERY / WARRANTY) is a genuine pre-sales family
 * — "what is your return policy", "how long do I have to return" — and it is
 * not implemented here. It was not among the families the audit found failing,
 * and guessing at it was out of scope for this task.
 */
const RETURN_UNDER_WAY = new RegExp(
  [
    // "my returning parcel", "I returned it", "refund the difference".
    // "RETURNING CUSTOMER" IS EXCLUDED, and it is not an edge case: it is
    // INT-PS02 (REGULAR CUSTOMER RECOGNITION), a pre-sales family in its own
    // right — "Returning customer. Do you sell rubber grommets?" is a buyer
    // introducing themselves, not a parcel going back.
    "\\breturning\\b(?!\\s+customer)",
    "\\breturned\\b",
    "\\brefund\\w*",
    "\\br(?:ü|ue)cksend\\w*|\\bretoure\\w*",
    // "send me a returns label", "a return postage label".
    "\\breturns?\\s+(?:label|postage|parcel|address|slip|code|process)\\b",
    // "I want to return item", "is it possible to return these items".
    "\\b(?:want|wish|need|going|like|possible|able)\\s+to\\s+return\\b",
    "\\breturn\\s+(?:it|them|this|these|the|item|items|my)\\b",
    "\\bsend\\s+(?:it|them|this|these)\\s+back\\b",
    // "send parcel straight back to Ledsone", "post the item back". Returns
    // INT08 lists "sent the parcel back" and "I posted it back"; the noun forms
    // were missing and a customer asking WHERE to send it back read as nothing
    // at all.
    "\\b(?:send|post|return|ship)\\s+(?:the\\s+|my\\s+)?(?:parcel|package|item|items|order|goods|lot)\\s+(?:straight\\s+|right\\s+|directly\\s+)?back\\b",
  ].join("|"),
  "i",
);

/**
 * The customer saying they do NOT want to send it back.
 *
 * Mirrors `REFUND_DECLINED` above, and exists for the same reason. "IS THE
 * WIRING INCLUDED? The light socket also DONT WANT TO RETURN IT IF I CANNOT
 * HOOK IT UP" is a wiring question with a return mentioned only to rule it out
 * — a pre-sales enquiry, and reading the return as active would lose it.
 */
const RETURN_DECLINED =
  /\b(?:do\s?n[o']?t|does\s?n[o']?t|did\s?n[o']?t|not|no)\s+(?:\w+\s+){0,2}?(?:want|wish|need|intend|going|like)\s+to\s+return\b/i;

function returnIsUnderWay(text: string): boolean {
  return RETURN_UNDER_WAY.test(text) && !RETURN_DECLINED.test(text);
}

/**
 * A rating written as a number followed by its unit — "5v", "12volt", "240v",
 * "8W", "1000mA".
 *
 * SEPARATE FROM `PRODUCT_ATTRIBUTE` BECAUSE THE DIGIT IS THE WHOLE POINT. The
 * abbreviated units are single letters, and "v" or "w" as bare vocabulary would
 * fire on every other sentence. Requiring a digit immediately before makes the
 * letter meaningless on its own: this matches "12v" and never "v". That is the
 * only reason it is safe to name them at all.
 *
 * 2,144 live eBay messages write a rating this way, which is why the spelled-out
 * list alone was never going to reach them.
 */
const NUMERIC_SPEC = /\d\s?(?:v|kv|mv|w|kw|va|ma|amp|amps|volt|volts|watt|watts)\b/i;

/**
 * HOW MANY DO I GET FOR THE MONEY — the pack-size question, asked before buying.
 *
 * THE COUNTERPART TO THE SHORTAGE RULE, and it exists for the same reason. A
 * buyer asking "is it just one crow for £19.89?" and a customer reporting "I
 * ordered 6 but only got 3" both talk about quantities, and only one of them
 * has a parcel. Nothing in `PRODUCT_ATTRIBUTE` covers pack size — it lists
 * specifications like voltage and diameter — so these questions matched no
 * pre-sales signal at all and fell to the admin catch-all.
 *
 * Every shape here is INTERROGATIVE and about the unit of sale: how many are in
 * it, whether it is one or a pair, what the price buys. `pre_sale_question`
 * still requires an actual question and still refuses once the customer has the
 * goods, so none of this can reach a message reporting a shortage — and
 * `missing_component` outranks `pre_sale_question` in any case.
 */
const PACK_SIZE_QUESTION = new RegExp(
  [
    "\\bhow\\s+many\\b",
    "\\bis\\s+(?:it|this|that)\\s+(?:just\\s+)?(?:one|1|a\\s+single)\\b",
    "\\b(?:one|1)\\s+or\\s+(?:two|2|a\\s+pair)\\b",
    "\\b(?:sold|come|comes|supplied|priced)\\s+(?:as|in)\\s+(?:a\\s+)?(?:pair|pairs|set|sets|single|singly|twos)\\b",
    "\\bas\\s+a\\s+(?:pair|set)\\b",
    "\\bdo\\s+i\\s+get\\s+(?:\\w+\\s+){0,2}?(?:one|two|three|four|\\d{1,3})\\b",
    "\\b(?:price|cost)\\s+(?:is\\s+)?for\\s+(?:one|1|a\\s+single|each|the\\s+pair)\\b",
    "\\bper\\s+(?:item|unit|piece|bulb|lamp|shade)\\b",
    // German
    "\\bwie\\s+viele?\\b",
    "\\bpro\\s+st(?:ü|ue)ck\\b",
  ].join("|"),
  "i",
);

/**
 * ASKING US TO ESTABLISH A PROPERTY OF THE PRODUCT — the shape of a
 * specification question, independent of which specification it is about.
 *
 * WHY A SHAPE AND NOT MORE VOCABULARY. `PRODUCT_ATTRIBUTE_STEMS` names the
 * attributes `PRE-SALES QUERIES.xlsx` itself names, and a buyer is not limited to
 * them: "could you confirm whether the primary and secondary windings are
 * electrically isolated" asks INT-PS04's question — TECHNICAL ELECTRICAL SPECS,
 * whose own routing note is "never guess electrical specs" — using a word that
 * appears nowhere in the 7,825 approved trigger phrases. Checked, not assumed:
 * "winding", "isolated" and "galvanic" have zero occurrences across all eleven
 * workbooks. Adding them to the stem list would be inventing CST evidence to
 * pass one message, and the next customer would use a different noun.
 *
 * So this recognises the ASK instead. INT-PS08 carries "just need to confirm it
 * would work" and INT-PS03 "could you confirm the size" — a request that we
 * establish whether something is so. That is a product-information request
 * whatever property follows it.
 *
 * IT ADDS NO REACH OF ITS OWN. `pre_sale_question` still requires a question,
 * still refuses a paperwork request, still refuses once the customer has the
 * goods, and still sits below every problem intent in `INTENT_OWNERSHIP` — so a
 * message that also reports a fault, a shortage or a non-delivery is decided by
 * that, not by this.
 */
const SPECIFICATION_QUESTION = new RegExp(
  [
    "\\b(?:confirm|clarify|verify|advise|establish)\\b[^.!?;\\n]{0,40}?\\b(?:whether|if)\\b",
    "\\b(?:know|tell\\s+me|let\\s+me\\s+know)\\b[^.!?;\\n]{0,40}?\\b(?:whether|if)\\b",
    "\\b(?:wanted|want|would\\s+like|need)\\s+to\\s+know\\b",
    // INT-PS04 "does it have to be switched manually", INT-PS15 "does it come
    // with a bulb", "does it take E27" — asking whether the product HAS a
    // feature, which is the whole of the pre-sales specification family and the
    // exact shape a missing-part report is not.
    "\\b(?:does|do|is|are|has|have)\\s+(?:it|this|that|they|these|the\\s+\\w+)\\s+(?:have|come\\s+with|comes\\s+with|include|includes|take|takes|got)\\b",
    // German: "können Sie mir sagen ob", "ich wüsste gerne ob".
    "\\b(?:sagen|wissen|best(?:ä|ae)tigen)\\b[^.!?;\\n]{0,40}?\\bob\\b",
  ].join("|"),
  "i",
);

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
    asksOrRequests(text) &&
    namesAProductAttribute(text) &&
    !ASKING_FOR_PAPERWORK.test(text) &&
    !ALREADY_PURCHASED.test(text) &&
    !AWAITING_SOMETHING.test(text) &&
    !MENTIONS_A_PROBLEM.test(text)
  );
}

/**
 * The claim each problem category rests on, for the strict table's gate.
 *
 * Only the three whose vocabulary is routinely used to DENY the problem —
 * "nothing is broken", "not faulty", "not missing anything". The other
 * categories are named by contrasts and counts, which a denial does not produce.
 */
function claimBehindCategory(category: MessageCategory): RegExp | undefined {
  if (category === "Damage queries") return IS_DAMAGED;
  if (category === "Defective items") return IS_DEFECTIVE;
  if (category === "Parts missing queries") return SOMETHING_ABSENT;
  return undefined;
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
  }))
    .filter((entry) => entry.hits > 0)
    // A PROBLEM STILL HAS TO BE CLAIMED, EVEN HERE.
    //
    // This table is the oldest witness and the only one that reads a word with
    // no clause attached, so "Nothing is broken, I just want to check the
    // wiring" scored a Damage hit on "broken" and won outright. The intent
    // layer and the corpus both refuse that already; this is the fourth route
    // to the same conclusion and needed the same gate.
    // Paperwork belongs to Admin, whatever product it names — the same guard
    // the intent layer applies, applied to this witness too.
    .filter((entry) => entry.label !== "Pre sales queries" || !ASKING_FOR_PAPERWORK.test(text))
    .filter((entry) => {
      const concept = claimBehindCategory(entry.label);
      if (concept === undefined) return true;
      const status = claimStatus(text, concept);
      // DENIALS ONLY. A tentative report — "I am just wondering if
      // something is missing?" — is still a report, and the intent layer
      // already separates a specification question from a claim.
      return status !== "negated";
    });

  // No phrase matched. Two shapes are still safe to name — the customer's own
  // mis-order wanting a swap, then a pre-sales enquiry. Checked in that order
  // because the first is the narrower of the two.
  if (scored.length === 0) {
    if (looksLikeOwnOrderingMistake(text)) return "Order change, before shipping queries";
    if (looksLikeDeliveryRequest(text)) return "Delivery queries";
    return looksPreSales(text) ? "Pre sales queries" : null;
  }

  // THE GATE. "Return and refunds" is an outcome, so it may not take a
  // conversation away from the problem that describes it unless the customer
  // asks for their money back. Without that, the return wording is a route the
  // customer is offering, and the problem category stands.
  //
  // Only ever removes Return when something else is there to take it: a message
  // that is nothing BUT a return request ("please send a returns label") has no
  // problem category to fall back on, and stays Return and refunds.
  const afterGate =
    !wantsMoneyBack(text) &&
    scored.some((entry) => entry.label === "Return and refunds") &&
    scored.some((entry) => PROBLEM_CATEGORIES.includes(entry.label))
      ? scored.filter((entry) => entry.label !== "Return and refunds")
      : scored;

  // Damage described on the PACKAGING, alongside something absent from inside
  // it, is context for the missing part rather than a complaint of its own.
  // Bounded to a single damage word, so a message that also reports the goods
  // themselves damaged keeps both signals and refuses as before.
  const damage = afterGate.find((entry) => entry.label === "Damage queries");
  const contenders =
    damage?.hits === 1 &&
    afterGate.some((entry) => entry.label === "Parts missing queries") &&
    PACKAGING_DAMAGE.test(text)
      ? afterGate.filter((entry) => entry.label !== "Damage queries")
      : afterGate;

  contenders.sort((a, b) => b.hits - a.hits);
  const [best, runnerUp] = contenders;

  // Wrong item / Order change against Return: decided by whether the money is
  // being asked for, at any score. See `REMEDY_REQUEST_DECIDES`.
  if (runnerUp !== undefined) {
    const byRemedy = remedyRequestWinner(best!.label, runnerUp.label, text);
    if (byRemedy !== null) return byRemedy;
  }

  if (runnerUp !== undefined && runnerUp.hits === best!.hits) {
    // A tie is genuine ambiguity and normally returns null. The exception is a
    // pair where the same words routinely mean one of them — see
    // `TIE_PRECEDENCE`. Anything not listed there still refuses.
    return precedenceWinner(best!.label, runnerUp.label);
  }

  return best!.label;
}

/* ------------------------------------------------------------------------- *
 * INTENT FALLBACK
 *
 * A SECOND LAYER, NOT A REPLACEMENT. Everything above is untouched and still
 * decides every conversation it can. What follows runs ONLY on the messages
 * that layer declined, and it exists because "no category" is not a useful
 * answer to give a CST agent looking at a real customer asking a real question.
 *
 * WHY IT IS SAFE TO BE LOOSER HERE. The phrase table is deliberately strict: it
 * has to survive being wrong in the presence of competing signals, so it
 * refuses on ties and demands specific wording. By the time control reaches
 * this layer, the table has already found NOTHING — there is no correct label
 * to destroy and no tie to lose. The cost of a loose signal here is a
 * second-best category instead of a blank; the cost of a loose phrase up there
 * is a wrong answer where a right one existed. That asymmetry is the whole
 * justification for the two layers having different standards of evidence.
 * ------------------------------------------------------------------------- */

/**
 * The intents this layer can recognise, named as the reviewer thinks about
 * them rather than as the regexes happen to be written.
 */
export type MessageIntent =
  | "received_wrong_item"
  | "missing_component"
  | "wrong_quantity_sent"
  | "damaged_product"
  | "defective_product"
  | "wrong_description"
  | "wants_refund"
  | "wants_post_delivery_return"
  | "wants_replacement"
  | "wants_order_change"
  | "delivery_request"
  | "pre_sale_question"
  | "admin_issue";

/** Any sign the goods are already with the customer. Broader than `ALREADY_PURCHASED`. */
/**
 * YOU CANNOT CONNECT SOMETHING YOU HAVE NOT RECEIVED.
 *
 * The receipt verbs miss the customer who never mentions the parcel because
 * they are already using the thing: "Connected to 12v led light and it is
 * pulsing - what say you?" reached no arrival signal at all, so the journey read
 * as PROSPECTIVE, "12v" reached the attribute list, and a fault report was filed
 * as a pre-sales enquiry.
 *
 * THE PAST TENSE IS THE WHOLE OF IT. "Connected", "wired", "fitted" say it has
 * happened; "how do I connect this", "can it be wired to a dimmer" ask whether
 * it could, and those are INT-PS19 and sheet Z — genuine pre-sales. The
 * lookbehinds keep the infinitive and the passive out.
 */
const ALREADY_IN_USE =
  /(?<!\bto\s)(?<!\bbe\s)(?<!\bbeing\s)(?<!\bget\s)(?<!\bgets\s)\b(?:connected|wired|fitted|installed|mounted|assembled|hooked\s+up|plugged\s+in|angeschlossen|montiert|installiert)\b/i;

const HAS_THE_GOODS = new RegExp(
  `\\b(?:received|receive|arrived|delivered|came|sent|got|turned\\s+up|opened|unpacked|erhalten|bekommen|geliefert|angekommen|ausgepackt)\\b|${ALREADY_IN_USE.source}`,
  "i",
);

/**
 * The goods are not the ones ordered.
 *
 * "the correct one" / "the right one" are here because that is how a customer
 * asks for the swap without ever using the word "wrong" — "can you send the
 * correct one and I'll send this one back". Paired with `HAS_THE_GOODS`, so a
 * pre-purchase "which is the right one for my lamp?" cannot reach it.
 *
 * "NOT WHAT I ORDERED" IS A MISMATCH; "NOT WHAT I EXPECTED" IS NOT. This used
 * to match a bare "not what i", which reads an ORDER against what arrived and
 * an EXPECTATION against what arrived as the same claim. They are not: the
 * first says we sent something other than what was bought, the second says the
 * customer does not like what they bought — "I received my parcel today but the
 * colour is not what I expected" is a preference, and the remedy is a return,
 * not us correcting an error. So the verb is required, and the verbs listed are
 * the ones that name the purchase. A customer who genuinely got the wrong thing
 * almost always says "wrong" too, which is the first alternative here and is
 * untouched.
 */
const A_MISMATCH =
  /\b(?:wrong|incorrect|not\s+what\s+i\s+(?:(?:'ve|have|had)\s+)?(?:ordered|order|asked|requested|bought|purchased|paid|chose|chosen|selected)|not\s+the\s+one|different\s+(?:item|product|one|model|type|thing)|(?:completely|totally|entirely)\s+different|(?:the\s+)?(?:correct|right)\s+one|falsch\w*|nicht\s+das\s+was)\b/i;

/**
 * Something that should be in the package is not — stated as an ABSENCE.
 *
 * "only received one" USED TO BE HERE AND IS NOT ANY MORE. `only <count>`,
 * `only received <count>`, `only got <count>` named a parts case from a single
 * number with nothing to compare it against, so "I only received one" was a
 * missing part while saying nothing about how many were expected. A count on
 * its own is not a shortfall; a count that is SMALLER THAN THE ONE ORDERED is,
 * and that comparison now lives in `orderedMoreThanArrived` where the two
 * quantities are actually read against each other. What stays here is wording
 * that asserts the absence outright, which needs no arithmetic.
 *
 * "SHOULD BE N" LEFT FOR THE SAME REASON. It states an EXPECTED QUANTITY, not
 * an absent component — "should be three" says how many were due and nothing
 * about a part. Every message carrying it also carries the count that arrived,
 * so the numeric comparison reaches it and names it the quantity case it is.
 * Leaving it here made the same sentence a parts case or a quantity case
 * depending only on which rule happened to be consulted first.
 *
 * "NOTHING TO" IS NOW "NOTHING TO HANG IT WITH", and the difference cost a real
 * conversation. The bare fragment was a generalisation of the Parts-missing
 * phrase "nothing to hang", and it fired on "it unfortunately has nothing to do
 * with my actual question" — a customer correcting our answer, asserting no
 * absence whatever, filed as a missing part. The fixing verbs are the sense
 * `missing parts query .xlsx` actually means.
 *
 * "ARE NOT THERE" IS ADDED for the opposite reason: `INT-MP04` lists "part
 * wasn't there" and "part absent", and "the screws that should have been
 * included are not there" matched nothing at all.
 */
const SOMETHING_ABSENT =
  /\b(?:missing|incomplete|not\s+included|no\s+screws|nothing\s+to\s+(?:hang|fix|attach|mount|secure|hold|screw|fasten)|short\s+of|(?:arrived|received|recieved|came)\s+without\s+(?!a\s+(?:mark|scratch|scratches|blemish|problem|issue|hitch|fault)\b)|(?:are|is|was|were)\s?n[o']?t\s+(?:there|in\s+the\s+box|included|present)|fehl\w*|unvollst(?:ä|ae)ndig|nicht\s+enthalten)\b/i;

/**
 * A shortfall stated as ARITHMETIC rather than as the word "missing".
 *
 * "Leider sind nur 2 Lampenschirme dabei. Es sollten aber 3 dabei sein." — the
 * customer never says fehlt, fehlen or unvollständig anywhere in the message.
 * They say they got two and should have three, and leave us to subtract. No
 * phrase can reach that, in any language, because the meaning is in the numbers.
 *
 * SO THE NUMBERS ARE COMPARED. Take the count in the "only ..." clause, and
 * look for any larger count elsewhere in the same message. That is what makes
 * this safe where a bare "nur + numeral" was not: "ich habe nur 2 bestellt"
 * names one count and cannot fire, while "nur 2 ... sollten aber 3" names two
 * and does. 165 live messages use "nur" with a numeral; requiring a second,
 * larger count is what separates the shortfalls from the rest.
 *
 * Digits are bounded to three, so a year or an order number cannot be mistaken
 * for a quantity.
 */
const COUNT_WORD: Readonly<Record<string, number>> = {
  ein: 1, eine: 1, einen: 1, einem: 1, einer: 1, eins: 1, one: 1,
  zwei: 2, two: 2, drei: 3, three: 3, vier: 4, four: 4,
  "fünf": 5, fuenf: 5, five: 5, sechs: 6, six: 6, sieben: 7, seven: 7,
  acht: 8, eight: 8, neun: 9, nine: 9, zehn: 10, ten: 10,
};

const COUNT_TOKEN = `\\d{1,3}|${Object.keys(COUNT_WORD).join("|")}`;

/**
 * A count that is a QUANTITY, not a price.
 *
 * "Is it just one crow for £19.89?" was named Parts missing. `just one` gave a
 * received count of 1, and the scan for a larger count found "19" inside
 * "£19.89" — both boundaries hold there, because "£" and "." are non-word
 * characters. A price was read as a quantity of goods, and the pre-sales
 * question became a shortfall report.
 *
 * So a quantity may not sit against a currency symbol or inside a decimal. The
 * lookbehind rejects "£19" and the "89" of "19.89"; the lookahead rejects the
 * "19" of "19.89". The three-digit bound on `COUNT_TOKEN` already kept years and
 * order numbers out, and still does.
 */
const QUANTITY = `(?<![£$€\\d.,])(?:${COUNT_TOKEN})(?!\\d*\\s*[.,]\\d)`;

const ONLY_THIS_MANY = new RegExp(
  `\\b(?:nur|only|just|lediglich)\\s+(?:noch\\s+)?(${QUANTITY})\\b`,
  "i",
);

function countValue(token: string): number {
  return COUNT_WORD[token.toLowerCase()] ?? Number(token);
}

function looksLikeShortfall(text: string): boolean {
  const received = ONLY_THIS_MANY.exec(text);
  if (received === null) return false;

  const got = countValue(received[1] ?? "");
  if (!Number.isFinite(got)) return false;

  // A fresh regex each call: a global one carries `lastIndex` between calls, and
  // this function has to stay pure.
  for (const match of text.matchAll(new RegExp(`\\b(${QUANTITY})\\b`, "gi"))) {
    if (countValue(match[1] ?? "") > got) return true;
  }
  return false;
}

/* ------------------------------------------------------------------------- *
 * QUANTITY SHORTAGE: WHAT WAS ORDERED AGAINST WHAT TURNED UP
 *
 * WHY `looksLikeShortfall` ALONE WAS NOT ENOUGH. It requires the received count
 * to sit IMMEDIATELY after "only" / "nur" / "just", and then accepts any larger
 * number anywhere in the message as the expectation. Both halves fail on real
 * wording:
 *
 *   "I ordered 6 bulbs but have only recieved 3"   the count is three words
 *                                                  after "only", not next to
 *                                                  it — and the verb is
 *                                                  misspelled, which no fixed
 *                                                  phrase survives.
 *   "Is it just one crow for £19.89?"              a price stood in for the
 *                                                  expectation. (Fixed above.)
 *
 * WHAT THIS DOES INSTEAD. Every quantity in the message is given a ROLE from
 * the nearest verb governing it — was this number ORDERED, or was it RECEIVED?
 * A shortage is then the arithmetic it always was: the smallest received count
 * is lower than the largest expected count. No phrase has to be enumerated,
 * because what carries the meaning is the pairing of two numbers with two
 * roles, and that is what is read.
 *
 * THIS IS ALSO THE GUARD. A message with only ONE role present cannot be a
 * shortage: "I only ordered 2 of these" has an expectation and no receipt, "I
 * only received one" has a receipt and no expectation, and "How many are
 * included?" has neither. None of them can reach a comparison, which is exactly
 * why a pre-sales question about pack size cannot become a parts case.
 * ------------------------------------------------------------------------- */

/** How far either side of a number to look for the verb that governs it. */
const QUANTITY_WINDOW = 45;

/** The number is what the customer ORDERED, or was told to expect. */
const EXPECTATION_VERB =
  /\b(?:ordered|order|bought|purchased|paid\s+for|requested|expected|expecting|should\s+(?:have\s+)?(?:be|been|contain|receive|received|recieved|got|had)|(?:meant|supposed)\s+to\s+(?:be|have|contain|receive)|bestellt|gekauft|sollte|sollten|m(?:ü|ue)ssten|erwartet)\b/gi;

/** The number is what actually turned up. */
/**
 * "GOT TO" IS NOT "GOT".
 *
 * `got` is the commonest way a customer says a thing arrived, and it is also
 * half of a verb of PROGRESS. Both appear in the same message:
 *
 *   "I purchased 2 of these lights ... he fitted one which was great but when he
 *    got to the second one it was missing one of the hollow bolts and nut"
 *
 * Both lights arrived. The electrician fitted one and reached the second, which
 * is missing a component — a Parts missing case. Reading "got to the second one"
 * as a receipt of one unit paired it with the "2" and made it a quantity error,
 * which sends an agent to dispatch a whole light instead of a bolt.
 *
 * The exclusion is only the prepositions that turn it into motion. "Got 3 of the
 * 6" is untouched, and so is every other receipt verb.
 */
const RECEIPT_VERB =
  /\b(?:received|recieved|got(?!\s+(?:to|round|around|as\s+far|onto|up\s+to))|arrived|came|delivered|sent|turned\s+up|in\s+the\s+(?:box|parcel|package)|dabei|angekommen|erhalten|bekommen|geliefert)\b/gi;

/**
 * The clause the number sits in — a verb in a neighbouring clause is not its
 * verb.
 *
 * "BUT" IS A CLAUSE BREAK HERE, and it has to be. The whole shape of a shortage
 * report is expectation-BUT-reality: "I should have received 4 but only got 2".
 * The verb governing the 4 is "should have received", 21 characters behind it;
 * the verb governing the 2 is "got", and it sits only 11 characters AHEAD of the
 * 4. Measuring by distance alone hands the 4 to "got", both numbers read as
 * receipts, and the shortage disappears. Sentence punctuation alone does not
 * separate them because the customer wrote one sentence.
 */
const CLAUSE_BREAK = /[.!?]|\b(?:but|however|though|whereas|aber|jedoch)\b/gi;

function clauseBefore(window: string): string {
  const breaks = [...window.matchAll(CLAUSE_BREAK)];
  const last = breaks.at(-1);
  return last === undefined ? window : window.slice(last.index + last[0].length);
}

function clauseAfter(window: string): string {
  const first = [...window.matchAll(CLAUSE_BREAK)][0];
  return first === undefined ? window : window.slice(0, first.index);
}

type Span = { readonly start: number; readonly end: number };

/** Fresh regex per call: a global one carries `lastIndex`, and this stays pure. */
function spansOf(pattern: RegExp, text: string): Span[] {
  return [...text.matchAll(new RegExp(pattern.source, "gi"))].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/**
 * Which role the nearest governing verb gives this number.
 *
 * NEAREST WINS, AND OVERLAPS GO TO THE EXPECTATION. "I should have received 4"
 * contains the receipt verb "received" INSIDE the expectation phrase "should
 * have received", and read naively the receipt verb is nearer to the 4. It is
 * not a separate verb, so a receipt match that falls within an expectation match
 * is discarded. Without that, "I should have received 4 but only got 2" reads
 * as two receipts and no expectation, and no shortage is found.
 *
 * BOTH SIDES ARE MEASURED, not one preferred over the other. English puts the
 * verb ahead of the count ("ordered 6") and German puts it behind ("6 Lampen
 * bestellt", "eine Lampe angekommen"), so neither side can be consulted first:
 * "I bought 5 shades and 2 turned up" has an expectation verb 20 characters
 * behind the 2 and the receipt verb that actually governs it 2 characters
 * ahead. Whichever is nearer wins, and a tie goes to the expectation.
 */
function roleOfQuantity(before: string, after: string): "expected" | "received" | null {
  let nearestExpectation = Infinity;
  let nearestReceipt = Infinity;

  // THE GAP BETWEEN VERB AND NUMBER, measured the same way on both sides. An
  // earlier version measured to the verb's START on both, which quietly
  // penalised the side where the verb comes first: in "I ordered 5 and received
  // 2" the word "ordered" ENDS one character before the 5, but its start is
  // eight away — further than "received" reads from the other direction. The 5
  // was taken for a receipt, both numbers came out as receipts, and a plain
  // shortage found nothing to compare.
  for (const [window, distance] of [
    [before, (span: Span) => before.length - span.end],
    [after, (span: Span) => span.start],
  ] as const) {
    const expectations = spansOf(EXPECTATION_VERB, window);
    // A receipt verb sitting INSIDE an expectation phrase is not a verb of its
    // own: "should have received" contains "received", and reading it as a
    // receipt turns an expectation into one.
    const receipts = spansOf(RECEIPT_VERB, window).filter(
      (receipt) =>
        !expectations.some((expect) => receipt.start >= expect.start && receipt.start < expect.end),
    );

    for (const span of expectations) nearestExpectation = Math.min(nearestExpectation, distance(span));
    for (const span of receipts) nearestReceipt = Math.min(nearestReceipt, distance(span));
  }

  if (nearestExpectation === Infinity && nearestReceipt === Infinity) return null;
  return nearestExpectation <= nearestReceipt ? "expected" : "received";
}

/** True when the customer names a count they expected and a smaller count that came. */
function orderedMoreThanArrived(text: string): boolean {
  const expected: number[] = [];
  const arrived: number[] = [];

  for (const match of text.matchAll(new RegExp(`\\b(${QUANTITY})\\b`, "gi"))) {
    const value = countValue(match[1] ?? "");
    if (!Number.isFinite(value)) continue;

    const start = match.index;
    const end = start + match[0].length;
    const role = roleOfQuantity(
      clauseBefore(text.slice(Math.max(0, start - QUANTITY_WINDOW), start)),
      clauseAfter(text.slice(end, end + QUANTITY_WINDOW)),
    );

    if (role === "expected") expected.push(value);
    if (role === "received") arrived.push(value);
  }

  if (expected.length === 0 || arrived.length === 0) return false;
  return Math.min(...arrived) < Math.max(...expected);
}

/**
 * Part of the order came and part of it did not, with no numbers given at all.
 *
 * "Only half of my order arrived" states the shortage as a fraction. A receipt
 * verb is still required somewhere in the message, so a sentence about half an
 * order that was never delivered cannot land here.
 */
const PARTIAL_ORDER =
  /\b(?:only|just)\s+(?:half|part|some|a\s+few|a\s+couple)\s+of\s+(?:my|the|our|this)\s+(?:order|orders|parcel|package|delivery|shipment|items?|goods)\b/i;

/**
 * Why a message counts as a quantity shortage, or null when it does not.
 *
 * DETERMINISTIC AND REPORTABLE. Exported so a reviewer can ask which of the
 * three kinds of evidence fired rather than re-deriving it from the category —
 * "Parts missing queries" alone does not say whether the customer counted the
 * units, said half the order came, or simply told us a part was absent. Only
 * the reason is returned; nothing about the customer or the message is carried
 * out of this function.
 */
export type ShortfallReason =
  | "ORDERED_QUANTITY_GREATER_THAN_RECEIVED"
  | "PARTIAL_ORDER_RECEIVED"
  | "MISSING_ORDER_COMPONENT";

/**
 * WHICH CASE EACH KIND OF SHORTAGE IS. The distinction CST draws, written once.
 *
 * A SHORTAGE IS NOT AUTOMATICALLY A PARTS CASE, and treating it as one was the
 * defect this table fixes. "I ordered 6 bulbs but have only recieved 3" is not
 * a bulb with a component absent from it — every bulb that arrived is complete.
 * Three of the six units are simply not there, which is a quantity error
 * against the order. "The lamp arrived but the screws are missing" is the other
 * thing entirely: the unit is present and something that belongs with it is not.
 *
 * The two are told apart by WHAT IS COUNTED. Counting units against the order
 * gives a quantity case; naming a component that should have been in the box
 * gives a parts case. That is exactly the split `quantityShortfallEvidence`
 * already draws, so the reason code carries it and nothing else has to decide.
 *
 * ORDER OF EVIDENCE MATTERS, and it is decided in `quantityShortfallEvidence`
 * rather than here: the numeric comparison is tried BEFORE the absence wording,
 * so "Only two lampshades arrived but should be three" is read as the quantity
 * case it is, even though "should be three" also reads as an expectation left
 * unmet. A message that names a component AND no counts still reaches the
 * absence branch untouched.
 */
const SHORTFALL_INTENT: Readonly<Record<ShortfallReason, MessageIntent>> = {
  ORDERED_QUANTITY_GREATER_THAN_RECEIVED: "wrong_quantity_sent",
  PARTIAL_ORDER_RECEIVED: "wrong_quantity_sent",
  MISSING_ORDER_COMPONENT: "missing_component",
};

/**
 * IS THE COUNT MEASURED AGAINST THE ORDER, OR AGAINST WHAT THE BOX SHOULD HOLD?
 *
 * THE ONE QUESTION THAT SEPARATES THE TWO CASES, and a count alone cannot
 * answer it. Both of these are "2 where 3 were due" and they are different CST
 * cases:
 *
 *   "Hi i ordered 2 of these and only received 1 of the drivers"
 *      -> the customer bought two units and one came. The shipment is short
 *         against the ORDER: a quantity error.
 *   "Ich habe die Hängeleuchte erhalten. Leider sind nur 2 Lampenschirme
 *    dabei. Es sollten aber 3 dabei sein."
 *      -> ONE pendant lamp was ordered and one arrived, complete except that
 *         two of its three shades are in the box. The order quantity is right;
 *         a component of the product is absent: a parts case.
 *
 * So the anchor decides. A reference to what was ORDERED, BOUGHT, PAID FOR or
 * SHOULD HAVE BEEN RECEIVED measures the delivery against the order. Wording
 * that only says what should BE there — "should be three", "sollten 3 dabei
 * sein", "meant to be" — measures the contents of what arrived, and says
 * nothing about how many units were bought.
 *
 * This is why the two near-identical German and English threads come out
 * differently, and both are right.
 */
const MEASURED_AGAINST_THE_ORDER =
  /\b(?:ordered|order|orders|bought|purchased|paid\s+for|expected|expecting|should\s+have\s+(?:received|recieved|got|had|been\s+sent)|fewer\s+than|short\s+delivery|bestellt|bestellung|gekauft|erwartet)\b/i;

export function quantityShortfallEvidence(customerText: string | null): ShortfallReason | null {
  const text = normalise(customerText?.trim() ?? "");
  if (text === "") return null;

  // "uns fehlt die Rechnung" — the absent thing is the paperwork. Guarded at the
  // source rather than at each caller: `refine` already refuses it for the
  // intent layer, and the same evidence reaching the semantic reading by a
  // different route made a German invoice request a parts case again.
  if (ADMIN_IS_WHAT_IS_MISSING.test(text)) return null;

  if (orderedMoreThanArrived(text) || looksLikeShortfall(text)) {
    return MEASURED_AGAINST_THE_ORDER.test(text)
      ? "ORDERED_QUANTITY_GREATER_THAN_RECEIVED"
      : "MISSING_ORDER_COMPONENT";
  }
  if (PARTIAL_ORDER.test(text) && new RegExp(RECEIPT_VERB.source, "i").test(text)) {
    return "PARTIAL_ORDER_RECEIVED";
  }

  /*
   * "THERE WAS ONLY ONE" — a shortage with no arithmetic in it.
   *
   * `wrong quantity.xlsx` INT-WQ03 lists exactly this shape: "only received
   * one", "only got one", "only one in the box", "there was only one". The
   * customer names what turned up and leaves the expectation implicit, so
   * `orderedMoreThanArrived` finds no pair of numbers to compare and every other
   * test above finds no absence word. "I've just received my lampshades, however
   * there was only one white plastic bit" was an admin fallback because of it.
   *
   * WHICH CATEGORY IT IS, IS ALREADY DECIDED ABOVE and is not re-decided here:
   * counted against the ORDER it is a quantity error, and otherwise it is a
   * component absent from goods that did arrive. Two lampshades with one reducer
   * ring between them is the second of those.
   *
   * The arrival test is what keeps it off "could I have only one please".
   */
  if (BARE_SHORTFALL.test(text) && HAS_THE_GOODS.test(text)) {
    return MEASURED_AGAINST_THE_ORDER.test(text)
      ? "ORDERED_QUANTITY_GREATER_THAN_RECEIVED"
      : "MISSING_ORDER_COMPONENT";
  }

  if (SOMETHING_ABSENT.test(text)) return "MISSING_ORDER_COMPONENT";
  return null;
}

/** INT-PS09/INT-PS11: availability and restock, which belong to pre-sales. */
const ASKING_ABOUT_STOCK =
  /\b(?:back\s+)?in\s+stock\b|\brestock\w*|\bout\s+of\s+stock\b|\bavailable\s+again\b|\bstock\s+levels?\b|\bwhen\s+(?:will|are)\s+you\s+(?:get|getting|have|restocking)\b/i;

/**
 * INT-WQ03's own wording for a shortage the customer does not count out.
 *
 * IT HAS TO NAME WHAT IS SHORT. "I only received one" names a count and nothing
 * else, and is already pinned as NOT a shortage — one role is not a comparison,
 * and a bare count in the middle of a thread means nothing on its own. "There
 * was only one white plastic bit" names the thing, which is the difference
 * between a fragment and a claim.
 */
const NAMES_WHAT_IS_SHORT = "(?!of|and|or|but|so|as|for|to|in|at|on)\\b[a-z]{3,}\\b";

const BARE_SHORTFALL = new RegExp(
  [
    `\\b(?:there\\s+(?:was|were)|was)\\s+only\\s+(?:one|1|a\\s+single)\\s+${NAMES_WHAT_IS_SHORT}`,
    `\\bonly\\s+(?:received|recieved|got|sent|had)\\s+(?:one|1|a\\s+single)\\s+${NAMES_WHAT_IS_SHORT}`,
    "\\bonly\\s+(?:one|1)\\s+(?:\\w+\\s+){0,3}?in\\s+the\\s+(?:box|package|parcel|bag|envelope)\\b",
  ].join("|"),
  "i",
);

/**
 * The goods are physically damaged.
 *
 * THE LAST FIVE ALTERNATIVES COME FROM THE DAMAGE WORKBOOK, not from live text,
 * and they closed a real gap. `DAMAGE DECISION GUIDE.xlsx` writes the severe
 * band as "arrived broken / smashed / shattered" and the cosmetic band as
 * "small chip on edge", "paint chipped", "surface scuff", "line crack /
 * fracture" — one row, several words for the same damage. This pattern knew
 * "smashed" and "broken" and had never been given "shattered", so "the glass
 * shade arrived shattered" reported no damage at all and fell to the admin
 * catch-all. Same for chipped, crushed, scuffed and fractured.
 *
 * "chip" is bounded to its damage sense (`chip on`, `chipped`) because the bare
 * noun is not one.
 */
const IS_DAMAGED =
  /\b(?:damag\w*|broken|smash\w*|crack\w*|dent\w*|scratch\w*|besch(?:ä|ae)digt|zerbrochen|zerkratzt|shatter\w*|chipped|chip\s+(?:on|off)|crush\w*|scuff\w*|fractur\w*)\b|\b(?:slightly\s+)?(?:bent|buckled|warped|misshapen)\b|\b(?:burn\s+marks?|melted|melting|heat\s+damage|discolour\w*|discolor\w*|blemish\w*|fray\w*|loose\s+threads?)\b|\b(?:not\s+perfectly\s+round|shape\s+(?:is\s+)?off|slight\s+wobble)\b/i;

/**
 * The goods are intact and they do not work.
 *
 * "SWITCH ON" / "TURN ON" / "COME ON" ADDED from `DEFECTIVE .xlsx` — INT-DF05
 * lists "won't turn on" and INT-DF07 "it doesn't come on". The pattern knew
 * only "does not WORK", so "I wired it correctly but it does not switch on" —
 * as plain a fault report as a customer can write — reached no fault signal at
 * all.
 */
const IS_DEFECTIVE =
  /\b(?:faulty|defect\w*|not\s+work\w*|does\s?n[o']?t\s+work|stopped\s+working|dead\s+on\s+arrival|flicker\w*|funktioniert\s+nicht|kaputt)\b|\b(?:does\s?n[o']?t|do\s?n[o']?t|wo\s?n[o']?t|will\s+not|did\s?n[o']?t)\s+(?:switch|turn|come|light)\s+(?:on|up)\b|\bnot\s+(?:switching|turning|coming|lighting)\s+(?:on|up)\b|\b(?:gone|went|goes|with\s+a|a\s+loud)\s+bang\b|\b(?:blew|blown)\s+(?:up|out)\b|\b(?:capacitor|fuse|bulb)\s+(?:blew|has\s+blown)\b|\bit\s+burst\b|\bburn(?:t|ed)\s+out\b|\b(?:puls\w*|flash\w*|strob\w*|blink\w*)\b|\b(?:on\s+off|on\s+and\s+off)\s+(?:per\s+sec|every|constantly|repeatedly)\b|\b(?:not|never)\s+soldered\b|\b(?:wires|cables?)\s+(?:are\s+)?not\s+(?:connected|soldered|joined)\b|\bnot\s+connecting\b|\b(?:arm|bracket|frame)\s+(?:is\s+)?not\s+(?:straight|flush|level)\b|\bkeeps\s+rotating\b|\bshort\s+circuit\b/i;

/**
 * WHAT ARRIVED IS THE WRONG SIZE — the other half of "wrong item sent".
 *
 * `Wrong item sent  final.xlsx` › 8 — MEASUREMENT & SIZE is a whole sheet of it,
 * and INT-WI07 and INT-WI08 are its trigger rows: "too short", "too small",
 * "wrong length", "wrong diameter", "doesn't fit". None of those is an
 * ordered-X-received-Y contrast, which is the only shape `A_MISMATCH` knows, so
 * "the screws sent for the clear parts are too small" reached no wrong-item
 * signal at all and fell to the admin catch-all.
 *
 * A SIZE COMPLAINT IS ONLY A WRONG ITEM ONCE THE GOODS ARE HERE — before that
 * it is a pre-sales fit question ("will this shade be too big for my pendant?").
 * The callers pair this with an arrival test for exactly that reason.
 */
const SIZE_OR_FIT_MISMATCH =
  /\btoo\s+(?:big|large|small|short|long|wide|narrow|thick|tight)\b|\bwrong\s+(?:size|sizes|diameter|dimensions?|length|width)\b|\b(?:does|do|did|would)\s?n[o']?t\s+fit\b|\bwo\s?n[o']?t\s+fit\b|\bnot\s+(?:the\s+)?right\s+(?:size|length|diameter|width)\b|\bmuch\s+(?:shorter|smaller|bigger|larger|longer)\b|\bnot\s+long\s+enough\b/i;

/**
 * WHAT ARRIVED IS THE OTHER THING — a mismatch stated without the word "wrong".
 *
 * `A_MISMATCH` knows the vocabulary of wrongness ("wrong", "not what I
 * ordered", "different item"). It does not know the two constructions customers
 * use most often to say the same thing without it:
 *
 *   "you sent the 20cm shade INSTEAD OF the 30cm one"
 *   "the supplied fitting BELONGS TO ANOTHER type of light"
 *
 * `Wrong item sent  final.xlsx` is built out of the first — INT-WI02 through
 * INT-WI06 are almost entirely "X not Y" and "X instead of Y" — and sheet 4
 * (DIFFERENT ITEM UNUSABLE) is the second. Without them a supplied-but-wrong
 * component reached no wrong-item signal at all.
 */
const SUPPLIED_THE_OTHER_THING =
  /\binstead\s+of\b|\b(?:belongs|is\s+for|are\s+for|meant\s+for)\s+(?:to\s+)?(?:a\s+|an\s+)?(?:different|another|other)\b|\bfor\s+(?:a\s+|an\s+)?(?:different|another)\s+(?:type|model|kind|version|fitting|light|lamp)\b|\bnot\s+the\s+(?:type|kind|model|version|size)\s+(?:i|we)\s+(?:ordered|bought|wanted|expected)\b/i;

/** A reference to what the listing promised, and a statement that reality differs. */
const LISTING_REFERENCE =
  /\b(?:photo|photograph|picture|image|listing|advert\w*|description|described|depicted|portray\w*|shown|specification|specs?|abbildung|beschreibung)\b/i;

const REALITY_DIFFERS =
  /\b(?:cannot|can\s?n[o']?t|can\s+not|unable|does\s?n[o']?t|do\s?n[o']?t|is\s?n[o']?t|are\s?n[o']?t|not|but|however|instead|different|mismatch|nicht|anders)\b/i;

/**
 * THE CLAIM ITSELF: the listing said one thing and the goods are another.
 *
 * `LISTING_REFERENCE` and `REALITY_DIFFERS` are each one half of a description
 * complaint and neither is the complaint. Tested independently across a whole
 * message they matched "as per the photograph" and "however" — 53 characters
 * apart, in unrelated clauses — and named a smashed shade a description error.
 *
 * This is the sentence a description complaint actually contains, taken from
 * `WRONG DESCRIPTION.xlsx` INT-WD07: "not as described", "the listing said",
 * "description doesn't match", "advertised as". Requiring it ALONGSIDE the two
 * halves keeps the measured breadth of the old rule while insisting that
 * somewhere in the message the customer made the claim.
 */
const LISTING_MISMATCH =
  /\bnot\s+as\s+(?:described|advertised|listed|shown|pictured)\b|\bas\s+(?:shown|depicted|portrayed|pictured|illustrated|described|advertised)\b|\b(?:listing|description|advert\w*|website|photo\w*|picture|image|spec\w*)\b[^.!?;\n]{0,40}?\b(?:says?|said|states?|stated|shows?|showed|claims?|promised|portray\w*|depict\w*|illustrat\w*)\b|\b(?:described|advertised|listed|sold)\s+as\b|\bdescription\s+(?:is\s+)?(?:wrong|incorrect|inaccurate|misleading)\b|\bdoes\s?n[o']?t\s+match\s+(?:the\s+)?(?:listing|description|photo\w*|picture|advert\w*)\b|\bnicht\s+wie\s+beschrieben\b|\blaut\s+beschreibung\b/i;

/** Wants the right thing sent, rather than the money. */
const WANTS_A_REPLACEMENT =
  /\b(?:replac\w*|send\s+(?:me\s+)?(?:a\s+|the\s+)?(?:new|correct|right)|the\s+correct\s+one|the\s+right\s+one|exchang\w*|swap|ersatz\w*|nachliefer\w*|austausch\w*|umtausch\w*)\b/i;

/* ------------------------------------------------------------------------- *
 * THE GOODS ARE ALREADY WITH THE CUSTOMER
 *
 * WHY THIS IS ITS OWN TEST AND NOT `HAS_THE_GOODS`. That pattern is a broad
 * "something to do with receiving" net — it fires on "sent", "got", and on
 * "have you received my message". Good enough for supporting a mismatch claim;
 * nowhere near good enough to decide whether a request to swap something is a
 * PRE-shipping amendment or a POST-delivery exchange, which is exactly the line
 * this draws. So the wording here has to actually say the parcel turned up.
 *
 * "received" is anchored to the customer as its subject — "I received", "I've
 * just received" — because "have YOU received" is about a message, not a
 * consignment, and a genuine order change ("have you received my message, can
 * you change the order to 3 metres") must not be dragged over this line by it.
 *
 * And the negation is excluded, because "it has not arrived" contains "arrived"
 * and means the precise opposite.
 * ------------------------------------------------------------------------- */
const GOODS_HAVE_ARRIVED = new RegExp(
  [
    "\\barrived\\b",
    "\\bturned\\s+up\\b",
    "\\bcame\\s+(?:today|yesterday|this\\s+\\w+|in\\s+the)\\b",
    "\\b(?:was|were|has\\s+been|have\\s+been)\\s+delivered\\b",
    "\\bi\\s*(?:'ve|\\s+have|\\s+had)?\\s*(?:just\\s+|finally\\s+|now\\s+)?(?:received|receive)\\b",
    // THE SUBJECT DROPPED, which is how people actually open a message:
    // "Received it and want to exchange it", "Received them today". The
    // alternative above anchors on "I", so neither of those said the parcel had
    // turned up, `hasTakenDelivery` was false, and a plain post-delivery
    // exchange reached no category at all.
    //
    // ANCHORED TO THE START OF A SENTENCE, and restricted to a bare pronoun
    // object. Both bounds are load-bearing: "have you received" must stay out
    // (it is about a message, not a consignment), and "received the invoice"
    // must stay out too, or a pre-shipping amendment that mentions any
    // paperwork would be read as a delivery.
    // Optionally after a greeting, because "Hi, received two vintage wall lamps
    // as ordered, but ..." is how a customer opens a message about goods that
    // plainly arrived — and reading it as NOT arrived let an urgent-delivery
    // rule claim a wrong-size report.
    "(?:^|[.!?]\\s+)(?:(?:hi|hello|hey|good\\s+(?:morning|afternoon|evening))[,.!]?\\s+)?received\\b",
    "\\b(?:unpacked|unboxed)\\b",
    "\\bopened\\s+the\\s+(?:box|parcel|package)\\b",
    // German
    "\\bangekommen\\b",
    "\\b(?:erhalten|bekommen)\\s+habe\\b",
    "\\bgeliefert\\s+(?:wurde|worden)\\b",
    "\\bausgepackt\\b",
  ].join("|"),
  "i",
);

/** The same words in the negative — a non-arrival, which is the opposite claim. */
const HAS_NOT_ARRIVED =
  /\b(?:not|never|no)\b[^.!?]{0,15}?\b(?:arrived|delivered|received)\b|\b(?:has|have|had|is|was|were)\s?n[o']?t\b[^.!?]{0,15}?\b(?:arrived|delivered|received)\b|\bnoch\s+nicht\b[^.!?]{0,20}?\b(?:erhalten|angekommen|geliefert|bekommen)\b/i;

function hasTakenDelivery(text: string): boolean {
  return GOODS_HAVE_ARRIVED.test(text) && !HAS_NOT_ARRIVED.test(text);
}

/** The attributes a customer swaps one unit of a product for another over. */
const VARIANT_ATTRIBUTE =
  "colour|colours|color|colors|shade|shades|size|sizes|finish|style|design|version|variant|farbe|gr(?:ö|oe)(?:ß|ss)e";

/**
 * Asking for a DIFFERENT unit of the product than the one in front of them.
 *
 * Two shapes, and the second is the one no existing pattern reached: a customer
 * who never uses the word "swap" and simply names the one they want instead —
 * "I need this colour", "I need the deeper copper one". The determiner is what
 * makes it a substitute rather than a specification: "the deeper copper ONE"
 * asks for another unit, while "what colour is it" asks about this one.
 *
 * WANTING THE SAME AGAIN IS EXCLUDED, and it is a real distinction rather than
 * a carve-out for an awkward sentence: "I need the same colour for the hallway"
 * is a repeat PURCHASE, and a repeat purchase is not an exchange.
 */
const WANTS_TO_SWAP_IT =
  /\b(?:swap|swapped|swapping|exchange|exchanged|exchanging|umtausch\w*|umtauschen|tauschen)\b|\bchang(?:e|ed|ing)\s+(?:it|them|this|these|that)\s+(?:for|to)\b/i;

const WANTS_THIS_ONE_INSTEAD = new RegExp(
  `\\b(?:need|needs|want|wants|wanted|prefer|(?:'d|would)\\s+like|looking\\s+for)\\s+` +
    `(?:to\\s+(?:get|have|order)\\s+)?` +
    `(?:this|that|these|those|the|a|an|another|it\\s+in)\\s+` +
    `(?:\\w+\\s+){0,3}?(?:${VARIANT_ATTRIBUTE}|one|ones)\\b`,
  "i",
);

/**
 * More of what they already have — a new order, not a swap of this one.
 *
 * Narrow on purpose. "too" and "as well" were tried here and dropped: "the
 * colour is too dark, I need the black one" is an exchange, and "too" would
 * have thrown it away.
 */
const WANTS_THE_SAME_AGAIN = /\b(?:same|matching)\b/i;

function wantsADifferentVariant(text: string): boolean {
  return (
    WANTS_TO_SWAP_IT.test(text) ||
    (WANTS_THIS_ONE_INSTEAD.test(text) && !WANTS_THE_SAME_AGAIN.test(text))
  );
}

/**
 * The customer ASKING US to change or cancel the order.
 *
 * WHY THIS REPLACED A PAIR OF WORD-LISTS. This intent used to be "the customer
 * mentioned ordering" AND "the customer mentioned something else" — two generic
 * lists, either of which matches by accident. Since the intent sits second in
 * the ownership order, an accidental match outranks almost every real problem,
 * and it did:
 *
 *   "my order arrived DAMAGED, please send another"     -> was Order change
 *   "my order arrived but a part is MISSING, send another"-> was Order change
 *   "the bulb is FAULTY, please send another"            -> was Order change
 *   "order arrived but the cable is wider than ADVERTISED
 *    ... does the width CHANGE because it's hemp"        -> was Order change
 *
 * Every one of those is a problem report where the strict table already had the
 * right answer. The bare noun "order" appears in 20,663 live messages, and
 * "another" is how anyone asks for a replacement of anything.
 *
 * WHAT IT MATCHES NOW: a change or cancellation applied to SOMETHING. The verb
 * must take an object, which is exactly what separates "can I change my order",
 * "change it for a braided cable" and "change colour of order" — all real, all
 * kept — from "does the width change", where nothing is being changed at the
 * customer's request. Read against the 85 live messages carrying both of the
 * old loose tokens, which are otherwise almost all genuine order changes.
 *
 * The customer's own mis-order ("I ordered the wrong colour by mistake",
 * "Falsches Design bestellt") is deliberately NOT here. That wording is already
 * measured, and it arrives through the phrase table and the strict shape rule —
 * duplicating it in a looser form here is what caused the damage above.
 */
const AMENDMENT_REQUEST = new RegExp(
  [
    // A change applied to an object, either immediately... "over" is
    // deliberately absent: "will the brightness change over time" is a question
    // about the product, and it was the one false positive this list produced.
    "\\b(?:chang(?:e|ed|ing)|amend(?:ed|ing)?|swap(?:ped|ping)?|switch(?:ed|ing)?)\\s+(?:it|them|this|these|that|to|for)\\b",
    // ...or to a named thing within a couple of words: "change my order",
    // "change the delivery address", "change colour of order".
    "\\b(?:chang(?:e|ed|ing)|amend(?:ed|ing)?|swap(?:ped|ping)?|exchang(?:e|ed|ing)|switch(?:ed|ing)?)\\s+(?:\\w+\\s+){0,2}?(?:order|orders|address|item|items|delivery|design|model|variant|option)\\b",
    // Cancelling is unambiguous on its own.
    "\\bcancel\\w*\\b",
    // German
    "\\b(?:bestellung|adresse|artikel)\\s+(?:\\w+\\s+){0,2}?(?:(?:ä|ae)ndern|umtauschen|tauschen|wechseln)\\b",
    "\\b(?:storni\\w*|kaufabbruch)\\b",
  ].join("|"),
  "i",
);

/**
 * AN AMENDMENT ASKED FOR AS A PREFERENCE, not as the verb "change".
 *
 * `AMENDMENT_REQUEST` recognises the act — change, amend, swap, cancel — and
 * customers do not always name it. `ORDER BEFORRE SHIPPING` INT-OS13's own
 * triggers say so: "I want a different colour", "add another", "remove one
 * item", "I don't want one of them". None of them uses the word change, and two
 * real conversations went to the admin catch-all because of it:
 *
 *   "Hi just ordered this lamp shade cage but want it in black please, there
 *    was no link for colour please ensure you send me a black one"
 *   "I have paid but could you please put 1x type 2 and 1 x type 3 please?"
 *
 * BOTH HALVES ARE REQUIRED, and that is what makes it safe. On its own, "I want
 * it in black" is a buyer choosing — a pre-sales message, and one of the busiest
 * shapes in this inbox. It becomes an amendment only once the customer has said
 * the order is already placed, and only while it is still here to amend.
 */
const ORDER_ALREADY_PLACED =
  /\b(?:just\s+(?:ordered|bought|paid|placed)|i\s?'?ve\s+(?:just\s+)?(?:ordered|bought|paid|placed)|i\s+have\s+(?:just\s+)?(?:ordered|bought|paid|placed)|placed\s+(?:an|my|the)\s+order)\b/i;

const WANTS_IT_A_PARTICULAR_WAY =
  /\b(?:want|would\s+like|need|prefer|prefered|preferred)\s+(?:it|them|this|these|mine)?\s*(?:in|to\s+be)\s+\w+/i;

const ASKS_US_TO_SEND_A_PARTICULAR_ONE =
  /\b(?:ensure|make\s+sure)\s+(?:you|that\s+you)\s+send\b|\b(?:could|can|would)\s+you\s+(?:please\s+)?(?:put|send|make\s+it)\s+\d+\s*x?\b/i;

function amendsAnOrderAlreadyPlaced(text: string): boolean {
  return (
    ORDER_ALREADY_PLACED.test(text) &&
    (WANTS_IT_A_PARTICULAR_WAY.test(text) || ASKS_US_TO_SEND_A_PARTICULAR_ONE.test(text)) &&
    !hasTakenDelivery(text)
  );
}

/**
 * Asking when it will come, or asking for it sooner.
 *
 * SPLIT IN TWO, because the halves are not equally trustworthy on their own.
 * Everything here asks a question ABOUT the consignment's timing — "when will
 * it", "how long", "arrive", "asap". A message containing one of these is
 * asking after something that has not turned up.
 */
const DELIVERY_TIMING =
  /\b(?:when\s+(?:will|is|does|can|do)|how\s+long|arrive|arriving|arrival|asap|as\s+soon\s+as|urgent\w*|wann)\b/i;

/**
 * A DEADLINE, which means delivery only when a delivery noun is there with it.
 *
 * WHY THESE ARE NOT IN `DELIVERY_TIMING`. "this week" and "next week" are bare
 * temporal adverbials: they date whatever the customer is talking about, and
 * most of the time that is not a delivery. The reported failure is exactly this
 * — "brought 3 of these shades this week didn't know I could buy as an option"
 * was named a Delivery query, on the strength of two words that say when
 * somebody went shopping. There is no parcel in that message, no whereabouts
 * question, nothing outstanding. Next to a delivery noun ("Lieferung noch diese
 * Woche") the same words are a deadline and do mean delivery, which is where
 * they are still used.
 */
const DELIVERY_DEADLINE =
  /\b(?:this\s+week|next\s+week|by\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|diese\s+woche)\b/i;

/**
 * The consignment itself, as a customer names it when chasing one.
 *
 * Nouns only, and deliberately ordinary ones. On its own this word list means
 * nothing — "order", "item" and "package" appear in most messages in the
 * inbox, whatever they are about — which is exactly why it is never tested
 * alone. It supplies the OBJECT half of the combinations below.
 */
const CONSIGNMENT =
  "orders?|parcels?|packages?|items?|deliver(?:y|ies)|shipments?|goods|post|sendung|paket|bestellung|lieferung|ware";

/**
 * CHASING A CONSIGNMENT: asking where it is, or saying it has not turned up.
 *
 * WHY A COMBINATION AND NOT PHRASES. "Where is my parcel" and "waiting for
 * delivery" both fell through to the admin fallback, and the tempting fix is to
 * add each wording to the table. That does not survive the next customer, who
 * writes "where's the package" or "still waiting on my order". What these all
 * share is a shape: a question about WHEREABOUTS, aimed at the CONSIGNMENT.
 * Both halves are required and neither means anything alone.
 *
 * "WHERE IS", NOT "WHERE DO". The verb is what keeps this honest. "Where do I
 * return the item" and "where can I find the size guide" are a returns question
 * and a pre-sales question that both contain "where" and a consignment noun;
 * restricting the verb to the copular forms — is / are / 's / has / have —
 * asks after the thing's LOCATION rather than after a procedure.
 *
 * The 25-character window keeps the two halves in the same clause, and stopping
 * at sentence punctuation prevents a "where is" in one sentence pairing with an
 * "order" in the next.
 *
 * NOTHING HERE CAN COST ANOTHER CATEGORY ITS MESSAGE. `delivery_request` sits
 * eighth in `INTENT_OWNERSHIP`, below wrong item, missing parts, damage and
 * defective, so a message that carries one of those is decided before this is
 * ever consulted. "Box arrived damaged" is damage no matter what this matches.
 */
const CHASING_A_CONSIGNMENT = new RegExp(
  [
    // "where is my item", "where's the parcel", "where are my orders"
    `\\bwhere\\s*(?:'s|is|are|has|have)\\b[^.!?]{0,25}?\\b(?:${CONSIGNMENT})\\b`,
    // "waiting for delivery", "still waiting on my parcel"
    `\\b(?:still\\s+)?wait(?:ing)?\\s+(?:for|on)\\b[^.!?]{0,25}?\\b(?:${CONSIGNMENT})\\b`,
    // "any news on my order", "any sign of the package"
    `\\bany\\s+(?:news|sign|word)\\b[^.!?]{0,25}?\\b(?:${CONSIGNMENT})\\b`,
    // "the parcel is still on the way", "my order is in transit". Not a
    // question, but it says the same thing a question does: the consignment has
    // not arrived and the customer is telling us so.
    `\\b(?:${CONSIGNMENT})\\b[^.!?]{0,25}?\\b(?:on\\s+(?:the|its)\\s+way|in\\s+transit|en\\s+route|still\\s+coming)\\b`,
  ].join("|"),
  "i",
);

const ADMIN_MATTER =
  /\b(?:invoice|receipt|vat|business\s+account|payment|paid|order\s+number|statement|rechnung|beleg|quittung|zahlung)\b/i;

/**
 * Not a customer at all — transport headers, automated notifications, partner
 * system alerts.
 *
 * THIS IS WHAT KEEPS THE ADMIN FALLBACK HONEST. "Never leave a customer message
 * uncategorised" is only safe if we can tell a customer message from machine
 * output; without this, every SMTP header block in the corpus would be filed as
 * an admin query. The three shapes below are the ones already pinned in the
 * tests as things this classifier must never name.
 */
const NOT_FROM_A_CUSTOMER = new RegExp(
  [
    // SMTP / MIME transport headers.
    "^(?:received|content-type|content-transfer-encoding|mime-version|authentication-results|return-path|dkim-signature|message-id|x-[\\w-]+):",
    // Automated notifications and no-reply boilerplate.
    "automatically\\s+generated",
    "auto(?:matically)?[-\\s]?generated",
    "do\\s+not\\s+reply",
    "no[-\\s]?reply@",
    "this\\s+is\\s+an\\s+automated",
    // Partner-system alerts that arrive in the same inbox.
    "you\\s+have\\s+a\\s+new\\s+ticket",
    "partner\\s+home\\s+inbox",
  ].join("|"),
  "im",
);

/**
 * What the phrase table says, expressed as intents.
 *
 * THIS IS HOW THE OLD LAYER BECOMES A SUPPORTING SIGNAL RATHER THAN A RIVAL.
 * Every phrase above was measured against live customer text, and throwing that
 * away to run regexes over the same message would be losing evidence, not
 * gaining independence. So the table still runs — its result is simply read as
 * one more witness to intent, on equal footing with the wording patterns.
 *
 * ONE MAPPING IS NOT THE IDENTITY, and it is the important one. A hit in the
 * Return and refunds phrase list does NOT become `wants_refund`, because that
 * list contains routes as well as outcomes — "return it", "send it back",
 * "replacement". Only an actual request for money becomes `wants_refund`;
 * everything else in that list becomes `wants_replacement`, which owns no
 * category. This is what makes "Wrong item received, can I return it?" a
 * wrong-item case: the table scores Return twice and Wrong item once, and it
 * still comes out as Wrong item sent, because scoring is no longer what decides.
 */
function intentsFromPhraseTable(text: string): MessageIntent[] {
  const hit = (label: MessageCategory): boolean =>
    SIGNALS.some(
      (signal) =>
        signal.label === label && signal.phrases.some((phrase) => contains(text, phrase)),
    );

  const found: MessageIntent[] = [];
  if (hit("Wrong item sent messages")) found.push("received_wrong_item");
  if (hit("Parts missing queries")) found.push("missing_component");
  // Measured wording for a unit shortfall — "only received", "fewer than",
  // "short delivery", "zu wenig erhalten". It had no intent at all before, so
  // the only way this category could ever be reached was the strict table
  // failing to find anything better.
  if (hit("Wrong quantity sent issues")) found.push("wrong_quantity_sent");
  if (hit("Damage queries")) found.push("damaged_product");
  if (hit("Defective items")) found.push("defective_product");
  if (hit("Wrong description issues")) found.push("wrong_description");
  if (hit("Order change, before shipping queries")) found.push("wants_order_change");
  if (hit("Delivery queries")) found.push("delivery_request");
  if (hit("Pre sales queries")) found.push("pre_sale_question");
  if (hit("Admin related issues")) found.push("admin_issue");
  if (hit("Return and refunds")) {
    found.push(wantsMoneyBack(text) ? "wants_refund" : "wants_replacement");
  }
  return found;
}

/**
 * Which intents a message carries. Exported so a reviewer can ask "why did it
 * say that?" and get an answer, rather than having to re-derive it.
 */
export function detectIntents(customerText: string | null): MessageIntent[] {
  const text = normalise(customerText?.trim() ?? "");
  if (text === "") return [];

  const found: MessageIntent[] = [];
  const add = (intent: MessageIntent, when: boolean) => {
    if (when) found.push(intent);
  };

  add("wants_refund", wantsMoneyBack(text));
  add("wants_replacement", WANTS_A_REPLACEMENT.test(text));
  add("wants_order_change", AMENDMENT_REQUEST.test(text) || amendsAnOrderAlreadyPlaced(text));
  add(
    "received_wrong_item",
    (HAS_THE_GOODS.test(text) && A_MISMATCH.test(text)) ||
      // "The SUPPLIED fitting belongs to another type of light." The mismatch
      // construction carries the arrival with it — a part cannot have been
      // supplied without having arrived — and "supplied" is deliberately not
      // added to `HAS_THE_GOODS` itself, where it would break "are any fixings
      // supplied?", a pre-sales question about a purchase nobody has made.
      (asserts(text, SUPPLIED_THE_OTHER_THING) &&
        (HAS_THE_GOODS.test(text) || /\bsupplied\b/i.test(text))),
  );
  // ONE PIECE OF EVIDENCE, ONE INTENT. `quantityShortfallEvidence` already
  // decides which kind of shortage a message describes, and the two kinds are
  // different CST cases: units short against the order is a quantity error,
  // a component absent from the goods is a parts case. Reading the reason code
  // rather than its mere presence is what keeps them apart — see
  // `SHORTFALL_INTENT`.
  const shortfall = quantityShortfallEvidence(text);
  if (shortfall !== null) found.push(SHORTFALL_INTENT[shortfall]);
  /*
   * A PROBLEM HAS TO BE CLAIMED, not merely mentioned.
   *
   * Each of these used to fire on a pattern hit anywhere in the message, which
   * makes a category a function of a substring rather than of what the customer
   * said. `asserts` reads the clause the concept landed in and refuses when it
   * is a question, a denial or a correction — so "nothing is broken", "is it
   * damaged?" and "not faulty" stop being reports of damage and faults.
   *
   * The listing mismatch keeps BOTH halves and gains the assertion test on the
   * one that carries the claim. That is the trego-13 defect: "one of the shades
   * arrived smashed as per the photograph" paired a listing noun with a
   * contrast word 53 characters apart and named it a description error.
   */
  add(
    "wrong_description",
    LISTING_REFERENCE.test(text) &&
      REALITY_DIFFERS.test(text) &&
      // The negation is constitutive here — see `ClaimOptions`.
      asserts(text, LISTING_MISMATCH, { negationReverses: false }),
  );
  add("damaged_product", asserts(text, IS_DAMAGED));
  add("defective_product", asserts(text, IS_DEFECTIVE));
  add(
    "delivery_request",
    /*
     * Chasing the consignment is checked FIRST and on its own terms.
     *
     * It deliberately does not carry the `HAS_THE_GOODS` guard the timing
     * branch below needs. That guard exists so "arrive" in "it arrived fine"
     * cannot read as a delivery question — but "where is my parcel, it still
     * hasn't arrived" contains "arrived" too, and guarding this branch would
     * throw away the clearest delivery message a customer can write. Asking
     * where a thing IS already says they do not have it.
     */
    CHASING_A_CONSIGNMENT.test(text) ||
      (DELIVERY_NOUN.test(text)
        ? DELIVERY_TIMING.test(text) ||
          DELIVERY_DEADLINE.test(text) ||
          DELIVERY_REQUESTED_SOON.test(text)
        : DELIVERY_TIMING.test(text) &&
          HAS_THE_GOODS.test(text) === false &&
          // "WHEN WILL THIS BE BACK IN STOCK" IS NOT A DELIVERY QUESTION.
          // Without a consignment noun, "when will" is the only thing this
          // branch has to go on, and INT-PS11 (RESTOCK DATE QUERY) uses exactly
          // the same words about a product nobody has bought yet.
          !ASKING_ABOUT_STOCK.test(text)),
  );
  add(
    "pre_sale_question",
    asksOrRequests(text) &&
      (namesAProductAttribute(text) ||
        PACK_SIZE_QUESTION.test(text) ||
        SPECIFICATION_QUESTION.test(text)) &&
      // Paperwork belongs to Admin, which sits directly BELOW this intent and
      // would otherwise lose every invoice request that mentioned a product.
      !ASKING_FOR_PAPERWORK.test(text) &&
      !HAS_THE_GOODS.test(text),
  );
  add("admin_issue", ADMIN_MATTER.test(text));

  for (const intent of intentsFromPhraseTable(text)) {
    if (!found.includes(intent)) found.push(intent);
  }

  // THE THIRD WITNESS: the approved customer language from the eleven CST rule
  // books, narrowed to the rows whose own Conditions hold for this message.
  // Added on the same footing as the phrase table — it can name an intent the
  // patterns above missed, and it cannot remove one they found. Removal is
  // `refine`'s job, and it is done on the evidence rather than by a source
  // outranking another.
  for (const intent of evidenceIntents(text)) {
    if (!found.includes(intent)) found.push(intent);
  }

  const refined = refine(found, text);

  // Last, because it is a judgement about the intents already found rather than
  // about the words on their own — see `wantsPostDeliveryReturn`.
  return wantsPostDeliveryReturn(refined, text)
    ? [...refined, "wants_post_delivery_return"]
    : refined;
}

/**
 * The intents that report something WRONG with what we sent, as opposed to the
 * customer changing their mind about it.
 *
 * Used only to hold the post-delivery return intent back. Each of these has a
 * measured precedence against Return already — a wrong item stays a wrong item
 * when a return is offered rather than the money asked for, a missing part stays
 * a missing part when a replacement is requested — and none of that is being
 * reopened here.
 */
const PROBLEM_INTENTS: readonly MessageIntent[] = [
  "received_wrong_item",
  "missing_component",
  "damaged_product",
  "defective_product",
  "wrong_description",
];

/**
 * A RETURN OR EXCHANGE OF SOMETHING ALREADY DELIVERED.
 *
 * WHAT WENT WRONG WITHOUT IT. "I received my parcel today but the colour is not
 * what I expected. Please is it possible to return it and swap them both for
 * black" was named an ORDER CHANGE BEFORE SHIPPING. The word "swap" reached
 * `AMENDMENT_REQUEST`, which sits second in the ownership order and knows
 * nothing about whether the parcel has been delivered — so a customer sending
 * an item back was filed alongside customers editing an order we have not
 * dispatched. The two are opposite ends of the order's life, and the ONE fact
 * that separates them is whether the goods have arrived.
 *
 * THREE CONDITIONS, ALL REQUIRED:
 *
 *   the goods arrived   `hasTakenDelivery`, which is deliberately stricter than
 *                       the general "has the goods" test. Without it this would
 *                       claim every genuine pre-shipping amendment, which is the
 *                       category it exists to protect.
 *   a return or swap    Either an explicit return REQUEST — the same measured
 *      is asked for     pattern the strict layer uses — or asking for a
 *                       different unit of the product. Neither the word "swap"
 *                       nor the word "change" means this on its own; both have
 *                       to be aimed at something already delivered.
 *   nothing is wrong    A fault, damage, an absent part, a wrong item or a
 *      with it          description mismatch is a PROBLEM, and each of those has
 *                       its own measured precedence against Return. This intent
 *                       covers the case where nothing is wrong with the goods —
 *                       the customer simply does not want the ones they got.
 *
 * The last condition is why this can sit high in the ownership order without
 * disturbing anything: it cannot fire at all on a message that reports a
 * problem, so the only category it can take one from is the pre-shipping
 * amendment it was written to correct.
 */
function wantsPostDeliveryReturn(found: readonly MessageIntent[], text: string): boolean {
  if (found.some((intent) => PROBLEM_INTENTS.includes(intent))) return false;
  if (!hasTakenDelivery(text)) return false;
  return EXPLICIT_REMEDY_REQUEST.test(text) || wantsADifferentVariant(text);
}

/**
 * The two contests where a fixed ownership order would overrule a MEASURED
 * result, resolved here instead so the order never has to decide them.
 *
 * This is the price of making intent primary, and it is worth paying explicitly
 * rather than pretending a single priority list can be right about everything.
 * A priority list is a global precedence, and both of these were investigated
 * precisely because a global precedence got them wrong.
 */
function refine(found: MessageIntent[], text: string): MessageIntent[] {
  const drop = (intent: MessageIntent) => found.filter((entry) => entry !== intent);

  // A PROBLEM THE CUSTOMER RULES OUT IS NOT A CASE, whichever witness raised it.
  //
  // THE SAME LEAK AS `pre_sale_question` BELOW, one category along. `detectIntents`
  // gates its own pattern on `asserts`, and that guards exactly one of the three
  // routes into these intents — the phrase table and the CST evidence map both
  // read a word as a witness with no clause attached, so "Nothing is broken, I
  // just want to check the wiring" was still filed as damage on the strength of
  // the word "broken" inside the denial. A judgement about whether the customer
  // is CLAIMING something belongs after every witness has spoken.
  //
  // ONLY WHERE THE CONCEPT IS ACTUALLY PRESENT AND NOT ASSERTED. `not_stated`
  // deliberately leaves the intent alone: `missing_component` also arrives by
  // arithmetic — "only two arrived but I ordered three" names no absence word at
  // all — and that route has no clause for this to read.
  for (const [intent, concept] of CLAIMED_PROBLEMS) {
    if (!found.includes(intent)) continue;
    const status = claimStatus(text, concept);
    if (status === "asked" || status === "negated") found = drop(intent);
  }

  // A REFUND ASKED FOR ABOUT A PROBLEM DOES NOT BECOME THE CASE.
  //
  // "One of the shades arrived smashed. Please refund me." is a DAMAGE case: the
  // Damage guide decides what happens next, and whether the answer is a
  // discount, a replacement or the money back is its decision to make. The
  // Returns workbook agrees — its seller-fault rows exist to accept a return
  // CAUSED by one of these problems, not to take the problem's place.
  //
  // ONLY WHERE A PROBLEM IS ACTUALLY ASSERTED, which is what keeps the cases a
  // refund legitimately owns: a chase the customer has given up on, a
  // cancellation with the money back, a colour nobody likes. None of those
  // raises a problem intent, so none of them reaches this.
  if (found.includes("wants_refund") && found.some((intent) => PROBLEM_INTENTS.includes(intent))) {
    found = drop("wants_refund");
  }

  // DAMAGE AGAINST A MISSING PART, decided by what the damage is predicated on
  // rather than by which intent happens to sit higher in the list. Damage on the
  // PACKAGING is context for the absent component; damage to the GOODS is the
  // complaint. The single-damage-word bound is what keeps "the box was damaged
  // and the shade is smashed" on the goods side of that line.
  // A SIZE REMARK IS NOT A WRONG ITEM WHEN THE CUSTOMER IS ASKING WHETHER A
  // PART IS MISSING.
  //
  //   "Is there suppose to be a fitting with it? The hole on the shade is too
  //    big for a standard ceiling light!! The box was damaged and slightly open
  //    so I'm just wondering if something is missing?"
  //
  // Every sentence is a question about what should have been in the box. The
  // size is the customer's REASON for thinking a part is absent — a reducer ring
  // — not a claim that we sent the wrong shade. `Wrong item sent final.xlsx`
  // sheet 8 owns a measurement mismatch and its own phrases include "too big",
  // which raised a wrong-item case above the parts case the customer is actually
  // describing.
  //
  // ONLY WHERE THERE IS NO ORDERED-VERSUS-RECEIVED CLAIM. "You sent the 20cm
  // instead of the 30cm and the reducer is missing" asserts a mismatch and stays
  // a wrong item, which is why the test is on the assertion and not on the size
  // wording.
  if (
    found.includes("received_wrong_item") &&
    found.includes("missing_component") &&
    !asserts(text, A_MISMATCH) &&
    !asserts(text, SUPPLIED_THE_OTHER_THING)
  ) {
    found = drop("received_wrong_item");
  }

  if (found.includes("missing_component") && found.includes("damaged_product")) {
    const damageWords = (SIGNALS.find((s) => s.label === "Damage queries")?.phrases ?? []).filter(
      (phrase) => contains(text, phrase),
    ).length;
    return damageWords <= 1 && PACKAGING_DAMAGE.test(text)
      ? drop("damaged_product")
      : drop("missing_component");
  }

  // THE MISSING THING IS THE INVOICE. German invoice requests say "uns fehlt die
  // Rechnung" — we are MISSING the INVOICE — and all six live conversations
  // where this collides are invoice requests, which is why the strict layer
  // carries a precedence entry for it. Recognised here by the two words being
  // next to each other, so an unrelated "a part is missing, and can you send the
  // invoice?" is untouched and stays a parts case.
  if (found.includes("missing_component") && ADMIN_IS_WHAT_IS_MISSING.test(text)) {
    return drop("missing_component");
  }

  // THE THING NOT RECEIVED IS THE INVOICE — the same collision as the rule
  // directly above, one category along. "I have not received my VAT invoice"
  // is an Admin request, but the strict phrase table lists "not received" as
  // delivery wording and reads a table hit as a witness with no context, so it
  // named a paperwork request a delivery chase. The CST evidence layer already
  // refuses this — `DEL-13.1` carries a `not_the_paperwork` condition — and
  // this closes the phrase-table route to the same conclusion.
  if (found.includes("delivery_request") && ADMIN_IS_WHAT_IS_MISSING.test(text)) {
    return drop("delivery_request");
  }

  // A RETURN ALREADY UNDER WAY IS NOT A PRE-SALES ENQUIRY, whichever witness
  // named it.
  //
  // HERE RATHER THAN AT THE THREE CALL SITES, and that is the point. Three
  // independent routes can raise `pre_sale_question` — the shape rule, the CST
  // evidence map, and the phrase table — and guarding two of them left the
  // third open: "I want to return item .. output voltage not mentioned" was
  // rejected by the evidence layer and then named a pre-sales query anyway,
  // because the strict table lists "voltage" and reads a table hit as a witness
  // with no context attached. A judgement about what the message IS belongs in
  // one place, applied after every witness has spoken.
  if (found.includes("pre_sale_question") && returnIsUnderWay(text)) {
    return drop("pre_sale_question");
  }

  // AND A PAPERWORK REQUEST IS NOT ONE EITHER, whichever witness named it. The
  // pattern route already refuses it; the CST evidence map raised
  // PRE_PURCHASE_ENQUIRY for "is there a wiring diagram for this fitting?",
  // which ADMIN.xlsx sheet C owns (INT-AD06, MANUAL / WIRING DIAGRAM).
  if (found.includes("pre_sale_question") && ASKING_FOR_PAPERWORK.test(text)) {
    return drop("pre_sale_question");
  }

  // DAMAGE TO THE BOX ALONE IS A DELIVERY MATTER, not a product one.
  //
  // "Box damaged but product fine" was named a Damage query, because the word
  // "damaged" is in the message and nothing asked what it was damage TO. CST is
  // explicit on the split: Delivery sheet 9 is "Damaged in Transit" and its 9.1
  // condition is "Outer box damaged — customer says contents appear OK", while
  // the Damage guide's product sheets describe only the goods. A courier
  // packaging complaint is not a claim about the item.
  //
  // BELOW THE PARTS BRANCH, and that ordering is deliberate rather than
  // incidental: a battered box WITH something absent from inside it is already
  // decided above and returns before reaching here, so this cannot take a
  // parts case and turn it into a delivery one.
  if (found.includes("damaged_product") && damageIsOnlyOnThePackaging(text)) {
    const withoutDamage = drop("damaged_product");
    return withoutDamage.includes("delivery_request")
      ? withoutDamage
      : [...withoutDamage, "delivery_request"];
  }

  return found;
}

/**
 * The intents that require the customer to CLAIM the thing, and the concept each
 * claim is about.
 *
 * `wrong_description` is absent on purpose: its claim is built out of negatives
 * ("does not match the listing", "not as described"), and it carries its own
 * `negationReverses: false` reading at the point it is raised.
 */
const CLAIMED_PROBLEMS: readonly (readonly [MessageIntent, RegExp])[] = [
  ["damaged_product", IS_DAMAGED],
  ["defective_product", IS_DEFECTIVE],
  ["missing_component", SOMETHING_ABSENT],
];

/** "fehlt die Rechnung" — the absent thing is the paperwork, not a component. */
const ADMIN_IS_WHAT_IS_MISSING =
  /\b(?:fehlt|fehlen|missing|not\s+received|never\s+received|no)\s+(?:\w+\s+){0,3}(?:rechnung|invoice|receipt|beleg|quittung|vat)\b|\b(?:rechnung|invoice|receipt|beleg|quittung)\s+(?:\w+\s+){0,3}(?:fehlt|fehlen|is\s+missing|missing)\b/i;

/* ------------------------------------------------------------------------- *
 * CST EVIDENCE: OWNERSHIP AND EXCLUSION
 *
 * The stage between "which rule books mention this wording" and "which category
 * this conversation is". `cst-category-evidence.ts` holds the approved customer
 * language from all eleven workbooks and can say what a message MIGHT be; it
 * cannot say what the message IS, because it holds no context. This does.
 *
 * OVERLAP IS EXPECTED AND IS NOT AN ERROR. Three rule books claim "smashed",
 * two claim "box damaged", and the Wrong item book claims most of the Wrong
 * quantity vocabulary. Every one of those claims is correct inside the book
 * that makes it — Delivery's sheet 9 is about damage caused in transit, and
 * "item smashed" genuinely routes there once you already know the case is a
 * delivery one. What none of them can do is decide the case, and treating a
 * clash as a fault in the documents is what previously stopped this work.
 *
 * SO CANDIDATES ARE FILTERED, NOT COUNTED. Each evidence row names the
 * Conditions its own workbook states, this checks them against the message, and
 * what survives is evidence for a CONCEPT. The concept has exactly one owner.
 * Nothing here scores, so a category cannot win by being mentioned in more
 * workbooks than another.
 * ------------------------------------------------------------------------- */

/**
 * Why a candidate was dropped. Reportable, because "we considered Delivery and
 * rejected it" is a more useful thing for a reviewer to read than silence.
 */
export type EvidenceRejection =
  | "DAMAGE_IS_ON_THE_PACKAGING"
  | "GOODS_THEMSELVES_ARE_DAMAGED"
  | "GOODS_ALREADY_DELIVERED"
  | "GOODS_NOT_YET_DELIVERED"
  | "COUNTED_AGAINST_THE_ORDER"
  | "THE_MISSING_THING_IS_PAPERWORK"
  | "NO_SECOND_THING_NAMED"
  | "A_RETURN_IS_UNDER_WAY";

/**
 * Whether the damage words in this message all attach to the BOX.
 *
 * THE TEST IS SUBTRACTIVE, and that is what makes it safe. A message can
 * mention a battered box and a smashed shade in one breath, and asking only
 * "is there packaging damage here?" answers yes to both of those and to "the
 * box was crushed, everything inside is fine". So the packaging clauses are
 * removed and the remainder is re-read: if a damage word survives that, it is
 * predicated on something other than the packaging, and the goods are what is
 * damaged.
 *
 *   "Box damaged but product fine."            -> nothing left. Delivery.
 *   "The box was damaged and the shade is
 *    smashed."                                 -> "smashed" left. Damage.
 *
 * CST supports the split directly. Delivery's sheet 9 is titled "Damaged in
 * Transit" and its 9.1 condition reads "Outer box damaged — customer says
 * contents appear OK", while the Damage guide's nine product sheets describe
 * only the goods.
 */
/** Every packaging-damage clause, so they can be removed in one pass. */
const EVERY_PACKAGING_DAMAGE = new RegExp(PACKAGING_DAMAGE.source, "gi");

function damageIsOnlyOnThePackaging(text: string): boolean {
  if (!PACKAGING_DAMAGE.test(text)) return false;
  // `replace` with a global regex resets `lastIndex` itself, so the shared
  // instance stays safe to reuse and this function stays pure.
  //
  // `asserts` RATHER THAN `.test`, because a damage word the customer uses to
  // rule damage OUT is not damage to the goods: "the item is not damaged, the
  // box was just scuffed" left "not damaged" standing in the residue and so
  // read as a product complaint — the exact opposite of what it says. CST
  // Delivery 9.1 owns this message ("Outer box damaged — customer says contents
  // appear OK").
  return !asserts(text.replace(EVERY_PACKAGING_DAMAGE, " "), IS_DAMAGED);
}

/**
 * Whether an ordered/received contrast actually names two DIFFERENT things.
 *
 * The shape alone is not the claim — see `ORDERED_ONE_THING_RECEIVED_ANOTHER`.
 * Three things disqualify a match, and each was written against a sentence that
 * would otherwise have been called a wrong item:
 *
 *   a pronoun or preposition   "I ordered it and received it" names nothing.
 *   a bare number              "I ordered 6 bulbs but only received 3" is a
 *                              count, and counts belong to Wrong quantity. The
 *                              `not_a_unit_shortfall` condition catches this
 *                              too; both are kept, because the two guards fail
 *                              on different sentences.
 *   the same thing twice       "ordered the black shade, received the black
 *                              shade" is not a mismatch.
 */
function namesTwoDifferentThings(text: string): boolean {
  const found = ORDERED_ONE_THING_RECEIVED_ANOTHER.exec(text);
  if (found === null) return false;

  const ordered = (found[1] ?? "").trim().toLowerCase();
  const arrived = (found[2] ?? "").trim().toLowerCase();
  if (ordered === "" || arrived === "" || ordered === arrived) return false;

  for (const phrase of [ordered, arrived]) {
    const head = phrase.split(/\s+/)[0] ?? "";
    if (NOT_A_PRODUCT_WORD.has(head) || /^\d+(?:[.,]\d+)?$/.test(head)) return false;
  }
  return true;
}

/**
 * A shortfall counted in UNITS against the order, which Wrong quantity owns.
 *
 * Used to keep two other categories off it. Wrong item's INT-WI16 row claims
 * "received fewer" and "one short", and Parts missing's INT-MP04 row claims
 * "missing from the order" — both true within their own book, both wrong as a
 * cross-category claim. `MISSING_ORDER_COMPONENT` is deliberately absent from
 * this test: that reason means a named component is absent, which is a parts
 * case and must NOT block Parts missing evidence.
 */
function isUnitShortfall(text: string): boolean {
  const reason = quantityShortfallEvidence(text);
  return reason === "ORDERED_QUANTITY_GREATER_THAN_RECEIVED" || reason === "PARTIAL_ORDER_RECEIVED";
}

/** Each named condition, and what rejecting it should be reported as. */
const EVIDENCE_CONDITIONS: Readonly<
  Record<EvidenceCondition, { readonly holds: (text: string) => boolean; readonly rejection: EvidenceRejection }>
> = {
  goods_have_arrived: { holds: hasTakenDelivery, rejection: "GOODS_NOT_YET_DELIVERED" },
  goods_not_yet_arrived: { holds: (text) => !hasTakenDelivery(text), rejection: "GOODS_ALREADY_DELIVERED" },
  damage_is_on_the_goods: {
    holds: (text) => !damageIsOnlyOnThePackaging(text),
    rejection: "DAMAGE_IS_ON_THE_PACKAGING",
  },
  damage_is_on_the_packaging: {
    holds: damageIsOnlyOnThePackaging,
    rejection: "GOODS_THEMSELVES_ARE_DAMAGED",
  },
  not_a_return_in_progress: {
    holds: (text) => !returnIsUnderWay(text),
    rejection: "A_RETURN_IS_UNDER_WAY",
  },
  not_a_unit_shortfall: { holds: (text) => !isUnitShortfall(text), rejection: "COUNTED_AGAINST_THE_ORDER" },
  not_the_paperwork: {
    holds: (text) => !ADMIN_IS_WHAT_IS_MISSING.test(text),
    rejection: "THE_MISSING_THING_IS_PAPERWORK",
  },
  two_different_things_named: {
    holds: namesTwoDifferentThings,
    rejection: "NO_SECOND_THING_NAMED",
  },
};

export type RejectedEvidence = EvidenceMatch & { readonly rejectedBecause: EvidenceRejection };

export type ResolvedEvidence = {
  /** Candidates whose workbook conditions hold for this message. */
  readonly upheld: readonly EvidenceMatch[];
  /** Candidates dropped, each with the condition that failed. */
  readonly rejected: readonly RejectedEvidence[];
};

const REQUIRES_BY_ID = new Map(CST_EVIDENCE.map((entry) => [entry.id, entry.requires ?? []]));

/**
 * Collects CST evidence for a message and drops what the context contradicts.
 *
 * Exported so the explanation endpoint and the tests can see both halves. The
 * rejected list is not noise: it is the record of an overlap being resolved,
 * and it is the only place that resolution is visible.
 */
export function resolveEvidenceOwnership(customerText: string | null): ResolvedEvidence {
  const raw = normalise(customerText?.trim() ?? "");
  if (raw === "") return { upheld: [], rejected: [] };

  const upheld: EvidenceMatch[] = [];
  const rejected: RejectedEvidence[] = [];

  // German product nouns are rendered into the CST vocabulary first, so a
  // German enquiry resolves against the SAME approved rows an English one does
  // and cites the same sheet — rather than matching nothing and losing its
  // provenance. See `GERMAN_TERMS` for why the corpus leaves no other
  // honest option. Nothing in that map appears in a non-pre-sales pattern, and
  // it touches no arrival, quantity, packaging or paperwork wording, so the
  // conditions below read exactly what they read before.
  const text = translateGermanTerms(raw);

  /*
   * EACH CONDITION IS ANSWERED ONCE PER MESSAGE, not once per entry.
   *
   * There are seven conditions and three dozen evidence rows, and several rows
   * share the same condition — `not_a_unit_shortfall` alone is required by
   * eight of them, and answering it runs the whole quantity-role analysis. This
   * is a pure memo on a pure function of the text, so it changes no verdict; it
   * is here because the layer runs on every message in the inbox and the
   * repeated work was measurable.
   */
  const answered = new Map<EvidenceCondition, boolean>();
  const holds = (condition: EvidenceCondition): boolean => {
    let answer = answered.get(condition);
    if (answer === undefined) {
      answer = EVIDENCE_CONDITIONS[condition].holds(text);
      answered.set(condition, answer);
    }
    return answer;
  };

  for (const match of collectCategoryEvidence(text)) {
    const failed = (REQUIRES_BY_ID.get(match.id) ?? []).find((condition) => !holds(condition));
    if (failed === undefined) upheld.push(match);
    else rejected.push({ ...match, rejectedBecause: EVIDENCE_CONDITIONS[failed].rejection });
  }

  return { upheld, rejected };
}

/**
 * What surviving evidence contributes to the intent layer.
 *
 * NOT EVERY CONCEPT CONTRIBUTES, and the two that do not are deliberate:
 *
 *   POST_DELIVERY_RETURN   Return already has exactly two routes into it, both
 *                          guarded by precedence measured against live text —
 *                          an explicit request for money (`wants_refund`), and
 *                          a post-delivery swap where nothing is wrong with the
 *                          goods (`wants_post_delivery_return`, which refuses
 *                          outright if any problem intent is present). A third
 *                          route from evidence would bypass both guards and let
 *                          the word "exchange" take a damage case. So this
 *                          concept is collected and reported, and decides
 *                          nothing.
 *   PACKAGING_OR_TRANSIT   Contributes `delivery_request`, but the DROP of
 *   _DAMAGE                `damaged_product` that has to accompany it belongs
 *                          with the other intent-versus-intent judgements in
 *                          `refine`, not here.
 */
const CONCEPT_INTENT: Readonly<Partial<Record<OwnershipConcept, MessageIntent>>> = {
  PHYSICAL_PRODUCT_DAMAGE: "damaged_product",
  PACKAGING_OR_TRANSIT_DAMAGE: "delivery_request",
  FUNCTIONAL_FAULT: "defective_product",
  CONSIGNMENT_WHEREABOUTS: "delivery_request",
  CONSIGNMENT_NOT_RECEIVED: "delivery_request",
  DELIVERED_NOT_RECEIVED: "delivery_request",
  URGENT_DELIVERY_DEADLINE: "delivery_request",
  COLLECTION_POINT_QUERY: "delivery_request",
  UNIT_QUANTITY_SHORTFALL: "wrong_quantity_sent",
  ABSENT_COMPONENT: "missing_component",
  DIFFERENT_ITEM_RECEIVED: "received_wrong_item",
  LISTING_MISMATCH: "wrong_description",
  PRE_DISPATCH_AMENDMENT: "wants_order_change",
  PRE_PURCHASE_ENQUIRY: "pre_sale_question",
  ACCOUNT_OR_PAPERWORK: "admin_issue",
};

function evidenceIntents(text: string): MessageIntent[] {
  const found: MessageIntent[] = [];
  for (const match of resolveEvidenceOwnership(text).upheld) {
    const intent = CONCEPT_INTENT[match.concept];
    if (intent !== undefined && !found.includes(intent)) found.push(intent);
  }
  return found;
}

/**
 * Which category owns which intent, in the order the ownership is decided.
 *
 * ORDER IS THE RULE, so it is written once, here, rather than spread through
 * branches. Two placements carry the weight:
 *
 *   wants_refund first        "Return and refunds" is an outcome category. If
 *                             the customer asked for their money, that is the
 *                             case whatever prompted it.
 *   post-delivery return      The SECOND and only other route to Return from
 *      above order change      this layer, and it is placed here for one
 *                             reason: a swap asked for AFTER delivery is a
 *                             return, and a swap asked for BEFORE shipping is
 *                             an amendment. Without this entry the amendment
 *                             intent claimed both. It cannot fire on a message
 *                             reporting a fault, damage, a missing part, a
 *                             wrong item or a description mismatch, so no
 *                             problem category can lose anything to it — see
 *                             `wantsPostDeliveryReturn`.
 *   order change before       "I ordered the wrong design, send me a different
 *      wrong item             one" is the customer's own mis-selection, not us
 *                             sending the wrong thing. Both signals fire on it;
 *                             the order is what tells them apart.
 *
 * `wants_replacement` deliberately owns NOTHING. It is detected because it is
 * the signal that most often gets mistaken for a refund request, and naming it
 * explicitly is how this layer records that a replacement is not money.
 */
const INTENT_OWNERSHIP: readonly (readonly [MessageIntent, MessageCategory])[] = [
  // THE ORDER IS UNCHANGED, AND THE REFUND RULE IS NOT ENFORCED HERE.
  //
  // "One of the shades arrived smashed, please refund me" must be a Damage case,
  // and the obvious fix — moving `wants_refund` below the problems — breaks the
  // cases where a refund legitimately outranks something: a chase the customer
  // has given up on, a cancellation asked for with the money back. Both are
  // measured, and both are right.
  //
  // So the rule is applied where it belongs, as a judgement about the message
  // rather than as a global precedence: `refine` drops the refund intent when a
  // PROBLEM is asserted, and this order is then correct for everything else.
  ["wants_refund", "Return and refunds"],
  ["wants_post_delivery_return", "Return and refunds"],
  ["wants_order_change", "Order change, before shipping queries"],
  ["received_wrong_item", "Wrong item sent messages"],
  ["missing_component", "Parts missing queries"],
  // Directly below the parts case, and the placement is not arbitrary: where a
  // message names BOTH a component by name and a unit count, the named
  // component is the more specific claim. In practice the two are mutually
  // exclusive anyway — one shortfall reason yields one intent.
  ["wrong_quantity_sent", "Wrong quantity sent issues"],
  ["wrong_description", "Wrong description issues"],
  ["damaged_product", "Damage queries"],
  ["defective_product", "Defective items"],
  ["delivery_request", "Delivery queries"],
  ["pre_sale_question", "Pre sales queries"],
  ["admin_issue", "Admin related issues"],
];

/**
 * The category for a conversation, with the intent layer behind the table.
 *
 * THE FLOW, AND WHY IT IS IN THIS ORDER:
 *
 *   1. `classifyMessageCategory` runs first and unchanged. Anything it names,
 *      it keeps — this layer can never overrule it, only fill in behind it.
 *   2. Machine-generated content stops here and returns null. Not every string
 *      in the inbox came from a person.
 *   3. The intent layer names what it safely can.
 *   4. Anything left that is genuinely a customer writing to us becomes
 *      "Admin related issues" rather than a blank. A general enquiry IS an
 *      admin matter, and an agent can retag it in a click; a blank tells them
 *      nothing and hides the conversation from every filter.
 *
 * `classifyMessageCategory` remains exported and unchanged for callers that
 * want the strict answer with no fallback.
 */
export function classifyMessageCategoryWithFallback(
  customerText: string | null,
): MessageCategory | null {
  const text = normalise(customerText?.trim() ?? "");
  if (text === "") return null;
  if (NOT_FROM_A_CUSTOMER.test(text)) return null;

  // INTENT FIRST. What the customer is trying to achieve decides the category,
  // and the phrase table has already been folded into that judgement as one of
  // its witnesses — see `intentsFromPhraseTable`. Where the two would disagree,
  // intent is what comes out, because ownership order encodes which problem a
  // message is ABOUT while scoring only counts how many words it happened to use.
  const intents = detectIntents(text);
  const owned = ownedIntentCategory(intents);
  if (owned !== null) return owned;

  // The strict table still gets the last word on anything intent could not
  // name — its German and Italian wording reaches shapes no intent pattern
  // here does, and none of that measurement is discarded.
  //
  // EXCEPT WHEN ITS ANSWER IS ADMIN, WHICH IS NOT AN ANSWER OF THAT KIND.
  // Admin is this system's fallback: it means "a customer wrote to us and
  // nothing stronger applies". A strict-table Admin therefore outranks nothing,
  // and letting it return here hid the two layers below from every message that
  // happened to use an admin word. "I paid for next day and it's a week late"
  // is a courier complaint that reached Admin on the word "paid".
  const strict = classifyMessageCategory(customerText);
  if (strict !== null && strict !== "Admin related issues") return strict;

  // A customer telling us the thing is sorted is not raising an admin matter.
  // Better a blank than a wrong tag on a conversation that needs nothing.
  if (strict === null && looksResolved(text)) return null;

  // THE WHOLE CST CORPUS, LAST. Everything measured has now declined, and the
  // question left is whether the customer is using a real CST trigger family
  // that no pattern above has been written for. `readCorpus` answers it under
  // role and condition gates — see `CORPUS_CONDITIONS`.
  //
  // THIS IS WHAT THE ADMIN FALLBACK IS FOR, AND WHAT IT IS NOT FOR. Admin is a
  // legitimate answer for a genuine admin matter and for a message nothing can
  // name. It is not the right answer for a customer asking whether a driver is
  // dimmable, and before this layer existed it was the answer they got.
  const fromCorpus = readCorpus(text).category;
  if (fromCorpus !== null) return fromCorpus;

  // And last of all, the reading of the message itself — see
  // `categoryFromSemantics`. Only then is Admin the honest answer.
  return categoryFromSemantics(semanticsOf(text), text) ?? "Admin related issues";
}

/**
 * The category an intent owns — with Admin held back to the end.
 *
 * ADMIN IS THE FALLBACK, AND A FALLBACK CANNOT WIN A CONTEST. `admin_issue` sits
 * last in `INTENT_OWNERSHIP` and is still an intent, so returning it from the
 * ownership loop ended the search before the CST corpus and the semantic reading
 * had been consulted at all. "I paid for next day and it's a week late" raised
 * `admin_issue` on the word "paid" and never reached Delivery sheet 14, which
 * owns exactly that complaint.
 *
 * So it is skipped here and applied by the caller after everything else has
 * declined — which is the same rule already applied to the strict table's Admin
 * verdict, stated once for both.
 */
function ownedIntentCategory(intents: readonly MessageIntent[]): MessageCategory | null {
  for (const [intent, category] of INTENT_OWNERSHIP) {
    if (category === "Admin related issues") continue;
    if (intents.includes(intent)) return category;
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * PROVENANCE
 * ------------------------------------------------------------------------- */

/**
 * Why a message got the category it got, with the CST rows behind it.
 *
 * WHAT THIS IS FOR. A category on its own is an assertion. A reviewer who
 * disagrees with it has nothing to check and no way to tell a genuine
 * disagreement about the case from a bug in a regex. This returns the same
 * answer `classifyMessageCategoryWithFallback` gives, plus the CST evidence
 * that supported it, the evidence that was considered and dropped, and the
 * reason the winner won.
 *
 * WHAT IT DOES NOT CONTAIN. No customer text beyond the matched fragment, no
 * message body, no identifiers, and no workbook contents beyond the sheet name
 * and the one-line condition already written into the evidence map. It is meant
 * to be safe to log.
 */
/* ------------------------------------------------------------------------- *
 * THE MESSAGE AS A SITUATION, NOT AS A BAG OF WORDS
 * ------------------------------------------------------------------------- */

/** Where the customer is in the order's life. */
export type JourneyStage =
  | "prospective"
  | "awaiting_delivery"
  | "received"
  | "returning"
  | "resolved"
  | "unknown";

/** What the customer is asking us to DO. The primary current intent. */
export type RequestedAction =
  | "technical_specification"
  | "availability"
  | "whereabouts"
  | "refund_or_return"
  | "exchange_or_replacement"
  | "order_amendment"
  | "report_problem"
  | "documentation"
  | "none";

/** The problem claims, and what the message does with each. */
export type ClaimName =
  | "physical_damage"
  | "functional_fault"
  | "absent_component"
  | "listing_mismatch"
  | "wrong_item";

/**
 * What actually happened, as opposed to what is being asked for.
 *
 * Separate from `requestedAction` because the two are independent and the
 * confusion between them is a category error in the literal sense: "the shade
 * arrived smashed, please refund me" has a damage EVENT and a refund REQUEST,
 * and CST files it under the event.
 */
export type MessageEvent =
  | "physical_damage"
  | "functional_failure"
  | "parcel_not_received"
  | "wrong_item_supplied"
  | "quantity_mismatch"
  | "component_missing"
  | "listing_mismatch"
  | "none";

export type MessageSemantics = {
  readonly journey: JourneyStage;
  /** What the customer is telling us happened. */
  readonly event: MessageEvent;
  readonly requestedAction: RequestedAction;
  /** What the message DOES: asks, tells, instructs, corrects, acknowledges. */
  readonly speechAct: SpeechAct;
  readonly claims: Readonly<Record<ClaimName, ClaimStatus>>;
};

/**
 * Reads the whole message as a situation.
 *
 * DERIVED, NOT STORED, and deliberately coarse. It exists so a reviewer can see
 * WHY a category was chosen in the terms a person would use — "they are asking
 * for a specification and asserting no problem" — rather than as a list of
 * regexes that happened to fire. The classifier's own decisions are made by the
 * intent layer; this reports the reasoning in a readable form and is the thing
 * to look at first when a category is wrong.
 */
export function semanticsOf(customerText: string | null): MessageSemantics {
  const text = normalise(customerText?.trim() ?? "");

  const claims: Record<ClaimName, ClaimStatus> = {
    physical_damage: claimStatus(text, IS_DAMAGED),
    functional_fault: claimStatus(text, IS_DEFECTIVE),
    // "uns fehlt die Rechnung" is an absent INVOICE, not an absent component.
    // ADMIN.xlsx sheet A owns it, and reading it as a component claim is what
    // put six live invoice requests into Parts missing.
    absent_component: ADMIN_IS_WHAT_IS_MISSING.test(text)
      ? "not_stated"
      : claimStatus(text, SOMETHING_ABSENT),
    listing_mismatch: claimStatus(text, LISTING_MISMATCH, { negationReverses: false }),
    wrong_item: claimStatus(text, A_MISMATCH),
  };

  const journey: JourneyStage = looksResolved(text)
    ? "resolved"
    : returnIsUnderWay(text)
      ? "returning"
      : hasTakenDelivery(text)
        ? "received"
        : HAS_NOT_ARRIVED.test(text) || CHASING_A_CONSIGNMENT.test(text)
          ? "awaiting_delivery"
          : asksOrRequests(text) && namesAProductAttribute(text)
            ? "prospective"
            : "unknown";

  // Ordered as the ownership layer orders the categories, so the action named
  // here is the one that decides — a refund asked for alongside a fault is a
  // refund request, which is what CST does with it too.
  const asserted = (claim: ClaimName) => claims[claim] === "asserted";
  const requestedAction: RequestedAction = wantsMoneyBack(text) || returnIsUnderWay(text)
    ? "refund_or_return"
    : WANTS_A_REPLACEMENT.test(text) && hasTakenDelivery(text)
      ? "exchange_or_replacement"
      : AMENDMENT_REQUEST.test(text) && !hasTakenDelivery(text)
        ? "order_amendment"
        : asserted("physical_damage") ||
            asserted("functional_fault") ||
            asserted("absent_component") ||
            asserted("wrong_item") ||
            asserted("listing_mismatch")
          ? "report_problem"
          : ASKING_FOR_PAPERWORK.test(text)
            ? "documentation"
            : CHASING_A_CONSIGNMENT.test(text) || HAS_NOT_ARRIVED.test(text)
              ? "whereabouts"
              : asksOrRequests(text) && namesAProductAttribute(text)
                ? "technical_specification"
                : asksOrRequests(text) && PACK_SIZE_QUESTION.test(text)
                  ? "availability"
                  : "none";

  // Ordered as the categories own each other: a wrong item that is also short
  // is a wrong item, a shortfall counted against the order is a quantity error
  // before it is an absent component.
  const shortfall = quantityShortfallEvidence(text);
  const event: MessageEvent = asserted("wrong_item")
    ? "wrong_item_supplied"
    : shortfall === "ORDERED_QUANTITY_GREATER_THAN_RECEIVED" || shortfall === "PARTIAL_ORDER_RECEIVED"
      ? "quantity_mismatch"
      : asserted("absent_component") || shortfall === "MISSING_ORDER_COMPONENT"
        ? "component_missing"
        : asserted("listing_mismatch")
          ? "listing_mismatch"
          : asserted("physical_damage")
            ? "physical_damage"
            : asserted("functional_fault")
              ? "functional_failure"
              : HAS_NOT_ARRIVED.test(text) || CHASING_A_CONSIGNMENT.test(text)
                ? "parcel_not_received"
                : "none";

  return { journey, event, requestedAction, speechAct: speechActOf(text), claims };
}

/* ------------------------------------------------------------------------- *
 * THE WHOLE CORPUS, ROLE-GATED AND CONDITION-CHECKED
 *
 * `cst-category-evidence.ts` is a reviewed selection: the rows that were needed
 * to settle a specific overlap, each with a hand-written condition. This is the
 * OTHER half — all 730 rows of all eleven workbooks, so a customer using a real
 * CST trigger family that nobody has yet written a pattern for still reaches the
 * right category instead of the admin catch-all.
 *
 * IT IS NOT A SECOND PHRASE TABLE WITH MORE ROWS IN IT. Three things stop that:
 *
 *   ROLE       Only PRIMARY_ISSUE rows may propose. The corpus is full of
 *              triggers that are useful once the category is known and useless
 *              for choosing it — "please refund me" appears in six workbooks.
 *
 *   CONDITION  A proposal has to survive what the whole message says. Damage
 *              needs damage ASSERTED, not merely mentioned; Wrong quantity needs
 *              a counted shortfall; Pre sales needs no problem asserted at all.
 *              These are the same readings `semanticsOf` reports.
 *
 *   OWNERSHIP  What survives is ordered by the documented ownership rules, not
 *              by how many rows or how many workbooks matched. Nothing here
 *              counts anything.
 *
 * AND IT RUNS LAST. Everything measured — the strict table, the intent layer,
 * the reviewed evidence map — has already spoken by the time this is consulted,
 * so it can only fill in a blank. It cannot take a category away from a layer
 * that named one.
 * ------------------------------------------------------------------------- */

/**
 * THE PARCEL'S JOURNEY, beyond "where is it".
 *
 * `Delivery_Master_Rules final.xlsx` is not only a tracking book. Sheets 2, 6,
 * 7, 8, 10, 11, 12, 15, 21 and 22 are the courier's handling of the consignment:
 * where it was left, whether the building could be reached, customs holding it,
 * the customer refusing it at the door, the driver's conduct, and where to leave
 * it next time. Every one of those is the delivery of the parcel and nothing
 * else about the goods — which is exactly the scope this category was narrowed
 * to. A test that only asked "is the customer chasing it" reached none of them,
 * and fourteen delivery families fell to the admin catch-all.
 *
 * IT STILL CANNOT REACH URGENCY. There is no deadline, no electrician and no
 * "I need it by Friday" here, deliberately: those are context Delivery records
 * about a case it already owns, and reading them as delivery evidence is the
 * defect this whole layer was written to stop.
 */
const DELIVERY_PROCESS = new RegExp(
  [
    // 2.2–2.4, 22.1 — where the parcel was left, or should be.
    "\\bleft\\s+(?:it\\s+)?(?:outside|in\\s+(?:the\\s+)?(?:bin|shed|porch|garden|street|public|rain)|on\\s+the\\s+(?:doorstep|pavement|street|step)|at\\s+the\\s+(?:side|front|door)|with\\s+(?:a\\s+|my\\s+)?neighbour|in\\s+a\\s+safe\\s+place)\\b",
    "\\bleave\\s+it\\s+(?:with|at|in|by)\\b",
    "\\bsafe\\s+place\\b",
    // 2.4, 6.3 — the parcel is SITTING somewhere. The predicate is required:
    // a bare "post office" is equally the customer explaining they cannot get
    // to one, which is a returns matter (Returns INT10) and not this.
    "\\b(?:left|held|waiting|sitting|it'?s|is|at)\\s+(?:at\\s+)?(?:the\\s+|a\\s+|my\\s+)?(?:collection\\s+point|pick-?up\\s+point|relay\\s+point|parcel\\s+shop|post\\s+office|depot|locker)\\b",
    "\\b(?:collection\\s+point|parcel\\s+shop|depot)\\b[^.!?;\\n]{0,30}?\\b(?:for\\s+days|notification|notified|collect\\s+it)\\b",
    // 15.1, 12.x — the parcel lost or taken in the courier's hands.
    "\\b(?:stolen|stole\\s+it|taken\\s+from\\s+(?:my|the)\\s+(?:doorstep|porch|door))\\b",
    "\\bcourier\\b[^.!?;\\n]{0,40}?\\b(?:lost|admitted|says|error|mistake|damaged|returned|refused|took)\\b",
    "\\b(?:lost\\s+in\\s+(?:the\\s+)?(?:post|transit)|lost\\s+within\\s+the\\s+courier)\\b",
    // 21.x — the driver.
    "\\b(?:delivery\\s+)?driver\\b[^.!?;\\n]{0,40}?\\b(?:rude|aggressive|refused|would\\s?n[o']?t|threw|left)\\b",
    "\\brude\\s+(?:delivery\\s+)?driver\\b",
    // 6.x, 7.x — the attempt that failed.
    "\\b(?:failed|attempted|missed)\\s+deliver(?:y|ies)\\b|\\bdelivery\\s+attempt\\b",
    "\\b(?:could\\s?n[o']?t|couldn'?t|unable\\s+to)\\s+(?:access|get\\s+(?:in|through)|find)\\s+(?:the\\s+)?(?:building|gate|entrance|address|flat|property|house)\\b",
    "\\b(?:business|office|commercial)\\s+address\\b[^.!?;\\n]{0,30}?\\bclosed\\b",
    // 10.x — customs.
    "\\bcustoms\\b|\\bimport\\s+dut(?:y|ies)\\b|\\bduties\\s+(?:unpaid|not\\s+paid|weren'?t\\s+paid)\\b",
    // 8.x, 11.x — returned to sender, or refused at the door.
    "\\breturn(?:ed)?\\s+to\\s+sender\\b|\\brts\\b",
    "\\breturned\\s+(?:because|due\\s+to|it\\s+because)\\b|\\bsent\\s+(?:it\\s+)?back\\s+due\\s+to\\b",
    "\\bcourier\\s+returned\\b|\\baddress\\s+(?:wasn'?t|was\\s+not|not)\\s+found\\b",
    "\\bi\\s+(?:refused|rejected|did\\s?n[o']?t\\s+accept)\\s+(?:the\\s+)?(?:delivery|parcel|package|it)\\b",
    "\\brefused\\s+(?:it\\s+)?at\\s+the\\s+door\\b",
    "\\bcoming\\s+back\\s+to\\s+you\\b|\\bbeing\\s+sent\\s+back\\b",
    // 14.2 — the express service that failed. A parcel that came very late is a
    // courier complaint; "sorry for the late reply" is not, which is why the
    // lateness has to be predicated of the consignment or counted in days.
    "\\b(?:parcel|order|delivery|item|package|shipment)\\b[^.!?;\\n]{0,30}?\\b(?:is|was|arrived|came)\\s+(?:\\w+\\s+){0,2}?late\\b",
    "\\b(?:a\\s+week|\\d+\\s+(?:days?|weeks?))\\s+late\\b|\\bpaid\\s+for\\s+next\\s+day\\b",
    // German, translated by `translateGermanTerms` into "collection point".
    "\\bcollection\\s+point\\b",
  ].join("|"),
  "i",
);

/**
 * AN INSTRUCTION ABOUT AN ORDER WE STILL HAVE.
 *
 * `ORDER BEFORRE SHIPPING And cancelation .xlsx` sheets 9 to 14 are all of this:
 * a duplicate order to unpick, an item to take off, a shipping upgrade, two
 * orders to combine, gift wrapping, no invoice in the box, a gift note, a
 * different payment method. None of them uses the word "change", so
 * `AMENDMENT_REQUEST` reached none of them and eight families sat in Admin.
 *
 * `hasTakenDelivery` is applied by the caller, which is what keeps this on the
 * pre-dispatch side of the category's own name.
 */
const PRE_DISPATCH_INSTRUCTION = new RegExp(
  [
    // 3 A3 / INT-OS03 — the duplicate.
    "\\b(?:ordered\\s+(?:it\\s+)?twice|placed\\s+two\\s+orders|duplicate\\s+order|double\\s+order|two\\s+orders\\s+(?:for\\s+the\\s+)?same)\\b",
    // 11 I4 — take one off.
    "\\b(?:remove|take)\\s+(?:one|an?\\s+item|it)\\s+(?:item\\s+)?(?:off|out|from)\\b|\\bdo\\s?n[o']?t\\s+want\\s+one\\s+of\\s+them\\b",
    "\\b(?:add|order)\\s+(?:another|one\\s+more|an\\s+extra)\\b|\\bincrease\\s+(?:the\\s+)?quantity\\b",
    // 12 J1 / J2 — shipping preference and combining.
    // ASKED FOR, not reported. "I paid for next day delivery and it is a week
    // late" names the same service and is a courier complaint, so the request
    // has to be there in the sentence.
    "\\b(?:can|could|please|want|need|possible|upgrade|pay\\s+for)\\b[^.!?;\\n]{0,30}?\\b(?:express|next\\s+day|overnight|priority|faster|rush)\\s+(?:shipping|delivery|postage|dispatch)\\b",
    "\\bupgrade\\s+(?:to\\s+)?(?:express|shipping|delivery|postage)\\b",
    "\\bcombine\\s+(?:my\\s+|the\\s+|two\\s+)?orders?\\b|\\bsend\\s+(?:them\\s+)?together\\b|\\bone\\s+(?:shipment|delivery)\\b",
    "\\b(?:hold|delay)\\s+(?:my\\s+|the\\s+)?(?:order|dispatch|shipment)\\b|\\bdo\\s?n[o']?t\\s+(?:send|dispatch)\\s+yet\\b",
    // 13 K1–K3 — gift and packing instructions.
    "\\bgift\\s?(?:wrap\\w*|note|message|receipt)\\b|\\bwrap\\s+it\\s+as\\s+a\\s+gift\\b",
    "\\bno\\s+(?:invoice|receipt|pricing|price)\\s+(?:in|inside|with)\\s+(?:the\\s+)?(?:box|parcel|package)\\b",
    "\\b(?:do\\s?n[o']?t|please\\s+do\\s+not)\\s+include\\s+(?:the\\s+)?price\\b",
    // 14 L3 — payment method.
    "\\b(?:change|different|switch)\\s+(?:the\\s+)?payment\\s+(?:method|option)?\\b|\\buse\\s+(?:a\\s+)?different\\s+card\\b|\\bpay\\s+differently\\b",
    // 10 H1 — the address, before it goes.
    "\\b(?:change|update|amend|correct)\\s+(?:my\\s+|the\\s+|delivery\\s+|shipping\\s+)?address\\b|\\bput\\s+the\\s+wrong\\s+address\\b",
  ].join("|"),
  "i",
);

/**
 * A RETURN ALREADY IN MOTION, AND THE MACHINERY OF ONE.
 *
 * Sheets 10, 11, 12, 14 and 16 of the Returns workbook are not about deciding to
 * return something — that decision has been made. They are the label that will
 * not print, the QR code that is blurred, the eBay case that has been opened,
 * the thirty days that have passed, the three-year warranty being claimed. A
 * test that asked only "does this customer want a refund" refused all twelve of
 * those families, and each of them is unambiguously a returns matter.
 */
const RETURN_LOGISTICS = new RegExp(
  [
    // 14 RL1 / RL2 — the label itself.
    "\\breturn(?:s)?\\s+label\\b|\\bprepaid\\s+label\\b",
    "\\b(?:no|have\\s?n[o']?t\\s+got|do\\s?n[o']?t\\s+have|cannot|can\\s?n[o']?t|unable\\s+to)\\s+(?:a\\s+)?(?:print(?:er)?|access\\s+to\\s+a\\s+printer)\\b",
    "\\bqr\\s?(?:code)?\\b[^.!?;\\n]{0,30}?\\b(?:blurred|unclear|not\\s+clear|expired|wo\\s?n[o']?t\\s+scan|too\\s+blurred)\\b",
    "\\b(?:label|qr\\s?code)\\s+(?:has\\s+)?(?:expired|is\\s+out\\s+of\\s+date|wo\\s?n[o']?t\\s+scan|invalid|not\\s+valid)\\b",
    // 12 EB1–EB5 / 16 AZ1–AZ5 — the platform case.
    "\\b(?:ebay|amazon)\\s+(?:case|return|claim|guarantee)\\b|\\ba\\s?-?to\\s?-?z\\b",
    "\\b(?:opened|raised|filed)\\s+(?:a\\s+)?(?:case|claim|return|dispute)\\b|\\breturn\\s+case\\b",
    // 10 BR1 / 11 WR1 — the window and the warranty.
    "\\b(?:past|outside|beyond|over)\\s+(?:the\\s+)?(?:30|thirty|60|sixty)\\s*(?:days?|day)\\b",
    "\\b(?:outside|past)\\s+(?:the\\s+)?return\\s+(?:window|period)\\b",
    "\\b(?:\\d\\s*-?\\s*year\\s+)?(?:warranty|guarantee)\\s+(?:claim|period)?\\b",
    // 08 BS12 / BS14 — combining returns, and asking for longer.
    "\\bmore\\s+time\\s+to\\s+return\\b|\\breturn\\s+it\\s+later\\b",
    "\\b(?:combine|put)\\s+(?:the\\s+)?(?:returns?|them\\s+all)\\b[^.!?;\\n]{0,30}?\\b(?:one\\s+box|together|one\\s+parcel)\\b",
    // 08 BS2 — the performance return.
    "\\b(?:not\\s+bright\\s+enough|too\\s+dim|not\\s+enough\\s+light|not\\s+as\\s+bright\\s+as)\\b",
  ].join("|"),
  "i",
);

/**
 * THE COURIER SENT IT BACK — Delivery sheet 8, not a customer return.
 *
 * The word "returned" belongs to both, and the difference is who did it: a
 * parcel that came back because nobody was home is a delivery case, and a parcel
 * the customer posted back is a returns case.
 */
const COURIER_SENT_IT_BACK =
  /\breturn(?:ed|ing)?\s+to\s+sender\b|\brts\b|\bcourier\s+returned\b|\b(?:parcel|package|it)\s+(?:is\s+)?(?:being\s+)?(?:sent|coming)\s+back\s+to\s+you\b|\breturned\s+(?:because|due\s+to)\b/i;

/** INT-WQ16: more arrived than was ordered. A mismatch, counted upwards. */
const RECEIVED_MORE_THAN_ORDERED =
  /\b(?:received|got|sent)\s+(?:an?\s+)?(?:extra|additional|too\s+many|more\s+than\s+(?:i\s+)?ordered)\b|\b(?:extra|additional|unexpected)\s+(?:item|items|package|parcel|delivery)\b|\bmore\s+than\s+(?:i\s+)?ordered\b|\bi\s+did\s+not\s+order\b/i;

/** Why a corpus proposal was refused. */
export type CorpusRejection =
  | "NO_DAMAGE_ASSERTED"
  | "NO_FAULT_ASSERTED"
  | "NO_ABSENCE_ASSERTED"
  | "THE_MISSING_THING_IS_PAPERWORK"
  | "NO_LISTING_MISMATCH_ASSERTED"
  | "NO_DIFFERENT_ITEM_ASSERTED"
  | "NO_COUNTED_SHORTFALL"
  | "NO_DELIVERY_MATTER"
  | "NOT_A_PRE_DISPATCH_AMENDMENT"
  | "NO_RETURN_OR_REFUND_INTENT"
  | "A_PROBLEM_IS_ASSERTED"
  | "A_PAPERWORK_REQUEST"
  | "NOT_AN_ADMIN_MATTER";

/**
 * What a message must actually SAY for each category's corpus rows to count.
 *
 * One entry per category, stated as the condition its own workbook states in
 * prose. A category with no entry could be proposed by any row that matched,
 * which is the failure this table exists to make impossible.
 */
const CORPUS_CONDITIONS: Readonly<
  Record<MessageCategory, (text: string, semantics: MessageSemantics) => CorpusRejection | null>
> = {
  "Damage queries": (_text, semantics) =>
    semantics.claims.physical_damage === "asserted" ? null : "NO_DAMAGE_ASSERTED",

  "Defective items": (_text, semantics) =>
    semantics.claims.functional_fault === "asserted" ? null : "NO_FAULT_ASSERTED",

  // The absence has to be CLAIMED. A component noun, a count and a question form
  // are each routinely present in a specification question and none of them is a
  // report that something is missing — see `message-semantics.ts`.
  // "uns fehlt die Rechnung" — we are MISSING the INVOICE. The absent thing is
  // paperwork, which ADMIN.xlsx sheet A owns. The intent layer already refuses
  // this in `refine`; the corpus reaches the same conclusion by its own route
  // and needs the same guard, or demoting `admin_issue` hands it a parts case.
  "Parts missing queries": (text, semantics) =>
    ADMIN_IS_WHAT_IS_MISSING.test(text)
      ? "THE_MISSING_THING_IS_PAPERWORK"
      : semantics.claims.absent_component === "asserted"
        ? null
        : "NO_ABSENCE_ASSERTED",

  "Wrong description issues": (_text, semantics) =>
    semantics.claims.listing_mismatch === "asserted" ? null : "NO_LISTING_MISMATCH_ASSERTED",

  // TWO ROUTES, because the workbook has two. Sheets 3–7 and 9 are about a
  // DIFFERENT item arriving; sheet 8 is about the right item in the wrong size.
  // Both need the goods to be here — a fit question asked before buying is a
  // pre-sales compatibility query, which is INT-PS08's family, not this one.
  "Wrong item sent messages": (text, semantics) =>
    (semantics.claims.wrong_item === "asserted" || asserts(text, SIZE_OR_FIT_MISMATCH)) &&
    HAS_THE_GOODS.test(text)
      ? null
      : "NO_DIFFERENT_ITEM_ASSERTED",

  // A MISMATCH IN EITHER DIRECTION. INT-WQ16 (RECEIVED EXTRA — unexpected item)
  // is the sheet's own row for the customer who got MORE than they ordered, and
  // a rule that only knows how to count downwards could never reach it.
  "Wrong quantity sent issues": (text) =>
    quantityShortfallEvidence(text) !== null || asserts(text, RECEIVED_MORE_THAN_ORDERED)
      ? null
      : "NO_COUNTED_SHORTFALL",

  // TRACKING, COURIER, THE PARCEL'S JOURNEY. Not urgency, not a deadline, not
  // an electrician — those are context the Delivery workbook records about a
  // case it already owns, and reading them as delivery evidence is what put
  // bathroom suitability questions in this category.
  "Delivery queries": (text, semantics) => {
    // AN OUTBOUND PARCEL IS NOT THIS CATEGORY. A customer who cannot reach a
    // post office, whose return is lost, or who wants us to collect, is asking
    // Returns a question about the parcel going the other way — and Delivery
    // sits above Returns in the ownership order, so without this it would take
    // those cases. The exception is the consignment the COURIER sent back,
    // which is Delivery sheet 8's whole subject.
    if (semantics.journey === "returning" && !COURIER_SENT_IT_BACK.test(text)) {
      return "NO_DELIVERY_MATTER";
    }
    return semantics.requestedAction === "whereabouts" ||
      semantics.journey === "awaiting_delivery" ||
      CHASING_A_CONSIGNMENT.test(text) ||
      HAS_NOT_ARRIVED.test(text) ||
      DELIVERY_PROCESS.test(text)
      ? null
      : "NO_DELIVERY_MATTER";
  },

  // BEFORE SHIPPING is the whole category. A post-delivery exchange is a return.
  "Order change, before shipping queries": (text, semantics) =>
    (semantics.requestedAction === "order_amendment" ||
      AMENDMENT_REQUEST.test(text) ||
      amendsAnOrderAlreadyPlaced(text) ||
      PRE_DISPATCH_INSTRUCTION.test(text)) &&
    !hasTakenDelivery(text) &&
    semantics.journey !== "returning"
      ? null
      : "NOT_A_PRE_DISPATCH_AMENDMENT",

  "Return and refunds": (text, semantics) =>
    semantics.journey === "returning" ||
    semantics.requestedAction === "refund_or_return" ||
    semantics.requestedAction === "exchange_or_replacement" ||
    wantsMoneyBack(text) ||
    RETURN_LOGISTICS.test(text)
      ? null
      : "NO_RETURN_OR_REFUND_INTENT",

  // A PRODUCT QUESTION WITH NO PROBLEM IN IT. Pre sales survives a previous
  // purchase — the customer who bought last year and is asking whether the
  // transformer has isolated windings is asking a pre-sales question — so the
  // test is about the CLAIM, not about whether they have ever ordered.
  "Pre sales queries": (text, semantics) => {
    // A DOCUMENT REQUEST IS ADMIN'S, and Pre sales sits above Admin here — so
    // "is there a wiring diagram for this fitting?" would otherwise be taken off
    // ADMIN.xlsx sheet C by the fact that it is a question about a product.
    if (ASKING_FOR_PAPERWORK.test(text)) return "A_PAPERWORK_REQUEST";
    const asserted = Object.values(semantics.claims).some((claim) => claim === "asserted");
    if (asserted) return "A_PROBLEM_IS_ASSERTED";
    if (semantics.journey === "returning") return "A_PROBLEM_IS_ASSERTED";
    return asksOrRequests(text) ? null : "A_PROBLEM_IS_ASSERTED";
  },

  // Admin's own primary families: paperwork, compliance, payment, platform,
  // safety and recall. NOT the catch-all — that is the fallback below, and
  // keeping them separate is what makes "no CST-supported message falls to
  // Admin" a checkable claim rather than a hope.
  "Admin related issues": (text) =>
    ASKING_FOR_PAPERWORK.test(text) || ADMIN_MATTER.test(text) ? null : "NOT_AN_ADMIN_MATTER",
};

/**
 * Which category owns a message when more than one survives its conditions.
 *
 * THE PROBLEM OUTRANKS THE REMEDY, and the more specific problem outranks the
 * more general one. Read top to bottom, this is the ownership the task
 * documents: a smashed shade with a refund request is a Damage case; a customer
 * who wants to swap a colour they simply do not like, with nothing wrong, is a
 * Return. Nothing here is decided by how many rows matched.
 */
const CORPUS_OWNERSHIP: readonly MessageCategory[] = [
  "Wrong item sent messages",
  "Parts missing queries",
  "Wrong quantity sent issues",
  "Wrong description issues",
  "Damage queries",
  "Defective items",
  "Delivery queries",
  "Order change, before shipping queries",
  "Return and refunds",
  "Pre sales queries",
  "Admin related issues",
];

/** One corpus row considered, with the outcome. Safe to log. */
export type CorpusCandidate = {
  readonly category: MessageCategory;
  readonly id: string;
  readonly file: string;
  readonly sheet: string;
  readonly name: string;
  readonly role: RuleRole;
  /** The workbook's own wording that matched — never the customer's. */
  readonly phrase: string;
  readonly rejectedBecause: CorpusRejection | null;
};

export type CorpusReading = {
  /** PRIMARY_ISSUE rows whose category conditions held. */
  readonly admitted: readonly CorpusCandidate[];
  /** PRIMARY_ISSUE rows whose category conditions did not hold. */
  readonly refused: readonly CorpusCandidate[];
  /**
   * Rows that matched but may not propose: remedies, context, internal
   * scenarios, resolutions and catch-alls. Reported, never counted.
   */
  readonly signals: readonly CorpusCandidate[];
  /** The category the corpus would name, or null. */
  readonly category: MessageCategory | null;
};

const CATEGORY_NAMES = new Set<string>(MESSAGE_CATEGORIES);

function isCategory(value: string): value is MessageCategory {
  return CATEGORY_NAMES.has(value);
}

/** Reads the whole corpus against one message, without deciding anything else. */
export function readCorpus(customerText: string | null): CorpusReading {
  const text = normalise(customerText?.trim() ?? "");
  if (text === "") return { admitted: [], refused: [], signals: [], category: null };

  const semantics = semanticsOf(text);
  const admitted: CorpusCandidate[] = [];
  const refused: CorpusCandidate[] = [];
  const signals: CorpusCandidate[] = [];

  // Conditions are per CATEGORY, and a category can match many rows; evaluating
  // it once keeps this linear in the rows that matched rather than in the rules.
  const verdicts = new Map<MessageCategory, CorpusRejection | null>();

  for (const match of corpusMatches(text)) {
    const { rule } = match;
    if (!isCategory(rule.category)) continue;

    const base = {
      category: rule.category,
      id: rule.id,
      file: rule.file,
      sheet: rule.sheet,
      name: rule.name,
      role: rule.role,
      phrase: match.phrase,
    } as const;

    if (rule.role !== "PRIMARY_ISSUE") {
      signals.push({ ...base, rejectedBecause: null });
      continue;
    }

    let verdict = verdicts.get(rule.category);
    if (verdict === undefined) {
      verdict = CORPUS_CONDITIONS[rule.category](text, semantics);
      verdicts.set(rule.category, verdict);
    }
    if (verdict === null) admitted.push({ ...base, rejectedBecause: null });
    else refused.push({ ...base, rejectedBecause: verdict });
  }

  const owned = CORPUS_OWNERSHIP.find((category) =>
    admitted.some((candidate) => candidate.category === category),
  );

  return { admitted, refused, signals, category: owned ?? null };
}

/**
 * The category the WHOLE-MESSAGE READING names, when no phrase anywhere did.
 *
 * THE LAST THING BEFORE ADMIN, AND THE POINT OF THE WHOLE EXERCISE. By the time
 * this runs, four layers have declined: the strict table, the intent layer, the
 * reviewed evidence map and all 730 corpus rows. What is left is a message whose
 * WORDING nobody has written down, and the question is whether we still know
 * what it is ABOUT. Often we do:
 *
 *   "Due to the physical size and weight of my returning parcel, I believe the
 *    cost should be no more than a standard 1st class letter"
 *
 * matches no trigger phrase in any of the eleven books, and every reading of it
 * says the same thing: the customer is returning something and arguing about
 * what it costs. RETURNS & REFUNDS owns that (INT-GAP01, RETURN POSTAGE COST
 * COMPLAINT). Filing it under Admin because no phrase matched is throwing away
 * an answer we already have.
 *
 * IT NAMES NOTHING IT HAS NOT READ. Every branch is a signal `semanticsOf`
 * derived from the message — an event that was ASSERTED, an action that was
 * ASKED FOR, a stage of the order the customer put themselves at. A message that
 * says none of those still falls to Admin, which is what Admin is for.
 *
 * THE EVENT COMES FIRST, and that is the ownership rule stated once more in the
 * one place it can still be got wrong: what happened decides the category, and
 * what the customer wants done about it does not.
 */
function categoryFromSemantics(semantics: MessageSemantics, text: string): MessageCategory | null {
  switch (semantics.event) {
    case "wrong_item_supplied":
      return "Wrong item sent messages";
    case "quantity_mismatch":
      return "Wrong quantity sent issues";
    case "component_missing":
      return "Parts missing queries";
    case "listing_mismatch":
      return "Wrong description issues";
    case "physical_damage":
      return "Damage queries";
    case "functional_failure":
      return "Defective items";
    case "parcel_not_received":
      return "Delivery queries";
    case "none":
      break;
  }

  switch (semantics.requestedAction) {
    case "whereabouts":
      return "Delivery queries";
    case "refund_or_return":
    case "exchange_or_replacement":
      return "Return and refunds";
    case "order_amendment":
      return "Order change, before shipping queries";
    case "technical_specification":
    case "availability":
      return "Pre sales queries";
    // Paperwork IS an admin matter, and saying so here rather than letting it
    // fall through keeps the fallback's meaning honest: Admin because the
    // customer asked for a document, not Admin because nothing matched.
    case "documentation":
      return "Admin related issues";
    case "report_problem":
    case "none":
      break;
  }

  // The courier's handling of the consignment, where nothing above named it.
  if (DELIVERY_PROCESS.test(text) && semantics.journey !== "returning") return "Delivery queries";

  return semantics.journey === "returning" ? "Return and refunds" : null;
}

export type CategoryExplanation = {
  readonly category: MessageCategory | null;
  /** The whole-message reading behind the decision. */
  readonly semantics: MessageSemantics;
  /** What the message was read as wanting, in ownership order. */
  readonly intents: readonly MessageIntent[];
  /** CST rows that matched and whose conditions held. */
  readonly evidence: readonly EvidenceMatch[];
  /** CST rows that matched and were dropped, each with the failing condition. */
  readonly rejected: readonly RejectedEvidence[];
  /** The whole-corpus reading: what it proposed, refused, and merely noted. */
  readonly corpus: CorpusReading;
  /**
   * Why this category and not another: the concept it owns where CST evidence
   * supports it, otherwise the intent that claimed it, otherwise the fallback.
   */
  readonly reason: string;
};

export function explainMessageCategory(customerText: string | null): CategoryExplanation {
  const text = normalise(customerText?.trim() ?? "");
  const semantics = semanticsOf(text);
  const empty = {
    intents: [],
    evidence: [],
    rejected: [],
    semantics,
    corpus: { admitted: [], refused: [], signals: [], category: null },
  } as const;

  if (text === "") return { category: null, ...empty, reason: "NO_CUSTOMER_TEXT" };
  if (NOT_FROM_A_CUSTOMER.test(text)) return { category: null, ...empty, reason: "NOT_FROM_A_CUSTOMER" };

  const { upheld, rejected } = resolveEvidenceOwnership(text);
  const intents = detectIntents(text);
  const corpus = readCorpus(text);
  const category = classifyMessageCategoryWithFallback(text);

  // The concept is the better explanation where one exists, because it names
  // the judgement — PHYSICAL_PRODUCT_DAMAGE says why Damage beat Delivery,
  // where "damaged_product" only restates the answer.
  const owningConcept = upheld.find((match) => match.category === category)?.concept;
  const owningIntent = INTENT_OWNERSHIP.find(
    ([intent, owns]) => owns === category && intents.includes(intent),
  )?.[0];

  // The corpus row that carried it, where neither of the two layers above did —
  // which is the case worth naming, because it means the category came from a
  // rule book family rather than from a pattern someone wrote by hand.
  const owningRow =
    owningConcept === undefined && owningIntent === undefined
      ? corpus.admitted.find((candidate) => candidate.category === category)
      : undefined;

  return {
    category,
    semantics,
    intents,
    evidence: upheld,
    rejected,
    corpus,
    reason:
      owningConcept ??
      (owningIntent !== undefined ? owningIntent.toUpperCase() : null) ??
      (owningRow !== undefined ? `CST_CORPUS ${owningRow.id}` : null) ??
      (category === null ? "NOTHING_TO_NAME" : "ADMIN_FALLBACK"),
  };
}

/* ------------------------------------------------------------------------- *
 * THREAD-AWARE CLASSIFICATION
 *
 * A conversation is not one long string, and treating it as one loses things.
 * Concatenating every inbound message merges signals that were never in the
 * same breath — a part missing in message one and a damaged box in message
 * three become a tie that neither message actually had — and it throws away
 * the ORDER, which is what tells us which problem the customer came with.
 *
 * Reading the messages separately, earliest first, is what lets a later "found
 * it, all sorted" leave the original category alone instead of diluting it.
 * ------------------------------------------------------------------------- */

/**
 * The customer telling us it is resolved — nothing is being asked for.
 *
 * These messages carry no intent by design, so they are the ones most likely to
 * fall through every rule and land on the admin catch-all. That is the wrong
 * answer twice over: the conversation is not an admin matter, and if an earlier
 * message named a real problem, that problem is what the conversation is about.
 */
const RESOLUTION_CONFIRMATION = new RegExp(
  [
    "found\\s+(?:it|them|these|those|the\\s+\\w+)",
    "(?:all|now|it\\s+is|its|it's)\\s+sorted",
    "sorted\\s+(?:it|this|now)",
    "problem\\s+(?:is\\s+|has\\s+been\\s+)?(?:solved|resolved|sorted|fixed)",
    "(?:is|has\\s+been)\\s+(?:solved|resolved|fixed)",
    "all\\s+(?:good|fine|ok|okay|well|sorted|there|present)",
    "everything\\s+(?:is\\s+|has\\s+)?(?:fine|ok|okay|good|there|arrived|received|here|complete)",
    "(?:received|got|arrived)\\s+(?:it|them|now)",
    "no\\s+(?:longer|further)\\s+(?:needed|necessary|action|required)",
    "please\\s+(?:ignore|disregard)",
    "disregard\\s+(?:this|that|my)",
    "nothing\\s+(?:further|else)\\s+(?:needed|required)",
    "my\\s+(?:mistake|apologies|bad)",
    // German
    "hat\\s+sich\\s+(?:erledigt|gekl(?:ä|ae)rt)",
    "erledigt",
    "alles\\s+(?:gut|ok|klar|da|bestens|vollst(?:ä|ae)ndig|in\\s+ordnung)",
    "gefunden",
  ].join("|"),
  "i",
);

function looksResolved(text: string): boolean {
  return RESOLUTION_CONFIRMATION.test(text);
}

/**
 * A message made of nothing but greeting and thanks.
 *
 * Used ONLY when deciding whether a whole thread is just the customer signing
 * off, because "All sorted now" followed by "Many thanks" is two messages and
 * both have to be accounted for. It is deliberately not consulted for a single
 * message on its own: a lone "Many thanks, kind regards." is still a customer
 * writing to us, and still gets the admin tag rather than a blank.
 */
const PLEASANTRY_ONLY =
  /^(?:[\s\p{P}\p{S}]*(?:hi|hello|hey|dear|sir|madam|many|much|thanks|thank|you|thankyou|cheers|regards|kind|best|wishes|great|brilliant|perfect|lovely|danke|vielen|dank|gr(?:ü|ue)(?:ß|ss)e|hallo|guten|tag|morgen|abend|mfg|lg)[\s\p{P}\p{S}]*)+$/iu;

/**
 * The categories that represent an actual case, as opposed to an enquiry.
 *
 * Used to pick which of several messages names what the conversation is ABOUT:
 * a thread that opens with a pre-sales question and later reports damage is a
 * damage case, so a case category outranks an enquiry wherever it appears in
 * the thread — while among case categories, the earliest wins.
 */
const CASE_CATEGORIES: readonly MessageCategory[] = [...PROBLEM_CATEGORIES, "Return and refunds"];

/**
 * The category for a whole conversation, from its customer messages in order.
 *
 * THE ORDER OF PREFERENCE, and what each step is protecting:
 *
 *   1. The earliest CASE category any single message names. This is the rule
 *      that stops a closing "found it, everything is fine" from costing the
 *      conversation its Parts missing tag: the confirmation names nothing, so
 *      it cannot outvote the message that did.
 *   2. Failing that, the earliest category of any kind — an enquiry thread
 *      still gets its enquiry tag.
 *   3. Failing that, the intent layer, message by message.
 *   4. Failing that, "Admin related issues" — UNLESS every message is only a
 *      resolution confirmation, in which case there is genuinely nothing to
 *      name and null is honest.
 *
 * Each message is read on its own, so no signal is invented by two unrelated
 * sentences landing next to each other.
 */
export function classifyConversationCategory(
  customerMessages: readonly (string | null)[],
): MessageCategory | null {
  const texts = customerMessages
    .map((message) => normalise(message?.trim() ?? ""))
    .filter((text) => text !== "" && !NOT_FROM_A_CUSTOMER.test(text));

  if (texts.length === 0) return null;

  // Intent first, message by message, in the order they were sent. Each message
  // is read on its own so no signal is invented by two unrelated sentences
  // landing next to each other.
  const perMessage = texts.map((text) => {
    const intents = detectIntents(text);
    const owned = ownedIntentCategory(intents);
    if (owned !== null) return owned;

    // Admin is the fallback and outranks nothing — see the same step in
    // `classifyMessageCategoryWithFallback`.
    const strict = classifyMessageCategory(text);
    if (strict !== null && strict !== "Admin related issues") return strict;

    // THE SAME LAST STEP THE SINGLE-MESSAGE PATH TAKES, and it has to be here
    // too: this function does not call `classifyMessageCategoryWithFallback`,
    // so without it the whole CST corpus is invisible to every conversation in
    // the inbox and reaches only callers classifying one message at a time.
    //
    // Skipped for a message that says the matter is closed, mirroring the
    // single-message path — a customer writing "all sorted, thanks" is not
    // raising whichever family their wording happens to brush against.
    if (strict === null && looksResolved(text)) return null;
    return (
      readCorpus(text).category ??
      categoryFromSemantics(semanticsOf(text), text) ??
      strict ??
      (intents.includes("admin_issue") ? "Admin related issues" : null)
    );
  });

  /*
   * A CASE THE CUSTOMER HAS SINCE CLOSED IS NOT WHAT THE THREAD IS ABOUT.
   *
   * "Earliest case wins" is right for the thread that opens with a problem and
   * ends with a thank-you, and it stays the rule. It is wrong for the thread
   * where the problem was SOLVED and a new one raised afterwards: "a part is
   * missing" ... "found it, all sorted" ... "now the bulb doesn't work" is a
   * defective case, and calling it Parts missing routes an agent to a question
   * the customer answered themselves.
   *
   * So the search starts after the LAST resolution confirmation. When nothing
   * follows it — the ordinary closing thank-you — this falls back to the whole
   * thread, which is the previous behaviour exactly.
   */
  const lastResolved = texts.reduce(
    (latest, text, index) => (looksResolved(text) ? index : latest),
    -1,
  );
  /*
   * The earliest case category in a window — with ONE exception.
   *
   * THE PARCEL TURNING UP ANSWERS THE QUESTION "WHERE IS MY PARCEL". A delivery
   * chase is the one case category that its own thread routinely resolves
   * without anybody saying "sorted". "Where is my parcel?" followed by "it
   * arrived smashed" is a DAMAGE case: the whereabouts question has been
   * answered by events, and the live issue is the state of the goods. Earliest
   * case wins would keep it on Delivery and send an agent to chase a parcel
   * sitting on the customer's table.
   *
   * DELIBERATELY NARROW, on all three counts:
   *
   *   only Delivery is superseded  Every other category still describes
   *                                something wrong once the goods arrive.
   *                                Damage does not stop being damage because a
   *                                later message asks after the replacement,
   *                                which is why the general rule is unchanged.
   *   the later message must say   `hasTakenDelivery` is the strict arrival
   *      the goods arrived         test, so "it still has not arrived" cannot
   *                                qualify.
   *   it must name its own case    A later message with no case category
   *                                supersedes nothing, so a chase followed by
   *                                "any news?" stays a chase.
   */
  const caseCategoryFrom = (start: number): MessageCategory | null => {
    const cases: number[] = [];
    for (let index = start; index < perMessage.length; index++) {
      const category = perMessage[index];
      if (category != null && CASE_CATEGORIES.includes(category)) cases.push(index);
    }
    const first = cases[0];
    if (first === undefined) return null;
    if (perMessage[first] !== "Delivery queries") return perMessage[first]!;

    /*
     * ANY LATER CASE SUPERSEDES A CHASE, not only an arrival.
     *
     * A chase states a PENDING condition — "where is it", "it has not come" —
     * and every later case message says what that condition became. The arrival
     * is only the commonest resolution; the customer who gives up is another:
     *
     *   "I need this today or I'll have to go to B&Q and buy another"
     *   "No, as I've said ... Please issue the refund."
     *
     * The refund is the live intent and the deadline is spent, but earliest-
     * case-wins left it on Delivery. Restricting this to arrivals answered the
     * first shape and not the second.
     *
     * Still narrow in the ways that matter: only Delivery is superseded, and
     * only by a DIFFERENT case category, so a chase followed by another chase
     * stays exactly where it was.
     */
    const supersedes = cases.find(
      (index) => index > first && perMessage[index] !== "Delivery queries",
    );
    return supersedes === undefined ? perMessage[first]! : perMessage[supersedes]!;
  };

  const afterResolution = caseCategoryFrom(lastResolved + 1);
  if (afterResolution != null) return afterResolution;

  const firstCase = caseCategoryFrom(0);
  if (firstCase != null) return firstCase;

  const firstAny = perMessage.find((category) => category != null);
  if (firstAny != null) return firstAny;

  // Nothing identifiable anywhere. A thread that is only the customer telling
  // us it is sorted — with or without a parting thank-you — is not an admin
  // query. At least one message has to actually say it is resolved; a thread of
  // pure pleasantries with no resolution in it still gets the admin tag.
  const resolvedOnly =
    texts.some((text) => looksResolved(text)) &&
    texts.every((text) => looksResolved(text) || PLEASANTRY_ONLY.test(text));
  if (resolvedOnly) return null;

  return "Admin related issues";
}

/* ------------------------------------------------------------------------- *
 * WARM-UP
 *
 * V8 compiles a regular expression's bytecode on its FIRST EXECUTION, not when
 * the literal is created. This module and the evidence map hold a few hundred
 * patterns between them, so the first message to reach the classifier paid
 * ~30ms of compilation that every message after it did not — measured at 31ms
 * cold against 0.35ms in steady state.
 *
 * Running the whole path once against a throwaway string moves that cost to
 * module load, where it happens once per process and alongside the import it
 * already belongs to. It is a pure call on a constant: no state is kept, and
 * the result is deliberately discarded.
 *
 * This is not a micro-optimisation for its own sake. The first inbox request
 * after a deploy is a real request, and it was the one paying.
 */
void detectIntents("warm up the patterns");
void classifyMessageCategory("warm up the patterns");
