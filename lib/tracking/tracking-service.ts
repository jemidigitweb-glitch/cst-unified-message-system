import "server-only";

import { type Carrier, CARRIER_LABELS, carrierFrom } from "./carrier";
import {
  type TrackingProvider,
  type TrackingRequest,
  type TrackingResult,
  TrackingNotConfigured,
} from "./provider";
import { royalMailProvider } from "./royal-mail-provider";

/**
 * Which provider answers a tracking lookup.
 *
 * ONE PLACE MAKES THIS CHOICE, the same shape as `lib/ai/draft-service.ts`:
 * callers ask for "the provider for this carrier" and get one or get nothing.
 * No caller names Royal Mail, so adding a second carrier later is an edit to
 * this file rather than to every call site.
 *
 * SERVER-ONLY. `server-only` makes importing this from a client component a
 * build error, which is what will keep carrier credentials out of the browser
 * bundle once there are any.
 *
 * REGISTERED IS NOT THE SAME AS CONNECTED. Royal Mail appears below, and it
 * still cannot answer: it has no endpoint and, in most environments, no
 * credentials. Registering it anyway is what lets `trackingStatus` say "Royal
 * Mail is the provider for this carrier and it is not usable yet, here is what
 * is missing" rather than the indistinguishable "no provider exists for Royal
 * Mail". Those are different problems with different fixes, and an operator
 * needs to be told which one they have.
 *
 * WHAT CONNECTING ANOTHER CARRIER INVOLVES, so the next person is not guessing:
 *
 *   1. A module exporting a `TrackingProvider` for that carrier, reading its
 *      credentials through `lib/config/env.ts` — the pattern
 *      `royal-mail-provider.ts` now follows.
 *   2. Its own mapping from the carrier's status words onto `TrackingStatus`,
 *      living with that provider.
 *   3. One entry in `PROVIDERS` below.
 *
 * Nothing above this file changes when that happens.
 */

/**
 * The registered providers.
 *
 * One entry, and it is not yet able to answer. See the note above.
 */
const PROVIDERS: readonly TrackingProvider[] = [royalMailProvider];

const NOT_CONFIGURED_REASON =
  "No carrier tracking provider is connected. Tracking is not available for this carrier yet.";

/** Whether a carrier can be asked, and by what. Carries no credential. */
export type TrackingProviderStatus =
  | { readonly configured: true; readonly carrier: Carrier; readonly provider: string }
  | { readonly configured: false; readonly reason: string };

/** The provider for a carrier, or undefined when none is registered. */
export function getTrackingProvider(carrier: Carrier): TrackingProvider | undefined {
  return PROVIDERS.find((provider) => provider.carrier === carrier);
}

/**
 * The provider for a stored courier string, or undefined.
 *
 * The convenience most callers actually want: they hold `delivery_courier` from
 * the order context, which is a service name rather than a carrier id. An
 * unrecognised string yields undefined rather than a nearest match — see
 * `carrierFrom`.
 */
export function getTrackingProviderFor(
  storedCourier: string | null | undefined,
): TrackingProvider | undefined {
  const carrier = carrierFrom(storedCourier);
  return carrier === null ? undefined : getTrackingProvider(carrier);
}

/**
 * Reports configuration without opening a connection.
 *
 * Deliberately carries no credential and no way to derive one, so a route
 * handler or a log line can use it safely.
 */
export function trackingStatus(carrier: Carrier): TrackingProviderStatus {
  const provider = getTrackingProvider(carrier);
  return provider === undefined
    ? {
        configured: false,
        reason: `${NOT_CONFIGURED_REASON} Asked for ${CARRIER_LABELS[carrier]}.`,
      }
    : { configured: true, carrier, provider: provider.name };
}

/** Every carrier that can currently be asked. Empty until one is registered. */
export function connectedCarriers(): readonly Carrier[] {
  return PROVIDERS.map((provider) => provider.carrier);
}

/**
 * One lookup, or a clear reason why not.
 *
 * FAILS RATHER THAN INVENTS. With no provider registered this always throws
 * `TrackingNotConfigured`, and that is the correct behaviour for the state this
 * system is in. Returning an empty `TrackingResult` instead would hand callers
 * a shape that looks like an answer — `currentStatus: "unknown"`, no events —
 * and the whole grounding design of this application rests on absent context
 * being distinguishable from established context.
 */
export function trackConsignment(request: TrackingRequest): Promise<TrackingResult> {
  const provider = getTrackingProvider(request.carrier);
  if (provider === undefined) {
    return Promise.reject(
      new TrackingNotConfigured(
        `${NOT_CONFIGURED_REASON} Asked for ${CARRIER_LABELS[request.carrier]}.`,
      ),
    );
  }
  return provider.track(request);
}
