import { type VerifiedFact, ungroundedClaims } from "@/lib/domain/draft";
import { type ConversationMessageView, displayBody } from "@/lib/domain/inbox";
import { type MessageIntent, detectIntents } from "@/lib/knowledge/message-category";
import type { TrackingResult } from "@/lib/tracking/provider";

/**
 * Draft accuracy validation.
 *
 * WHAT THIS IS FOR. A draft can satisfy every gate that already exists — valid
 * JSON, a conforming schema, resolved citations, no forbidden claim — and still
 * be wrong in the one way that matters to a customer: it contradicts something
 * the backend already established, or it does not answer what was asked.
 *
 *   "We will check the dispatch status and cancel if possible."
 *
 * is a well-formed, well-cited, entirely useless reply when the verified order
 * says the goods have not been dispatched. The dispatch status is not something
 * to check. It is a fact we were handed before the model was called.
 *
 * WHERE IT SITS. After generation, before the reviewer sees anything. A failing
 * draft is regenerated ONCE with the findings as correction instructions, and
 * whatever comes back is still shown to a human. This layer can ask for a
 * rewrite and it can force review. It cannot approve, discard or transmit
 * anything — there is no transport here and no state after `reviewed`.
 *
 * PURE. No network, no database, no clock, no model. Every judgement below is
 * made from the draft text, the verified facts that were supplied, and the
 * customer's own words. That is what makes a finding reproducible and arguable
 * rather than another opinion from another model.
 *
 * WHY NOT ASK A MODEL TO GRADE THE DRAFT. Because then a wrong draft and a
 * wrong grade have the same cause, and the reviewer has no independent signal.
 * A deterministic check disagrees with the generator for reasons that can be
 * read in this file.
 */

/* ------------------------------------------------------------------------- *
 * WHAT A FINDING IS
 * ------------------------------------------------------------------------- */

/**
 * The kinds of defect this layer can name.
 *
 * Deliberately about the DRAFT, not about the model: "contradicts a verified
 * fact" is something a person can check in ten seconds against the sidebar.
 */
export type DraftIssueType =
  /** The reply states, or treats as open, something the backend already settled. */
  | "contradicts_verified_fact"
  /** The verified situation required a route the reply never went down. */
  | "rule_not_followed"
  /** The customer asked for one thing and the reply is about another. */
  | "intent_not_addressed"
  /** The reply asserts something no supplied fact supports. */
  | "unsupported_claim";

/**
 * Whether a finding is worth a second model call.
 *
 * THE DISTINCTION IS "WRONG" VERSUS "INCOMPLETE", and it is the whole of the
 * cost control on this layer. A regeneration is a full second call — the same
 * instructions, the same retrieval, the same reasoning — so spending one has to
 * be worth roughly doubling what the draft cost.
 *
 *   critical  the reply says something FALSE, or asserts something nothing
 *             supports, or answers a question nobody asked. A reviewer cannot
 *             fix that by adding a sentence; the text has to be rewritten, and
 *             a wrong statement that reaches a customer costs money or trust.
 *
 *   minor     the reply is TRUE but does not go far enough — a route it should
 *             have covered, one of several questions left unanswered. A
 *             reviewer reads the finding and adds the missing line in seconds.
 *             Paying for a whole regeneration to save that is the wrong trade,
 *             and it risks losing the parts that were already right.
 *
 * Minor findings still reach the reviewer and still force review. They just do
 * not buy another call.
 */
export type DraftSeverity = "critical" | "minor";

/**
 * One defect, with everything a reviewer needs to judge it.
 *
 * The five reported fields are what the CST team asked for: what kind of
 * problem, the sentence at fault, the fact it should have used, the rule that
 * governs the case, and what the regeneration was told to do about it.
 */
export type DraftFinding = {
  readonly issue: DraftIssueType;
  readonly severity: DraftSeverity;
  /** The offending sentence, quoted from the draft. Empty when the fault is an omission. */
  readonly incorrectStatement: string;
  /** The verified fact the reply should have used, as `name = value`. Null when none applies. */
  readonly verifiedFact: string | null;
  /** The CST rule area that governs this case, in the team's own terms. */
  readonly ruleThatApplies: string | null;
  /** The correction instruction handed to the regeneration. */
  readonly regenerationReason: string;
};

export type DraftValidation = {
  readonly passed: boolean;
  readonly findings: readonly DraftFinding[];
  /**
   * Whether anything here justifies a second model call.
   *
   * False with findings present is the common and deliberate case: the draft is
   * flagged for a human, and nothing is spent re-running the model.
   */
  readonly regenerationWarranted: boolean;
  /**
   * Correction instructions for a regeneration, deduplicated, order preserved.
   *
   * CRITICAL FINDINGS ONLY. A regeneration is bought to fix what is wrong, so
   * that is all it is told about — adding the minor points would spend output
   * tokens rewriting parts that were already acceptable, and each rewritten
   * part is a fresh chance to introduce an error the first draft did not have.
   */
  readonly corrections: readonly string[];
  /** One line per finding, for `missing_information`. Internal; never shown to a customer. */
  readonly notes: readonly string[];
};

/** What the validator needs to judge one draft. */
export type DraftUnderReview = {
  readonly reply: string;
  readonly facts: readonly VerifiedFact[];
  readonly messages: readonly ConversationMessageView[];
  /**
   * Carrier tracking, when the conversation had any.
   *
   * Null is the normal case and means the reply may state NO delivery status —
   * see `DELIVERY_STATE_CLAIM`. Present means the draft may say what this says
   * and nothing beyond it.
   */
  readonly tracking?: TrackingResult | null;
  /**
   * Whether the CST knowledge base was reachable for this draft.
   *
   * A restricted draft is REQUIRED to state no policy and to do little more
   * than acknowledge and ask, so grading it on "did it follow the cancellation
   * rule" would fail it for obeying its instructions. Fact and hallucination
   * checks still run: a draft with no rules may still not contradict the order.
   */
  readonly knowledgeAvailable: boolean;
};

/* ------------------------------------------------------------------------- *
 * READING THE VERIFIED FACTS
 * ------------------------------------------------------------------------- */

function factValue(facts: readonly VerifiedFact[], name: string): string | null {
  const found = facts.find((fact) => fact.name === name);
  const value = found?.value.trim();
  return value === undefined || value === "" ? null : value;
}

/**
 * The order statuses this system actually records.
 *
 * Not a guess and not a superset: these are the seven distinct values of
 * `order_management.orders.status` across 1,094,694 live orders — Completed,
 * Refunded, Cancelled, Deleted, Inprogress, New, Hold. A closed vocabulary is
 * what makes "the draft named a status, and it is not this order's status" a
 * decidable question rather than a fuzzy one.
 */
export const ORDER_STATUS_VALUES = [
  "Completed",
  "Refunded",
  "Cancelled",
  "Deleted",
  "Inprogress",
  "New",
  "Hold",
] as const;

/** Comparison form: case-folded, and "in progress" reunited with "Inprogress". */
function normaliseStatus(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

export type DispatchState = "dispatched" | "not_dispatched" | "unknown";

/**
 * Whether the goods have left us, decided only from facts we were given.
 *
 * THIS DERIVES; IT DOES NOT FETCH. No new query, no new fact, no change to the
 * order-context source — it reads what `resolveEbayOrderContext` already put in
 * front of the model and says what that evidence supports.
 *
 * MEASURED, on 105,635 orders from the last 180 days:
 *
 *   tracking_number present -> DISPATCHED. A tracking number exists only once a
 *     shipment has been booked: 3 orders in 88,203 carry one without a shipment
 *     timestamp, which is 0.003% and is a data repair job, not a category.
 *
 *   order_status = New -> NOT DISPATCHED. Every one of the 85 orders in that
 *     state has no tracking number and no shipment timestamp. "New" is the
 *     state before anything is picked.
 *
 *   everything else -> UNKNOWN, and that is the important one. 15% of Completed
 *     orders have no tracking number recorded, so ABSENCE OF TRACKING IS NOT
 *     EVIDENCE OF NON-DISPATCH. Reading it as one would let this layer "correct"
 *     a draft into telling a customer their dispatched parcel had not been sent.
 *     Unknown means no finding is raised either way.
 *
 * An explicit `dispatch_status` fact, should the context layer ever supply one,
 * outranks the derivation. Nothing produces one today; accepting it costs a
 * branch and means this file needs no edit when something does.
 */
export function dispatchState(facts: readonly VerifiedFact[]): DispatchState {
  const stated = factValue(facts, "dispatch_status");
  if (stated !== null) {
    if (/\b(?:not|no|un|awaiting|pending|nicht)\b/i.test(stated)) return "not_dispatched";
    if (/dispatch|despatch|ship|versand/i.test(stated)) return "dispatched";
  }

  if (factValue(facts, "tracking_number") !== null) return "dispatched";

  const status = factValue(facts, "order_status");
  if (status !== null && normaliseStatus(status) === "new") return "not_dispatched";

  return "unknown";
}

/* ------------------------------------------------------------------------- *
 * READING THE DRAFT
 * ------------------------------------------------------------------------- */

/**
 * Sentences, so a finding can quote the exact clause at fault.
 *
 * Line breaks end a sentence as surely as a full stop does: drafts are written
 * with greetings, paragraphs and sign-offs, and joining those into one blob
 * would let a hedge in the greeting attach itself to a fact in the body.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Wording that treats a matter as still open.
 *
 * NARROWER THAN IT LOOKS, on purpose. "Confirm" and "see" are absent because
 * "we can confirm your order was dispatched" and "I can see your order has
 * shipped" are the CORRECT reply when the fact is settled — a hedge list that
 * caught those would fire on exactly the drafts this layer wants to encourage.
 * What remains is future or conditional: work not yet done ("we will check"),
 * or an outcome made contingent ("if it has not been dispatched").
 */
const UNSETTLED = new RegExp(
  [
    // "we will check", "I'll verify", "we need to look into", "we can chase up"
    "\\b(?:we|i)\\s*(?:'ll|'ve|\\s+will|\\s+shall|\\s+can|\\s+could|\\s+need\\s+to|\\s+have\\s+to|\\s+are\\s+going\\s+to|\\s+am\\s+going\\s+to)?\\s*(?:now\\s+|then\\s+)?(?:check|verify|look\\s+into|investigate|find\\s+out|chase(?:\\s+up)?)\\b",
    "\\blet\\s+(?:me|us)\\s+(?:check|look|investigate)\\b",
    "\\b(?:checking|verifying|looking\\s+into|investigating)\\b",
    "\\bonce\\s+we\\s+(?:have\\s+)?(?:check|verif|look|investigat)",
    "\\bsee\\s+(?:if|whether)\\b",
    // Conditionals: the outcome is being made contingent on the settled fact.
    "\\bif\\s+(?:it|this|that|they|possible|not|your|the)\\b",
    "\\bwhether\\b",
    "\\bin\\s+case\\b",
    "\\bshould\\s+it\\b",
    // German
    "\\b(?:pr(?:ü|ue)fen|nachsehen|kl(?:ä|ae)ren|falls|ob)\\b",
  ].join("|"),
  "i",
);

/** The subject matter of a sentence, for pairing against a settled fact. */
const DISPATCH_TOPIC =
  /\b(?:dispatch(?:ed|ing|es)?|despatch(?:ed|ing|es)?|ship(?:ped|ping|s)?|posted|left\s+(?:our\s+)?(?:warehouse|depot)|versand\w*|versendet|verschickt|abgeschickt)\b/i;
const REFUND_TOPIC =
  /\b(?:refund\w*|money\s+back|reimburs\w*|r(?:ü|ue)ckerstatt\w*|erstatt\w*)\b/i;
const CANCEL_TOPIC = /\b(?:cancel\w*|storni\w*|kaufabbruch)\b/i;
const TRACKING_TOPIC =
  /\b(?:tracking|track(?:ed|ing)?\s+(?:number|no\.?|code|reference)|sendungsnummer|sendungsverfolgung)\b/i;

/**
 * A status named as this order's status.
 *
 * The cue words are what makes this safe. Bare "new" is one of the commonest
 * words in a reply — "we will send a new one", "place a new order" — and would
 * be a false positive on every draft that offered a replacement. Requiring
 * "showing as", "marked as", "the status is" means only a sentence actually
 * reporting our system's state can match.
 */
const STATED_STATUS = new RegExp(
  `\\b(?:showing|shows|shown|marked|listed|recorded|registered|sits|remains|stands|status\\s+is|status\\s+of\\s+[^.!?]{0,40}?\\s+is)\\s+(?:up\\s+)?(?:still\\s+)?(?:as\\s+|at\\s+)?["']?(${ORDER_STATUS_VALUES.join("|")}|in\\s+progress)\\b`,
  "i",
);

/** A stated tracking number, so its VALUE can be compared and not just its presence. */
const STATED_TRACKING =
  /\btracking\s*(?:number|no\.?|code|reference)?\s*(?:is|:|=)\s*["']?([A-Za-z0-9][A-Za-z0-9-]{5,})/i;

/** A stated order number, same reasoning. */
const STATED_ORDER_NUMBER =
  /\border\s*(?:number|no\.?|#|id|reference)\s*(?:is|:|=)?\s*["']?([0-9][0-9A-Za-z-]{5,})/i;

/** Identifier comparison form: only the characters an identifier actually carries. */
function normaliseIdentifier(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

/* ------------------------------------------------------------------------- *
 * CHECK 1 — FACT CHECK
 * ------------------------------------------------------------------------- */

/**
 * What each settled fact pairs with, and what it makes untrue to say.
 *
 * One shape, four applications: when the backend has settled a matter, a reply
 * that hedges about that matter is wrong regardless of how it is phrased. This
 * catches "we will check the dispatch status", "let me look into whether a
 * refund was issued" and "if your order has not yet been cancelled" with the
 * same rule, and would catch the next three wordings nobody has thought of.
 */
type SettledMatter = {
  readonly topic: RegExp;
  readonly fact: string;
  readonly rule: string;
  readonly correction: string;
};

function settledMatters(facts: readonly VerifiedFact[]): SettledMatter[] {
  const matters: SettledMatter[] = [];

  const dispatch = dispatchState(facts);
  if (dispatch !== "unknown") {
    const settled = dispatch === "dispatched" ? "DISPATCHED" : "NOT DISPATCHED";
    matters.push({
      topic: DISPATCH_TOPIC,
      fact:
        factValue(facts, "dispatch_status") !== null
          ? `dispatch_status = ${factValue(facts, "dispatch_status")}`
          : dispatch === "dispatched"
            ? `tracking_number = ${factValue(facts, "tracking_number")}`
            : `order_status = ${factValue(facts, "order_status")}`,
      rule:
        dispatch === "dispatched"
          ? "Dispatched orders: the return/refund route applies, not cancellation"
          : "Undispatched orders: cancel and refund without waiting on a check",
      correction: `The dispatch status of this order is already established: ${settled}. Do not offer to check it, do not say you will look into it, and do not make any part of the reply conditional on it. Write from that fact as settled, because it is.`,
    });
  }

  const status = factValue(facts, "order_status");
  if (status !== null && normaliseStatus(status) === "refunded") {
    matters.push({
      topic: REFUND_TOPIC,
      fact: `order_status = ${status}`,
      rule: "Refund already processed: tell the customer it is done",
      correction:
        "This order has already been refunded — that is a verified fact, not something to check. Do not offer to look into the refund, do not ask whether the customer would like one, and do not describe it as something that will happen. State that it has been done.",
    });
  }

  if (status !== null && normaliseStatus(status) === "cancelled") {
    matters.push({
      topic: CANCEL_TOPIC,
      fact: `order_status = ${status}`,
      rule: "Cancellation already processed: tell the customer it is done",
      correction:
        "This order has already been cancelled — that is a verified fact. Do not offer to check whether it can be cancelled and do not make the cancellation conditional. State that it has been done.",
    });
  }

  const tracking = factValue(facts, "tracking_number");
  if (tracking !== null) {
    matters.push({
      topic: TRACKING_TOPIC,
      fact: `tracking_number = ${tracking}`,
      rule: "Delivery queries: answer from the verified tracking information",
      correction:
        "A tracking number for this order is in the verified context. Do not say tracking is unavailable, do not ask the customer for it, and do not describe obtaining it as future work. Use what you were given.",
    });
  }

  return matters;
}

/** Claims that a tracking number is not to be had, when one was supplied. */
const DENIES_TRACKING =
  /\b(?:no\s+tracking|(?:do|does|did)\s*n(?:'|o)t\s+have\s+(?:a\s+|any\s+)?tracking|without\s+(?:a\s+)?tracking|tracking\s+(?:number\s+|details\s+|information\s+)?is\s+(?:not\s+available|unavailable)|keine\s+sendungsnummer)\b/i;

/** Claims that no refund exists, when the order is recorded as refunded. */
const DENIES_REFUND =
  /\b(?:no\s+refund|not\s+(?:yet\s+)?been\s+refunded|have\s*n(?:'|o)t\s+refunded|refund\s+has\s+not|there\s+is\s+no\s+refund|keine\s+r(?:ü|ue)ckerstattung)\b/i;

function factCheck(draft: DraftUnderReview): DraftFinding[] {
  const findings: DraftFinding[] = [];
  const matters = settledMatters(draft.facts);

  for (const sentence of sentences(draft.reply)) {
    if (!UNSETTLED.test(sentence)) continue;
    for (const matter of matters) {
      if (!matter.topic.test(sentence)) continue;
      findings.push({
        issue: "contradicts_verified_fact",
        // Always critical: the reply states something the backend disproves.
        severity: "critical",
        incorrectStatement: sentence,
        verifiedFact: matter.fact,
        ruleThatApplies: matter.rule,
        regenerationReason: matter.correction,
      });
    }
  }

  // A status the reply attributes to this order, against the one on record.
  const status = factValue(draft.facts, "order_status");
  if (status !== null) {
    for (const sentence of sentences(draft.reply)) {
      const named = STATED_STATUS.exec(sentence)?.[1];
      if (named === undefined) continue;
      if (normaliseStatus(named) === normaliseStatus(status)) continue;
      findings.push({
        issue: "contradicts_verified_fact",
        // Always critical: the reply states something the backend disproves.
        severity: "critical",
        incorrectStatement: sentence,
        verifiedFact: `order_status = ${status}`,
        ruleThatApplies: "Order status: state only the status on record",
        regenerationReason: `The reply tells the customer this order is "${named}". The verified status is "${status}". Use the verified status or do not mention a status at all.`,
      });
    }
  }

  // Flat denials, which carry no hedge and so are not caught above.
  if (status !== null && normaliseStatus(status) === "refunded") {
    for (const sentence of sentences(draft.reply)) {
      if (!DENIES_REFUND.test(sentence)) continue;
      findings.push({
        issue: "contradicts_verified_fact",
        // Always critical: the reply states something the backend disproves.
        severity: "critical",
        incorrectStatement: sentence,
        verifiedFact: `order_status = ${status}`,
        ruleThatApplies: "Refund already processed: tell the customer it is done",
        regenerationReason:
          "The reply denies a refund that the verified order records as already made. Say that the refund has been processed.",
      });
    }
  }

  const tracking = factValue(draft.facts, "tracking_number");
  if (tracking !== null) {
    for (const sentence of sentences(draft.reply)) {
      if (!DENIES_TRACKING.test(sentence)) continue;
      findings.push({
        issue: "contradicts_verified_fact",
        // Always critical: the reply states something the backend disproves.
        severity: "critical",
        incorrectStatement: sentence,
        verifiedFact: `tracking_number = ${tracking}`,
        ruleThatApplies: "Delivery queries: answer from the verified tracking information",
        regenerationReason:
          "The reply says tracking is not available. A tracking number for this order is in the verified context — use it.",
      });
    }
  }

  /*
   * IDENTIFIERS ARE COMPARED BY VALUE, NOT BY PRESENCE.
   *
   * The existing claim scan asks whether a draft states a tracking number at
   * all. That is the wrong question once a verified one exists: stating it is
   * exactly what the reply should do. The question is whether the one stated is
   * the one on record — a transposed digit reads as authoritative and sends a
   * customer to chase a parcel that is not theirs.
   */
  for (const [pattern, name] of [
    [STATED_TRACKING, "tracking_number"],
    [STATED_ORDER_NUMBER, "order_number"],
  ] as const) {
    const verified = factValue(draft.facts, name);
    if (verified === null) continue;
    for (const sentence of sentences(draft.reply)) {
      const stated = pattern.exec(sentence)?.[1];
      if (stated === undefined) continue;
      if (normaliseIdentifier(stated) === normaliseIdentifier(verified)) continue;
      findings.push({
        issue: "contradicts_verified_fact",
        // Always critical: the reply states something the backend disproves.
        severity: "critical",
        incorrectStatement: sentence,
        verifiedFact: `${name} = ${verified}`,
        ruleThatApplies: "Identifiers: quote only the verified value",
        regenerationReason: `The reply states a ${name.replace("_", " ")} of "${stated}". The verified value is "${verified}". Quote the verified value exactly or omit it.`,
      });
    }
  }

  return findings;
}

/* ------------------------------------------------------------------------- *
 * CHECKS 2 AND 3 — RULE COMPLIANCE AND CUSTOMER INTENT
 *
 * The same test with two different triggers, and the distinction is worth
 * keeping: one asks "the verified situation demanded this route, did the reply
 * take it", the other asks "the customer asked for this, did the reply answer".
 * Both are satisfied by TOPIC COVERAGE and nothing stronger. This layer never
 * dictates wording — it reports that a reply about a missing part never
 * mentions the part, which is a fact about the text, not a style opinion.
 * ------------------------------------------------------------------------- */

/**
 * What the customer's intent obliges the reply to be about.
 *
 * The vocabulary is REPLY-SIDE and generic: how a support agent writes about
 * refunds, damage, delivery. No product name, no SKU, no listing word appears
 * here and none ever should — this file must behave identically for a lampshade
 * and for a cable.
 *
 * German alternatives are present because drafts are written in the customer's
 * language, and a German reply that does address the refund would otherwise be
 * reported as ignoring it.
 *
 * `pre_sale_question` is deliberately absent. A pre-sales answer has no fixed
 * vocabulary — it is about whatever was asked — so any word list would be
 * wrong. Its one checkable failure is handled separately below.
 */
const INTENT_COVERAGE: Partial<
  Record<MessageIntent, { readonly label: string; readonly topic: RegExp; readonly rule: string }>
> = {
  wants_refund: {
    label: "a refund request",
    topic:
      /\b(?:refund\w*|money\s+back|reimburs\w*|cancel\w*|r(?:ü|ue)ckerstatt\w*|erstatt\w*|storni\w*)\b/i,
    rule: "Refund requests: address the refund",
  },
  wants_replacement: {
    label: "a replacement request",
    topic:
      /\b(?:replac\w*|send\s+(?:you\s+)?(?:a\s+|an\s+|another|out)|new\s+one|exchange|ersatz\w*|austausch\w*|nachsend\w*)\b/i,
    rule: "Replacement requests: address the replacement",
  },
  wants_order_change: {
    label: "a change or cancellation of the order",
    /*
     * A refusal counts as addressing it, and that is not a loophole.
     *
     * "Your order is already on its way, so it cannot be stopped — return it
     * once it arrives and we will refund you" is the CORRECT reply to a
     * too-late cancellation, and it contains none of the change vocabulary. A
     * list without the refusal wording reported that reply as ignoring the
     * customer, which is the opposite of true. What this check is for is the
     * reply that is about something else entirely.
     */
    topic:
      /\b(?:chang\w*|amend\w*|updat\w*|cancel\w*|address|stop(?:ped|ping)?|too\s+late|already\s+(?:on\s+its\s+way|left|dispatch\w*|despatch\w*|shipp\w*|sent)|return\w*|refund\w*|(?:ä|ae)ndern|adresse|storni\w*|unterwegs)\b/i,
    rule: "Order amendments: address the change that was asked for",
  },
  received_wrong_item: {
    label: "the wrong item being received",
    topic:
      /\b(?:wrong|incorrect|correct\s+(?:item|one|product)|right\s+one|replac\w*|return\w*|falsch\w*|richtig\w*|r(?:ü|ue)cksend\w*)\b/i,
    rule: "Wrong item received: the wrong-item route applies",
  },
  missing_component: {
    label: "a missing part",
    topic:
      /\b(?:missing|part|parts|component|piece|incomplete|send\s+(?:you\s+)?(?:the|a|an|out)|fehl\w*|teil\w*|unvollst(?:ä|ae)ndig)\b/i,
    rule: "Parts missing: the missing-part route applies",
  },
  damaged_product: {
    label: "damage to the goods",
    topic:
      /\b(?:damag\w*|broken|breakage|crack\w*|smash\w*|besch(?:ä|ae)dig\w*|schaden|kaputt|zerbrochen)\b/i,
    rule: "Damage: the damage route and its evidence requirements apply",
  },
  defective_product: {
    label: "a fault with the goods",
    topic:
      /\b(?:fault\w*|defect\w*|not\s+work\w*|stopped\s+work\w*|faulty|defekt\w*|funktioniert)\b/i,
    rule: "Defective goods: the fault route applies",
  },
  wrong_description: {
    label: "the listing not matching what arrived",
    topic:
      /\b(?:describ\w*|description|listing|specification|spec\b|measur\w*|dimension\w*|size|width|length|beschreib\w*|angabe\w*|ma(?:ß|ss)\w*)\b/i,
    rule: "Listing mismatch: address the description against what arrived",
  },
  delivery_request: {
    label: "delivery of the parcel",
    topic:
      /\b(?:deliver\w*|dispatch\w*|despatch\w*|ship\w*|tracking|courier|parcel|post|liefer\w*|versand\w*|sendung\w*|paket)\b/i,
    rule: "Delivery queries: answer from the verified delivery information",
  },
  admin_issue: {
    label: "an administrative request",
    topic:
      /\b(?:invoice|receipt|vat|account|address|detail\w*|document\w*|rechnung|beleg|konto)\b/i,
    rule: "Admin: address the administrative request",
  },
};

/** Asking for an order number, which a pre-sales enquiry does not have. */
const ASKS_FOR_ORDER_NUMBER =
  /\b(?:(?:your|the)\s+order\s+(?:number|no\.?|id|reference)|bestellnummer)\b/i;

/** The newest thing the customer actually said, which is what a draft replies to. */
function newestCustomerText(messages: readonly ConversationMessageView[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.direction !== "inbound") continue;
    const body = displayBody(message);
    if (body.available) return body.text;
  }
  return null;
}

/** Every inbound message, oldest first — the fallback when the newest carries no intent. */
function allCustomerText(messages: readonly ConversationMessageView[]): string | null {
  const parts = messages
    .filter((message) => message.direction === "inbound")
    .map((message) => displayBody(message))
    .filter((body) => body.available)
    .map((body) => body.text);
  return parts.length === 0 ? null : parts.join("\n\n");
}

/**
 * What the customer wants, from the deterministic classifier this project
 * already owns.
 *
 * NOT A SECOND OPINION, THE SAME ONE. `detectIntents` is the layer that decides
 * the message category shown beside every conversation. Reusing it means the
 * category a reviewer sees and the intent a draft is graded against can never
 * disagree, and it means this file adds no classification vocabulary of its own.
 *
 * The newest inbound message is asked first, because that is what the reply
 * answers. A newest message carrying no intent at all — "any update?" — falls
 * back to the whole thread, so a follow-up is graded against the problem it is
 * following up on rather than against nothing.
 */
function customerIntents(messages: readonly ConversationMessageView[]): MessageIntent[] {
  const newest = detectIntents(newestCustomerText(messages));
  if (newest.length > 0) return newest;
  return detectIntents(allCustomerText(messages));
}

function intentCheck(draft: DraftUnderReview): DraftFinding[] {
  const findings: DraftFinding[] = [];
  const intents = customerIntents(draft.messages);

  const gradeable = intents.filter((intent) => INTENT_COVERAGE[intent] !== undefined);
  const uncovered = gradeable.filter((intent) => !INTENT_COVERAGE[intent]!.topic.test(draft.reply));

  /*
   * ANSWERING NOTHING IS A DIFFERENT FAILURE FROM ANSWERING MOST OF IT.
   *
   * A reply that touches none of what the customer raised is about the wrong
   * subject — the "thank you, please confirm your postcode" non-answer — and no
   * amount of reviewer editing rescues it. That is worth a second call.
   *
   * A reply that covers the damage but not the invoice is a real gap and the
   * reviewer must see it, but the reply is not wrong and most of it is usable.
   * Regenerating would spend a full call and re-risk the part that was already
   * right.
   */
  const severity: DraftSeverity =
    gradeable.length > 0 && uncovered.length === gradeable.length ? "critical" : "minor";

  for (const intent of uncovered) {
    const coverage = INTENT_COVERAGE[intent]!;
    findings.push({
      issue: "intent_not_addressed",
      severity,
      // An omission has no offending sentence to quote. Saying so is more honest
      // than quoting an arbitrary line that happens to be near the gap.
      incorrectStatement: "",
      verifiedFact: null,
      ruleThatApplies: coverage.rule,
      regenerationReason: `The customer's message is ${coverage.label} and the reply never addresses it. Answer that directly in the reply.`,
    });
  }

  /*
   * A pre-sales enquiry answered by asking for an order number.
   *
   * The narrow, decidable failure inside a category that otherwise has no fixed
   * vocabulary: someone who has not bought anything has no order number, so the
   * request cannot be met and the question stays unanswered.
   */
  if (intents.includes("pre_sale_question") && ASKS_FOR_ORDER_NUMBER.test(draft.reply)) {
    findings.push({
      issue: "intent_not_addressed",
      // Critical: the reply asks for something that cannot exist, so the
      // customer's only possible response is to say so. The exchange is wasted.
      severity: "critical",
      incorrectStatement:
        sentences(draft.reply).find((line) => ASKS_FOR_ORDER_NUMBER.test(line)) ?? "",
      verifiedFact: null,
      ruleThatApplies: "Pre-sales: answer the product question",
      regenerationReason:
        "This is a pre-sales enquiry, so the customer has no order number to give. Answer the question that was asked instead of requesting order details.",
    });
  }

  return findings;
}

/** Returning goods, which is the route once they have left us. */
const RETURN_TOPIC =
  /\b(?:return\w*|send\s+(?:it|them|these|this)\s+back|sending\s+back|r(?:ü|ue)cksend\w*|zur(?:ü|ue)cksend\w*|retoure)\b/i;

/**
 * The routes a verified situation demands, whatever wording the reply chooses.
 *
 * TWO RULES, both about the same fork, because it is the fork with money on
 * both sides: a cancellation request is a completely different piece of work
 * before dispatch and after it, and the verified context already says which
 * side this order is on.
 *
 * COVERAGE, NOT WORDING. The test is whether the reply is ABOUT the route the
 * situation requires — not how it phrases it, not what it promises, not which
 * rule it cites. A reply that never mentions the customer's money when they
 * asked to cancel has not applied the rule, in any phrasing.
 *
 * These are the two the CST team stated. Nothing here invents a policy: this
 * layer writes no customer text and grants nothing — it asks for a rewrite.
 */
function ruleCheck(draft: DraftUnderReview): DraftFinding[] {
  const intents = customerIntents(draft.messages);
  const wantsRefund = intents.includes("wants_refund");
  const wantsToCancel = wantsRefund || intents.includes("wants_order_change");
  if (!wantsToCancel) return [];

  const dispatch = dispatchState(draft.facts);
  const findings: DraftFinding[] = [];
  const orderStatus = factValue(draft.facts, "order_status");

  if (dispatch === "not_dispatched") {
    const addressesCancellation =
      CANCEL_TOPIC.test(draft.reply) || REFUND_TOPIC.test(draft.reply);
    if (!addressesCancellation) {
      findings.push({
        issue: "rule_not_followed",
        // Minor: what the reply says is true, it just does not go far enough.
        // A reviewer adds the missing line faster than a second call returns.
        severity: "minor",
        incorrectStatement: "",
        verifiedFact: `order_status = ${orderStatus ?? "not dispatched"}`,
        ruleThatApplies: "Undispatched orders: cancel and refund without waiting on a check",
        regenerationReason:
          "The customer asked to cancel and the verified order has not been dispatched, so the cancellation route applies. Tell the customer what happens with the cancellation.",
      });
    } else if (wantsRefund && !REFUND_TOPIC.test(draft.reply)) {
      // They asked for their money and the reply never mentions it. Cancelling
      // the order is only half of what was asked for.
      findings.push({
        issue: "rule_not_followed",
        // Minor: what the reply says is true, it just does not go far enough.
        // A reviewer adds the missing line faster than a second call returns.
        severity: "minor",
        incorrectStatement: "",
        verifiedFact: `order_status = ${orderStatus ?? "not dispatched"}`,
        ruleThatApplies: "Undispatched orders: cancel and refund without waiting on a check",
        regenerationReason:
          "The customer asked for a refund as well as a cancellation, and the reply never mentions the refund. Say what happens to their money.",
      });
    }
  }

  if (dispatch === "dispatched" && !RETURN_TOPIC.test(draft.reply)) {
    findings.push({
      issue: "rule_not_followed",
      /*
       * Minor, and only because the WRONG half of this fork is caught
       * elsewhere and caught hard: a reply that actually tells a dispatched
       * customer their order has been cancelled is an unsupported claim, and
       * unsupported claims are critical. What is left here is the reply that
       * says nothing false and simply never sets out the return route — a gap
       * the reviewer closes with one sentence.
       */
      severity: "minor",
      incorrectStatement: "",
      verifiedFact: `tracking_number = ${factValue(draft.facts, "tracking_number") ?? "present"}`,
      ruleThatApplies: "Dispatched orders: the return route applies, not cancellation",
      regenerationReason:
        "The customer asked to cancel, but the verified order has already been dispatched, so it cannot simply be stopped. The reply must set out the return route rather than treating this as a cancellation.",
    });
  }

  return findings;
}

/* ------------------------------------------------------------------------- *
 * CHECK 4 — HALLUCINATION
 * ------------------------------------------------------------------------- */

/**
 * Assertions that require a supporting fact, and what supports each.
 *
 * These sit ALONGSIDE `ungroundedClaims`, which already scans for refund,
 * replacement, tracking, delivery-date and policy-exception commitments. What
 * is added here is the class that one cannot express: a claim whose grounding
 * depends on a SPECIFIC fact having a SPECIFIC value, rather than on any fact
 * of that kind existing.
 */
type GroundedAssertion = {
  readonly claim: string;
  readonly pattern: RegExp;
  readonly supported: (facts: readonly VerifiedFact[]) => boolean;
  readonly fact: (facts: readonly VerifiedFact[]) => string | null;
  readonly correction: string;
};

const GROUNDED_ASSERTIONS: readonly GroundedAssertion[] = [
  {
    // "Your order has been dispatched" is a statement about the warehouse, and
    // it is either supported by the verified context or it is invented.
    claim: "dispatch statement",
    pattern:
      /\b(?:(?:your|the)\s+(?:order|parcel|item)\s+(?:has\s+been|was|is)\s+(?:already\s+)?(?:dispatch|despatch|ship|post)|we\s+(?:have|'ve)\s+(?:already\s+)?(?:dispatch|despatch|ship|post))/i,
    supported: (facts) => dispatchState(facts) === "dispatched",
    fact: (facts) =>
      facts.length === 0 ? null : `dispatch is ${dispatchState(facts).replace("_", " ")}`,
    correction:
      "The reply states that the order has been dispatched. The verified context does not establish that. Remove the claim, or say only what the verified context supports.",
  },
  {
    claim: "cancellation statement",
    pattern:
      /\b(?:(?:your|the)\s+order\s+(?:has\s+been|was|is\s+now)\s+cancel|we\s+(?:have|'ve)\s+cancel)/i,
    supported: (facts) => {
      const status = factValue(facts, "order_status");
      return status !== null && normaliseStatus(status) === "cancelled";
    },
    fact: (facts) => {
      const status = factValue(facts, "order_status");
      return status === null ? null : `order_status = ${status}`;
    },
    correction:
      "The reply tells the customer the order has been cancelled. The verified order does not record it as cancelled. Describe what will happen rather than asserting it is done.",
  },
  {
    /*
     * An investigation nobody performed.
     *
     * "I have checked our system and ..." is the most persuasive sentence a
     * draft can contain and the least defensible: nothing in this pipeline
     * checks anything on demand. Either a verified fact was supplied before the
     * model ran, or no check happened. With no facts at all, the claim is
     * always false.
     */
    claim: "investigation statement",
    pattern:
      /\b(?:(?:we|i)\s+(?:have|'ve|has)\s+(?:now\s+)?(?:checked|reviewed|investigated|looked\s+into|verified)|our\s+(?:team|warehouse|system)\s+(?:has|have)\s+(?:confirmed|checked)|(?:i|we)\s+(?:can\s+)?see\s+(?:on\s+)?our\s+system)/i,
    supported: (facts) => facts.length > 0,
    fact: () => null,
    correction:
      "The reply claims that something was checked or looked up. No verified context was supplied for this conversation, so nothing was. Remove the claim and ask for what you need instead.",
  },
];

/**
 * The reply telling the customer where their parcel is.
 *
 * THREE CLAIMS, NAMED BY THE TEAM: delivered, delayed, out for delivery. Each
 * is a statement about the physical world that we can only know from a carrier,
 * and each is checkable by the customer within minutes — they can look out of
 * the window. A wrong one here is not a tone problem; it is the reply telling
 * somebody their missing parcel arrived.
 *
 * Written to catch the ASSERTION, not the mention. "Has it been delivered?" and
 * "if it has not been delivered by Friday" are not claims that it was, and a
 * pattern that fired on the bare word would flag most delivery replies ever
 * written. The subject and a copular verb are required.
 */
const DELIVERY_STATE_CLAIM = new RegExp(
  [
    // "your parcel has been delivered", "the item was delivered on Tuesday"
    "\\b(?:your|the)\\s+(?:parcel|order|item|package|delivery|consignment)\\s+(?:has\\s+been|have\\s+been|was|were|is)\\s+(?:already\\s+)?(?:deliver|out\\s+for\\s+deliver)",
    // "it has been delivered"
    "\\bit\\s+(?:has\\s+been|was)\\s+deliver",
    // "we delivered it", "it shows as delivered", "marked as delivered"
    "\\b(?:shows?|showing|marked|recorded)\\s+as\\s+deliver",
    // "your parcel is delayed", "the delivery has been delayed"
    "\\b(?:your|the)\\s+(?:parcel|order|item|package|delivery|consignment)\\s+(?:has\\s+been|is|was)\\s+(?:slightly\\s+|a\\s+little\\s+)?(?:delay|held\\s+up|lost)",
    // "it is out for delivery today"
    "\\bit\\s+is\\s+out\\s+for\\s+deliver",
  ].join("|"),
  "i",
);

/**
 * Wording that turns the clause into something other than an assertion.
 *
 * A QUESTION IS NOT A CLAIM, and neither is a condition. "Could you confirm
 * whether it has been delivered?" and "if it has not been delivered by Friday"
 * both contain the exact words of a delivery claim while asserting nothing —
 * and both are perfectly good things for a delivery reply to say. Without this,
 * the check fired on the first one, which would have made it a tax on every
 * careful draft rather than a guard against the careless ones.
 */
const NOT_AN_ASSERTION = /\b(?:whether|if|unless|in\s+case|once|when|until|should\s+it)\b/i;

/** The offending sentence, if the reply actually asserts a delivery state. */
function deliveryStateClaim(reply: string): string | null {
  for (const sentence of sentences(reply)) {
    if (!DELIVERY_STATE_CLAIM.test(sentence)) continue;
    if (sentence.trim().endsWith("?")) continue;
    if (NOT_AN_ASSERTION.test(sentence)) continue;
    return sentence;
  }
  return null;
}

/** The tracking statuses that actually support each of those claims. */
function trackingSupports(
  tracking: TrackingResult | null | undefined,
  reply: string,
): boolean {
  if (tracking === null || tracking === undefined) return false;
  const status = tracking.currentStatus;
  // An unknown status supports nothing. It is the carrier saying it does not
  // know, and a reply may not be more certain than the carrier.
  if (status === "unknown") return false;

  const saysDelivered = /\bdeliver(?:ed|y)\b/i.test(reply);
  const saysOutForDelivery = /\bout\s+for\s+deliver/i.test(reply);
  const saysDelayed = /\b(?:delay|held\s+up|lost)/i.test(reply);

  if (saysOutForDelivery && status !== "out_for_delivery") return false;
  if (saysDelayed && status !== "exception" && status !== "attempted_delivery") return false;
  if (saysDelivered && !saysOutForDelivery && status !== "delivered") return false;
  return true;
}

function hallucinationCheck(draft: DraftUnderReview): DraftFinding[] {
  const findings: DraftFinding[] = [];

  /*
   * A DELIVERY STATE MAY ONLY COME FROM A CARRIER.
   *
   * Not from the order status, not from the dispatch date, not from what would
   * be reasonable given the timescale. Either a tracking lookup established it
   * for this conversation or the reply may not say it.
   */
  const deliveryClaim = deliveryStateClaim(draft.reply);
  if (deliveryClaim !== null && !trackingSupports(draft.tracking, deliveryClaim)) {
    findings.push({
      issue: "unsupported_claim",
      severity: "critical",
      incorrectStatement: deliveryClaim,
      verifiedFact:
        draft.tracking == null
          ? null
          : `tracking status = ${draft.tracking.currentStatus}`,
      ruleThatApplies: "Delivery status: state only what the carrier established",
      regenerationReason:
        draft.tracking == null
          ? "The reply tells the customer where their parcel is. No carrier tracking was established for this conversation, so that is not something we know. Remove it and say what the verified order context supports instead."
          : `The reply describes a delivery state the carrier does not report. The carrier's status is "${draft.tracking.currentStatus}". Say that, or say nothing about where the parcel is.`,
    });
  }

  for (const assertion of GROUNDED_ASSERTIONS) {
    if (!assertion.pattern.test(draft.reply)) continue;
    if (assertion.supported(draft.facts)) continue;
    findings.push({
      issue: "unsupported_claim",
      // Always critical: an invented refund, replacement or dispatch is the
      // expensive failure this whole design exists to prevent.
      severity: "critical",
      incorrectStatement:
        sentences(draft.reply).find((line) => assertion.pattern.test(line)) ?? "",
      verifiedFact: assertion.fact(draft.facts),
      ruleThatApplies: "Never state anything the verified context does not support",
      regenerationReason: assertion.correction,
    });
  }

  // The existing scan, reported through the same channel so a reviewer reads
  // one list rather than two that overlap.
  for (const claim of ungroundedClaims(draft.reply, draft.facts)) {
    findings.push({
      issue: "unsupported_claim",
      // Always critical: an invented refund, replacement or dispatch is the
      // expensive failure this whole design exists to prevent.
      severity: "critical",
      incorrectStatement: "",
      verifiedFact: null,
      ruleThatApplies: "Never state anything the verified context does not support",
      regenerationReason: `The reply makes a ${claim} that no verified fact supports. Remove it.`,
    });
  }

  return findings;
}

/* ------------------------------------------------------------------------- *
 * THE VALIDATION
 * ------------------------------------------------------------------------- */

/** One reviewer-facing line carrying all five reported fields. */
export function describeFinding(finding: DraftFinding): string {
  return [
    `Accuracy check [${finding.severity}] (${finding.issue.replace(/_/g, " ")})`,
    finding.incorrectStatement === ""
      ? "in the reply as a whole"
      : `in "${finding.incorrectStatement}"`,
    finding.verifiedFact === null ? "no supporting fact" : `verified: ${finding.verifiedFact}`,
    finding.ruleThatApplies === null ? "no rule named" : `rule: ${finding.ruleThatApplies}`,
    finding.regenerationReason,
  ].join(" — ");
}

/**
 * Every check, against one draft.
 *
 * ORDER OF CHECKS IS THE ORDER OF SEVERITY. A contradiction of something we
 * know is worse than an unanswered question, which is worse than a claim we
 * cannot support but which may still be harmless. A reviewer reading the top of
 * the list reads the worst thing first.
 */
export function validateDraftAccuracy(draft: DraftUnderReview): DraftValidation {
  const findings: DraftFinding[] = [
    ...factCheck(draft),
    ...hallucinationCheck(draft),
    /*
     * SKIPPED IN RESTRICTED MODE, and only these two.
     *
     * Without the CST knowledge base the draft is INSTRUCTED to state no policy
     * and to do no more than acknowledge and ask. Grading it on "did it apply
     * the cancellation route" would fail it for obeying its instructions, and a
     * regeneration could only fix the finding by inventing the policy it was
     * told not to invent. The fact and hallucination checks above still run: a
     * draft written without rules may still not contradict the order.
     */
    ...(draft.knowledgeAvailable ? ruleCheck(draft) : []),
    ...(draft.knowledgeAvailable ? intentCheck(draft) : []),
  ];

  const critical = findings.filter((finding) => finding.severity === "critical");

  // Two checks can reach the same conclusion by different routes — an
  // undispatched cancellation is both a hedge on a settled fact and a route not
  // taken. The reviewer needs the instruction once.
  //
  // Corrections come from the CRITICAL findings only; the notes carry all of
  // them, because a reviewer must see every finding whether or not it bought a
  // second call.
  const corrections = [...new Set(critical.map((finding) => finding.regenerationReason))];
  const notes = [...new Set(findings.map(describeFinding))];

  return {
    passed: findings.length === 0,
    findings,
    regenerationWarranted: critical.length > 0,
    corrections,
    notes,
  };
}

/**
 * The correction block appended to a regeneration's input.
 *
 * Written as a correction to a specific previous attempt rather than as extra
 * standing policy, because that is what it is — appending it to the permanent
 * instruction would make every future draft defensive about a mistake it never
 * made.
 *
 * THE REJECTED DRAFT IS INCLUDED, AND IT PAYS FOR ITSELF. A reply is a few
 * hundred tokens against a request of tens of thousands, so the cost is close
 * to nothing. What it buys is a MEND rather than a REWRITE: without it the
 * model starts from a blank page, spends a full reply's worth of output and
 * reasoning, and is free to reintroduce the same error by the same route it
 * took the first time — the corrections say what was wrong but not what the
 * wrong thing was. With it, the task is to change the named parts and leave the
 * rest, which is cheaper in output tokens and likelier to pass on the retry.
 * The retry that fails is the expensive outcome: two calls and still flagged.
 */
export function correctionBlock(
  corrections: readonly string[],
  rejectedDraft?: string,
): string {
  return [
    "CORRECTION — YOUR PREVIOUS ATTEMPT AT THIS REPLY WAS REJECTED.",
    "",
    ...(rejectedDraft === undefined || rejectedDraft.trim() === ""
      ? []
      : [`This is what you wrote:\n\n"""\n${rejectedDraft}\n"""`, ""]),
    "An accuracy check compared it against the verified context and the customer's own message and found the following.",
    "",
    ...corrections.map((correction, index) => `${index + 1}. ${correction}`),
    "",
    "Write the reply again. Change what these points name and keep everything else that was already right — this is a correction, not a fresh start. Everything else in your instructions still applies: you may still state nothing the verified context does not support, and fixing these must not be done by inventing anything.",
  ].join("\n");
}
