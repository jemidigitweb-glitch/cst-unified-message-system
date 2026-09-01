import "server-only";

import type { VerifiedFact } from "@/lib/domain/draft";
import type { MessageCategory } from "@/lib/knowledge/message-category";
import { carrierFrom } from "@/lib/tracking/carrier";
import type { TrackingResult } from "@/lib/tracking/provider";
import { readFreshTracking, writeTracking } from "@/lib/tracking/tracking-cache";
import { getTrackingProvider } from "@/lib/tracking/tracking-service";

/**
 * Carrier tracking for a conversation, when it is warranted and available.
 *
 * THIS IS THE GATE. It is the only place that decides whether a carrier is
 * asked at all, and it is deliberately narrow on both axes:
 *
 *   the QUESTION  the conversation has to be a delivery query. Somebody
 *                 reporting a cracked lampshade is not asking where their
 *                 parcel is, and putting a scan history in front of the model
 *                 for that case adds tokens, latency and a fact the reply has
 *                 no business using.
 *   the CONTEXT   the order must already have resolved to a verified tracking
 *                 number AND a carrier we can name. Neither is ever taken from
 *                 the customer's message — a reference somebody typed is
 *                 customer-stated, and asking a carrier about it would launder
 *                 an unverified string into a verified-looking fact.
 *
 * IT NEVER THROWS AND NEVER FAILS A DRAFT. Every path out is a result or null.
 * Tracking is an enhancement to a delivery reply, not a precondition for one:
 * an unsupported carrier, an unreachable API, a refused credential and an
 * unrecognised reference all produce null, and the draft is written exactly as
 * it would have been before this existed.
 *
 * STALE IS NOT A FALLBACK. When the carrier cannot be reached, this returns
 * null rather than an expired cache entry. See `tracking-cache.ts` — a scan
 * history from an hour ago stated as the current position is the one failure
 * mode that would make this feature worse than not having it.
 */

/**
 * The one category that warrants a lookup.
 *
 * Named as a constant rather than inlined so the exclusion list in the task —
 * pre-sales, return/refund, damage, wrong item, parts missing, wrong
 * description — is enforced by construction. Anything that is not this is out,
 * including a category added to `MESSAGE_CATEGORIES` next year that nobody
 * thinks to exclude.
 */
export const TRACKING_CATEGORY: MessageCategory = "Delivery queries";

function factValue(facts: readonly VerifiedFact[], name: string): string | null {
  const value = facts.find((fact) => fact.name === name)?.value.trim();
  return value === undefined || value === "" ? null : value;
}

/** Why a lookup did not happen, for the log. Never customer text. */
export type TrackingSkipReason =
  | "not_a_delivery_query"
  | "no_tracking_number"
  | "no_carrier"
  | "carrier_not_recognised"
  | "carrier_not_supported"
  | "lookup_failed";

export type TrackingContext =
  | { readonly tracking: TrackingResult }
  | { readonly tracking: null; readonly reason: TrackingSkipReason };

/**
 * The lookup itself, with NO category gate — everything except the question.
 *
 * WHY THIS IS SEPARATE, and why the gate did not simply move or disappear. The
 * category check exists for ONE consumer: the draft. Putting a scan history in
 * front of the model on a conversation about a cracked lampshade adds tokens,
 * latency and a fact the reply has no business using, and that argument is
 * still sound — so `resolveTrackingContext` below is unchanged and the draft
 * pipeline behaves exactly as it did.
 *
 * It was never a good argument for the SIDEBAR. A reviewer answering a damage
 * claim, a wrong-item complaint or a refund request is often asking precisely
 * whether the parcel arrived and when — and hiding a verified shipment from
 * them bought nothing, because a human reading a screen costs no tokens and
 * states nothing to a customer.
 *
 * EVERY OTHER GATE IS SHARED, deliberately, by both callers reaching this one
 * function: the tracking number and courier must come from a resolved order,
 * the carrier must normalise, and the provider's own refusals — never polled,
 * one reference on two orders, an order sent in several parcels, a stale
 * non-terminal status — all still apply. The only thing display skips is the
 * question the customer happened to ask.
 */
export async function resolveVerifiedTracking(input: {
  readonly facts: readonly VerifiedFact[];
}): Promise<TrackingContext> {
  // Both come from the resolved order, never from the customer's message.
  const trackingNumber = factValue(input.facts, "tracking_number");
  if (trackingNumber === null) return { tracking: null, reason: "no_tracking_number" };

  const courier = factValue(input.facts, "delivery_courier");
  if (courier === null) return { tracking: null, reason: "no_carrier" };

  // Normalised, never matched raw — "Royal Mail 48" and "Royal Mail" are one
  // carrier, and 132,095 shipments are stored under the spellings a raw
  // comparison would miss.
  const carrier = carrierFrom(courier);
  if (carrier === null) return { tracking: null, reason: "carrier_not_recognised" };

  const provider = getTrackingProvider(carrier);
  if (provider === undefined) return { tracking: null, reason: "carrier_not_supported" };

  const cached = readFreshTracking(carrier, trackingNumber);
  if (cached !== undefined) return { tracking: cached };

  try {
    const result = await provider.track({ carrier, trackingNumber });
    writeTracking(result);
    return { tracking: result };
  } catch (cause) {
    /*
     * EVERY failure lands here, and every one of them is the same answer: no
     * tracking. Not an expired entry, not a partial result, not an error to the
     * reviewer — the draft proceeds without this block, which is what it did
     * before the feature existed.
     *
     * The carrier's own message never reaches a log line here: it can quote the
     * request, and the request contains a real consignment reference.
     */
    console.warn(
      `[tracking] lookup failed for ${carrier}: ${(cause as Error).name ?? "error"}`,
    );
    return { tracking: null, reason: "lookup_failed" };
  }
}

/**
 * The draft's entry point: the category gate, then the shared lookup.
 *
 * UNCHANGED. Same signature, same first check, same result for every input it
 * has ever been given. The body below it moved into `resolveVerifiedTracking`
 * so display could reach it without the gate — sharing the code is what stops
 * the two paths' safety rules drifting apart, which is the failure a second
 * copy of this function would eventually produce.
 */
export async function resolveTrackingContext(input: {
  readonly category: MessageCategory | null;
  readonly facts: readonly VerifiedFact[];
}): Promise<TrackingContext> {
  if (input.category !== TRACKING_CATEGORY) {
    return { tracking: null, reason: "not_a_delivery_query" };
  }
  return resolveVerifiedTracking({ facts: input.facts });
}
