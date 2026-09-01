import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildDraftInput, verifiedTrackingBlock } from "@/lib/ai/draft-assembly";
import type { DraftRequest } from "@/lib/ai/provider";
import type { VerifiedFact } from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";
import type { TrackingResult } from "@/lib/tracking/provider";

/**
 * The model is told what we already know about the parcel, on every category.
 *
 * THE BUG THIS FILE EXISTS FOR. A draft on a return told the customer:
 *
 *   "Please send us the latest tracking update and collection deadline so we
 *    can review the next step."
 *
 * while the system held a scan history showing the parcel delivered. Two
 * separate faults produced it, and both are pinned here:
 *
 *   1. tracking never reached the request at all — the draft's lookup was gated
 *      on "Delivery queries", and a return is not one.
 *   2. nothing in the prompt said the tracking was authoritative, so even where
 *      it did arrive the model was free to ask for it again.
 *
 * Everything below is assertion on the INPUT the model receives. What the model
 * then writes is its own business and is checked by the accuracy gate; what can
 * be guaranteed here is that it was never short of the facts.
 */

const ROOT = join(__dirname, "..", "..");

function read(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const draftRoute = read("app", "api", "conversations", "[conversationId]", "draft", "route.ts");

function message(body: string): ConversationMessageView {
  return {
    id: "1",
    direction: "inbound",
    sourceTimestamp: "2026-08-31 09:00:00",
    bodyText: body,
    bodyDecodeStatus: "decoded",
    attachments: [],
  };
}

const FACTS: VerifiedFact[] = [
  { name: "order_number", value: "AA-11111-11111" },
  { name: "order_status", value: "Completed" },
  { name: "tracking_number", value: "AB123456789GB" },
  { name: "delivery_courier", value: "Royal Mail 48" },
];

/** A delivered parcel with a full journey behind it. */
function tracking(overrides: Partial<TrackingResult> = {}): TrackingResult {
  return {
    carrier: "royal_mail",
    trackingNumber: "AB123456789GB",
    currentStatus: "delivered",
    trackingEvents: [
      {
        status: "pre_transit",
        description: "Data Received",
        location: null,
        timestamp: "2026-08-28 06:29:37",
      },
      {
        status: "in_transit",
        description: "Received by local delivery company",
        location: null,
        timestamp: "2026-08-29 18:56:59",
      },
      {
        status: "out_for_delivery",
        description: "Out for delivery",
        location: null,
        timestamp: "2026-08-30 08:18:52",
      },
      {
        status: "delivered",
        description: "Package delivered",
        location: null,
        timestamp: "2026-08-30 12:35:03",
      },
    ],
    lastUpdated: "2026-08-30 12:35:03",
    source: { provider: "source_database", retrieval: "cached" },
    ...overrides,
  };
}

function request(body: string, result: TrackingResult | null): DraftRequest {
  return {
    messages: [message(body)],
    marketplace: "ebay",
    listingItemRef: "123456789012",
    facts: FACTS,
    tracking: result,
  };
}

/**
 * The five conversations named in the change request, one per category the old
 * gate excluded. Each asserts the same thing: the shipment reached the model.
 */
const CONVERSATIONS: readonly (readonly [string, string])[] = [
  ["a delivery question", "Where is my parcel?"],
  ["a wrong item return", "I returned the wrong item, when will it arrive?"],
  ["a refund chase", "I sent the item back but I have had no refund."],
  ["a missing replacement", "My replacement has not arrived."],
  ["a damage claim", "The lampshade arrived cracked, what happens now?"],
];

describe("tracking reaches the draft whatever the customer asked", () => {
  for (const [label, body] of CONVERSATIONS) {
    it(`puts the verified shipment in front of the model for ${label}`, () => {
      const input = buildDraftInput(request(body, tracking()));

      expect(input).toContain("VERIFIED TRACKING INFORMATION:");
      expect(input).toContain("Current status: Delivered");
      expect(input).toContain("Tracking number: AB123456789GB");
      expect(input).toContain("Carrier: Royal Mail");
    });
  }

  /**
   * The route-level half of the fix. A prompt instruction cannot help a request
   * that carries no tracking, and the gate is what decided that.
   */
  it("no longer gates the draft's lookup on the conversation's category", () => {
    expect(draftRoute).toContain("resolveVerifiedTracking");
    expect(draftRoute).not.toContain("resolveTrackingContext");
  });
});

describe("the instruction not to ask for what we hold", () => {
  it("states that verified tracking is authoritative", () => {
    const block = verifiedTrackingBlock(tracking())!;
    expect(block).toContain(
      "VERIFIED SHIPMENT TRACKING INFORMATION IS AUTHORITATIVE. Use it before requesting information from the customer.",
    );
  });

  it("names the three things the model must not ask for", () => {
    const block = verifiedTrackingBlock(tracking())!.toLowerCase();
    expect(block).toContain("never ask them for the latest tracking update");
    expect(block).toContain("current parcel status");
    expect(block).toContain("tracking history");
  });

  it("keeps the standing rule against inventing movement", () => {
    const block = verifiedTrackingBlock(tracking())!;
    expect(block).toMatch(/USE ONLY THIS VERIFIED TRACKING INFORMATION/);
    expect(block).toMatch(/do not describe any movement not listed above/i);
  });
});

/**
 * AVAILABLE IS NOT THE SAME AS WORTH SAYING.
 *
 * The regression these pin, in the words that produced it: a customer wrote
 * "the driver is missing from my order, I need a refund" and was answered with
 * "the carrier last recorded the parcel as delivered on 28 August at 13:21".
 * Every word verified, and an answer to a question nobody asked — it reads as
 * deflection and buries the part they wanted.
 */
describe("tracking is evidence, not mandatory reply content", () => {
  it("tells the model to decide whether the customer needs it", () => {
    const block = verifiedTrackingBlock(tracking())!;
    expect(block).toContain("IT IS EVIDENCE, NOT SOMETHING YOU MUST REPEAT.");
    expect(block).toMatch(
      /does this customer need delivery or shipment information to have THEIR message answered/,
    );
  });

  /** The YES branch: the questions where the parcel's position IS the answer. */
  it("names the questions that call for tracking in the reply", () => {
    const block = verifiedTrackingBlock(tracking())!.toLowerCase();
    for (const cue of [
      "where the parcel is",
      "whether it arrived",
      "when it will come",
      "a delay",
      "a delivery attempt",
      "a redelivery",
      "a collection",
    ]) {
      expect(block, cue).toContain(cue);
    }
  });

  /** The NO branch: the cases that produced the narration bug. */
  it("names the questions that do not, and says to stay silent on it", () => {
    const block = verifiedTrackingBlock(tracking())!.toLowerCase();
    for (const cue of [
      "a missing part",
      "a refund amount",
      "a replacement decision",
      "a wrong or damaged item",
    ]) {
      expect(block, cue).toContain(cue);
    }
    expect(block).toContain("use the tracking silently");
    expect(block).toContain("do not narrate it");
    expect(block).toContain("answer the question they actually asked");
  });

  /**
   * The rule must not become "never mention it". A customer contradicting a
   * Delivered scan has made the record relevant by disputing it.
   */
  it("makes a conflict relevant again", () => {
    const block = verifiedTrackingBlock(tracking())!;
    expect(block).toContain(
      "If what the customer describes conflicts with the record above, that makes it relevant",
    );
  });

  /**
   * THE SAME BLOCK REACHES EVERY CATEGORY. The relevance decision is the
   * model's, made per conversation — it is deliberately not a second gate in
   * code, because "is this customer asking about delivery" is exactly the
   * judgement a keyword list gets wrong.
   */
  it("gives the same guidance whatever the customer asked", () => {
    const forRefund = buildDraftInput(
      request("The driver is missing from my order. I need a refund.", tracking()),
    );
    const forDelivery = buildDraftInput(request("Where is my parcel?", tracking()));

    for (const input of [forRefund, forDelivery]) {
      expect(input).toContain("IT IS EVIDENCE, NOT SOMETHING YOU MUST REPEAT.");
      expect(input).toContain("Current status: Delivered");
    }
  });
});

describe("the whole journey, not just the last scan", () => {
  it("lists every event", () => {
    const block = verifiedTrackingBlock(tracking())!;
    expect(block).toContain("Tracking history (most recent first):");
    for (const description of [
      "Data Received",
      "Received by local delivery company",
      "Out for delivery",
      "Package delivered",
    ]) {
      expect(block, description).toContain(description);
    }
  });

  it("puts the most recent first", () => {
    const block = verifiedTrackingBlock(tracking())!;
    const history = block.slice(block.indexOf("Tracking history"));
    expect(history.indexOf("Package delivered")).toBeLessThan(history.indexOf("Data Received"));
  });

  it("says so plainly when the carrier recorded no scans", () => {
    const block = verifiedTrackingBlock(tracking({ trackingEvents: [] }))!;
    expect(block).toContain("Tracking history: (none recorded)");
    expect(block).toContain("Latest scan: (none recorded)");
  });

  /** The forbidden field, one last time — the prompt is the final destination. */
  it("carries no location into the prompt", () => {
    const block = verifiedTrackingBlock(
      tracking({
        trackingEvents: [
          {
            status: "delivered",
            description: "Package delivered",
            location: null,
            timestamp: "2026-08-30 12:35:03",
          },
        ],
      }),
    )!;
    expect(block).not.toMatch(/\bat null\b/);
    expect(block).not.toMatch(/signer|pod_image|parcel_image|geo/i);
  });
});

describe("when there is no tracking to use", () => {
  /**
   * The block is ABSENT, not empty. A section saying "no tracking was
   * retrieved" on every other draft would be noise the model reads past, and
   * the draft is then free to ask the customer — which is correct, because in
   * this state we genuinely do not know.
   */
  it("omits the block entirely, leaving the model free to ask", () => {
    expect(verifiedTrackingBlock(null)).toBeNull();
    expect(verifiedTrackingBlock(undefined)).toBeNull();

    const input = buildDraftInput(request("I sent the item back but no refund.", null));
    expect(input).not.toMatch(/VERIFIED TRACKING/);
    expect(input).not.toMatch(/AUTHORITATIVE/);
  });

  it("changes nothing else about the request when tracking is absent", () => {
    const withoutTracking = buildDraftInput(request("Where is my parcel?", null));
    const noField = buildDraftInput({
      ...request("Where is my parcel?", null),
      tracking: undefined,
    });
    expect(withoutTracking).toBe(noField);
  });
});

describe("when the customer's account conflicts with the record", () => {
  /**
   * The instruction must not read as "never ask about the parcel". A customer
   * saying it never arrived against a Delivered scan needs their account
   * addressed, not overridden in silence.
   */
  it("tells the model to state the record and ask what would settle it", () => {
    const block = verifiedTrackingBlock(tracking())!;
    expect(block).toContain("conflicts with the record above, that makes it relevant");
    expect(block).toMatch(/ask them to confirm the detail that would settle it/i);
  });

  it("still reaches a draft where the customer contradicts a delivered parcel", () => {
    const input = buildDraftInput(
      request("It says delivered but nothing has arrived here.", tracking()),
    );
    expect(input).toContain("Current status: Delivered");
    expect(input).toContain("conflicts with the record above");
  });
});
