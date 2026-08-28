import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TRACKING_STATUSES, TrackingNotConfigured } from "@/lib/tracking/provider";
import {
  ROYAL_MAIL_PROVIDER_NAME,
  authenticate,
  mapResponse,
  requestTracking,
  royalMailConfigured,
  royalMailProvider,
  statusFrom,
} from "@/lib/tracking/royal-mail-provider";
import { carrierFrom } from "@/lib/tracking/carrier";
import { getTrackingProvider, getTrackingProviderFor } from "@/lib/tracking/tracking-service";

/**
 * The Royal Mail provider, as a structure.
 *
 * It cannot answer a lookup and is not meant to: there is no endpoint. What is
 * testable now is everything that does not need one — that it is selected for
 * the right carrier and only that carrier, that it refuses with a message
 * naming what is missing, that it touches no network, and that its mapper
 * produces the agreed shape from a response it has not seen yet.
 *
 * The fake credentials below are synthetic strings. No key is contacted.
 */

const VARS = ["ROYAL_MAIL_CLIENT_ID", "ROYAL_MAIL_CLIENT_SECRET", "ROYAL_MAIL_API_KEY"] as const;
const FAKE = "test-value-not-a-real-credential";

let saved: Record<string, string | undefined>;

/** The error a lookup refused with, failing loudly if it did not refuse. */
async function refusal(run: () => Promise<unknown>): Promise<Error> {
  let outcome: unknown;
  try {
    outcome = await run();
  } catch (cause) {
    return cause as Error;
  }
  throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
}

/** What stage 2 is handed: the headers stage 1 established. */
const AUTH = { headers: { accept: "application/json", "x-ibm-client-id": "test-id" } };

const LOOKUP = () =>
  royalMailProvider.track({ carrier: "royal_mail" as const, trackingNumber: "AB123456789GB" });

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
  for (const name of VARS) delete process.env[name];
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

/* ------------------------------------------------------------------ */

describe("selecting the provider", () => {
  /** 1. Royal Mail selects it. */
  it("is the provider for the Royal Mail carrier", () => {
    expect(getTrackingProvider("royal_mail")).toBe(royalMailProvider);
    expect(royalMailProvider.carrier).toBe("royal_mail");
    expect(royalMailProvider.name).toBe(ROYAL_MAIL_PROVIDER_NAME);
  });

  /**
   * 4 (carrier compatibility). All four stored spellings reach it, and they do
   * so through `carrierFrom` — 214,165 live shipments across the four. A fifth
   * spelling appearing in the data is a change to the normaliser, not here.
   */
  it("is reached by every stored Royal Mail spelling", () => {
    for (const stored of ["Royal Mail", "Royal Mail 48", "Royal Mail 24", "Royal Mail 1st Class"]) {
      expect(carrierFrom(stored), stored).toBe("royal_mail");
      expect(getTrackingProviderFor(stored), stored).toBe(royalMailProvider);
    }
  });

  /** 2. An unsupported carrier must not resolve to Royal Mail. */
  it("is not selected for any other carrier", () => {
    for (const carrier of ["evri", "dhl", "dpd", "ups", "usps", "yodel"] as const) {
      expect(getTrackingProvider(carrier), carrier).toBeUndefined();
    }
    for (const stored of ["Evri", "Hermes", "DPD", "wayfair", "Other", null]) {
      expect(getTrackingProviderFor(stored), String(stored)).not.toBe(royalMailProvider);
    }
  });

  /**
   * The provider must not compare stored courier strings itself. Matching
   * "Royal Mail" by hand here is what would let "Royal Mail 48" go untracked.
   */
  it("declares a normalised carrier and compares against no raw string", async () => {
    const source = await import("node:fs").then(({ readFileSync }) =>
      readFileSync("lib/tracking/royal-mail-provider.ts", "utf8"),
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

    // Naming the carrier in a message an operator reads is fine and necessary.
    // COMPARING against a stored spelling is what would let "Royal Mail 48"
    // go untracked, so that is what this forbids.
    for (const comparison of [
      /[=!]==?\s*["'`]\s*royal\s*mail/i,
      /\.(?:includes|startsWith|endsWith|match|test)\s*\(\s*["'`/][^)]*royal\s*mail/i,
      /\/[^/\n]*royal\s*mail[^/\n]*\/[gimsuy]*/i,
    ]) {
      expect(code, String(comparison)).not.toMatch(comparison);
    }
    expect(code).toContain('carrier: "royal_mail"');
  });
});

/* ------------------------------------------------------------------ */

describe("without credentials", () => {
  /** 3. Missing credentials refuse, and the message names what to set. */
  it("reports itself unconfigured", () => {
    expect(royalMailConfigured()).toBe(false);
  });

  it("refuses a lookup and names every missing variable", async () => {
    await expect(
      royalMailProvider.track({ carrier: "royal_mail", trackingNumber: "AB123456789GB" }),
    ).rejects.toBeInstanceOf(TrackingNotConfigured);

    const error = await refusal(LOOKUP);
    /*
     * TWO ARE REQUIRED, NOT THREE. The Tracking API authenticates with the
     * client id and secret from the developer portal, sent as headers. The api
     * key variable is kept as an alias for the client id — parts of the portal
     * call it that — so it is not named as missing when the client id would do.
     */
    expect(error.message).toContain("ROYAL_MAIL_CLIENT_ID");
    expect(error.message).toContain("ROYAL_MAIL_CLIENT_SECRET");
    // The warning that keeps a server credential off the client.
    expect(error.message).toContain("NEXT_PUBLIC_");
  });

  it("refuses at each stage independently", async () => {
    await expect(authenticate()).rejects.toBeInstanceOf(TrackingNotConfigured);
    await expect(
      requestTracking(AUTH, "AB123456789GB"),
    ).rejects.toBeInstanceOf(TrackingNotConfigured);
  });

  /**
   * Partial configuration is NOT configuration. One header without the other
   * cannot make a successful request, and failing at the first call with a 401
   * reads like a revoked credential rather than a missing one.
   */
  it("treats a partially configured environment as unconfigured", () => {
    process.env.ROYAL_MAIL_CLIENT_ID = FAKE;
    expect(royalMailConfigured()).toBe(false);

    delete process.env.ROYAL_MAIL_CLIENT_ID;
    process.env.ROYAL_MAIL_CLIENT_SECRET = FAKE;
    expect(royalMailConfigured()).toBe(false);
  });

  /** The two the API actually needs are enough; the api key is an alias. */
  it("is configured on the client id and secret alone", () => {
    process.env.ROYAL_MAIL_CLIENT_ID = FAKE;
    process.env.ROYAL_MAIL_CLIENT_SECRET = FAKE;
    expect(royalMailConfigured()).toBe(true);
  });

  it("treats a value left at the .env.example placeholder as absent", () => {
    for (const name of VARS) process.env[name] = "<royal-mail-client-id>";
    expect(royalMailConfigured()).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("mapping a response", () => {
  const RESPONSE = {
    mailPieces: {
      mailPieceId: "AB123456789GB",
      summary: {
        lastEventDateTime: "2026-08-20T14:02:00+01:00",
        lastEventName: "Delivered",
        lastEventLocationName: "Stafford DO",
        statusDescription: "It's been delivered",
        statusCategory: "DELIVERED",
      },
      // Newest first, as the carrier returns them.
      events: [
        { eventCode: "EVKOP", eventName: "Delivered", eventDateTime: "2026-08-20T14:02:00+01:00", locationName: "Stafford DO" },
        { eventCode: "EVOFD", eventName: "Out for delivery", eventDateTime: "2026-08-20T07:30:00+01:00", locationName: "Stafford DO" },
        { eventCode: "EVGPD", eventName: "Accepted", eventDateTime: "2026-08-19T18:11:00+01:00", locationName: "Birmingham MC" },
      ],
    },
  };

  /** 5. The mapping produces the agreed interface. */
  it("produces the agreed TrackingResult shape", () => {
    const result = mapResponse(RESPONSE, "AB123456789GB");

    expect(Object.keys(result).sort()).toEqual(
      ["carrier", "currentStatus", "lastUpdated", "source", "trackingEvents", "trackingNumber"].sort(),
    );
    expect(result.carrier).toBe("royal_mail");
    expect(result.trackingNumber).toBe("AB123456789GB");
    expect(result.currentStatus).toBe("delivered");
    expect(TRACKING_STATUSES).toContain(result.currentStatus);
    expect(result.source).toEqual({ provider: ROYAL_MAIL_PROVIDER_NAME, retrieval: "live" });
  });

  /** The interface says oldest first, so no caller has to sort. */
  it("returns the events oldest first whatever order they arrived in", () => {
    const events = mapResponse(RESPONSE, "AB123456789GB").trackingEvents;
    expect(events.map((event) => event.timestamp)).toEqual([
      "2026-08-19T18:11:00+01:00",
      "2026-08-20T07:30:00+01:00",
      "2026-08-20T14:02:00+01:00",
    ]);
  });

  /** Timestamps are the carrier's, verbatim — never parsed or converted. */
  it("keeps the carrier's own wording and timestamps", () => {
    const result = mapResponse(RESPONSE, "AB123456789GB");
    expect(result.lastUpdated).toBe("2026-08-20T14:02:00+01:00");
    expect(result.trackingEvents[0]!.description).toBe("Accepted");
    expect(result.trackingEvents[0]!.location).toBe("Birmingham MC");
  });

  /**
   * TOTAL. A response shape written from documentation is a hypothesis, so the
   * mapper must degrade rather than throw when the hypothesis is wrong.
   */
  it("maps an empty or unexpected response to a stated unknown", () => {
    for (const input of [{}, { mailPieces: {} }, { mailPieces: { summary: {}, events: [] } }]) {
      const result = mapResponse(input, "AB123456789GB");
      expect(result.currentStatus).toBe("unknown");
      expect(result.trackingEvents).toEqual([]);
      expect(result.lastUpdated).toBeNull();
      expect(result.carrier).toBe("royal_mail");
    }
  });

  it("drops an event with no timestamp rather than inventing one", () => {
    const result = mapResponse(
      { mailPieces: { summary: { statusCategory: "IN TRANSIT" }, events: [{ eventName: "Accepted" }] } },
      "AB123456789GB",
    );
    expect(result.trackingEvents).toEqual([]);
    expect(result.currentStatus).toBe("in_transit");
  });

  /**
   * THE SAFETY PROPERTY. An unmapped carrier status becomes "we do not know",
   * never a plausible neighbour — the difference between those two is a promise
   * to a customer chasing a parcel.
   */
  it("maps an unrecognised status to unknown rather than guessing", () => {
    expect(statusFrom("SOMETHING ROYAL MAIL ADDED LAST TUESDAY")).toBe("unknown");
    expect(statusFrom(undefined)).toBe("unknown");
    expect(statusFrom("")).toBe("unknown");
  });

  it("tolerates the carrier changing the case or spacing of a status", () => {
    for (const written of ["IN TRANSIT", "In Transit", "in-transit", "in_transit"]) {
      expect(statusFrom(written), written).toBe("in_transit");
    }
  });
});
