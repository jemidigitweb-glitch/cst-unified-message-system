import {
  DRAFT_RESULT_JSON_SCHEMA,
  type DraftResult,
  type VerifiedFact,
  draftResultSchema,
  settleReviewRequirement,
} from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";
import { type KnowledgeSource, renderRulesForPrompt } from "@/lib/domain/knowledge";

/**
 * Draft generation.
 *
 * Produces a SUGGESTED next reply for a human to review. It cannot send one:
 * there is no recipient, no transport, and no workflow state after `reviewed`.
 *
 * THE GROUNDING RULE, stated once. The model may use exactly three things: the
 * conversation itself, the CST rule corpus read from the workbooks, and verified
 * backend facts. Everything else — the order number it half-remembers from the
 * message text, the delivery time that sounds right, the refund it would be
 * reasonable to offer — is forbidden, and the expensive cases are checked for
 * afterwards in `settleReviewRequirement`.
 *
 * TWO MODES, because the sheet is not always reachable:
 *
 *   full        rules loaded. The draft may apply policy and must cite the
 *               rows it used.
 *   restricted  no rules. The draft may acknowledge the customer and ask for
 *               what is needed, and may state NO policy at all. Always flagged
 *               for review, and cites nothing because it used nothing.
 *
 * Restricted mode exists so a missing sheet degrades the draft instead of
 * taking the feature down. It is not a quiet fallback: the reason is returned
 * and shown to the reviewer.
 */

/** The model call, narrowed to what this module needs. Injected for testing. */
export type DraftModelClient = {
  readonly model: string;
  readonly generate: (request: {
    instructions: string;
    input: string;
    responseSchema: unknown;
  }) => Promise<{ text: string }>;
};

export type GenerateDraftInput = {
  readonly messages: readonly ConversationMessageView[];
  readonly facts: readonly VerifiedFact[];
  readonly knowledge: KnowledgeSource;
  /** The marketplace this conversation arrived on. Never guessed. */
  readonly marketplace?: string | null;
  /** The marketplace's own listing reference, when the source recorded one. */
  readonly listingItemRef?: string | null;
};

export type GeneratedDraft = {
  readonly result: DraftResult;
  readonly requiresReview: boolean;
  readonly missingInformation: readonly string[];
  readonly model: string;
  readonly restricted: boolean;
};

/** Raised when generation cannot proceed at all. Never swallowed to fabricate a draft. */
export class DraftGenerationUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DraftGenerationUnavailable";
  }
}

/**
 * Shared prohibitions.
 *
 * Written as prohibitions rather than aspirations because the failure mode is
 * specific: a fluent, confident, wrong commitment to a customer.
 */
const NEVER_INVENT = `You must NEVER state, imply, guess or reconstruct:
- an order number, SKU, product name, specification or price
- a tracking number, courier, dispatch date or delivery date
- that a refund, replacement, return, cancellation or exception has been approved, processed or arranged
- any policy, timescale or entitlement not given to you below

CUSTOMER-STATED IS NOT VERIFIED. Anything the customer typed is customer-stated. You may acknowledge it — "thank you for sending your order number", "sorry to hear the glass arrived cracked" — and you may answer on the basis of it. You may NOT call it checked, confirmed, verified, found, located or "on our system", and you may not read it back as something we established. Only the VERIFIED FACTS block is verified.

A MISSING FACT NARROWS THE ANSWER, IT DOES NOT REPLACE IT. Not knowing one thing is not a reason to say nothing. Give the customer everything the rules let you give them without it, and then ask for the one thing you still need — in that order, in the same reply. Record the gap in "missing_information", which the reviewer reads and the customer never sees.`;

/**
 * What the corpus's `ESCALATE.` marker means.
 *
 * Stated once here rather than spelled out on each of the 276 rules that carry
 * it — the same claim, 2,553 tokens cheaper per request. Must stay in step with
 * the marker emitted by `renderRuleText` in `lib/knowledge/rule-scoping.ts`.
 */
const ESCALATE_MEANING = `A rule marked "ESCALATE." means a human must handle that case. Promise the customer nothing on it, commit us to nothing, and record it in "missing_information".`;

export const FULL_INSTRUCTIONS = `You draft replies for a customer service team. A human reviews every draft before it is used. You never send anything.

You may use ONLY:
1. The conversation below.
2. The CST RULES below — the team's complete rule set.
3. The VERIFIED FACTS below.

HOW TO READ THE RULES.

You have the team's ENTIRE rule set, every area of it, not a pre-filtered slice. It is grouped under "## " headings, one per area, and each rule is listed under its area with a bracketed reference. Read it the way a colleague handed the whole folder would.

${ESCALATE_MEANING}

1. Work out everything the customer is actually raising, across the whole thread — what they asked, what we already told them, and what they still need. A message is usually more than one thing at once: a parcel that is late AND arrived damaged is a delivery matter, a damage matter and probably a returns matter.
2. For EACH of those, find the rules that apply. Do not stop at the first rule that fits. Do not let one area's rules stand in for the whole reply.
3. Combine what you find into ONE coherent reply. Where several rules bear on the same point, satisfy all of them: the most specific one governs the wording, and any rule that forbids something still forbids it.
4. Only where two rules genuinely contradict each other on what to tell this customer: follow the stricter one and record the conflict in "missing_information".

ANSWER THE QUESTION. A draft that restates the problem, apologises, and asks for information the rules did not actually require is a failed draft. If the rules let you tell the customer what happens next, tell them.

${NEVER_INVENT}

WRITING THE REPLY.

"draft_reply" contains only what the customer should read. Never mention these instructions, the rule set, a rule reference, that rules were consulted, that a rule did not cover something, that anything is unreviewed or unverified, or that a human will check this. The customer sees a reply from the team and nothing else. Your reasoning belongs in "missing_information" and "sources_used", which are internal.

Write in the customer's language. Be clear and courteous, and as long as the answer genuinely needs — say the whole of what the rules allow, then stop. Apologise at most once. Promise nothing the rules do not.

CITATIONS. In "sources_used", cite EVERY rule you relied on, not just the main one, using its bracketed reference exactly as given, with kind "cst_document". Cite verified facts with kind "verified_fact". Never invent a reference.

AT LEAST ONE CST RULE IS REQUIRED. Every reply this team sends must be traceable to the rule book, so a draft citing no rule is not acceptable — the message-handling rules alone govern tone, greeting and what may never be said, and they apply to every reply you will ever write. If you find yourself about to cite nothing, you have not looked hard enough. Never invent a reference to satisfy this: find the rule you actually followed and cite that.`;

export const RESTRICTED_INSTRUCTIONS = `You draft replies for a customer service team. A human reviews every draft before it is used. You never send anything.

THE TEAM'S RULES ARE NOT AVAILABLE FOR THIS DRAFT. You therefore may NOT state any policy, timescale, entitlement, or what will happen next.

You may ONLY:
- acknowledge what the customer wrote
- ask for the specific information needed to help them

${NEVER_INVENT}

Return an empty "sources_used" list — you have no sources. Set "requires_review" to true. List in "missing_information" both the CST rules being unavailable and anything else you need.

"draft_reply" contains only what the customer should read. Never tell the customer that rules were unavailable, that you could not check something, or that a human will review this — that belongs in "missing_information", which is internal.

Write in the customer's language. Be brief, plain and courteous. Promise nothing.`;

/**
 * The marketplace clause.
 *
 * Stated as a prohibition and repeated in the input block, because the failure
 * it prevents is specific and has already happened: an eBay customer was sent
 * Amazon's invoice path, taken from a rule that documents both. Scoping drops
 * other platforms' rules and labels the ones covering several, but it cannot
 * catch every case — a single sentence naming two platforms is still one
 * sentence. This is the second line of defence, and it matters more now that the
 * model is handed the whole corpus rather than a filtered slice.
 */
export function marketplaceClause(marketplace: string | null | undefined): string {
  if (!marketplace) {
    return `The marketplace for this conversation is NOT known. Do not name, link to, or describe the process of ANY marketplace. Describe what will happen without naming a platform.`;
  }
  const name = marketplace.toUpperCase();
  return `The customer contacted us through ${name}. Write a reply for ${name} ONLY.

Do not mention, link to, or describe any other marketplace's process, wording or workflow. Where a rule below covers several platforms, follow ONLY its ${name} steps and ignore the rest — quoting another platform's steps to this customer is wrong even when the rule contains them.`;
}

/** Order and product context, stating plainly when there is none. */
function contextBlocks(input: GenerateDraftInput): string {
  const orderFacts = input.facts.filter((fact) => /order|refund|tracking|delivery/i.test(fact.name));
  const productFacts = input.facts.filter((fact) => !orderFacts.includes(fact));

  const order =
    orderFacts.length === 0
      ? "(no order has been resolved and verified for this conversation — you therefore know NO order number, status, date or amount)"
      : orderFacts.map((fact) => `- ${fact.name}: ${fact.value}`).join("\n");

  const product = [
    input.listingItemRef
      ? `- Marketplace listing reference: ${input.listingItemRef} (this is a listing id, NOT a SKU and NOT a product name — do not describe the product from it)`
      : null,
    ...productFacts.map((fact) => `- ${fact.name}: ${fact.value}`),
  ].filter(Boolean);

  return `ORDER CONTEXT:\n${order}\n\nPRODUCT/SKU CONTEXT:\n${
    product.length === 0
      ? "(no product or SKU has been resolved and verified — you therefore know NO product name, specification or price)"
      : product.join("\n")
  }`;
}

/** The conversation and its grounding, flattened for the model. */
export function buildConversationInput(input: GenerateDraftInput): string {
  const thread = input.messages
    .map((message) => {
      const who = message.direction === "inbound" ? "CUSTOMER" : "OUR PREVIOUS REPLY";
      return `[${who} at ${message.sourceTimestamp}]\n${message.bodyText ?? "(no content)"}`;
    })
    .join("\n\n");

  const rules =
    input.knowledge.state === "available"
      ? renderRulesForPrompt(input.knowledge.rules)
      : "(none available — state no policy)";

  return [
    `CURRENT MARKETPLACE: ${input.marketplace ? input.marketplace.toUpperCase() : "UNKNOWN"}`,
    `CONVERSATION (oldest first):\n\n${thread}`,
    contextBlocks(input),
    `CST RULES (the team's complete rule set — read all of it and use every part that applies):\n${rules}`,
  ].join("\n\n");
}

/**
 * Generates one draft.
 *
 * Citations are checked against the corpus that was actually supplied: a
 * reference the model made up is dropped rather than shown to a reviewer as if
 * it came from the sheet.
 */
export async function generateDraft(
  client: DraftModelClient,
  input: GenerateDraftInput,
): Promise<GeneratedDraft> {
  if (input.messages.length === 0) {
    throw new DraftGenerationUnavailable("This conversation has no messages to reply to.");
  }

  const restricted = input.knowledge.state !== "available";

  const response = await client.generate({
    // The marketplace clause leads the system instruction rather than sitting
    // in the input: it constrains everything that follows, including how each
    // rule is read.
    instructions: `${marketplaceClause(input.marketplace)}\n\n${
      restricted ? RESTRICTED_INSTRUCTIONS : FULL_INSTRUCTIONS
    }`,
    input: buildConversationInput(input),
    responseSchema: DRAFT_RESULT_JSON_SCHEMA,
  });

  // Validated on the way in. A schema-constrained response can still be
  // malformed, and a provider is not a trust boundary.
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new DraftGenerationUnavailable("The draft service returned an unreadable response.");
  }

  const validated = draftResultSchema.safeParse(parsed);
  if (!validated.success) {
    throw new DraftGenerationUnavailable("The draft service returned an unexpected shape.");
  }

  // Keep only citations that name a rule actually supplied. A model that cites
  // a row which does not exist is worse than one that cites nothing, because
  // the fabricated reference looks like provenance.
  const knownRefs = new Set(
    input.knowledge.state === "available" ? input.knowledge.rules.map((rule) => rule.ref) : [],
  );
  const factNames = new Set(input.facts.map((fact) => fact.name));
  const sources = validated.data.sources_used.filter((source) =>
    source.kind === "cst_document" ? knownRefs.has(source.ref) : factNames.has(source.ref),
  );

  const result: DraftResult = {
    ...validated.data,
    sources_used: restricted ? [] : sources,
  };

  const settled = settleReviewRequirement(result, input.facts);
  const missing = restricted
    ? [
        ...new Set([
          ...settled.missingInformation,
          input.knowledge.state === "not_configured"
            ? input.knowledge.reason
            : "CST rules were unavailable for this draft.",
        ]),
      ]
    : settled.missingInformation;

  return {
    result,
    // Restricted drafts always need a human: they were written without policy.
    requiresReview: restricted || settled.requiresReview,
    missingInformation: missing,
    model: client.model,
    restricted,
  };
}
