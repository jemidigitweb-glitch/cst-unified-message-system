import "server-only";

import {
  ROYAL_MAIL_TOKEN_URL_VAR,
  royalMailConfig,
  royalMailMissingVars,
} from "@/lib/config/env";

import type {
  TrackingEvent,
  TrackingProvider,
  TrackingRequest,
  TrackingResult,
  TrackingStatus,
} from "./provider";
import { TrackingNotConfigured, TrackingNotFound, TrackingUnavailable } from "./provider";

/**
 * Royal Mail tracking.
 *
 * THREE STAGES, split where the failures differ:
 *
 *   authenticate()     credentials -> the headers a request must carry
 *   requestTracking()  those headers + a reference -> the carrier's own JSON
 *   mapResponse()      the carrier's own JSON -> `TrackingResult`
 *
 * WHY SPLIT THERE. Those three fail for entirely different reasons and are
 * fixed in different places. A revoked client secret, a carrier outage and a
 * response field that changed name all present as "tracking is broken" when
 * they share one function, and the first hour of every such incident goes on
 * working out which one it is. Split, the stack trace says so — and that is not
 * theoretical: a wrong token endpoint surfaced as `royal_mail auth 404`, which
 * named the stage and pointed straight at the cause.
 *
 * THE ENDPOINTS, AND HOW FAR THEY ARE ESTABLISHED.
 *
 *   tracking   `https://api.royalmail.net/mailpieces/v2/{id}/events`, confirmed
 *              against a working third-party client for this product.
 *   auth       BY HEADER, not by token exchange. `X-IBM-Client-Id` and
 *              `X-IBM-Client-Secret`, issued when an application is registered
 *              on Royal Mail's developer portal. There is no token endpoint to
 *              call, which is why the default path makes no auth request at all.
 *
 * Both remain overridable by environment variable. The response SHAPE is still
 * unverified against a live payload — see `RoyalMailTrackingResponse`.
 *
 * CARRIER MATCHING IS NORMALISED, NEVER RAW. This provider declares
 * `carrier: "royal_mail"` and nothing else. The four stored spellings — "Royal
 * Mail", "Royal Mail 48", "Royal Mail 24", "Royal Mail 1st Class", together
 * 214,165 live shipments — are collapsed by `carrierFrom` before selection ever
 * reaches here. No string comparison against a stored courier value appears in
 * this file, which is what stops a fifth spelling from silently going untracked.
 *
 * NOT WIRED TO DRAFT GENERATION. A tracking result would be a verified fact,
 * and a verified fact may be stated to a customer. That connection waits for a
 * live provider whose freshness and failure modes are known.
 */

/** The provider's name, recorded on every result's `source`. */
export const ROYAL_MAIL_PROVIDER_NAME = "royal_mail_tracking_api";

/**
 * A token obtained from Royal Mail, once `authenticate` is real.
 *
 * The expiry travels with it so the caller can tell a token it may reuse from
 * one it must replace. Kept in memory by whoever holds it and never written
 * down: a stored bearer token is a credential.
 */
export type RoyalMailToken = {
  readonly accessToken: string;
  /** When the token stops working, as the carrier stated it. */
  readonly expiresAt: string;
};

/* ------------------------------------------------------------------------- *
 * THE CARRIER'S OWN SHAPE
 * ------------------------------------------------------------------------- */

/**
 * The response this maps FROM.
 *
 * UNVERIFIED AGAINST A LIVE RESPONSE, and that has to be said plainly. These
 * field names follow Royal Mail's published Tracking API shape — a `mailPieces`
 * object carrying a `summary` and an `events` array — but nobody here has seen
 * a real payload, and a schema written from documentation is a hypothesis. The
 * mapper below is therefore written to be TOTAL: every field is optional, and
 * anything absent or unrecognised produces a stated-unknown rather than a
 * throw. Confirming this shape against a sandbox response is the first task
 * when credentials arrive.
 */
export type RoyalMailTrackingResponse = {
  readonly mailPieces?: {
    readonly mailPieceId?: string;
    readonly summary?: {
      readonly lastEventDateTime?: string;
      readonly lastEventName?: string;
      readonly lastEventLocationName?: string;
      readonly statusDescription?: string;
      /** The coarse bucket this maps on. See `STATUS_CATEGORIES`. */
      readonly statusCategory?: string;
    };
    readonly events?: readonly {
      readonly eventCode?: string;
      readonly eventName?: string;
      readonly eventDateTime?: string;
      readonly locationName?: string;
    }[];
  };
};

/**
 * Royal Mail's status buckets, mapped onto ours.
 *
 * ALSO UNVERIFIED. These are the categories the published documentation
 * describes; the exact strings must be checked against live responses, and
 * `statusFrom` defaults to `"unknown"` for anything not listed rather than
 * guessing at the nearest. That default is the safety property: an unmapped
 * Royal Mail status becomes "we do not know", never "delivered".
 *
 * Matching is case-insensitive and space-insensitive because a carrier that
 * writes "IN TRANSIT" in one release and "In Transit" in the next should not
 * silently start returning unknown for every parcel in the country.
 */
const STATUS_CATEGORIES: Readonly<Record<string, TrackingStatus>> = {
  presubmission: "pre_transit",
  pending: "pre_transit",
  intransit: "in_transit",
  outfordelivery: "out_for_delivery",
  delivered: "delivered",
  attempteddelivery: "attempted_delivery",
  awaitingcollection: "awaiting_collection",
  returned: "returned_to_sender",
  returnedtosender: "returned_to_sender",
  undeliverable: "exception",
  redirected: "exception",
};

function normaliseCategory(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

/** One Royal Mail status bucket as a `TrackingStatus`. Unmapped means unknown. */
export function statusFrom(category: string | undefined): TrackingStatus {
  if (category === undefined || category.trim() === "") return "unknown";
  return STATUS_CATEGORIES[normaliseCategory(category)] ?? "unknown";
}

/* ------------------------------------------------------------------------- *
 * THE THREE STAGES
 * ------------------------------------------------------------------------- */

/** The message naming exactly which variables are missing. Never a value. */
function notConfigured(): TrackingNotConfigured {
  const missing = royalMailMissingVars();
  return new TrackingNotConfigured(
    `Royal Mail tracking is not configured: set ${missing.join(", ")} in the server environment. These are server-side only and must never be prefixed with NEXT_PUBLIC_.`,
  );
}

/**
 * How long either call may take before it is abandoned.
 *
 * A reviewer is waiting behind this. A carrier that has not answered in ten
 * seconds is not going to answer usefully, and holding the request open longer
 * turns one slow carrier into a slow page.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * How early a token is treated as expired.
 *
 * A token that expires while the tracking request is in flight fails as a 401,
 * which reads like a bad credential. Retiring it a minute early costs one extra
 * token call an hour and removes that whole class of confusing failure.
 */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

/**
 * The injected network call.
 *
 * The seam the tests use. Defaulting to the global `fetch` keeps every caller
 * unchanged, while a test supplies its own and no request leaves the machine —
 * the alternative, monkey-patching a global, leaks between test files.
 */
export type RoyalMailFetch = typeof globalThis.fetch;

/**
 * The token, held in memory only.
 *
 * NEVER WRITTEN DOWN. A bearer token is a credential: it is not persisted, not
 * logged, and not returned through any error. It lives for the life of the
 * process and is replaced when it nears expiry.
 *
 * Keyed by client id so a rotated credential cannot serve a token minted for
 * the previous one — the staleness bug that cost two debugging sessions on the
 * Gemini side, where a cached key made a stale credential's 429 look like a
 * quota problem.
 */
let cachedToken: { readonly forClientId: string; readonly token: RoyalMailToken } | undefined;

/** Drops any cached token. For tests, and for a credential rotation. */
export function forgetRoyalMailToken(): void {
  cachedToken = undefined;
}

function tokenIsUsable(entry: typeof cachedToken, clientId: string): boolean {
  if (entry === undefined || entry.forClientId !== clientId) return false;
  const expiresAt = Date.parse(entry.token.expiresAt);
  // An unparseable expiry is treated as expired rather than as forever.
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - TOKEN_SAFETY_MARGIN_MS > Date.now();
}

/**
 * One request, with a timeout, reporting only what is safe to report.
 *
 * LOGS CARRIER, STATUS AND TIMING — nothing else. No credential, no token, no
 * consignment reference, no customer data. A tracking number identifies a real
 * parcel belonging to a real person, so it stays out of the log even though it
 * would be convenient in one.
 */
async function send(
  fetchImpl: RoyalMailFetch,
  stage: "auth" | "tracking",
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = performance.now();

  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const durationMs = Math.round(performance.now() - startedAt);
    console.info(`[tracking] royal_mail ${stage} ${response.status} in ${durationMs}ms`);

    // A gateway can answer non-JSON on an error path. That is a failure to
    // report, not an exception to leak.
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  } catch (cause) {
    const durationMs = Math.round(performance.now() - startedAt);
    const aborted = (cause as Error)?.name === "AbortError";
    console.warn(
      `[tracking] royal_mail ${stage} ${aborted ? "timed out" : "failed"} after ${durationMs}ms`,
    );
    throw new TrackingUnavailable(
      aborted
        ? "The carrier did not respond in time."
        : "The carrier could not be reached.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** What a request must carry to be accepted. Never logged, never returned. */
export type RoyalMailAuth = {
  readonly headers: Readonly<Record<string, string>>;
  /** Present only where a token exchange was configured and performed. */
  readonly token?: RoyalMailToken;
};

/**
 * STAGE 1 — establish what a request must carry.
 *
 * HEADER AUTHENTICATION IS THE DEFAULT, AND THIS IS THE BUG FIX. The previous
 * version posted client credentials to `https://api.royalmail.net/token` and
 * every lookup failed with `royal_mail auth 404`, because that endpoint does
 * not exist on this product. The Tracking API authenticates with the client id
 * and secret issued by the developer portal, sent as `X-IBM-Client-Id` and
 * `X-IBM-Client-Secret` on each request. There is no token to fetch, so the
 * default path makes NO NETWORK CALL AT ALL — which is also why it can no
 * longer 404.
 *
 * The `/login/v1/tokens` endpoint that does exist belongs to Royal Mail's
 * CONSUMER mobile API — a different product, with an `origin` header naming
 * the consumer app. Reaching for it here was the mistake.
 *
 * A TOKEN EXCHANGE REMAINS AVAILABLE, and only when `ROYAL_MAIL_TOKEN_URL` is
 * set. Some Royal Mail products do issue bearer tokens, and an operator who
 * needs one should not need a code change — but nobody gets one by default.
 */
export async function authenticate(fetchImpl: RoyalMailFetch = fetch): Promise<RoyalMailAuth> {
  const config = royalMailConfig();
  if (config === undefined) throw notConfigured();

  const headers: Record<string, string> = {
    accept: "application/json",
    "x-ibm-client-id": config.clientId,
    "x-ibm-client-secret": config.clientSecret,
    // Royal Mail's gateway asks callers to acknowledge their terms. Harmless
    // where it is not required; fatal to omit where it is.
    "x-accept-rmg-terms": "yes",
  };

  // THE DEFAULT PATH ENDS HERE. No endpoint, no request, nothing to 404.
  if (config.tokenUrl === undefined) return { headers };

  if (tokenIsUsable(cachedToken, config.clientId)) {
    return { headers: withBearer(headers, cachedToken!.token), token: cachedToken!.token };
  }

  const { status, body } = await send(fetchImpl, "auth", config.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "x-ibm-client-id": config.clientId,
      "x-ibm-client-secret": config.clientSecret,
    },
    // The credentials travel in the body, never in the URL — a query string
    // reaches access logs and proxies.
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }).toString(),
  });

  /*
   * A REFUSED CREDENTIAL IS A CONFIGURATION PROBLEM, not an outage, so 401 and
   * 403 raise `TrackingNotConfigured`. An operator fixes those two in entirely
   * different places and one message covering both sends them to the wrong one.
   *
   * A 404 IS ALSO CONFIGURATION, and it is here because of what happened: it
   * means the token URL is wrong, which is a setting to correct rather than a
   * carrier to wait for. Reporting it as `TrackingUnavailable` is what made the
   * original failure look like an outage for as long as it did.
   */
  if (status === 401 || status === 403) {
    throw new TrackingNotConfigured(
      "Royal Mail refused the tracking credentials. Check the server configuration.",
    );
  }
  if (status === 404) {
    throw new TrackingNotConfigured(
      `Royal Mail has no token endpoint at the configured ${ROYAL_MAIL_TOKEN_URL_VAR}. The Tracking API authenticates by header — unset it unless this deployment genuinely needs a token exchange.`,
    );
  }
  if (status < 200 || status >= 300) {
    throw new TrackingUnavailable("The carrier could not issue a tracking token.");
  }

  const payload = body as { access_token?: unknown; expires_in?: unknown } | undefined;
  const accessToken = typeof payload?.access_token === "string" ? payload.access_token : "";
  if (accessToken === "") {
    throw new TrackingUnavailable("The carrier returned no tracking token.");
  }

  // `expires_in` is seconds. A missing or unusable value is treated as a short
  // life rather than a long one: re-authenticating too often is cheap, and
  // using a dead token is the failure that reads like a bad credential.
  const seconds =
    typeof payload?.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 300;

  const token: RoyalMailToken = {
    accessToken,
    expiresAt: new Date(Date.now() + seconds * 1_000).toISOString(),
  };
  cachedToken = { forClientId: config.clientId, token };
  return { headers: withBearer(headers, token), token };
}

function withBearer(
  headers: Readonly<Record<string, string>>,
  token: RoyalMailToken,
): Record<string, string> {
  return { ...headers, authorization: `Bearer ${token.accessToken}` };
}

/**
 * STAGE 2 — ask the carrier about one reference.
 *
 * Takes the token rather than fetching one, so a caller tracking several
 * consignments authenticates once.
 *
 * THE FOUR OUTCOMES, mapped onto the errors the tracking layer already has:
 *
 *   200        the carrier's own JSON, handed to `mapResponse` unchanged.
 *   404        `TrackingNotFound` — the carrier has never heard of it. This is
 *              NOT the same as an empty result, which means the carrier has it
 *              and has not scanned it. They look alike and mean opposite things
 *              to somebody chasing a parcel.
 *   400        `TrackingNotFound` as well, and deliberately: the gateway
 *              answers 400 for a reference that is not a valid mailpiece id,
 *              which from a caller's point of view is the same fact — this
 *              number will never track — reported with a different number.
 *   401 / 403  `TrackingNotConfigured`. The token was rejected, so the cached
 *              one is dropped before throwing; the next attempt re-authenticates
 *              rather than re-presenting a token already known to be refused.
 *   otherwise  `TrackingUnavailable`, including 429 and every 5xx.
 */
export async function requestTracking(
  auth: RoyalMailAuth,
  trackingNumber: string,
  fetchImpl: RoyalMailFetch = fetch,
): Promise<RoyalMailTrackingResponse> {
  const config = royalMailConfig();
  if (config === undefined) throw notConfigured();

  const reference = trackingNumber.trim();
  if (reference === "") throw new TrackingNotFound("No tracking number was supplied.");

  const { status, body } = await send(
    fetchImpl,
    "tracking",
    `${config.trackingUrl}/${encodeURIComponent(reference)}/events`,
    { method: "GET", headers: { ...auth.headers } },
  );

  if (status === 404 || status === 400) {
    throw new TrackingNotFound("The carrier does not recognise this tracking number.");
  }
  if (status === 401 || status === 403) {
    // The token is no good. Drop it so the next attempt gets a fresh one
    // instead of presenting the same refused credential again.
    forgetRoyalMailToken();
    throw new TrackingNotConfigured(
      "Royal Mail refused the tracking credentials. Check the server configuration.",
    );
  }
  if (status === 429) {
    throw new TrackingUnavailable("The carrier's tracking service is rate limiting requests.");
  }
  if (status < 200 || status >= 300) {
    throw new TrackingUnavailable("The carrier's tracking service is unavailable.");
  }

  return (body ?? {}) as RoyalMailTrackingResponse;
}

/**
 * STAGE 3 — the carrier's shape, as ours.
 *
 * PURE AND TOTAL. No network, no credential, no clock, and no input it will
 * refuse: a response missing `mailPieces` entirely maps to a result stating
 * unknown with no events, which is the honest reading of "the carrier told us
 * nothing". It is written this way so it can be tested now and so a carrier
 * field that changes name degrades to unknown rather than throwing inside a
 * request a reviewer is waiting on.
 *
 * TIMESTAMPS ARE VERBATIM. Not parsed and not converted — the same discipline
 * the rest of this application applies to source timestamps. The carrier's zone
 * is theirs; a converted time that is wrong by an hour is worse than an
 * unconverted one.
 */
export function mapResponse(
  response: RoyalMailTrackingResponse,
  trackingNumber: string,
): TrackingResult {
  const summary = response.mailPieces?.summary;

  const trackingEvents: TrackingEvent[] = (response.mailPieces?.events ?? [])
    .filter((event) => typeof event.eventDateTime === "string" && event.eventDateTime !== "")
    .map((event) => ({
      // Per-event category is not supplied by the carrier, so each scan carries
      // the summary's bucket. Stated rather than fabricated per event: claiming
      // to know that scan #3 was specifically "out for delivery" would be an
      // invention, and the carrier's own wording is preserved beside it.
      status: statusFrom(summary?.statusCategory),
      description: event.eventName ?? event.eventCode ?? "",
      location: event.locationName ?? null,
      timestamp: event.eventDateTime!,
    }))
    // OLDEST FIRST, because `TrackingResult` says so and no caller should sort.
    // Royal Mail returns newest first; comparing the strings is safe for the
    // ISO-8601 timestamps the API documents, and an unparseable value keeps its
    // position rather than being dropped.
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    carrier: "royal_mail",
    trackingNumber,
    currentStatus: statusFrom(summary?.statusCategory),
    trackingEvents,
    lastUpdated: summary?.lastEventDateTime ?? trackingEvents.at(-1)?.timestamp ?? null,
    source: { provider: ROYAL_MAIL_PROVIDER_NAME, retrieval: "live" },
  };
}

/* ------------------------------------------------------------------------- *
 * THE PROVIDER
 * ------------------------------------------------------------------------- */

/**
 * The Royal Mail provider.
 *
 * Registered unconditionally rather than only when credentials are present, and
 * that is deliberate. `trackingStatus("royal_mail")` can then report "Royal
 * Mail is the provider for this carrier, and it is not configured" — which is
 * what an operator needs — instead of the indistinguishable "no provider
 * exists for Royal Mail". The refusal happens on the call, where the message
 * can name the missing variables.
 */
/**
 * The provider, over an injectable network call.
 *
 * A FACTORY RATHER THAN A LITERAL, so a test can exercise `track` end to end
 * without a network. This is not a hypothetical concern: the first version of
 * this file had no seam here, and a test that set fake credentials and called
 * `track` sent a real request to Royal Mail's production host and got a 404
 * back in 1.4 seconds. A test suite must not generate outbound traffic, and the
 * only reliable way to guarantee that is to make the call injectable.
 */
export function createRoyalMailProvider(fetchImpl: RoyalMailFetch = fetch): TrackingProvider {
  return {
    carrier: "royal_mail",
    name: ROYAL_MAIL_PROVIDER_NAME,

    async track(request: TrackingRequest): Promise<TrackingResult> {
      if (request.trackingNumber.trim() === "") {
        throw new TrackingNotFound("No tracking number was supplied.");
      }
      const auth = await authenticate(fetchImpl);
      return mapResponse(
        await requestTracking(auth, request.trackingNumber, fetchImpl),
        request.trackingNumber,
      );
    },
  };
}

/** The registered provider, over the real network. */
export const royalMailProvider: TrackingProvider = createRoyalMailProvider();

/** Whether Royal Mail could actually answer today. Carries no credential. */
export function royalMailConfigured(): boolean {
  return royalMailConfig() !== undefined;
}
