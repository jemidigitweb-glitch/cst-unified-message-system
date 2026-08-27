import {
  customerProductDataBlock,
  extractCustomerProductData,
} from "@/lib/domain/customer-product-data";
import {
  type DraftResult,
  draftResultSchema,
  settleReviewRequirement,
} from "@/lib/domain/draft";
import { normaliseRef } from "@/lib/knowledge/rule-evidence";

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
    `VERIFIED CONTEXT — ORDER:\n${order}`,
    `VERIFIED CONTEXT — PRODUCT/SKU:\n${
      product.length === 0
        ? "(no product or SKU has been resolved and verified — you therefore know NO product name, specification or price)"
        : product.join("\n")
    }`,
  ];

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
  const customerBlock = customerProductDataBlock(extractCustomerProductData(request.messages));
  if (customerBlock !== null) blocks.push(customerBlock);

  return blocks.join("\n\n");
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
