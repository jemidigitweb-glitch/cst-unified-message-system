import "server-only";

import { getGeminiProvider } from "./gemini-provider";
import { getOpenAiProvider } from "./openai-client";
import { type DraftProvider, DraftServiceNotConfigured, type ProviderName } from "./provider";
import { withDraftValidation } from "./validated-draft-provider";

/**
 * Which provider answers a draft request.
 *
 * ONE PLACE MAKES THIS CHOICE. The route asks for "the draft provider" and gets
 * one; it does not know or name a vendor. That is what makes the next migration
 * an edit to this file rather than an edit to the API surface.
 *
 * ORDER OF PREFERENCE, and why:
 *
 *   1. DRAFT_PROVIDER, when set. An explicit override beats inference — an
 *      operator comparing the two, or rolling back a migration, should not have
 *      to unset a credential to change which one runs.
 *   2. OpenAI, when configured. It is the primary path: the CST knowledge lives
 *      in a vector store and File Search retrieves per conversation, instead of
 *      ~127,000 tokens of rules travelling with every request.
 *   3. Gemini, when configured. The fallback, and still the only path that puts
 *      every rule in front of the model with no retrieval step in between.
 *
 * Configuration is read on EVERY call. Nothing is memoised, so a rotated key or
 * a changed provider takes effect on the next draft rather than the next
 * restart — a lesson that cost two debugging sessions when a cached Gemini key
 * made a stale credential's 429 look like a provider quota problem.
 */

export const DRAFT_PROVIDER_VAR = "DRAFT_PROVIDER";

const NOT_CONFIGURED_REASON =
  "No AI provider is configured: set OPENAI_API_KEY (with OPENAI_VECTOR_STORE_ID) " +
  "or GEMINI_API_KEY in the server environment. These are server-side only and " +
  "must never be prefixed with NEXT_PUBLIC_.";

/** Whether a provider is available, and which. Carries no credential. */
export type ProviderStatus =
  | { readonly configured: true; readonly provider: ProviderName; readonly model: string }
  | { readonly configured: false; readonly reason: string };

function requested(): ProviderName | undefined {
  const raw = process.env[DRAFT_PROVIDER_VAR]?.trim().toLowerCase();
  if (raw === "openai" || raw === "gemini") return raw;
  return undefined;
}

/**
 * The configured provider, or undefined when none is.
 *
 * An explicit `DRAFT_PROVIDER` that is set but unusable returns undefined
 * rather than silently falling through to the other one. Quietly running the
 * provider an operator did not choose is how a comparison run produces numbers
 * for the wrong model.
 */
export function getDraftProvider(): DraftProvider | undefined {
  const preference = requested();
  const chosen =
    preference === "openai"
      ? getOpenAiProvider()
      : preference === "gemini"
        ? getGeminiProvider()
        : (getOpenAiProvider() ?? getGeminiProvider());

  /**
   * THE ACCURACY GATE IS NOT OPTIONAL, and it is applied here rather than in
   * the route.
   *
   * Every caller asking for "the draft provider" gets a gated one, so there is
   * no path that reaches a model without the check — adding a provider later
   * does not mean remembering to gate it. The wrapper reports the same `name`
   * and `model` as what it wraps, so selection, status and usage accounting are
   * unaffected; see `lib/ai/validated-draft-provider.ts`.
   */
  return chosen === undefined ? undefined : withDraftValidation(chosen);
}

/**
 * Reports configuration without opening a connection or spending a token.
 *
 * Deliberately carries no key and no way to derive one, so a route handler or a
 * log line can use it safely.
 */
export function draftProviderStatus(): ProviderStatus {
  let provider: DraftProvider | undefined;
  try {
    provider = getDraftProvider();
  } catch (cause) {
    // Thrown when a key is present but unusable (blank, placeholder). The
    // message names the variable, never the value.
    return { configured: false, reason: (cause as Error).message };
  }
  return provider === undefined
    ? { configured: false, reason: NOT_CONFIGURED_REASON }
    : { configured: true, provider: provider.name, model: provider.model };
}

/** The provider, or a clear configuration error naming what to set. */
export function requireDraftProvider(): DraftProvider {
  const provider = getDraftProvider();
  if (provider === undefined) {
    const status = draftProviderStatus();
    throw new DraftServiceNotConfigured(
      status.configured ? NOT_CONFIGURED_REASON : status.reason,
    );
  }
  return provider;
}
