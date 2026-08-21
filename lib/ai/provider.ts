import type { DraftResult, VerifiedFact } from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";

/**
 * The AI draft layer, stated independently of any vendor.
 *
 * WHAT THIS BOUNDARY IS FOR. Everything above it — the route, the workflow, the
 * repositories, the review UI — must not know or care which model wrote a
 * draft. Everything below it is one vendor's HTTP shape. The previous design
 * leaked: the route imported `GeminiUnavailable` by name, so the API surface
 * mentioned a supplier in a file that has no business naming one.
 *
 * WHAT A PROVIDER OWNS. How it reaches the CST knowledge base. That is the real
 * difference between them and the reason this is an interface rather than a
 * config switch:
 *
 *   openai  the knowledge lives in a vector store; File Search retrieves the
 *           relevant part per request. Nothing bulk is sent.
 *   gemini  no retrieval service, so the corpus is rendered and sent inline —
 *           ~127,000 tokens every call.
 *
 * Both are asked for identical BEHAVIOUR (see `instructions.ts`) and both must
 * return the identical validated shape. A caller cannot tell them apart except
 * by the `provider` field on the outcome, which exists for the record rather
 * than for branching.
 */

export type DraftRequest = {
  readonly messages: readonly ConversationMessageView[];
  /** The marketplace this conversation arrived on. Never guessed. */
  readonly marketplace: string | null;
  /** The marketplace's own listing reference, when the source recorded one. */
  readonly listingItemRef: string | null;
  /** Backend facts established outside the model. Empty is normal today. */
  readonly facts: readonly VerifiedFact[];
};

/**
 * What one generation consumed.
 *
 * Reported by the provider rather than estimated by the caller: only the
 * provider knows what the retrieval step actually pulled in, and a count we
 * guessed would be worse than no count at all. Undefined when a provider does
 * not return usage — recorded as unknown rather than as zero.
 */
export type DraftUsage = {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
};

export type DraftOutcome = {
  readonly result: DraftResult;
  /** Token usage for this call, when the provider reported it. */
  readonly usage?: DraftUsage;
  readonly requiresReview: boolean;
  readonly missingInformation: readonly string[];
  readonly model: string;
  readonly provider: ProviderName;
  /**
   * Whether the provider could reach the CST knowledge base at all.
   *
   * False means the draft was written in restricted mode and states no policy.
   * Kept distinct from "cited nothing": a draft can have knowledge available
   * and still fail to cite, and those two need different responses.
   */
  readonly knowledgeAvailable: boolean;
  /** Why the knowledge base was unreachable, when it was. */
  readonly knowledgeReason?: string;
};

export const PROVIDER_NAMES = ["openai", "gemini"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface DraftProvider {
  readonly name: ProviderName;
  readonly model: string;
  generate(request: DraftRequest): Promise<DraftOutcome>;
}

/**
 * Raised when no provider is configured at all.
 *
 * Distinct from `DraftServiceUnavailable`, which means "configured, but the
 * call failed". An operator fixes those two in completely different places, so
 * the error says which one it is and names what to set.
 */
export class DraftServiceNotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftServiceNotConfigured";
  }
}

/**
 * Raised when a configured provider could not produce a draft.
 *
 * The message is OUR wording, never the vendor's: a provider error can quote
 * the request back, and the request contains customer messages.
 */
export class DraftServiceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftServiceUnavailable";
  }
}

/** Raised when generation cannot proceed at all. Never swallowed to fabricate a draft. */
export class DraftGenerationUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DraftGenerationUnavailable";
  }
}

/**
 * Turns a provider HTTP status into something a reviewer can act on.
 *
 * Shared, because these situations are the same whoever is answering: quota,
 * a refused key, a missing model, an outage. "The draft service rejected the
 * request" is true of all four and useful for none of them.
 *
 * The vendor's own text is never returned — only a retry delay is lifted out of
 * it, because that is the one part a reviewer can use and it names no one.
 */
export function describeFailure(status: number, providerMessage?: string): string {
  if (status === 429) {
    const seconds = /(?:retry in|try again in)\s*(\d+)/i.exec(providerMessage ?? "")?.[1];
    return seconds
      ? `The draft service has reached its usage limit. Try again in about ${seconds} seconds.`
      : "The draft service has reached its usage limit. Try again shortly.";
  }
  if (status === 401 || status === 403) {
    return "The draft service refused the API key. Check the server configuration.";
  }
  if (status === 404) {
    return "The configured model is not available. Check the server configuration.";
  }
  if (status === 400) {
    return "The draft service rejected the request as malformed.";
  }
  if (status >= 500) {
    return "The draft service is temporarily unavailable. Try again shortly.";
  }
  return "The draft service rejected the request.";
}
