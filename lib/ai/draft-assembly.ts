import {
  customerProductDataBlock,
  extractCustomerProductData,
} from "@/lib/domain/customer-product-data";
import {
  type DraftResult,
  draftResultSchema,
  settleReviewRequirement,
} from "@/lib/domain/draft";
import type { BundleContext } from "@/lib/domain/bundle-context";
import { displayBody } from "@/lib/domain/inbox";
import { readConversation } from "@/lib/knowledge/message-category";
import { normaliseRef } from "@/lib/knowledge/rule-evidence";
import { CARRIER_LABELS } from "@/lib/tracking/carrier";
import { TRACKING_STATUS_LABELS, type TrackingResult } from "@/lib/tracking/provider";

import { correctionBlock } from "./draft-validation";
import { DraftGenerationUnavailable, type DraftRequest } from "./provider";

/**
 * The parts of draft generation that are the same whoever answers.
 *
 * Building the conversation context and checking what comes back are business
 * concerns, not vendor concerns. Duplicating them per provider is how two
 * providers quietly start behaving differently — one drops invented citations,
 * the other does not — and the difference only surfaces in front of a customer.
 *
 * PURE. No network, no files, no clock.
 */

const RETURN_FACT_NAMES = new Set(["return_status", "return_reason", "return_evidence_available"]);

/**
 * Order and product context, stating plainly when there is none.
 *
 * The empty case is spelled out rather than omitted. A blank section invites
 * the model to fill it; a sentence saying "no order has been resolved and
 * verified, you therefore know NO order number" does not.
 *
 * RETURN is different on purpose: it is OMITTED, not spelled out, when empty.
 * Unlike order/product — relevant to essentially every reply — a return case
 * is the exception, not the rule, and a block insisting "no return exists"
 * on every single draft would be noise the model has to read past on every
 * call for no benefit. Present only via `resolveEbayReturnContext`, which
 * itself never fabricates a return record — see that module for the "only
 * after a verified single order, matched by order_id, never item_id alone"
 * contract this block assumes but does not enforce.
 */
/**
 * The category the classifier already read from the whole thread.
 *
 * WHY IT IS HERE AT ALL. `readConversation` reads every customer message in
 * order, weights the latest intent, and separates the issue from the requested
 * action. It gets cases the raw text does not: a buyer whose phone turned "red"
 * into "refund" wrote "does the big rustic refund (36cm) come with a reduced
 * plate? Refund = red colour", and the classifier reads that as a pre-sales
 * enquiry while a reader starting from the words alone retrieves the refund
 * rules and answers a question nobody asked. Until now that reading was computed
 * and thrown away before the model saw anything.
 *
 * INTERNAL GUIDANCE, NOT A FACT. It is deliberately NOT headed "VERIFIED": it is
 * this system's reading of the customer's intent, not something established
 * against the source database, and it can be wrong. The wording says so, and
 * says the conversation itself wins where the two disagree — otherwise a
 * misclassification would override the customer's own words instead of being
 * corrected by them.
 *
 * NEVER SPOKEN. The instruction to keep it out of the reply is stated here,
 * with the data, rather than in the standing system instruction — the same
 * reason the tracking block carries its own rules. A draft that has no category
 * is not told to keep quiet about categories.
 *
 * The label is the classifier's own, verbatim. Translating "Pre sales queries"
 * into friendlier words would create a second vocabulary that could drift from
 * the one on the reviewer's screen.
 */
function categoryBlock(request: DraftRequest): string | null {
  const category = readConversation(
    request.messages.map((message) => ({
      direction: message.direction === "inbound" ? ("inbound" as const) : ("outbound" as const),
      text: displayBody(message).available ? displayBody(message).text : null,
    })),
  ).category;

  if (category === null) return null;

  return [
    `INTERNAL GUIDANCE — MESSAGE CATEGORY: ${category}`,
    "(this is THIS SYSTEM'S reading of what the customer is asking about, taken from the whole thread. It is not a verified fact and it is not something the customer said.",
    "Use it to work out which rule areas to search when the wording is ambiguous, a typo has changed a word, or a later message corrects an earlier one.",
    "Where it disagrees with what the customer plainly wrote, the customer's own words win.",
    "NEVER mention it. Do not name the category, do not refer to a classification, a label, an internal system, backend context or any analysis of the message. The customer reads a reply from the team and nothing else.)",
  ].join("\n");
}

/** Fact names whose value settles whether a product has an electrical interface. */
const ELECTRICAL_REQUIREMENT_FACTS = new Set(["req_electrician", "cap_elec_req"]);

/** A stored "no" from the product sheet. Values are single letters, never phrases. */
const MEANS_NO = /^n$/i;

/**
 * How the model must USE the verified product facts above.
 *
 * TWO RULES, AND EACH FIXES A MEASURED FAILURE.
 *
 * ANSWER FIRST. A customer asked "can this be used on a table lamp as well or
 * just a ceiling shade?" against a listing whose sheet says `table_lamp: Y`, and
 * was told to send us the fitting type, voltage and wattage of their lamp. The
 * CST compatibility rules do say to ask for setup details first, and they are
 * right for the half of the question that is about the customer's own lamp —
 * but the other half is about the product, and the answer to it was already in
 * the context. This says which half is which.
 *
 * PASSIVE PRODUCTS. The compatibility rules were written for electrical goods —
 * "ask for wattage, voltage, fitting type FIRST" is correct for a bulb or a
 * ceiling rose. A lampshade is a passive metal shade with no electrical
 * connection, and its buyer has no voltage to give. The sheet already says which
 * is which (`req_electrician`, `cap_elec_req`), and this line is added ONLY when
 * those facts say the product is passive — a bulb or a rose never sees it, and
 * the CST rules are neither removed nor weakened for the products they were
 * written for.
 *
 * NEITHER LINE PERMITS A GUESS. Both are about facts already in the block above;
 * nothing here softens the standing prohibition on stating an unverified
 * specification.
 *
 * OMITTED ENTIRELY when no product facts resolved, so a draft with nothing to
 * answer from is unchanged from what it was before this existed.
 */
function usageRule(
  productFacts: readonly { name: string; value: string }[],
  bundle: BundleContext | null | undefined,
): string[] {
  /*
   * ONLY WHERE THERE IS A CATALOGUE TO ANSWER FROM.
   *
   * A resolved order contributes `sku` and `product_title` to this block, and
   * those two alone answer no product question — there is nothing for a "use it
   * before you ask" rule to bite on. Requiring a third fact keeps every
   * post-sale draft byte-identical to what it was.
   *
   * A BUNDLE COUNTS AS A CATALOGUE, and forgetting that was a real defect. This
   * rule was first gated on product facts alone, so a bundle listing — which
   * carries no product facts, because its components travel in their own block —
   * silently got no guidance at all. Measured live on a 50-option lampshade
   * bundle: the draft asked the customer for their voltage and wattage for a
   * passive metal shade, which is the exact failure this rule exists to stop,
   * on exactly the listings the bundle resolver was built to serve.
   */
  const answerable = productFacts.filter(
    (fact) => fact.name !== "sku" && fact.name !== "product_title",
  );
  const bundleAttributes: { name: string; value: string }[] = [
    ...(bundle?.common ?? []).flatMap((component) =>
      component.attributes.map((attribute) => ({ name: attribute.key, value: attribute.value })),
    ),
    ...(bundle?.varyingAgreement ?? []).map((attribute) => ({
      name: attribute.key,
      value: attribute.value,
    })),
  ];
  if (answerable.length === 0 && bundleAttributes.length === 0) return [];

  const lines = [
    "",
    // "you have been given" rather than "above": the facts may sit in this block
    // or in the BUNDLE COMPONENTS block that follows it, and the rule governs both.
    "USING THE VERIFIED PRODUCT INFORMATION YOU HAVE BEEN GIVEN (in this block and in any BUNDLE COMPONENTS block below):",
    "- If it answers the customer's question about THE PRODUCT, answer it directly. Do not ask the customer for something already stated there, and do not ask them to check a detail we have already established.",
    "- Ask only for what depends on THE CUSTOMER'S OWN fitting, fixture or setup, and only when the answer genuinely turns on it. Answer everything you can first, then ask for the minimum still missing, in that order and in the same reply.",
  ];

  const passive = [...productFacts, ...bundleAttributes].some(
    (fact) => ELECTRICAL_REQUIREMENT_FACTS.has(fact.name) && MEANS_NO.test(fact.value.trim()),
  );
  if (passive) {
    lines.push(
      "- This product needs no electrical installation — see `req_electrician` / `cap_elec_req` above. Do NOT ask this customer for voltage, wattage, an electrical rating, or whether an electrician is involved: those do not apply to it. Where a compatibility rule calls for setup details, ask only for the ones that do apply, such as the fitting or holder type and the relevant measurement.",
    );
  }

  return lines;
}

export function contextBlocks(request: DraftRequest): string {
  const orderFacts = request.facts.filter((fact) =>
    /order|refund|tracking|delivery/i.test(fact.name),
  );
  const returnFacts = request.facts.filter((fact) => RETURN_FACT_NAMES.has(fact.name));
  const productFacts = request.facts.filter(
    (fact) => !orderFacts.includes(fact) && !returnFacts.includes(fact),
  );

  const order =
    orderFacts.length === 0
      ? "(no order has been resolved and verified for this conversation — you therefore know NO order number, status, date or amount)"
      : orderFacts.map((fact) => `- ${fact.name}: ${fact.value}`).join("\n");

  const product = [
    request.listingItemRef
      ? `- Marketplace listing reference: ${request.listingItemRef} (this is a listing id, NOT a SKU and NOT a product name — do not describe the product from it)`
      : null,
    ...productFacts.map((fact) => `- ${fact.name}: ${fact.value}`),
  ].filter(Boolean);

  const blocks = [
    categoryBlock(request),
    `VERIFIED CONTEXT — ORDER:\n${order}`,
    `VERIFIED CONTEXT — PRODUCT/SKU:\n${
      product.length === 0
        ? "(no product or SKU has been resolved and verified — you therefore know NO product name, specification or price)"
        : [...product, ...usageRule(productFacts, request.bundle)].join("\n")
    }`,
  ].filter((block): block is string => block !== null);

  if (returnFacts.length > 0) {
    blocks.push(
      `VERIFIED CONTEXT — RETURN:\n${returnFacts.map((fact) => `- ${fact.name}: ${fact.value}`).join("\n")}\n(this tells you a return record exists and its status/reason — it does NOT mean you have seen any photo; never describe what an image shows)`,
    );
  }

  /**
   * What the CUSTOMER said about the product, kept apart from everything above.
   *
   * Deliberately the LAST block and deliberately not headed "VERIFIED": every
   * block before it was established against the source database, and this one
   * was asserted by a member of the public. Same separation the sidebar makes
   * on screen, for the same reason — a colour the customer asked for and a SKU
   * the backend confirmed must not read as the same class of thing.
   *
   * Extracted from `request.messages`, which this already has, so nothing new
   * is fetched, computed elsewhere or stored. Omitted entirely when the
   * customer stated nothing.
   */
  // An earlier reply from this team is what the incomplete-bundle guidance must
  // protect. Read from the thread this request already carries — nothing new is
  // fetched, and a thread with no outbound message gets the shorter block.
  const bundleBlock = verifiedBundleBlock(
    request.bundle,
    request.messages.some((message) => message.direction === "outbound"),
  );
  if (bundleBlock !== null) blocks.push(bundleBlock);

  const customerBlock = customerProductDataBlock(extractCustomerProductData(request.messages));
  if (customerBlock !== null) blocks.push(customerBlock);

  const trackingBlock = verifiedTrackingBlock(request.tracking);
  if (trackingBlock !== null) blocks.push(trackingBlock);

  return blocks.join("\n\n");
}

/**
 * A bundle listing's components, when the listing is one.
 *
 * OMITTED ENTIRELY WHEN ABSENT, like the tracking block and for the same reason:
 * most listings are not bundles, and a paragraph insisting "this is not a
 * bundle" on every other draft would be noise the model reads past every time.
 *
 * ONE BLOCK PER COMPONENT, NEVER A MERGED LIST. The components' attribute names
 * collide — the ceiling rose in one real bundle has `diameter_mm: 100` while the
 * lampshade beside it has `diameter_mm: 320` — so flattening them would put a
 * contradiction in front of the model with no way to resolve it. Each component
 * keeps its own heading and the sheet's own attribute names beneath.
 *
 * THE INSTRUCTION TRAVELS WITH THE DATA, as it does for tracking. Two rules
 * matter enough to state here rather than in the standing instruction, because
 * both are about THIS block and a draft without one should not be told either:
 *
 *   what varies    the model must not attribute a colour or option to the
 *                  customer's choice, because nothing here knows which they
 *                  mean. Only what every option shares is present.
 *   what is in the box
 *                  when a component has no verified record, the component list
 *                  is known but not described, and no statement about package
 *                  contents may be built from it. Saying "it includes a shade
 *                  and a reducer ring" when the bundle also contains a rose, a
 *                  holder and possibly a bulb is worse than saying nothing: it
 *                  reads complete.
 */
export function verifiedBundleBlock(
  bundle: BundleContext | null | undefined,
  /**
   * Whether this team has already replied in this thread.
   *
   * Only used to decide whether the incomplete-bundle guidance needs its
   * "never retract what we already said" clause — see `incompleteGuidance`.
   * Defaults to false so a caller that does not know assumes the quieter block.
   */
  hasPreviousReplies = false,
): string | null {
  if (bundle === null || bundle === undefined) return null;

  const componentLines = bundle.common.flatMap((component) => [
    `- COMPONENT ${component.sku}${component.title === null ? "" : ` — ${component.title}`}`,
    ...(component.attributes.length === 0
      ? ["    (no verified product record — state nothing about this component)"]
      : component.attributes.map((attribute) => `    ${attribute.key}: ${attribute.value}`)),
  ]);

  const varyingLines =
    bundle.varyingAgreement.length === 0
      ? []
      : [
          "- THE PART THAT VARIES BY OPTION. These are the same for EVERY option, so they",
          "  may be stated without knowing which the customer means:",
          ...bundle.varyingAgreement.map((attribute) => `    ${attribute.key}: ${attribute.value}`),
        ];

  return [
    "VERIFIED CONTEXT — BUNDLE COMPONENTS:",
    `This listing is sold as a bundle. Its components come from the order system's own`,
    `record of what is picked for it, across ${bundle.variantCount} option(s) that agree.`,
    ...componentLines,
    ...varyingLines,
    "",
    "Attribute names and values above are the product record's own. Each component's",
    "attributes describe THAT component only — several components can carry the same",
    "attribute name with different values, so never merge them or apply one component's",
    "measurement to another.",
    "NEVER state or imply which option, colour or finish the customer has, or wants. Nothing",
    "above identifies one. Anything the options differ on has been left out deliberately.",
    ...(bundle.complete
      ? ["Every component above has a verified record, so you may say what the package contains."]
      : incompleteGuidance(bundle, hasPreviousReplies)),
  ].join("\n");
}

/**
 * What "incomplete" means, and — just as importantly — what it does not.
 *
 * THE FAILURE THIS SECOND HALF EXISTS FOR. The first version said only "you do
 * NOT know the full package contents; do not list what is included". Run against
 * a real thread, the model read that as a reason to revisit a reply the team had
 * ALREADY SENT, and opened with "One correction to my previous message… please
 * don't rely on the earlier parts list". That earlier reply — "1 x metal
 * lampshade and 1 x reducer plate" — was CORRECT: the decomposition is a shade
 * plus `RPR44WH`, which is the reducer plate. The gate was doing its job; the
 * wording let it do it in the wrong direction.
 *
 * SO THE LIMIT IS STATED AS A LIMIT ON NEW CLAIMS. Not knowing something is a
 * reason not to assert it. It is never a reason to withdraw what a person on
 * this team already told this customer, and a customer-facing retraction costs
 * more trust than the gap it was trying to close.
 *
 * The retraction clause is added ONLY when the thread actually contains an
 * earlier reply. A first-contact conversation has nothing to contradict, and
 * telling it not to retract a message that does not exist is a sentence spent on
 * nothing — the same reasoning that keeps the tracking and bundle blocks out of
 * the drafts that have no tracking and no bundle.
 *
 * The banned phrasings are listed literally because that is what the model
 * actually wrote. "Do not contradict" is a principle; "never write 'one
 * correction'" is checkable, by a test and by a reviewer.
 */
function incompleteGuidance(bundle: BundleContext, hasPreviousReplies: boolean): string[] {
  const missing = bundle.componentsWithoutRecord;
  const lines = [
    `INCOMPLETE: ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no verified product record. You therefore do NOT know the full package contents.`,
    "- Do not state, list or imply what the package contains, do not describe the missing component, and do not present any component's own parts list as the bundle's.",
    "- This is a limit on what you may NEWLY claim. It is not a finding, not a discovery, and not something to tell the customer about.",
  ];

  if (hasPreviousReplies) {
    lines.push(
      "- WHAT THIS TEAM HAS ALREADY TOLD THIS CUSTOMER IN THIS THREAD STANDS. Those replies went out under our name and a person stood behind them; treat them as authoritative and assume they were right.",
      "- NEVER retract, correct, contradict, walk back, apologise for, or cast doubt on anything already sent. Never write \"correction\", \"one correction\", \"to clarify my previous message\", \"ignore my previous message\", \"please disregard\", \"the previous information was incorrect\", or \"do not rely on\" anything we have already said.",
      "- If what you can verify here is thinner than an earlier reply, that is a gap in THIS block, not an error in that reply. Say nothing about the difference. Silence is correct; a public retraction is not.",
      "- Answer only what the customer has asked that the earlier replies did not already answer, using what is verified above, and ask only for what is genuinely still missing.",
    );
  }

  return lines;
}

/**
 * What the carrier says about the parcel, when we asked and got an answer.
 *
 * OMITTED ENTIRELY WHEN ABSENT, unlike the order and product blocks above.
 * Those are spelled out when empty because they apply to essentially every
 * reply, and a blank section invites the model to fill it in. A tracking lookup
 * is the exception rather than the rule — only a delivery query with a resolved
 * carrier gets one — so a paragraph insisting "no tracking was retrieved" on
 * every other draft would be noise the model reads past on every call.
 *
 * THE INSTRUCTION TRAVELS WITH THE DATA. It is stated here rather than added to
 * the standing system instruction for the same reason: a rule about tracking
 * belongs in front of the model on the drafts that have tracking, and telling
 * every draft not to guess at a delivery status it was never given is a
 * sentence spent on nothing.
 *
 * `retrieval` IS SHOWN, and it matters. "Delivered, checked a moment ago" and
 * "Delivered, checked a quarter of an hour ago" are different claims, and only
 * one of them should be written to a customer as the present state of affairs.
 */
export function verifiedTrackingBlock(tracking: TrackingResult | null | undefined): string | null {
  if (tracking === null || tracking === undefined) return null;

  const latest = tracking.trackingEvents.at(-1);

  /**
   * The whole scan history, most recent first.
   *
   * A single latest scan is enough to answer "where is it" and useless for the
   * questions that actually generate work: whether a return arrived, when a
   * delivery was attempted, how long a parcel has sat unmoved. Those are read
   * off the shape of the journey, and the model cannot infer a shape from one
   * point. Reversed here because `trackingEvents` is oldest-first by contract
   * and a reader wants the newest line first.
   */
  const history = [...tracking.trackingEvents]
    .reverse()
    .map(
      (event) =>
        `  * ${event.timestamp} — ${TRACKING_STATUS_LABELS[event.status]} — ${event.description}`,
    );

  return [
    "VERIFIED TRACKING INFORMATION:",
    `- Carrier: ${CARRIER_LABELS[tracking.carrier]}`,
    `- Tracking number: ${tracking.trackingNumber}`,
    `- Current status: ${TRACKING_STATUS_LABELS[tracking.currentStatus]}`,
    `- Last updated: ${tracking.lastUpdated ?? "(the carrier has reported nothing yet)"}`,
    latest === undefined
      ? "- Latest scan: (none recorded)"
      : `- Latest scan: ${latest.description}${latest.location === null ? "" : ` at ${latest.location}`}`,
    history.length === 0 ? "- Tracking history: (none recorded)" : "- Tracking history (most recent first):",
    ...history,
    `- Source: ${tracking.source.retrieval === "live" ? "Live" : "Cached"}`,
    "",
    /*
     * EVIDENCE FIRST, CONTENT ONLY IF ASKED FOR. Both halves are here because
     * each was broken in turn.
     *
     * Withholding it produced drafts asking a customer to "send us the latest
     * tracking update" on a conversation where every scan above was already in
     * front of the model — asking for a fact we hold reads as not having
     * looked.
     *
     * Supplying it without this rule produced the opposite: a customer writing
     * "the driver is missing from my order, I need a refund" was answered with
     * "the carrier last recorded the parcel as delivered on 28 August at
     * 13:21" — true, verified, and an answer to a question nobody asked. It
     * reads as deflection, and it buries the part of the reply they wanted.
     *
     * So the model is told what the tracking is FOR: reasoning always, saying
     * only when the customer's own question turns on where the parcel is.
     */
    "VERIFIED SHIPMENT TRACKING INFORMATION IS AUTHORITATIVE. Use it before requesting information from the customer. Never ask them for the latest tracking update, the current parcel status, or the tracking history — all of it is above.",
    "IT IS EVIDENCE, NOT SOMETHING YOU MUST REPEAT. Before putting any of it in the reply, ask yourself: does this customer need delivery or shipment information to have THEIR message answered? If yes — they are asking where the parcel is, whether it arrived, when it will come, about a delay, a delivery attempt, a redelivery or a collection — then say what the carrier recorded and what it means for them. If no — they are asking about a missing part, a refund amount, a replacement decision, a wrong or damaged item, or the product itself — then use the tracking silently, to check your assumptions and to avoid contradicting the record, and do not narrate it. Answer the question they actually asked.",
    "USE ONLY THIS VERIFIED TRACKING INFORMATION. Do not guess the delivery status, do not estimate when it will arrive, and do not describe any movement not listed above. If the status is unknown, say that we are checking with the carrier — do not fill the gap.",
    /*
     * The one case where raising it unprompted IS right. Without this, the
     * relevance rule above would let a customer saying "it never arrived"
     * against a Delivered scan be answered as though the record agreed with
     * them.
     */
    "If what the customer describes conflicts with the record above, that makes it relevant: say what the carrier recorded, and ask them to confirm the detail that would settle it.",
    tracking.source.retrieval === "cached"
      ? "This was retrieved a short time ago rather than this moment. Do not present it as the position right now — say what the carrier last recorded."
      : null,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** The thread, oldest first, with each side labelled. */
export function conversationBlock(request: DraftRequest): string {
  return request.messages
    .map((message) => {
      const who = message.direction === "inbound" ? "CUSTOMER" : "OUR PREVIOUS REPLY";
      return `[${who} at ${message.sourceTimestamp}]\n${message.bodyText ?? "(no content)"}`;
    })
    .join("\n\n");
}

/**
 * The user-content block.
 *
 * `knowledge` is optional and that is the whole point of this signature. A
 * provider with retrieval (File Search) passes nothing and the model searches;
 * a provider without one passes the rendered corpus. Everything else the model
 * sees is identical, so a difference in draft quality is attributable to
 * retrieval rather than to two divergent prompts.
 */
export function buildDraftInput(request: DraftRequest, knowledge?: string): string {
  return [
    `CURRENT MARKETPLACE: ${request.marketplace ? request.marketplace.toUpperCase() : "UNKNOWN"}`,
    `CONVERSATION (oldest first):\n\n${conversationBlock(request)}`,
    contextBlocks(request),
    knowledge === undefined
      ? `CST KNOWLEDGE: search the knowledge base for every rule area this conversation touches before you write.`
      : `CST RULES (the team's complete rule set — read all of it and use every part that applies):\n${knowledge}`,
    /*
     * LAST, and only on a regeneration.
     *
     * Last because it is the most specific thing in the request and has to be
     * read against everything above it, not before. Absent on a first attempt,
     * so the input is unchanged from what it was before the accuracy check
     * existed — a correction block on every draft would make the model
     * defensive about a mistake it has not made.
     */
    ...(request.corrections !== undefined && request.corrections.length > 0
      ? [correctionBlock(request.corrections, request.rejectedDraft)]
      : []),
  ].join("\n\n");
}

export type ValidatedDraft = {
  readonly result: DraftResult;
  readonly requiresReview: boolean;
  readonly missingInformation: readonly string[];
};

/**
 * Parses and checks what the model returned.
 *
 * FOUR GATES, in order, and none is redundant:
 *
 *   1. JSON parse         a schema-constrained response can still be truncated.
 *   2. Domain schema      a provider is not a trust boundary.
 *   3. Citation filter    a reference that resolves to nothing is worse than no
 *                         reference, because it LOOKS like provenance.
 *   4. Claim scan         `settleReviewRequirement` re-reads the reply for
 *                         refund/tracking/approval claims the facts do not
 *                         support, whatever the model said about itself.
 *
 * `knownRefs` is optional. When the caller can enumerate the rules that were
 * available — Gemini sends them, so it can — a citation outside that set is
 * dropped. With retrieval the caller may not know the full set, and passing
 * `undefined` keeps citations rather than discarding provenance we cannot
 * disprove. Silently dropping every citation because we could not check them
 * would turn a grounded draft into an apparently ungrounded one.
 */
export function validateDraft(
  text: string,
  request: DraftRequest,
  knownRefs: ReadonlySet<string> | undefined,
): ValidatedDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DraftGenerationUnavailable("The draft service returned an unreadable response.");
  }

  const validated = draftResultSchema.safeParse(parsed);
  if (!validated.success) {
    throw new DraftGenerationUnavailable("The draft service returned an unexpected shape.");
  }

  const factNames = new Set(request.facts.map((fact) => fact.name));

  /**
   * Citations are canonicalised before anything else touches them.
   *
   * The knowledge documents present a rule as `## [RETREF-GFR-9] EB4` and the
   * instruction asks for the bracketed reference exactly, so the model returns
   * `[RETREF-GFR-9]` — brackets and all — while the corpus is keyed without
   * them. Stored raw, every citation later failed to resolve and was reported
   * to the reviewer as a rule that no longer exists. Normalising at the point
   * of validation means the database holds one shape, and the lookup does not
   * have to guess which shape it is.
   */
  const sources = validated.data.sources_used
    .map((source) => ({ ...source, ref: normaliseRef(source.ref) }))
    .filter((source) => {
      if (source.ref === "") return false;
      if (source.kind !== "cst_document") return factNames.has(source.ref);
      return knownRefs === undefined || knownRefs.has(source.ref);
    });

  const result: DraftResult = { ...validated.data, sources_used: sources };
  const settled = settleReviewRequirement(result, request.facts);

  return {
    result,
    requiresReview: settled.requiresReview,
    missingInformation: settled.missingInformation,
  };
}
