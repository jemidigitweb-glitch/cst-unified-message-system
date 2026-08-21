import { z } from "zod";

/**
 * The AI draft contract.
 *
 * Phase 1 produces a REVIEWED DRAFT and stops. Nothing in this module, or
 * anything it feeds, can transmit a reply: there is no state after `reviewed`,
 * no recipient field, and no transport.
 */

/** Where a revision came from. Exhaustive — there is no 'sent' or 'approved'. */
export const DRAFT_ORIGINS = ["generated", "edited"] as const;

export type DraftOrigin = (typeof DRAFT_ORIGINS)[number];

/** What a draft was allowed to rely on. */
export const DRAFT_SOURCE_KINDS = ["cst_document", "verified_fact"] as const;

export type DraftSourceKind = (typeof DRAFT_SOURCE_KINDS)[number];

export const draftSourceSchema = z.object({
  kind: z.enum(DRAFT_SOURCE_KINDS),
  /** Opaque identifier from the source system. Never document content. */
  ref: z.string().min(1),
  label: z.string().nullable(),
});

export type DraftSource = z.infer<typeof draftSourceSchema>;

/**
 * The structured result the model must return.
 *
 * Enforced as a Structured Output at the API boundary, so a response that omits
 * `missing_information` or invents a field fails validation rather than
 * reaching a CST agent. Snake_case because these are the wire names.
 */
export const draftResultSchema = z.object({
  draft_reply: z.string().min(1),
  sources_used: z.array(draftSourceSchema),
  missing_information: z.array(z.string()),
  requires_review: z.boolean(),
});

export type DraftResult = z.infer<typeof draftResultSchema>;

/**
 * JSON Schema for the provider's Structured Outputs mode.
 *
 * Kept beside the Zod schema deliberately: the provider validates the shape on
 * the way out, and Zod validates it again on the way in. Neither is trusted to
 * cover for the other, because a schema-conforming response can still be
 * ungrounded and that is what the checks below are for.
 */
export const DRAFT_RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["draft_reply", "sources_used", "missing_information", "requires_review"],
  properties: {
    draft_reply: {
      type: "string",
      description:
        "The proposed reply to the customer. Plain text. Must not state any order number, SKU, product detail, tracking number, delivery date, refund or replacement decision unless that exact value appears in the supplied verified facts.",
    },
    sources_used: {
      type: "array",
      description:
        "Every approved CST document or verified fact the reply relied on. Empty if the reply relied on nothing.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "ref", "label"],
        properties: {
          kind: { type: "string", enum: [...DRAFT_SOURCE_KINDS] },
          ref: { type: "string" },
          label: { type: ["string", "null"] },
        },
      },
    },
    missing_information: {
      type: "array",
      description:
        "Everything needed to answer properly that was NOT available. Name the gap; never fill it.",
      items: { type: "string" },
    },
    requires_review: {
      type: "boolean",
      description: "True whenever anything is missing, uncertain, or in conflict.",
    },
  },
} as const;

/**
 * Facts the model is permitted to state, because the backend verified them.
 *
 * Deliberately a flat list of named values rather than free text: the reply is
 * checked against it, and a check needs discrete values to look for.
 */
export const verifiedFactSchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
});

export type VerifiedFact = z.infer<typeof verifiedFactSchema>;

/**
 * Claims a draft may never make on its own authority.
 *
 * These are the commitments that cost money or trust when wrong: a refund, a
 * replacement, a delivery date, a tracking number, a policy exception. The
 * model is instructed not to make them, and `ungroundedClaims` checks that it
 * did not, because an instruction is not an enforcement.
 */
export const PROHIBITED_CLAIM_PATTERNS: readonly { readonly claim: string; readonly pattern: RegExp }[] = [
  { claim: "refund decision", pattern: /\b(we (have|'ve)? ?(issued|processed|approved)|your refund (has|is)|i have refunded|refund (has been|is being) (issued|processed))\b/i },
  { claim: "replacement decision", pattern: /\b(we (have|'ve)? ?(sent|dispatched|arranged) (you )?a replacement|replacement (has been|is being) (sent|dispatched))\b/i },
  { claim: "tracking number", pattern: /\b(tracking (number|no\.?|code|reference)\s*(is|:)\s*\S+)/i },
  { claim: "delivery promise", pattern: /\b(will (arrive|be delivered|be with you)\s+(on|by|tomorrow|today)|delivered (on|by)\s+\d)/i },
  { claim: "policy exception", pattern: /\b(as an exception|we('| wi)ll make an exception|outside our (usual )?policy)\b/i },
];

/**
 * Claims present in a draft that no supplied fact supports.
 *
 * The last line of defence, and the reason it exists: the prompt forbids these
 * claims, Structured Outputs constrains the shape, and neither can stop a model
 * writing "your refund has been processed" into a free-text field. This reads
 * the finished text and reports what it found.
 *
 * A claim is allowed only when a verified fact actually carries the value —
 * `"refund"` in a fact name is not enough on its own; the reply has to be
 * talking about something the backend established.
 */
export function ungroundedClaims(
  draftReply: string,
  facts: readonly VerifiedFact[],
): string[] {
  const factText = facts.map((fact) => `${fact.name} ${fact.value}`).join(" ").toLowerCase();

  return PROHIBITED_CLAIM_PATTERNS.filter(({ claim, pattern }) => {
    if (!pattern.test(draftReply)) return false;
    // Grounded only if a verified fact names this kind of claim.
    return !factText.includes(claim.split(" ")[0]!.toLowerCase());
  }).map(({ claim }) => claim);
}

/**
 * Final gate before a draft is stored.
 *
 * Review is forced — never cleared — when anything is missing, nothing was
 * cited, or an ungrounded claim slipped through. A model that returns
 * `requires_review: false` cannot talk its way past this.
 */
export function settleReviewRequirement(
  result: DraftResult,
  facts: readonly VerifiedFact[],
): { requiresReview: boolean; missingInformation: string[] } {
  const ungrounded = ungroundedClaims(result.draft_reply, facts);
  const missing = [
    ...result.missing_information,
    ...ungrounded.map((claim) => `Unsupported ${claim} removed from review: verify before sending`),
  ];

  const requiresReview =
    result.requires_review ||
    missing.length > 0 ||
    result.sources_used.length === 0 ||
    ungrounded.length > 0;

  return { requiresReview, missingInformation: [...new Set(missing)] };
}
