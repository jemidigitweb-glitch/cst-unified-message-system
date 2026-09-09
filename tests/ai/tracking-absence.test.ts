import { describe, expect, it } from "vitest";

import { buildDraftInput, noVerifiedTrackingBlock } from "@/lib/ai/draft-assembly";
import { validateDraftAccuracy } from "@/lib/ai/draft-validation";
import type { DraftRequest } from "@/lib/ai/provider";
import { TRACKING_CATEGORY } from "@/lib/context/resolve-tracking-context";
import type { VerifiedFact } from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";
import type { TrackingResult } from "@/lib/tracking/provider";

/**
 * TRACKING MENTIONED WHEN THERE IS NO TRACKING.
 *
 * THE DRAFTS THIS EXISTS FOR. With no carrier data the prompt simply omitted
 * its tracking block, so the model was told nothing at all about tracking —
 * and answering "where is my parcel?" it filled the gap the way a helpful
 * assistant does:
 *
 *   "Here is your tracking number..."
 *   "Please check your tracking details..."
 *   "You can track your parcel using..."
 *
 * None of it supportable, and all of it sends a customer looking for a record
 * that may not exist.
 *
 * WHAT IS PINNED HERE. Absence of tracking is TWO situations, not one, and they
 * permit different replies:
 *
 *   - nothing established        tracking may not be mentioned in any form
 *   - a number, no carrier read  the number may be given, with no update on it
 *   - a full carrier result      unchanged, exactly as before
 *
 * Everything under test is pure: no network, no key, no vendor, no database.
 */

function message(bodyText: string): ConversationMessageView {
  return {
    id: `m-${bodyText.slice(0, 8)}`,
    direction: "inbound",
    sourceTimestamp: "2026-09-08 09:00:00",
    bodyText,
    bodyDecodeStatus: "decoded",
    attachments: [],
  };
}

const WHERE_IS_IT = "Where is my parcel? It was supposed to be here by now.";
const PRE_SALE = "Could you tell me the weight of this lampshade please?";
const DAMAGED = "The item arrived damaged, the glass is cracked.";

/** An order that resolved, with nothing about a shipment on it. */
const NO_SHIPMENT: VerifiedFact[] = [
  { name: "order_number", value: "11-11111-11111" },
  { name: "order_status", value: "Completed" },
];

/** The same order, with a tracking number the carrier could not be read for. */
const NUMBER_ONLY: VerifiedFact[] = [
  ...NO_SHIPMENT,
  { name: "tracking_number", value: "AB123456789GB" },
  { name: "delivery_courier", value: "Royal Mail" },
];

const TRACKING: TrackingResult = {
  carrier: "royal_mail",
  trackingNumber: "AB123456789GB",
  currentStatus: "in_transit",
  lastUpdated: "2026-09-06 11:04:00",
  trackingEvents: [
    {
      timestamp: "2026-09-06 11:04:00",
      status: "in_transit",
      description: "Item received at delivery office",
      location: "Sheffield Mail Centre",
    },
  ],
  source: { provider: "royal_mail", retrieval: "live" },
};

function request(
  text: string,
  facts: VerifiedFact[],
  tracking: TrackingResult | null = null,
): DraftRequest {
  return {
    messages: [message(text)],
    marketplace: "ebay",
    listingItemRef: "123456789012",
    facts,
    tracking,
  };
}

/* ------------------------------------------------------------------ *
 * 1. NO SHIPMENT DATA
 * ------------------------------------------------------------------ */

describe("no shipment data at all", () => {
  const input = buildDraftInput(request(WHERE_IS_IT, NO_SHIPMENT));

  it("tells the model plainly that there is no tracking", () => {
    expect(input).toMatch(/NO SHIPMENT TRACKING FOR THIS ORDER\./);
    expect(input).toMatch(/No tracking number, courier or delivery status has been established/);
  });

  it("forbids every form of mentioning it, not just stating a number", () => {
    expect(input).toMatch(/no tracking link or page, no courier name, and no delivery status/);
    expect(input).toMatch(/Do NOT ask the customer to check, look up, refresh or send you tracking/);
  });

  /*
   * The subtle one. "Unfortunately no tracking is available for your order" is
   * still a sentence about a tracking record, and a customer reads it as one
   * existing somewhere.
   */
  it("forbids the polite version that still implies a record exists", () => {
    expect(input).toMatch(/do not tell them tracking is unavailable/);
  });

  it("says the absence is ours, not a fact about the parcel", () => {
    expect(input).toMatch(/an absence in what we can see, not a fact about the parcel/);
  });

  it("supplies no verified tracking block to contradict it", () => {
    expect(input).not.toMatch(/VERIFIED TRACKING INFORMATION:/);
    expect(input).not.toMatch(/CUSTOMER-FACING DELIVERY STATUS/);
  });
});

/* ------------------------------------------------------------------ *
 * 2. TRACKING AVAILABLE — UNCHANGED
 * ------------------------------------------------------------------ */

describe("a carrier result was retrieved", () => {
  const input = buildDraftInput(request(WHERE_IS_IT, NUMBER_ONLY, TRACKING));

  it("supplies the verified tracking block exactly as before", () => {
    expect(input).toMatch(/VERIFIED TRACKING INFORMATION:/);
    expect(input).toMatch(/AB123456789GB/);
    expect(input).toMatch(/CUSTOMER-FACING DELIVERY STATUS/);
    expect(input).toMatch(/Item received at delivery office/);
  });

  it("adds no absence guidance that would contradict it", () => {
    expect(input).not.toMatch(/NO SHIPMENT TRACKING FOR THIS ORDER/);
    expect(input).not.toMatch(/NO CARRIER UPDATE FOR THIS SHIPMENT/);
  });

  it("does not fault a reply that gives the tracking number", () => {
    const validation = validateDraftAccuracy({
      reply:
        "Thank you for getting in touch. Your tracking number is AB123456789GB and we will keep an eye on it for you.",
      facts: NUMBER_ONLY,
      messages: [message(WHERE_IS_IT)],
      tracking: TRACKING,
      knowledgeAvailable: true,
    });
    expect(
      validation.findings.filter((f) => f.issue === "unsupported_claim").map((f) => f.ruleThatApplies),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 3. A NUMBER, BUT NO CARRIER UPDATE
 * ------------------------------------------------------------------ */

describe("a tracking number with no readable carrier update", () => {
  const input = buildDraftInput(request(WHERE_IS_IT, NUMBER_ONLY));

  it("permits the number and the absence of news", () => {
    expect(input).toMatch(/NO CARRIER UPDATE FOR THIS SHIPMENT\./);
    expect(input).toMatch(/You may give that number and say we have no further update on it yet/);
  });

  it("still forbids a position, a movement or an arrival", () => {
    expect(input).toMatch(
      /You may NOT say where the parcel is, that it is on its way, in transit, out for delivery, delivered, or when it will arrive/,
    );
  });

  it("does not use the harsher no-tracking wording", () => {
    expect(input).not.toMatch(/NO SHIPMENT TRACKING FOR THIS ORDER/);
  });
});

/* ------------------------------------------------------------------ *
 * THE DETERMINISTIC HALF
 * ------------------------------------------------------------------ */

describe("the accuracy gate enforces it, rather than trusting the instruction", () => {
  const reported = (reply: string, facts: VerifiedFact[]) =>
    validateDraftAccuracy({
      reply,
      facts,
      messages: [message(WHERE_IS_IT)],
      tracking: null,
      knowledgeAvailable: true,
    }).findings.filter((finding) => finding.regenerationReason.includes("raises tracking"));

  it.each([
    "Please check your tracking details for the latest position.",
    "You can track your parcel using the link in your order confirmation.",
    "Here is your tracking number: AB123456789GB.",
    "I have attached the tracking information for you.",
    "Please check the tracking page for an update.",
    "You can track the order on the courier's website.",
  ])("faults %j when no tracking number was established", (reply) => {
    const findings = reported(reply, NO_SHIPMENT);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("critical");
  });

  it("permits the same sentence once a tracking number is verified", () => {
    expect(reported("Please check your tracking details for the latest position.", NUMBER_ONLY)).toEqual(
      [],
    );
  });

  /*
   * The check must not fire on ordinary English. "On track" and "backtrack"
   * contain the word and say nothing about a consignment.
   */
  it.each([
    "We are on track to get this resolved for you today.",
    "Sorry, I need to backtrack — I gave you the wrong size.",
    "Your order is being picked and packed now.",
  ])("leaves %j alone", (reply) => {
    expect(reported(reply, NO_SHIPMENT)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * WHERE THE BLOCK APPEARS AT ALL
 * ------------------------------------------------------------------ */

describe("only where tracking could have been in play", () => {
  it.each([
    ["a pre-sale question", PRE_SALE],
    ["a damage report", DAMAGED],
  ])("stays out of %s", (_label, text) => {
    const input = buildDraftInput(request(text, NO_SHIPMENT));
    expect(input).not.toMatch(/NO SHIPMENT TRACKING FOR THIS ORDER/);
    expect(input).not.toMatch(/NO CARRIER UPDATE FOR THIS SHIPMENT/);
  });

  it("returns nothing for a null category", () => {
    expect(noVerifiedTrackingBlock(null, NO_SHIPMENT)).toBeNull();
  });

  /**
   * The gate is the SAME question `resolveTrackingContext` asks before calling
   * a carrier. Pinned equal because the constant is duplicated rather than
   * imported — that module is `server-only` and pulls the provider and cache
   * behind it, which is a heavy dependency for one string.
   */
  it("uses the same category that decides whether to look tracking up", () => {
    expect(noVerifiedTrackingBlock(TRACKING_CATEGORY, NO_SHIPMENT)).toMatch(
      /NO SHIPMENT TRACKING FOR THIS ORDER/,
    );
  });

  /** An empty tracking number is not a tracking number. */
  it("treats a blank tracking number as no tracking", () => {
    const blank = [...NO_SHIPMENT, { name: "tracking_number", value: "   " }];
    expect(noVerifiedTrackingBlock(TRACKING_CATEGORY, blank)).toMatch(
      /NO SHIPMENT TRACKING FOR THIS ORDER/,
    );
  });
});
