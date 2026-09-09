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
 * A remedy this team can agree to in a conversation.
 *
 * Deliberately a closed, two-value vocabulary. It exists to answer one narrow
 * question — "did a colleague already offer this and did the customer say yes"
 * — and every value has to be recognisable from an offer, from an acceptance
 * and from the claim it grounds. A longer list would be guesswork at all three.
 *
 * ONLY `replacement` GROUNDS ANYTHING TODAY, and that is worth saying plainly so
 * nobody reads this list as a statement about what is permitted. Grounding is
 * decided entirely by the `commitment` field in `PROHIBITED_CLAIM_PATTERNS`, and
 * one pattern carries it. An accepted refund offer is recognised here and
 * changes no outcome — the refund patterns below all describe a refund already
 * ISSUED, which no agreement can establish.
 */
export const COMMITMENT_KINDS = ["replacement", "refund"] as const;

export type CommitmentKind = (typeof COMMITMENT_KINDS)[number];

/**
 * One turn of the thread, reduced to what a commitment reading needs.
 *
 * A structural type rather than `ConversationMessageView`, so this module stays
 * free of the inbox contract and of `displayBody`. The caller decides what
 * "readable" means and passes null for anything that is not — see
 * `threadCommitments` in `lib/ai/draft-validation.ts`.
 */
export type CommitmentTurn = {
  readonly direction: "inbound" | "outbound";
  readonly text: string | null;
};

/**
 * An outbound message PUTTING SOMETHING TO THE CUSTOMER rather than mentioning it.
 *
 * The construction is required, and it is what keeps this honest. "We are
 * unable to send a replacement for an item outside the returns window" names
 * the remedy and offers nothing; "would you be happy for us to resend the item"
 * is the offer. Without an offer construction the remedy word alone would make
 * every refusal read as an agreement.
 */
const OFFER_CONSTRUCTION =
  /\b(?:would\s+you\s+(?:be\s+happy|like|prefer|want|rather)|do\s+you\s+want|shall\s+(?:we|i)|(?:can|could|shall)\s+(?:we|i)\s+|we\s+(?:can|could)\b|(?:we|i)\s+(?:would\s+be|am|are)\s+happy\s+to|happy\s+to\s+(?:arrange|send|resend|offer|issue)|let\s+us\s+know\s+if\s+you|if\s+you(?:'d|\s+would)\s+like|m(?:ö|oe)chten\s+sie|sollen\s+wir|wir\s+k(?:ö|oe)nnen)\b/i;

/** The remedy an offer names, per commitment kind. */
const OFFERED_REMEDY: Readonly<Record<CommitmentKind, RegExp>> = {
  replacement:
    /\b(?:re-?sen[dt]\w*|replac\w*|send\s+(?:you\s+)?(?:a\s+|an\s+)?(?:new|another|replacement)|send\s+(?:it|them|this|these|one)\s+(?:out\s+)?again|ersatz\w*|nachsend\w*|erneut\s+(?:senden|schicken|zusenden))\b/i,
  refund: /\b(?:refund\w*|money\s+back|reimburs\w*|r(?:ü|ue)ckerstatt\w*|erstatt\w*)\b/i,
};

/**
 * The customer saying yes.
 *
 * TWO SHAPES, because acceptance arrives as both. A bare affirmative ("yes
 * please", "go ahead", "that's fine") carries no remedy word and is only
 * meaningful against the offer it answers — which is why this is never read on
 * its own, only after an offer has been seen. A restated request ("yes please
 * resend asap") carries both, and matches here on the affirmative.
 *
 * A QUESTION IS NOT AN ACCEPTANCE. "Yes, but how long will that take?" is a
 * question about the offer; treating it as agreement would have the draft
 * confirm something the customer has not yet said yes to.
 */
const ACCEPTANCE_WORDING =
  /\b(?:yes|yeah|yep|please\s+do|please\s+(?:re-?send|send|arrange|proceed)|go\s+ahead|that(?:'s| is)\s+fine|that\s+works|sounds\s+good|(?:i|we)(?:'d| would)\s+like\s+(?:that|this|a|the)|happy\s+with\s+that|agreed|ok(?:ay)?\s+(?:please|then|do)|ja\b|gerne|bitte\s+(?:ja|machen|senden)|einverstanden)\b/i;

/**
 * Whether the customer said yes anywhere in this message.
 *
 * READ PER SENTENCE, NOT PER MESSAGE, and the difference is a real reply: "Yes
 * please resend asap. How long will it take?" both accepts the offer and asks a
 * question. Judging the message by its last character would discard the
 * acceptance because of the question that follows it, which is the opposite of
 * what the customer said. So a question sentence is skipped and the rest are
 * still read — "Yes but how long would a resend take?" is one sentence, and one
 * question, and accepts nothing.
 */
function acceptsTheOffer(text: string): boolean {
  return text
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "" && !sentence.endsWith("?"))
    .some((sentence) => ACCEPTANCE_WORDING.test(sentence));
}

/**
 * The remedies this team has already offered and the customer has accepted.
 *
 * WHY THIS EXISTS. The grounding rule is that only the verified context is
 * verified, and that is right about the world — but it was also being applied
 * to decisions THIS TEAM had already taken. A colleague wrote "would you be
 * happy for us to resend the item for you?", the customer wrote "yes please
 * resend asap", and the draft refused, because a resend appears in no verified
 * fact and never will: no backend row records an offer a human made in a
 * message. The agreement is in the thread or it is nowhere.
 *
 * ORDER MATTERS AND IS ENFORCED. An acceptance only counts for offers made
 * BEFORE it, so a customer asking for a resend that we later declined does not
 * come out as agreed. Where several remedies were offered before an acceptance,
 * all of them are treated as accepted: "yes please" to a message offering a
 * resend or a refund does not say which, and the draft must be free to carry
 * either forward rather than refusing both.
 *
 * PURE, AND IT ESTABLISHES A DECISION — NEVER AN OUTCOME. What it returns says
 * that we agreed to do something, not that it has been done. `ungroundedClaims`
 * keeps that distinction: see the two replacement patterns below.
 */
export function acceptedCommitments(
  turns: readonly CommitmentTurn[],
): CommitmentKind[] {
  const offered = new Set<CommitmentKind>();
  const accepted = new Set<CommitmentKind>();

  for (const turn of turns) {
    const text = turn.text?.trim();
    if (text === undefined || text === "") continue;

    if (turn.direction === "outbound") {
      if (!OFFER_CONSTRUCTION.test(text)) continue;
      for (const kind of COMMITMENT_KINDS) {
        if (OFFERED_REMEDY[kind].test(text)) offered.add(kind);
      }
      continue;
    }

    if (offered.size === 0) continue;
    if (!acceptsTheOffer(text)) continue;
    for (const kind of offered) accepted.add(kind);
  }

  return [...accepted];
}

/**
 * Claims a draft may never make on its own authority.
 *
 * These are the commitments that cost money or trust when wrong: a refund, a
 * replacement, a delivery date, a tracking number, a policy exception. The
 * model is instructed not to make them, and `ungroundedClaims` checks that it
 * did not, because an instruction is not an enforcement.
 *
 * `commitment` NAMES THE ONE THING A THREAD CAN GROUND, and exactly one pattern
 * carries it. A decision this team took with the customer is established by the
 * conversation; what happened afterwards in a warehouse or on a card is not,
 * and never becomes so however clearly the two of them agreed. So "we have
 * arranged a replacement" — the sentence that carries out an agreed resend —
 * is groundable, and "we have dispatched a replacement" is not.
 */
export const PROHIBITED_CLAIM_PATTERNS: readonly {
  readonly claim: string;
  readonly pattern: RegExp;
  /** Groundable by an accepted commitment of this kind. Absent: verified fact only. */
  readonly commitment?: CommitmentKind;
}[] = [
  { claim: "refund decision", pattern: /\b(we (have|'ve)? ?(issued|processed|approved)|your refund (has|is)|i have refunded|refund (has been|is being) (issued|processed))\b/i },
  /*
   * COMPLETION. Unchanged in wording except that `arranged` has moved to the
   * entry below: these say the goods left us, which only the backend can
   * establish. An accepted offer cannot ground them and is not offered the
   * chance to.
   */
  { claim: "replacement decision", pattern: /\b(we (have|'ve)? ?(sent|dispatched) (you )?a replacement|replacement (has been|is being) (sent|dispatched))\b/i },
  /*
   * THE AGREED ACTION, CARRIED OUT. Split out of the pattern above, where it
   * was indistinguishable from a claim that the parcel had gone. "We have
   * arranged a replacement" is the correct confirmation of a resend this team
   * offered and the customer accepted — and with no such agreement it is still
   * exactly what it was before: an unsupported commitment, blocked.
   */
  {
    claim: "replacement arrangement",
    pattern: /\b(we (have|'ve)? ?arranged (you )?a replacement|replacement (has been|is being) arranged|arranging (you )?a replacement)\b/i,
    commitment: "replacement",
  },
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
 *
 * `commitments` IS THE SECOND WAY TO BE GROUNDED, and it grounds strictly less
 * than the facts do: only the patterns that name a `commitment` can use it, and
 * only for the kind that was actually agreed. Defaulted to empty, so every
 * caller that does not pass a thread behaves exactly as it did before this
 * existed.
 */
export function ungroundedClaims(
  draftReply: string,
  facts: readonly VerifiedFact[],
  commitments: readonly CommitmentKind[] = [],
): string[] {
  const factText = facts.map((fact) => `${fact.name} ${fact.value}`).join(" ").toLowerCase();
  const agreed = new Set(commitments);

  return PROHIBITED_CLAIM_PATTERNS.filter(({ claim, pattern, commitment }) => {
    if (!pattern.test(draftReply)) return false;
    // Grounded by an agreement this team reached with this customer in the
    // thread — available only to a pattern that names a commitment kind.
    if (commitment !== undefined && agreed.has(commitment)) return false;
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
 *
 * `commitments` is passed straight through to `ungroundedClaims` and can only
 * ever REMOVE a finding about a remedy this team already agreed. It cannot
 * clear review on its own: every other reason above is untouched, and a draft
 * carrying out an agreed resend still reaches a human like all the others.
 */
export function settleReviewRequirement(
  result: DraftResult,
  facts: readonly VerifiedFact[],
  commitments: readonly CommitmentKind[] = [],
): { requiresReview: boolean; missingInformation: string[] } {
  const ungrounded = ungroundedClaims(result.draft_reply, facts, commitments);
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
