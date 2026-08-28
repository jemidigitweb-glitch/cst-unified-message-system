import { createHash } from "node:crypto";

import type { Carrier } from "./carrier";
import type { TrackingResult } from "./provider";

/**
 * A short-lived cache for carrier lookups.
 *
 * WHY CACHE AT ALL. A reviewer opening the same delivery conversation three
 * times in a minute should not cost three carrier calls, and a carrier that
 * rate-limits will start refusing if we let them.
 *
 * WHY IT IS SMALL AND IN MEMORY. Tracking is a fact about the outside world
 * that changes on its own. A durable store would need invalidation, migration
 * and a staleness policy of its own, and it would hold consignment references
 * belonging to real people. A process-lifetime map needs none of that: it is
 * empty on restart, which is the correct default for data whose whole value is
 * being recent.
 *
 * WHAT IS STORED, AND WHAT IS DELIBERATELY NOT.
 *
 *   stored      carrier, the retrieval time, the source, and the scan history.
 *   not stored  the tracking reference itself, any customer message, any name,
 *               address or order.
 *
 * The KEY IS A HASH, and the reference is stripped from the stored value and
 * re-attached from the caller's own input on the way out. So the cache holds no
 * recoverable consignment reference: an operator reading a heap dump learns
 * that some parcel was delivered, not whose.
 *
 * THE STALENESS RULE, which is the one that matters. An expired entry is not a
 * fallback. When the carrier cannot be reached, this returns nothing at all —
 * it never hands back yesterday's "Delivered" for a draft to state as the
 * current position. A stale fact presented as a current one is exactly the
 * failure the whole grounding design exists to prevent, and it is worse here
 * than elsewhere because the customer can see the parcel and we cannot.
 */

/** How long a result stays usable. Tracking moves a few times a day. */
export const DEFAULT_TRACKING_TTL_MS = 15 * 60_000;

export const TRACKING_TTL_VAR = "TRACKING_CACHE_TTL_SECONDS";

export function trackingTtlMs(): number {
  const raw = process.env[TRACKING_TTL_VAR]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_TRACKING_TTL_MS;
  const seconds = Number.parseInt(raw, 10);
  // An unusable value falls back rather than disabling the cache or making it
  // eternal — a typo in a tuning knob must not change correctness.
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86_400) {
    return DEFAULT_TRACKING_TTL_MS;
  }
  return seconds * 1_000;
}

/** What is held per consignment. Carries no reference and no personal data. */
type Entry = {
  readonly carrier: Carrier;
  /** The result WITHOUT its tracking number. Re-attached on read. */
  readonly result: Omit<TrackingResult, "trackingNumber">;
  readonly retrievedAt: number;
};

const entries = new Map<string, Entry>();

/**
 * The cache key.
 *
 * SHA-256 over carrier and reference. Not a security boundary — a tracking
 * number is low-entropy and could be brute-forced by anyone with the map — but
 * it means the reference is not sitting in memory in plain form for the sake of
 * being a key, which costs one hash and is simply the better default.
 */
function keyFor(carrier: Carrier, trackingNumber: string): string {
  return createHash("sha256").update(`${carrier}:${trackingNumber.trim()}`).digest("hex");
}

/**
 * A result that is still fresh, or undefined.
 *
 * Undefined covers both "never looked up" and "looked up too long ago", and
 * the caller must treat them identically: go and ask the carrier. An expired
 * entry is dropped on the way past rather than left to accumulate.
 */
export function readFreshTracking(
  carrier: Carrier,
  trackingNumber: string,
  now: number = Date.now(),
): TrackingResult | undefined {
  const key = keyFor(carrier, trackingNumber);
  const entry = entries.get(key);
  if (entry === undefined) return undefined;

  if (now - entry.retrievedAt >= trackingTtlMs()) {
    entries.delete(key);
    return undefined;
  }

  return {
    ...entry.result,
    trackingNumber: trackingNumber.trim(),
    // The status is unchanged; how we came by it is not. A reviewer reading
    // "Delivered" needs to know whether that was a moment ago or a quarter of
    // an hour ago, and no wording in the status itself can tell them.
    source: { ...entry.result.source, retrieval: "cached" },
  };
}

/** Records a live result. Strips the reference before storing it. */
export function writeTracking(
  result: TrackingResult,
  now: number = Date.now(),
): void {
  const { trackingNumber, ...withoutReference } = result;
  entries.set(keyFor(result.carrier, trackingNumber), {
    carrier: result.carrier,
    result: withoutReference,
    retrievedAt: now,
  });
}

/** Empties the cache. For tests, and for anyone who needs a clean read. */
export function forgetTracking(): void {
  entries.clear();
}

/** How many consignments are held. For tests and diagnostics only. */
export function trackingCacheSize(): number {
  return entries.size;
}
