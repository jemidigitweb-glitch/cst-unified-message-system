import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDraftInput, verifiedTrackingBlock } from "@/lib/ai/draft-assembly";
import { validateDraftAccuracy } from "@/lib/ai/draft-validation";
import type { DraftRequest } from "@/lib/ai/provider";
import { resolveTrackingContext } from "@/lib/context/resolve-tracking-context";
import type { VerifiedFact } from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";
import { MESSAGE_CATEGORIES } from "@/lib/knowledge/message-category";
import type { TrackingResult } from "@/lib/tracking/provider";
import {
  forgetTracking,
  readFreshTracking,
  trackingCacheSize,
  writeTracking,
} from "@/lib/tracking/tracking-cache";
import { forgetRoyalMailToken } from "@/lib/tracking/royal-mail-provider";

/**
 * Tracking, from the gate to the prompt.
 *
 * NO NETWORK. The Royal Mail provider is unconfigured in these tests, so any
 * lookup that gets past the gate refuses immediately and locally — which is
 * itself one of the safety paths being asserted. The cases that need a
 * successful lookup use the cache, which is the same code path a live result
 * takes on its way to the prompt.
 */

const RM_VARS = ["ROYAL_MAIL_CLIENT_ID", "ROYAL_MAIL_CLIENT_SECRET", "ROYAL_MAIL_API_KEY"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(RM_VARS.map((name) => [name, process.env[name]]));
  for (const name of RM_VARS) delete process.env[name];
  forgetTracking();
  forgetRoyalMailToken();
});

afterEach(() => {
  for (const name of RM_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  forgetTracking();
  forgetRoyalMailToken();
  vi.restoreAllMocks();
});

const TRACKED: VerifiedFact[] = [
  { name: "order_number", value: "AA-11111-11111" },
  { name: "order_status", value: "Completed" },
  { name: "tracking_number", value: "AB123456789GB" },
  { name: "delivery_courier", value: "Royal Mail 48" },
];

function result(overrides: Partial<TrackingResult> = {}): TrackingResult {
  return {
    carrier: "royal_mail",
    trackingNumber: "AB123456789GB",
    currentStatus: "in_transit",
    trackingEvents: [
      {
        status: "in_transit",
        description: "Accepted at Birmingham MC",
        location: "Birmingham MC",
        timestamp: "2026-08-19T18:11:00+01:00",
      },
    ],
    lastUpdated: "2026-08-19T18:11:00+01:00",
    source: { provider: "royal_mail_tracking_api", retrieval: "live" },
    ...overrides,
  };
}

function message(text: string): ConversationMessageView {
  return {
    id: "1",
    direction: "inbound",
    sourceTimestamp: "2026-08-20 09:00:00",
    bodyText: text,
    bodyDecodeStatus: "decoded",
    attachments: [],
  };
}

function request(overrides: Partial<DraftRequest> = {}): DraftRequest {
  return {
    messages: [message("Where is my parcel? It still has not arrived.")],
    marketplace: "ebay",
    listingItemRef: "123456789012",
    facts: TRACKED,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */

describe("2. the gate decides whether a carrier is asked at all", () => {
  /**
   * The exclusion list, enforced by construction rather than enumerated: the
   * gate admits ONE category, so every other one — present and future — is out.
   */
  it("asks for no category but Delivery queries", async () => {
    for (const category of MESSAGE_CATEGORIES.filter((name) => name !== "Delivery queries")) {
      const context = await resolveTrackingContext({ category, facts: TRACKED });
      expect(context.tracking, category).toBeNull();
      expect(context.tracking === null && context.reason, category).toBe("not_a_delivery_query");
    }
    // And explicitly the six the task names.
    for (const category of [
      "Pre sales queries",
      "Return and refunds",
      "Damage queries",
      "Wrong item sent messages",
      "Parts missing queries",
      "Wrong description issues",
    ] as const) {
      expect((await resolveTrackingContext({ category, facts: TRACKED })).tracking).toBeNull();
    }
  });

  it("asks for nothing when the conversation has no category", async () => {
    const context = await resolveTrackingContext({ category: null, facts: TRACKED });
    expect(context.tracking).toBeNull();
  });

  /**
   * Both come from the RESOLVED ORDER. A reference the customer typed is
   * customer-stated, and asking a carrier about it would launder an unverified
   * string into a verified-looking fact.
   */
  it("requires a verified tracking number and a carrier", async () => {
    const cases: readonly (readonly [string, VerifiedFact[]])[] = [
      ["no_tracking_number", TRACKED.filter((fact) => fact.name !== "tracking_number")],
      ["no_carrier", TRACKED.filter((fact) => fact.name !== "delivery_courier")],
    ];
    for (const [reason, facts] of cases) {
      const context = await resolveTrackingContext({ category: "Delivery queries", facts });
      expect(context.tracking, reason).toBeNull();
      expect(context.tracking === null && context.reason).toBe(reason);
    }
  });

  it("refuses a courier string it cannot name", async () => {
    const context = await resolveTrackingContext({
      category: "Delivery queries",
      // A real stored value, and not a carrier — 26,600 live shipments.
      facts: [...TRACKED.filter((f) => f.name !== "delivery_courier"), { name: "delivery_courier", value: "wayfair" }],
    });
    expect(context.tracking).toBeNull();
    expect(context.tracking === null && context.reason).toBe("carrier_not_recognised");
  });

  /**
   * Every recognised carrier now HAS a provider — the source database serves
   * all of them — so the gate no longer stops at `carrier_not_supported` for
   * one. It gets as far as the lookup and stops there instead, with no source
   * database configured in this environment. The guarantee under test is
   * unchanged and is the one that matters: no tracking reaches the draft.
   */
  it("produces no tracking when the lookup cannot be answered", async () => {
    const context = await resolveTrackingContext({
      category: "Delivery queries",
      facts: [...TRACKED.filter((f) => f.name !== "delivery_courier"), { name: "delivery_courier", value: "Evri" }],
    });
    expect(context.tracking).toBeNull();
    expect(context.tracking === null && context.reason).toBe("lookup_failed");
  });
});

/* ------------------------------------------------------------------ */

describe("3 and 4. cache freshness", () => {
  it("reuses a fresh result and marks it cached", () => {
    writeTracking(result());
    const cached = readFreshTracking("royal_mail", "AB123456789GB");
    expect(cached).toBeDefined();
    expect(cached!.currentStatus).toBe("in_transit");
    // The status is unchanged; how we came by it is not.
    expect(cached!.source.retrieval).toBe("cached");
    expect(cached!.trackingNumber).toBe("AB123456789GB");
  });

  it("does not reuse a result once it has expired", () => {
    const longAgo = Date.now() - 60 * 60_000;
    writeTracking(result(), longAgo);
    expect(readFreshTracking("royal_mail", "AB123456789GB")).toBeUndefined();
    // Dropped on the way past rather than left to accumulate.
    expect(trackingCacheSize()).toBe(0);
  });

  it("keys on the carrier as well as the reference", () => {
    writeTracking(result());
    expect(readFreshTracking("evri", "AB123456789GB")).toBeUndefined();
    expect(readFreshTracking("royal_mail", "SOMETHING-ELSE")).toBeUndefined();
  });

  /**
   * The cache holds no recoverable consignment reference: the key is a hash and
   * the reference is stripped from the stored value, then re-attached from the
   * caller's own input on the way out.
   */
  /**
   * The reference is stripped before storage and re-attached from the caller's
   * own input on the way out, and the key is a hash. Asserted against the
   * source rather than by inspecting the map, because exporting the internals
   * to prove they are private would defeat the point.
   */
  it("stores no plain tracking reference and no customer data", async () => {
    const source = await import("node:fs").then(({ readFileSync }) =>
      readFileSync("lib/tracking/tracking-cache.ts", "utf8"),
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
    // The write path destructures the reference out of what it keeps.
    expect(code).toMatch(/const \{ trackingNumber, \.\.\.withoutReference \} = result/);
    expect(code).toMatch(/createHash\("sha256"\)/);
    // Nothing here can even see a customer message.
    expect(code).not.toMatch(/bodyText|messages|ConversationMessageView/);

    // And the reference still comes back, because the caller supplied it.
    writeTracking(result());
    expect(readFreshTracking("royal_mail", "AB123456789GB")!.trackingNumber).toBe("AB123456789GB");
  });

  /** A fresh entry means the gate never reaches the carrier. */
  it("serves the gate from cache without a lookup", async () => {
    writeTracking(result());
    const context = await resolveTrackingContext({ category: "Delivery queries", facts: TRACKED });
    expect(context.tracking).not.toBeNull();
    expect(context.tracking!.source.retrieval).toBe("cached");
  });
});

/* ------------------------------------------------------------------ */

describe("5 and 6. safety when the carrier cannot be reached", () => {
  /**
   * THE RULE THAT MATTERS MOST. An expired entry is not a fallback. With the
   * provider unconfigured the live call fails, and the answer is no tracking —
   * not yesterday's "Delivered" presented as the position now.
   */
  it("does not fall back to stale tracking when the lookup fails", async () => {
    writeTracking(result({ currentStatus: "delivered" }), Date.now() - 60 * 60_000);
    const context = await resolveTrackingContext({ category: "Delivery queries", facts: TRACKED });
    expect(context.tracking).toBeNull();
    expect(context.tracking === null && context.reason).toBe("lookup_failed");
  });

  it("returns null rather than throwing when the provider refuses", async () => {
    const context = await resolveTrackingContext({ category: "Delivery queries", facts: TRACKED });
    expect(context.tracking).toBeNull();
  });

  /** Without tracking the prompt is exactly what it was before this feature. */
  it("omits the tracking block entirely when there is none", () => {
    expect(verifiedTrackingBlock(null)).toBeNull();
    expect(verifiedTrackingBlock(undefined)).toBeNull();
    const input = buildDraftInput(request({ tracking: null }));
    expect(input).not.toMatch(/VERIFIED TRACKING/);
    expect(buildDraftInput(request())).toBe(input);
  });
});

/* ------------------------------------------------------------------ */

describe("1 and 3. the verified tracking block reaches the draft", () => {
  it("states the carrier, reference, status, time and source", () => {
    const block = verifiedTrackingBlock(result())!;
    expect(block).toContain("VERIFIED TRACKING INFORMATION:");
    expect(block).toContain("Carrier: Royal Mail");
    expect(block).toContain("Tracking number: AB123456789GB");
    expect(block).toContain("Current status: In transit");
    expect(block).toContain("Last updated: 2026-08-19T18:11:00+01:00");
    expect(block).toContain("Source: Live");
  });

  /** The instruction travels with the data, on the drafts that have data. */
  it("carries the instruction not to guess", () => {
    const block = verifiedTrackingBlock(result())!;
    expect(block).toMatch(/USE ONLY THIS VERIFIED TRACKING INFORMATION/);
    expect(block).toMatch(/do not guess the delivery status/i);
  });

  /**
   * "Delivered, a moment ago" and "Delivered, a quarter of an hour ago" are
   * different claims, and only one may be written as the present state.
   */
  it("tells the model when the answer is cached rather than live", () => {
    writeTracking(result());
    const cached = readFreshTracking("royal_mail", "AB123456789GB")!;
    const block = verifiedTrackingBlock(cached)!;
    expect(block).toContain("Source: Cached");
    expect(block).toMatch(/do not present it as the position right now/i);
  });

  it("reaches the model's input, after the verified context", () => {
    const input = buildDraftInput(request({ tracking: result() }));
    expect(input).toMatch(/VERIFIED TRACKING INFORMATION/);
    expect(input.indexOf("VERIFIED TRACKING")).toBeGreaterThan(input.indexOf("VERIFIED CONTEXT"));
  });

  it("says plainly when the carrier has reported nothing", () => {
    const block = verifiedTrackingBlock(
      result({ currentStatus: "unknown", trackingEvents: [], lastUpdated: null }),
    )!;
    expect(block).toContain("Current status: Not known");
    expect(block).toContain("the carrier has reported nothing yet");
  });
});

/* ------------------------------------------------------------------ */

describe("5. a delivery state may only come from a carrier", () => {
  const check = (reply: string, tracking: TrackingResult | null) =>
    validateDraftAccuracy({
      reply,
      facts: TRACKED,
      messages: [message("Where is my parcel?")],
      tracking,
      knowledgeAvailable: true,
    });

  /** The three claims the team named, with no tracking to support them. */
  it("rejects delivered, delayed and out for delivery when nothing verified them", () => {
    for (const reply of [
      "Good news — your parcel has been delivered.",
      "Your order was delivered on Tuesday.",
      "It shows as delivered on our system.",
      "Your parcel is delayed, sorry about that.",
      "Your delivery has been held up in the network.",
      "It is out for delivery today.",
    ]) {
      const finding = check(reply, null).findings.find((f) => f.issue === "unsupported_claim");
      expect(finding, reply).toBeDefined();
      expect(finding!.severity).toBe("critical");
      expect(finding!.ruleThatApplies).toMatch(/Delivery status/);
    }
  });

  it("accepts the claim the carrier actually supports", () => {
    const delivered = result({ currentStatus: "delivered" });
    expect(
      check("Your parcel has been delivered.", delivered).findings.filter(
        (f) => f.ruleThatApplies?.includes("Delivery status"),
      ),
    ).toEqual([]);
  });

  /**
   * Tracking present is not a licence for any delivery claim.
   *
   * THE CORRECTION NAMES THE STATUS IN CUSTOMER LANGUAGE, and this assertion
   * changed on purpose. It used to require the identifier `in_transit`, which
   * was the defect rather than the contract: the correction is handed straight
   * to a regeneration whose whole job is to write to a customer, so telling it
   * to say "in_transit" invited exactly the leak this file now guards against.
   */
  it("rejects a claim the carrier's status does not support", () => {
    const inTransit = result({ currentStatus: "in_transit" });
    const finding = check("Your parcel has been delivered.", inTransit).findings.find((f) =>
      f.ruleThatApplies?.includes("Delivery status"),
    );
    expect(finding).toBeDefined();
    expect(finding!.regenerationReason).toContain("Your parcel is currently in transit.");
    expect(finding!.regenerationReason).not.toContain("in_transit");
  });

  /** A reply may not be more certain than the carrier. */
  it("treats an unknown carrier status as supporting nothing", () => {
    const unknown = result({ currentStatus: "unknown" });
    expect(
      check("Your parcel has been delivered.", unknown).findings.some((f) =>
        f.ruleThatApplies?.includes("Delivery status"),
      ),
    ).toBe(true);
  });

  /**
   * Asking about delivery is not claiming one. A pattern that fired on the bare
   * word would flag most delivery replies ever written.
   */
  it("does not fire on a question or a condition about delivery", () => {
    for (const reply of [
      "Could you confirm whether it has been delivered?",
      "If it has not been delivered by Friday, please let us know.",
      "We will let you know as soon as we have a delivery update.",
      "Your order was dispatched and is on its way to you.",
    ]) {
      expect(
        check(reply, null).findings.filter((f) => f.ruleThatApplies?.includes("Delivery status")),
        reply,
      ).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("7. nothing secret is exposed", () => {
  it("logs a reason, never the reference or the customer's words", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args) => lines.push(args.join(" ")));
    vi.spyOn(console, "info").mockImplementation((...args) => lines.push(args.join(" ")));

    await resolveTrackingContext({ category: "Delivery queries", facts: TRACKED });

    const log = lines.join("\n");
    expect(log).not.toContain("AB123456789GB");
    expect(log).not.toContain("AA-11111-11111");
    expect(log).not.toContain("Where is my parcel");
  });

  it("puts no credential in the prompt block", () => {
    const block = verifiedTrackingBlock(result())!.toLowerCase();
    for (const secret of ["client_secret", "api_key", "bearer", "access_token", "authorization"]) {
      expect(block, secret).not.toContain(secret);
    }
  });
});
