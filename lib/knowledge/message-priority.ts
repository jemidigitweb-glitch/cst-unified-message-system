/**
 * How urgently CST staff should handle a conversation.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS NOT THE WORKBOOK'S `Priority` COLUMN
 * ------------------------------------------------------------------------
 * The first version of this module read that column and normalised it. That was
 * measurably wrong, and the counter-example is not marginal: "Is this light
 * dimmable?" carries `HIGH` in PRE-SALES QUERIES.xlsx, so a routine question
 * from somebody who has not bought anything ranked level with a product recall.
 *
 * The column is not a defect — it answers a different question. In the intent
 * sheets it ranks a case WITHIN its own workbook, for the team that owns that
 * workbook: a compatibility question is the pre-sales team's top job. Read as
 * one inbox-wide urgency scale, twelve routine sales enquiries jump the queue.
 *
 * So the column no longer decides anything, with ONE exception stated below.
 *
 * ------------------------------------------------------------------------
 * WHAT DECIDES INSTEAD
 * ------------------------------------------------------------------------
 * Priority answers "how soon does somebody need to touch this", and the answer
 * is built from what the customer actually said, read through the semantic layer
 * the category classifier already uses:
 *
 *   HIGH    a safety hazard, a platform case, a cancellation, an exchange
 *           request, an explicitly urgent customer, or one chasing an unanswered
 *           message.
 *   MEDIUM  a real problem or a request that needs work — delivery, damage,
 *           wrong item, missing parts, returns, refunds, order amendments.
 *   LOW     pre-sales, compatibility, general information, and a customer
 *           closing the case.
 *   null    nothing established. NOT "low" — see `classifyMessagePriority`.
 *
 * THE ONE SURVIVING USE OF THE WORKBOOK COLUMN is its HIGHEST tier, and only
 * that tier. All twenty rows carrying it are recalls, safety concerns, waiting
 * electricians and compensation demands above purchase price — every one of them
 * a Feature 1 HIGH on its own terms. The HIGH, MED and LOW tiers are ignored
 * entirely, which is exactly what stops the dimmable question escalating.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS MODULE DOES NOT DO
 * ------------------------------------------------------------------------
 * It does not reimplement the category classifier, and it changes nothing about
 * it. `semanticsOf`, `claimStatus` and `corpusMatches` are called and their
 * answers read; none of them is modified, wrapped or shadowed. Category output
 * for any message is byte-identical whether or not this module is ever called.
 *
 * IT INVENTS NO ORDER FACTS. It cannot see whether an order has been dispatched,
 * so it never escalates on a claim that depends on knowing — see
 * `ADDRESS_CHANGE_IS_NOT_ESCALATED` below.
 *
 * PURE. No network, no model, no database, no timestamps, no side effects.
 */

import { type ClaimStatus, claimStatus } from "./message-semantics";
import { CST_CATEGORY_CORPUS, type CorpusRule, corpusMatches } from "./cst-corpus-match";
import { classifyMessageCategory, semanticsOf } from "./message-category";

/**
 * THREE LEVELS, THOUGH THE WORKBOOKS WRITE FOUR.
 *
 * A reviewer triaging an inbox has two useful questions — "does this need me
 * now?" and "can this wait?" — and a fourth band splits the first without
 * changing either answer. The workbooks' HIGHEST folds into HIGH; what separates
 * a recall from a cancellation is the category chip beside it, which already
 * says which is which.
 */
export const MESSAGE_PRIORITIES = ["HIGH", "MEDIUM", "LOW"] as const;

export type MessagePriority = (typeof MESSAGE_PRIORITIES)[number];

/** Higher is more urgent. Not exported: nothing outside compares by number. */
const RANK: Readonly<Record<MessagePriority, number>> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/** Why a message was ranked the way it was. Safe to log — no customer text. */
export type PriorityReason =
  /* HIGH */
  | "safety_hazard"
  | "platform_case"
  | "cancellation_requested"
  | "exchange_requested"
  | "customer_urgency"
  | "chasing_unanswered_contact"
  | "workbook_highest"
  /* MEDIUM */
  | "problem_reported"
  | "action_required"
  /* LOW */
  | "pre_sales_enquiry"
  | "case_closed_by_customer";

const REASON_PRIORITY: Readonly<Record<PriorityReason, MessagePriority>> = {
  safety_hazard: "HIGH",
  platform_case: "HIGH",
  cancellation_requested: "HIGH",
  exchange_requested: "HIGH",
  customer_urgency: "HIGH",
  chasing_unanswered_contact: "HIGH",
  workbook_highest: "HIGH",
  problem_reported: "MEDIUM",
  action_required: "MEDIUM",
  pre_sales_enquiry: "LOW",
  case_closed_by_customer: "LOW",
};

export type PriorityReading = {
  readonly priority: MessagePriority | null;
  /** Every reason that applied, most urgent first. Empty when none did. */
  readonly reasons: readonly PriorityReason[];
  /**
   * The customer is closing the case — thanking, confirming, saying it is
   * sorted — and raising nothing new. Read by the conversation-level function
   * so a thread does not keep an old urgency after it is over.
   */
  readonly closesTheCase: boolean;
};

/* ------------------------------------------------------------------------- *
 * HOW A CONCEPT IS READ
 * ------------------------------------------------------------------------- */

/**
 * Every signal below is a concept run through `claimStatus`, never a bare
 * `.test()`, and that is what keeps this from being the naive keyword list the
 * brief warns about. The semantic layer supplies, for free and without being
 * modified:
 *
 *   NEGATION      "This is not urgent" reads as `negated`, so the word `urgent`
 *                 appearing in a message does not rank it.
 *   QUESTIONS     a concept raised inside an interrogative frame reads as
 *                 `asked`, so a hypothetical is not a report.
 *   CORRECTIONS   "that has nothing to do with my question" disclaims whatever
 *                 else the clause contains.
 *   CLAUSE SCOPE  the reading is taken from the clause the concept landed in,
 *                 not from the whole message.
 */
type Gate =
  /** Only a flat statement counts: a hazard, a filed case, a chase. */
  | "asserted"
  /**
   * A statement OR a question counts, because English asks for things politely.
   * "Can you cancel my order?" is a request, not an enquiry, and reading it as
   * a question would drop every courteous cancellation in the inbox. Used ONLY
   * for concepts whose wording is already a request frame — see
   * `CANCELLATION_REQUESTED`, which cannot match "what is your cancellation
   * policy?" in the first place.
   */
  | "asserted_or_asked";

function states(text: string, concept: RegExp, gate: Gate = "asserted"): boolean {
  const status: ClaimStatus = claimStatus(text, concept);
  return gate === "asserted" ? status === "asserted" : status === "asserted" || status === "asked";
}

/* ------------------------------------------------------------------------- *
 * THE HIGH SIGNALS
 * ------------------------------------------------------------------------- */

/**
 * Sparks, smoke, shocks, burning, injury.
 *
 * The vocabulary is the business's own — it is the language of the corpus rows
 * "SAFETY — Sparks / shock / fire / injury", "SAFETY Burning bang sparks smell"
 * and "⚠ Customer reports a safety concern" — widened only for the inflections a
 * customer actually writes. It is a pattern here rather than a corpus lookup
 * because a hazard has to be read through `claimStatus`: "there was no smoke"
 * and "is this a fire risk?" must not rank, and phrase matching cannot tell.
 *
 * BARE `fire`, `burning` AND `smoke` ARE DELIBERATELY ABSENT even though the
 * workbooks list them as standalone triggers. "Fire" is in half the product
 * names in a lighting catalogue, "burning" describes a smell that is usually
 * reported as "burning smell", and `smoked` / `smoke grey` are FINISHES —
 * `message-category.ts` lists "smoked" in its finish vocabulary, so a bare match
 * would rank a question about a smoked-glass shade as an electrical hazard. Each
 * one is admitted only in a shape that cannot be a product description.
 */
const SAFETY_HAZARD = new RegExp(
  [
    "\\bspark(?:s|ed|ing)\\b",
    "\\bsmoking\\b(?!\\s+glass)",
    "\\bsmoke\\s+(?:came|coming|started|poured|pouring|billow\\w*)\\b",
    "\\bgiving\\s+off\\s+smoke\\b",
    "\\bcaught\\s+fire\\b",
    "\\bon\\s+fire\\b",
    "\\bfire\\s+(?:risk|hazard)\\b",
    "\\bcould\\s+(?:cause|start)\\s+a\\s+fire\\b",
    "\\bburst\\s+into\\s+flames\\b",
    "\\belectric(?:al)?\\s+shock\\b",
    "\\b(?:gave|given)\\s+(?:me|us|him|her|them)\\s+an?\\s+shock\\b",
    "\\bgot\\s+an?\\s+(?:electric\\s+)?shock\\b",
    "\\bshocked\\s+(?:me|him|her|them)\\b",
    "\\bburn(?:t|ed)\\s+out\\b",
    "\\bburn(?:ing|t|ed)\\s+smell\\b",
    "\\bburn\\s+marks?\\b",
    "\\bsmell(?:s|ed|t|ing)?\\s+(?:of\\s+|like\\s+)?burn(?:ing|t|ed)\\b",
    "\\bmelt(?:ed|ing)\\b",
    "\\boverheat(?:s|ed|ing)\\b",
    "\\bexposed\\s+(?:wire|wires|wiring|live)\\b",
    "\\bloud\\s+bang\\b",
    "\\bcapacitor\\s+(?:blew|has\\s+blown)\\b",
    "\\bblew\\s+up\\b",
    "\\bdangerous\\b",
    "\\bhazard(?:ous)?\\b",
    "\\bunsafe\\b",
    "\\bnot\\s+safe\\b",
    "\\bsafety\\s+(?:risk|hazard|concern|issue)\\b",
    "\\bhealth\\s+and\\s+safety\\b",
    "\\binjur(?:y|ies|ed)\\b",
    "\\bhurt\\s+(?:me|us|him|her|them|someone|somebody)\\b",
  ].join("|"),
  "i",
);

/**
 * A marketplace case that has been opened, or that the customer says they are
 * opening.
 *
 * ASSERTED ONLY, which is the whole reason the gate exists. "I have opened a
 * case with eBay" and "I'll open a case" are statements and rank; "I'll open a
 * case if this is not sorted" carries the semantic layer's conditional frame,
 * comes back `asked`, and does not. A conditional threat is a warning about a
 * future, and this field is about the present.
 */
const PLATFORM_CASE = new RegExp(
  [
    "\\ba[\\s-]?to[\\s-]?z\\b",
    "\\b(?:open|opened|opening|rais(?:e|ed|ing)|fil(?:e|ed|ing)|start(?:ed|ing)?|log(?:ged|ging)?)\\s+(?:a|an|the)\\s+(?:case|claim|dispute|complaint)\\b",
    "\\b(?:ebay|amazon|paypal|etsy)\\s+(?:case|claim|dispute)\\b",
    "\\bchargeback\\b",
    "\\bsection\\s+75\\b",
    "\\b(?:report|reporting|reported|escalat(?:e|ed|ing))\\s+(?:this|it|you|them)?\\s*to\\s+(?:ebay|amazon|paypal|trading\\s+standards|citizens\\s+advice|the\\s+ombudsman)\\b",
    "\\bescalat(?:e|ed|ing)\\s+(?:this|it)\\b",
    "\\bleave\\s+(?:negative|bad|poor)\\s+feedback\\b",
    "\\bsmall\\s+claims\\b",
    "\\blegal\\s+action\\b",
  ].join("|"),
  "i",
);

/**
 * A cancellation the customer is ASKING FOR.
 *
 * Every alternative carries its own request frame — "cancel MY order", "I want
 * to cancel", "can you cancel" — so the pattern cannot reach "what is your
 * cancellation policy?" or "how do I cancel an order?", which are pre-sales
 * questions about a process rather than an instruction about an order. That is
 * what makes `asserted_or_asked` safe here.
 */
const CANCELLATION_REQUESTED = new RegExp(
  [
    "\\bcancel\\s+(?:my|the|this|our|that)\\s+(?:order|purchase|item|delivery)\\b",
    "\\bcancel\\s+(?:it|this|that|them)\\b",
    "\\b(?:please|kindly)\\s+cancel\\b",
    "\\bi\\s*(?:'|’)?\\s*(?:d|would|ll|will|want|need|wish|like)?\\s*(?:like\\s+)?to\\s+cancel\\b",
    "\\bi\\s+(?:want|need|wish)\\s+(?:to\\s+)?cancel\\b",
    "\\b(?:can|could|would|will|may)\\s+(?:you|i|we)\\s+(?:please\\s+)?cancel\\b",
    "\\bstop\\s+(?:my|the)\\s+(?:order|delivery)\\b",
    "\\bdo\\s*n[o']?t\\s+(?:want|need)\\s+(?:it|this|them|the\\s+order)\\s+(?:any\\s?more|now)\\b",
  ].join("|"),
  "i",
);

/**
 * An exchange or replacement the customer is ASKING FOR.
 *
 * `please send` on its own is NOT here and must not be: "please send me the
 * invoice" is an admin request, and a bare send frame ranked every one of them
 * as an exchange. The object is required.
 */
const EXCHANGE_REQUESTED = new RegExp(
  [
    "\\bi\\s*(?:'|’)?\\s*(?:d|would|ll|will)?\\s*(?:like|want|need|wish)\\s+(?:an?\\s+)?(?:to\\s+)?(?:exchange|swap|replacement|replace)\\b",
    "\\b(?:can|could|would|will|please)\\s+(?:you\\s+)?(?:please\\s+)?(?:send|post|dispatch|provide|give)\\s+(?:me\\s+|us\\s+)?(?:a|an|another)\\s+(?:replacement|new\\s+one|exchange)\\b",
    "\\bsend\\s+(?:me\\s+|us\\s+)?(?:a|an|another)\\s+replacement\\b",
    "\\bplease\\s+(?:replace|exchange|swap)\\b",
    "\\bexchange\\s+(?:this|it|them|these|the\\s+\\w+)\\b",
    "\\breplace\\s+(?:this|it|them|these|the\\s+\\w+)\\b",
    "\\bswap\\s+(?:this|it|them|these)\\b",
    "\\breplacement\\s+(?:sent|please)\\b",
  ].join("|"),
  "i",
);

/**
 * The customer saying, in their own words, that this cannot wait.
 *
 * A DEADLINE IS NOT A DATE. "I need an answer today" ranks; "delivered on
 * Tuesday" does not. Each alternative requires the urgency to attach to a
 * need — which is also why the negated form falls out for free: "this is not
 * urgent" puts a negator directly in front of the concept, and `claimStatus`
 * reads it as a denial.
 */
const EXPLICIT_URGENCY = new RegExp(
  [
    "\\burgent(?:ly)?\\b",
    "\\basap\\b",
    "\\bas\\s+soon\\s+as\\s+possible\\b",
    "\\bimmediately\\b",
    "\\b(?:straight|right)\\s+away\\b",
    "\\bmatter\\s+of\\s+urgency\\b",
    "\\bemergency\\b",
    "\\bneed\\s+(?:an?\\s+)?(?:answer|reply|response|update|it|them|this|these)\\s+(?:today|now|by\\s+\\w+|before\\s+\\w+|this\\s+week|tomorrow)\\b",
    "\\bneed(?:ed)?\\s+(?:it|them|this)\\s+(?:for|by)\\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|the\\s+weekend|christmas)\\b",
  ].join("|"),
  "i",
);

/**
 * The customer chasing US — a message we have not answered.
 *
 * DELIBERATELY NOT "still waiting" ON ITS OWN. The brief lists it, and read
 * literally it would rank every ordinary WISMO in the inbox: "still waiting for
 * my parcel" is the single commonest sentence a delivery query contains, and it
 * is waiting on the COURIER, not on us. Read in the company of the items beside
 * it in the brief — repeated unanswered contact, no response, still not resolved
 * — what it means is waiting for a REPLY, and that is what this matches. Waiting
 * for goods stays MEDIUM through the delivery route; waiting for us is HIGH.
 */
const CHASING_UNANSWERED_CONTACT = new RegExp(
  [
    "\\bno\\s+(?:response|reply|answer|word)\\b",
    "\\b(?:have|has|had|i)\\s*n[o']?t\\s+heard\\s+(?:back|anything|from)\\b",
    "\\b(?:nobody|no\\s+one|no-one)\\s+(?:has\\s+)?(?:replied|responded|answered|got(?:ten)?\\s+back|come\\s+back)\\b",
    "\\b(?:contacted|emailed|e-mailed|messaged|written\\s+to|phoned|called|chased)\\s+(?:you|your\\s+team|customer\\s+services?)\\b[^.!?;\\n]{0,25}?\\b(?:twice|three|four|five|several|multiple|many|again|\\d+)\\b",
    "\\b(?:second|third|fourth|fifth)\\s+time\\s+(?:i|we)\\b",
    "\\bstill\\s+(?:waiting\\s+for|had\\s+no|have\\s+had\\s+no|no)\\s*(?:a\\s+)?(?:reply|response|answer|update)\\b",
    "\\bstill\\s+(?:not|nothing)\\s+(?:been\\s+)?(?:resolved|sorted|fixed|dealt\\s+with)\\b",
    "\\bstill\\s+chasing\\b",
    "\\bchasing\\s+(?:this|you|an?\\s+(?:reply|response|answer|update))\\b",
    "\\bignor(?:ed|ing)\\s+(?:me|us|my\\s+\\w+)\\b",
  ].join("|"),
  "i",
);

/**
 * THERE IS DELIBERATELY NO ADDRESS-CHANGE RULE HERE, and its absence is the
 * point.
 *
 * The business rule escalates a delivery-address change requested BEFORE
 * DISPATCH. "Before dispatch" is a fact about the order, held in
 * `context_snapshots` and the tracking layer — not something a customer's
 * sentence can establish. A module that only reads text and escalated on the
 * request alone would be inventing the dispatch state, and would rank a
 * post-delivery address correction as urgent as a recall.
 *
 * So an address change is left to the MEDIUM route it reaches on its own merits,
 * as an order amendment that needs work. The escalation belongs to a later
 * integration layer that can read the verified order state, and there is a test
 * pinning this module out of that business.
 */
const ADDRESS_CHANGE_IS_NOT_ESCALATED = true;

/* ------------------------------------------------------------------------- *
 * THE WORKBOOK'S HIGHEST TIER — THE ONLY SURVIVING USE OF THE COLUMN
 * ------------------------------------------------------------------------- */

/**
 * Reads the level out of one of the fifteen spellings the workbooks use:
 * `HIGH`, `🔴 HIGH`, `RED HIGH`, `ORANGE HIGH`, `🔴 HIGHEST`, `RED HIGHEST`,
 * `MED`, `🟡 MED`, `YELLOW MED`, `LOW`, `🟢 LOW`, `GREEN LOW`, and two HIGHEST
 * rows carrying a trailing note.
 *
 * THE WORD DECIDES, NOT THE COLOUR — the books write HIGH as both 🔴 and 🟠, so
 * the swatch would make one level two answers depending on which sheet it was
 * written on.
 *
 * Exported because the four-into-three fold is worth testing directly, NOT
 * because the result decides a priority. Only `HIGHEST` reaches the reading
 * below; `HIGH`, `MED` and `LOW` are read here and then discarded.
 */
export function normalisePriority(raw: string): MessagePriority | "HIGHEST" | null {
  const words = raw.toUpperCase();
  // HIGHEST first: the longer word contains the shorter one.
  if (/\bHIGHEST\b/.test(words)) return "HIGHEST";
  if (/\bHIGH\b/.test(words)) return "HIGH";
  if (/\bMED(?:IUM)?\b/.test(words)) return "MEDIUM";
  if (/\bLOW\b/.test(words)) return "LOW";
  return null;
}

/** Whether a corpus row is one of the twenty the business marked HIGHEST. */
function isHighestTier(rule: CorpusRule): boolean {
  return normalisePriority(rule.priority) === "HIGHEST";
}

/**
 * Escapes a workbook phrase into a pattern that tolerates the whitespace and
 * punctuation differences `corpusMatches` already normalises away.
 */
function phrasePattern(phrase: string): RegExp {
  const words = phrase
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(words.join("\\s+"), "i");
}

/**
 * Whether the message asserts one of the HIGHEST-tier scenarios.
 *
 * The corpus finds the candidates; `claimStatus` decides whether the customer
 * is REPORTING one. A phrase table alone would rank "this is not a recall" and
 * "is this covered by the recall?" identically with the real thing.
 */
function assertsHighestTierScenario(text: string): boolean {
  for (const match of corpusMatches(text)) {
    if (!isHighestTier(match.rule)) continue;
    if (states(text, phrasePattern(match.phrase))) return true;
  }
  return false;
}

/* ------------------------------------------------------------------------- *
 * THE MEDIUM AND LOW ROUTES
 * ------------------------------------------------------------------------- */

/**
 * Requests that need somebody to do work, but not today.
 *
 * `exchange_or_replacement` is absent because the brief puts it in HIGH, and it
 * is handled there. `technical_specification` and `availability` are absent
 * because they are pre-sales, and they are handled in LOW.
 */
const ACTION_NEEDS_WORK: ReadonlySet<string> = new Set([
  "whereabouts",
  "refund_or_return",
  "order_amendment",
  "cancellation_considered",
  "report_problem",
  "documentation",
]);

/** Questions from somebody who is still deciding whether to buy. */
const ACTION_IS_PRE_SALES: ReadonlySet<string> = new Set([
  "technical_specification",
  "availability",
]);

/* ------------------------------------------------------------------------- *
 * READING ONE MESSAGE
 * ------------------------------------------------------------------------- */

/**
 * Everything one customer message says about urgency.
 *
 * ORDER OF THE CHECKS DOES NOT DECIDE THE ANSWER — every reason that applies is
 * collected and the most urgent wins, so a message that is both a cancellation
 * and a safety report is HIGH for both reasons and a reviewer can see both.
 */
export function explainMessagePriority(customerText: string | null): PriorityReading {
  const text = customerText?.trim() ?? "";
  if (text === "") return { priority: null, reasons: [], closesTheCase: false };

  const semantics = semanticsOf(text);
  // The STRICT phrase table, deliberately not `classifyMessageCategoryWithFallback`.
  // The fallback answers "Admin related issues" for anything it cannot place,
  // which would make every unreadable message MEDIUM and destroy the null this
  // module depends on. Read, never rewritten.
  const category = classifyMessageCategory(text);
  const reasons: PriorityReason[] = [];

  /* ---- HIGH ---- */
  if (states(text, SAFETY_HAZARD)) reasons.push("safety_hazard");
  if (states(text, PLATFORM_CASE)) reasons.push("platform_case");
  if (states(text, CANCELLATION_REQUESTED, "asserted_or_asked")) {
    reasons.push("cancellation_requested");
  }
  // DELIBERATELY NOT `semantics.requestedAction === "exchange_or_replacement"`.
  // That reads the word "replacement" wherever it appears, so "the replacement
  // has arrived damaged" — a customer REPORTING that our second attempt failed —
  // came back as a fresh exchange request and ranked HIGH. The request has to be
  // asked for, not merely mentioned.
  if (states(text, EXCHANGE_REQUESTED, "asserted_or_asked")) reasons.push("exchange_requested");
  if (states(text, EXPLICIT_URGENCY)) reasons.push("customer_urgency");
  if (states(text, CHASING_UNANSWERED_CONTACT)) reasons.push("chasing_unanswered_contact");
  if (assertsHighestTierScenario(text)) reasons.push("workbook_highest");

  /* ---- MEDIUM ---- */
  // The customer is telling us something went wrong. `semanticsOf` has already
  // decided this is a claim rather than a question about one, and it is the
  // same reading the category classifier acts on — read, never rewritten.
  if (semantics.event !== "none") reasons.push("problem_reported");
  if (
    ACTION_NEEDS_WORK.has(semantics.requestedAction) ||
    // THE CATEGORY IS THE THIRD ROUTE TO MEDIUM, and it is what closes the
    // delivery and damage gap the first version had. "When will my order
    // arrive?" and "The box was crushed in transit" name no event and request
    // no action `semanticsOf` has a word for, but the phrase table places both
    // without hesitation — and a conversation the business can name a case area
    // for is a conversation somebody has to work. Pre-sales is excluded because
    // it is the one category that is not work arising from an order.
    (category !== null && category !== "Pre sales queries")
  ) {
    reasons.push("action_required");
  }

  /* ---- LOW ---- */
  if (
    ACTION_IS_PRE_SALES.has(semantics.requestedAction) ||
    semantics.journey === "prospective" ||
    category === "Pre sales queries"
  ) {
    reasons.push("pre_sales_enquiry");
  }

  // CLOSING REQUIRES THAT NOTHING ELSE WAS RAISED. "Tracking says delivered but
  // I have not received it" reads as `journey: resolved` — the parcel's journey
  // is over, the customer's problem is not — and treating that as a closing
  // message would have let it clear a thread's urgency. A customer closes a case
  // by raising nothing, not by using the word "delivered".
  const closesTheCase =
    reasons.length === 0 &&
    (semantics.speechAct === "acknowledgement" || semantics.journey === "resolved");
  if (closesTheCase) reasons.push("case_closed_by_customer");

  reasons.sort((a, b) => RANK[REASON_PRIORITY[b]] - RANK[REASON_PRIORITY[a]]);
  const priority = reasons.length === 0 ? null : REASON_PRIORITY[reasons[0]!];
  return { priority, reasons, closesTheCase };
}

/**
 * How urgently one customer message needs handling, or null when nothing in it
 * says.
 *
 * NULL IS NOT LOW. A message nothing recognises is unranked, and the interface
 * must render that as no priority established rather than as the least urgent
 * thing in the inbox — a conversation nobody could read is not a conversation
 * that can wait.
 */
export function classifyMessagePriority(customerText: string | null): MessagePriority | null {
  return explainMessagePriority(customerText).priority;
}

/* ------------------------------------------------------------------------- *
 * READING A CONVERSATION
 * ------------------------------------------------------------------------- */

/**
 * How urgently a conversation needs handling, from its customer messages.
 *
 * THE CURRENT ISSUE, NOT THE WORST THING EVER SAID. The first version took the
 * maximum across the thread, which meant a customer who once had an electrician
 * waiting stayed HIGH forever — including after they wrote "all sorted, thanks".
 * A permanently red row is a row a reviewer learns to ignore.
 *
 * So a closing message RESETS the reading. Each message is still read on its
 * own and the most urgent kept, but a message that closes the case and raises
 * nothing new drops the thread back to LOW, and anything after it starts again
 * from there. A customer who says it is sorted and then reports a new fault is
 * MEDIUM on the new fault, not HIGH on the old deadline.
 *
 * EACH MESSAGE IS READ SEPARATELY, the same discipline
 * `classifyConversationCategory` keeps: concatenating the thread would let two
 * unrelated sentences in two unrelated messages form a phrase neither contains.
 *
 * OUR OWN REPLIES ARE NOT AN INPUT. The parameter is customer messages; a
 * caller must filter before calling, or it would be grading our urgency rather
 * than the customer's.
 */
export function explainConversationPriority(
  customerMessages: readonly (string | null)[],
): PriorityReading {
  let best: PriorityReading = { priority: null, reasons: [], closesTheCase: false };

  for (const text of customerMessages) {
    const reading = explainMessagePriority(text);

    // A customer closing the case clears what came before it. `closesTheCase`
    // is already false for any message that raises something — see
    // `explainMessagePriority` — so "thanks, but it has now broken again"
    // cannot be mistaken for a closing message: it carries a fresh problem, so
    // it resets nothing and ranks on its own terms.
    if (reading.closesTheCase) {
      best = reading;
      continue;
    }

    if (reading.priority === null) continue;
    if (best.priority === null || RANK[reading.priority] > RANK[best.priority]) best = reading;
  }

  return best;
}

export function classifyConversationPriority(
  customerMessages: readonly (string | null)[],
): MessagePriority | null {
  return explainConversationPriority(customerMessages).priority;
}

/* ------------------------------------------------------------------------- *
 * COVERAGE
 * ------------------------------------------------------------------------- */

/**
 * What the workbook column still contributes, published so the size of it is a
 * number a reviewer can check rather than a claim in a comment.
 *
 * `rulesWithStatedPriority` is how many rows carry the column at all;
 * `highestTierRules` is how many of those this module still reads. The
 * difference — the HIGH, MED and LOW tiers — is deliberately discarded, and
 * `ADDRESS_CHANGE_IS_NOT_ESCALATED` is re-exported alongside it so the decision
 * not to invent dispatch state is visible to a caller rather than buried.
 */
export const PRIORITY_CORPUS_STATS = {
  rules: CST_CATEGORY_CORPUS.length,
  rulesWithStatedPriority: CST_CATEGORY_CORPUS.filter(
    (rule) => normalisePriority(rule.priority) !== null,
  ).length,
  highestTierRules: CST_CATEGORY_CORPUS.filter(isHighestTier).length,
  addressChangeIsNotEscalated: ADDRESS_CHANGE_IS_NOT_ESCALATED,
} as const;
