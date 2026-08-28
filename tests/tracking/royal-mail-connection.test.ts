import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TrackingNotConfigured, TrackingNotFound, TrackingUnavailable } from "@/lib/tracking/provider";
import {
  type RoyalMailFetch,
  authenticate,
  createRoyalMailProvider,
  forgetRoyalMailToken,
  requestTracking,
} from "@/lib/tracking/royal-mail-provider";

/**
 * The live Royal Mail connection, against a mocked carrier.
 *
 * NO REQUEST LEAVES THIS PROCESS. Every test supplies its own `fetch` through
 * the injection seam, so there is no global to patch and nothing to leak
 * between files. The credentials below are synthetic strings; the URLs point at
 * a reserved example host that resolves nowhere.
 *
 * WHAT THESE ARE FOR. The endpoint shapes are configuration and the response
 * shape is a hypothesis written from documentation — neither has been checked
 * against a real Royal Mail response. What CAN be pinned without a credential
 * is everything around them: that each failure becomes the right error, that a
 * timeout is a timeout, that a token is reused and dropped when refused, and
 * that no secret ever reaches a log.
 */

const VARS = [
  "ROYAL_MAIL_CLIENT_ID",
  "ROYAL_MAIL_CLIENT_SECRET",
  "ROYAL_MAIL_API_KEY",
  "ROYAL_MAIL_TOKEN_URL",
  "ROYAL_MAIL_TRACKING_URL",
] as const;

const CLIENT_ID = "test-client-id-not-real";
const CLIENT_SECRET = "test-client-secret-not-real-Sh4redSecret";
const API_KEY = "test-api-key-not-real-9f3a1c";
const TOKEN = "test-access-token-not-real-abc123";

const TOKEN_URL = "https://royalmail.example.invalid/token";
const TRACKING_URL = "https://royalmail.example.invalid/mailpieces/v2";

let saved: Record<string, string | undefined>;

/**
 * A working configuration.
 *
 * DELIBERATELY NO TOKEN URL. That is the shipped default now: the Tracking API
 * authenticates by header, and setting a token endpoint here would test a path
 * almost no deployment takes while hiding the one every deployment does.
 */
function configure(): void {
  process.env.ROYAL_MAIL_CLIENT_ID = CLIENT_ID;
  process.env.ROYAL_MAIL_CLIENT_SECRET = CLIENT_SECRET;
  process.env.ROYAL_MAIL_API_KEY = API_KEY;
  process.env.ROYAL_MAIL_TRACKING_URL = TRACKING_URL;
}

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
  for (const name of VARS) delete process.env[name];
  forgetRoyalMailToken();
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  forgetRoyalMailToken();
  vi.restoreAllMocks();
});

/** A fetch that answers with one scripted response and records what it was asked. */
function respondWith(
  responses: readonly { status: number; body?: unknown; text?: string }[],
): RoyalMailFetch & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    const next = responses[calls.length - 1] ?? responses.at(-1)!;
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      json: async () => {
        if (next.text !== undefined) throw new SyntaxError("not json");
        return next.body;
      },
    } as unknown as Response;
  }) as RoyalMailFetch & { calls: { url: string; init: RequestInit }[] };
  impl.calls = calls;
  return impl;
}

/** The error a call refused with, failing loudly if it did not refuse. */
async function refusal(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (cause) {
    return cause as Error;
  }
  throw new Error("expected a refusal");
}

/** What stage 2 is handed: the headers stage 1 established. */
const AUTH = { headers: { accept: "application/json", "x-ibm-client-id": "test-id" } };

const TOKEN_OK = { status: 200, body: { access_token: TOKEN, expires_in: 3600 } };

const TRACKING_OK = {
  status: 200,
  body: {
    mailPieces: {
      mailPieceId: "AB123456789GB",
      summary: {
        lastEventDateTime: "2026-08-20T14:02:00+01:00",
        lastEventName: "Delivered",
        statusCategory: "DELIVERED",
      },
      events: [
        { eventCode: "EVKOP", eventName: "Delivered", eventDateTime: "2026-08-20T14:02:00+01:00", locationName: "Stafford DO" },
      ],
    },
  },
};

/* ------------------------------------------------------------------ */

describe("1. authentication — the default header path", () => {
  /**
   * THE REGRESSION THIS FIXES. The provider used to POST client credentials to
   * a guessed `/token` endpoint, and every lookup died with
   * `royal_mail auth 404` because no such endpoint exists on this product. The
   * Tracking API authenticates by header, so the default path now makes NO
   * REQUEST AT ALL — which is what makes a 404 impossible rather than unlikely.
   */
  it("makes no network call and returns the headers a request must carry", async () => {
    configure();
    const fetchImpl = respondWith([TOKEN_OK]);
    const auth = await authenticate(fetchImpl);

    expect(fetchImpl.calls).toHaveLength(0);
    expect(auth.token).toBeUndefined();
    expect(auth.headers["x-ibm-client-id"]).toBe(CLIENT_ID);
    expect(auth.headers["x-ibm-client-secret"]).toBe(CLIENT_SECRET);
    expect(auth.headers["x-accept-rmg-terms"]).toBe("yes");
  });

  /**
   * The portal labels the client id an "API key" in places. Failing on the same
   * value under a different name would be a configuration puzzle with no useful
   * answer, so it is accepted as an alias.
   */
  it("accepts the api key as an alias for the client id", async () => {
    process.env.ROYAL_MAIL_CLIENT_SECRET = CLIENT_SECRET;
    process.env.ROYAL_MAIL_API_KEY = API_KEY;
    const auth = await authenticate(respondWith([TOKEN_OK]));
    expect(auth.headers["x-ibm-client-id"]).toBe(API_KEY);
  });

  it("still refuses when the secret is missing", async () => {
    process.env.ROYAL_MAIL_CLIENT_ID = CLIENT_ID;
    const error = await refusal(() => authenticate(respondWith([TOKEN_OK])));
    expect(error).toBeInstanceOf(TrackingNotConfigured);
    expect(error.message).toContain("ROYAL_MAIL_CLIENT_SECRET");
  });
});

/* ------------------------------------------------------------------ */

describe("1b. the optional token exchange", () => {
  /** Only when an operator sets a token URL. Nobody gets one by default. */
  function configureWithToken(): void {
    configure();
    process.env.ROYAL_MAIL_TOKEN_URL = TOKEN_URL;
  }

  it("exchanges the client credentials for a token when one is configured", async () => {
    configureWithToken();
    const fetchImpl = respondWith([TOKEN_OK]);
    const auth = await authenticate(fetchImpl);

    expect(auth.token!.accessToken).toBe(TOKEN);
    expect(Date.parse(auth.token!.expiresAt)).toBeGreaterThan(Date.now());
    expect(auth.headers.authorization).toBe(`Bearer ${TOKEN}`);

    const [call] = fetchImpl.calls;
    expect(call!.url).toBe(TOKEN_URL);
    expect(call!.init.method).toBe("POST");

    /*
     * The credentials must travel in the BODY. A query string reaches access
     * logs, proxy logs and browser history; a form body does not.
     */
    expect(call!.url).not.toContain(CLIENT_SECRET);
    const body = String(call!.init.body);
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain(encodeURIComponent(CLIENT_ID));
  });

  /**
   * A 404 on the token endpoint is a SETTING to correct, not a carrier to wait
   * for. Reporting it as unavailable is what made the original failure look
   * like an outage for as long as it did.
   */
  it("reports a wrong token endpoint as configuration, and says to unset it", async () => {
    configureWithToken();
    const error = await refusal(() => authenticate(respondWith([{ status: 404 }])));
    expect(error).toBeInstanceOf(TrackingNotConfigured);
    expect(error.message).toContain("ROYAL_MAIL_TOKEN_URL");
    expect(error.message).toMatch(/authenticates by header/i);
  });
});

describe("1c. token reuse, when a token is in play", () => {
  beforeEach(() => {
    configure();
    process.env.ROYAL_MAIL_TOKEN_URL = TOKEN_URL;
  });

  /** A token is a credential and a round trip. Neither is spent twice. */
  it("reuses a token that has not expired", async () => {
    const fetchImpl = respondWith([TOKEN_OK]);
    await authenticate(fetchImpl);
    await authenticate(fetchImpl);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  /**
   * A token expiring mid-request fails as a 401, which reads like a bad
   * credential. Retiring it early removes that whole class of confusion.
   */
  it("does not reuse a token that is about to expire", async () => {
    const fetchImpl = respondWith([{ status: 200, body: { access_token: TOKEN, expires_in: 30 } }]);
    await authenticate(fetchImpl);
    await authenticate(fetchImpl);
    expect(fetchImpl.calls).toHaveLength(2);
  });

  /** A rotated credential must not be served a token minted for the old one. */
  it("does not reuse a token across a credential rotation", async () => {
    const fetchImpl = respondWith([TOKEN_OK]);
    await authenticate(fetchImpl);
    process.env.ROYAL_MAIL_CLIENT_ID = "test-rotated-client-id";
    await authenticate(fetchImpl);
    expect(fetchImpl.calls).toHaveLength(2);
  });

  /**
   * A refused credential is a CONFIGURATION problem, not an outage. They are
   * fixed in different places, so they must not share an error.
   */
  it("treats a refused credential as not configured, not unavailable", async () => {
    for (const status of [401, 403]) {
      forgetRoyalMailToken();
      await expect(authenticate(respondWith([{ status }]))).rejects.toBeInstanceOf(
        TrackingNotConfigured,
      );
    }
  });

  it("treats a token endpoint failure as unavailable", async () => {
    await expect(authenticate(respondWith([{ status: 500 }]))).rejects.toBeInstanceOf(
      TrackingUnavailable,
    );
  });

  it("refuses a 200 that carries no token rather than proceeding", async () => {
    await expect(
      authenticate(respondWith([{ status: 200, body: { token_type: "Bearer" } }])),
    ).rejects.toBeInstanceOf(TrackingUnavailable);
  });
});

/* ------------------------------------------------------------------ */

describe("2. a successful tracking lookup", () => {
  it("asks for the reference and presents the credential headers", async () => {
    configure();
    const fetchImpl = respondWith([TRACKING_OK]);
    const response = await requestTracking(
      AUTH,
      "AB123456789GB",
      fetchImpl,
    );

    expect(response.mailPieces?.summary?.statusCategory).toBe("DELIVERED");

    const [call] = fetchImpl.calls;
    expect(call!.url).toBe(`${TRACKING_URL}/AB123456789GB/events`);
    // Whatever stage 1 established is what stage 2 sends, unchanged.
    expect(call!.init.headers).toEqual(AUTH.headers);
  });

  /** A reference with a space or slash must not break the path it is put in. */
  it("escapes the reference into the path", async () => {
    configure();
    const fetchImpl = respondWith([TRACKING_OK]);
    await requestTracking(
      AUTH,
      "AB 123/456",
      fetchImpl,
    );
    expect(fetchImpl.calls[0]!.url).toBe(`${TRACKING_URL}/AB%20123%2F456/events`);
  });
});

/* ------------------------------------------------------------------ */

describe("3. missing credentials", () => {
  it("refuses both stages without touching the network", async () => {
    const fetchImpl = respondWith([TOKEN_OK]);
    await expect(authenticate(fetchImpl)).rejects.toBeInstanceOf(TrackingNotConfigured);
    await expect(
      requestTracking(AUTH, "AB1", fetchImpl),
    ).rejects.toBeInstanceOf(TrackingNotConfigured);
    // Nothing was attempted. An unconfigured provider must not generate traffic.
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

describe("4. an invalid tracking number", () => {
  /**
   * NOT the same as an empty result. "Never heard of it" and "have it, not yet
   * scanned" look alike in a naive shape and mean opposite things to somebody
   * chasing a parcel.
   */
  it("reports not found for a reference the carrier rejects", async () => {
    configure();
    const token = AUTH;
    for (const status of [404, 400]) {
      await expect(
        requestTracking(token, "NOT-A-REAL-REFERENCE", respondWith([{ status }])),
      ).rejects.toBeInstanceOf(TrackingNotFound);
    }
  });

  it("reports not found for an empty reference without asking the carrier", async () => {
    configure();
    const fetchImpl = respondWith([TRACKING_OK]);
    await expect(
      requestTracking(AUTH, "   ", fetchImpl),
    ).rejects.toBeInstanceOf(TrackingNotFound);
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

describe("5. a timeout", () => {
  it("abandons a carrier that does not answer, and says so", async () => {
    configure();
    // Never resolves until aborted — exactly what a hung carrier looks like.
    const hangs: RoyalMailFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal!;
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });

    process.env.ROYAL_MAIL_TOKEN_URL = TOKEN_URL;
    const started = Date.now();
    const error = await refusal(() => authenticate(hangs));
    expect(error).toBeInstanceOf(TrackingUnavailable);
    expect(error.message).toMatch(/did not respond in time/i);
    // The request really was abandoned rather than left hanging.
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 30_000);

  it("reports a network failure as unavailable", async () => {
    configure();
    const refuses: RoyalMailFetch = () => Promise.reject(new TypeError("fetch failed"));
    await expect(requestTracking(AUTH, "AB123456789GB", refuses)).rejects.toBeInstanceOf(
      TrackingUnavailable,
    );
  });
});

/* ------------------------------------------------------------------ */

describe("6. an error response", () => {
  const token = AUTH;

  it("maps rate limiting and outages to unavailable", async () => {
    configure();
    for (const status of [429, 500, 502, 503]) {
      await expect(
        requestTracking(token, "AB123456789GB", respondWith([{ status }])),
      ).rejects.toBeInstanceOf(TrackingUnavailable);
    }
  });

  it("maps a refused token to not configured", async () => {
    configure();
    for (const status of [401, 403]) {
      await expect(
        requestTracking(token, "AB123456789GB", respondWith([{ status }])),
      ).rejects.toBeInstanceOf(TrackingNotConfigured);
    }
  });

  /**
   * A refused token must not be presented again. Without this the next attempt
   * repeats a credential already known to be rejected and fails identically.
   */
  it("drops the cached token when the carrier refuses it", async () => {
    configure();
    process.env.ROYAL_MAIL_TOKEN_URL = TOKEN_URL;
    const auth = respondWith([TOKEN_OK]);
    await authenticate(auth);
    await requestTracking(token, "AB1", respondWith([{ status: 401 }])).catch(() => undefined);
    await authenticate(auth);
    expect(auth.calls).toHaveLength(2);
  });

  it("survives a gateway answering something that is not JSON", async () => {
    configure();
    await expect(
      requestTracking(token, "AB1", respondWith([{ status: 502, text: "<html>Bad Gateway</html>" }])),
    ).rejects.toBeInstanceOf(TrackingUnavailable);
  });
});

/* ------------------------------------------------------------------ */

describe("the provider end to end", () => {
  /**
   * `track` over an injected network call: authenticate, request, map. The
   * factory exists for exactly this — without it a test that set credentials
   * and called `track` sent a real request to Royal Mail's production host.
   */
  it("authenticates, asks, and returns the mapped result", async () => {
    configure();
    const fetchImpl = respondWith([TRACKING_OK]);
    const provider = createRoyalMailProvider(fetchImpl);

    const result = await provider.track({ carrier: "royal_mail", trackingNumber: "AB123456789GB" });

    // ONE call, not two: header authentication spends no round trip.
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0]!.url).toBe(`${TRACKING_URL}/AB123456789GB/events`);
    expect(result.carrier).toBe("royal_mail");
    expect(result.currentStatus).toBe("delivered");
    expect(result.trackingNumber).toBe("AB123456789GB");
    expect(result.lastUpdated).toBe("2026-08-20T14:02:00+01:00");
    expect(result.source.provider).toBe("royal_mail_tracking_api");
  });

  it("does not ask the carrier at all when unconfigured", async () => {
    const fetchImpl = respondWith([TOKEN_OK, TRACKING_OK]);
    const provider = createRoyalMailProvider(fetchImpl);
    await expect(
      provider.track({ carrier: "royal_mail", trackingNumber: "AB123456789GB" }),
    ).rejects.toBeInstanceOf(TrackingNotConfigured);
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

describe("7. nothing secret reaches a log or an error", () => {
  const SECRETS = [CLIENT_SECRET, API_KEY, TOKEN];

  /**
   * The allowed fields are carrier, request status and timing. A tracking
   * number is excluded too: it identifies a real parcel belonging to a real
   * person, and it would be convenient in a log, which is exactly the reason to
   * keep it out.
   */
  it("logs only the carrier, the status and the timing", async () => {
    configure();
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((...args) => lines.push(args.join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...args) => lines.push(args.join(" ")));

    await authenticate(respondWith([TOKEN_OK]));
    await requestTracking(
      AUTH,
      "AB123456789GB",
      respondWith([TRACKING_OK]),
    );
    await requestTracking(
      AUTH,
      "AB123456789GB",
      respondWith([{ status: 500 }]),
    ).catch(() => undefined);

    expect(lines.length).toBeGreaterThan(0);
    const log = lines.join("\n");
    for (const secret of [...SECRETS, CLIENT_ID]) expect(log).not.toContain(secret);
    expect(log).not.toContain("AB123456789GB");
    // What it DOES carry, so the log is still worth having.
    expect(log).toMatch(/royal_mail/);
    expect(log).toMatch(/\d+ms/);
  });

  it("never puts a secret in an error a caller could surface", async () => {
    configure();
    const errors: string[] = [];
    process.env.ROYAL_MAIL_TOKEN_URL = TOKEN_URL;
    for (const attempt of [
      () => authenticate(respondWith([{ status: 401 }])),
      () => authenticate(respondWith([{ status: 500 }])),
      () =>
        requestTracking(
          AUTH,
          "AB123456789GB",
          respondWith([{ status: 403 }]),
        ),
    ]) {
      forgetRoyalMailToken();
      errors.push((await refusal(attempt)).message);
    }
    const joined = errors.join("\n");
    for (const secret of [...SECRETS, CLIENT_ID]) expect(joined).not.toContain(secret);
  });
});
