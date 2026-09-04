import { describe, expect, it } from "vitest";

import { verifiedTrackingBlock } from "@/lib/ai/draft-assembly";
import { validateDraftAccuracy } from "@/lib/ai/draft-validation";
import type { VerifiedFact } from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";
import {
  CUSTOMER_DELIVERY_LANGUAGE,
  DISPATCHED_SENTENCE,
  customerDeliveryDate,
  customerDeliveryStatus,
} from "@/lib/domain/tracking-customer-language";
import { TRACKING_STATUSES, type TrackingResult, type TrackingStatus } from "@/lib/tracking/provider";

/**
 * Internal tracking evidence, and the words a customer actually reads.
 *
 * THE FAILURE THIS FILE EXISTS FOR. A delivery draft came back saying:
 *
 *   "Royal Mail tracking shows Data Received on 28 August at 05:56 and Not yet
 *    with the carrier."
 *
 * Every word verified. "Data Received" is the carrier's own pre-scan event,
 * "05:56" is a database timestamp, and "Not yet with the carrier" is OUR label,
 * written for the reviewer's sidebar — the customer was handed a database row.
 *
 * WHAT IS PINNED HERE, on both sides of the model:
 *
 *   input   the block gives ONE customer-facing sentence and labels everything
 *           the carrier said as evidence. The evidence is still there — it was
 *           never the problem — but it is no longer presented as language.
 *   output  a reply containing that wording is a critical finding and buys a
 *           regeneration, while the ordinary delivery words a customer expects
 *           pass untouched.
 *
 * THE SECOND HALF IS LOAD-BEARING. A check that failed "your parcel is out for
 * delivery" would cost a second model call on every good delivery draft, which
 * is a worse outcome than the leak it was written to stop.
 */

const ORDERED: VerifiedFact[] = [
  { name: "order_number", value: "AA-11111-11111" },
  { name: "order_status", value: "Completed" },
];

/** The same order once a shipment is booked — this is what establishes dispatch. */
const DISPATCHED: VerifiedFact[] = [
  ...ORDERED,
  { name: "tracking_number", value: "AB123456789GB" },
  { name: "delivery_courier", value: "Royal Mail 48" },
];

function result(
  currentStatus: TrackingStatus,
  events: TrackingResult["trackingEvents"],
  lastUpdated: string | null = events.at(-1)?.timestamp ?? null,
): TrackingResult {
  return {
    carrier: "royal_mail",
    trackingNumber: "AB123456789GB",
    currentStatus,
    trackingEvents: events,
    lastUpdated,
    source: { provider: "source_database", retrieval: "cached" },
  };
}

/** The label made and never scanned — the state behind the reported failure. */
const PRE_TRANSIT = result("pre_transit", [
  {
    status: "pre_transit",
    description: "Data Received",
    location: null,
    timestamp: "2026-08-28 05:56:12",
  },
]);

const DELIVERED = result("delivered", [
  {
    status: "pre_transit",
    description: "Data Received",
    location: null,
    timestamp: "2026-08-28 05:56:12",
  },
  {
    status: "delivered",
    description: "Package delivered",
    location: null,
    timestamp: "2026-08-30 12:35:03",
  },
]);

const OUT_FOR_DELIVERY = result("out_for_delivery", [
  {
    status: "out_for_delivery",
    description: "Out for delivery",
    location: null,
    timestamp: "2026-08-30 08:18:52",
  },
]);

const EXCEPTION = result("exception", [
  {
    status: "returned_to_sender",
    description: "Returned at Sort Facility Birmingham Service Centre - GBR",
    location: null,
    timestamp: "2026-08-30 19:02:11",
  },
]);

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

/** One reply, checked as the accuracy gate checks it. */
function leaks(reply: string, tracking: TrackingResult | null = DELIVERED) {
  return validateDraftAccuracy({
    reply,
    facts: DISPATCHED,
    messages: [message("Where is my parcel?")],
    tracking,
    knowledgeAvailable: true,
  }).findings.filter((finding) => finding.issue === "technical_tracking_language");
}

/* ------------------------------------------------------------------ */

describe("the customer-facing vocabulary", () => {
  /**
   * TOTAL, and checked rather than trusted. A status with no wording would fall
   * through to a holding line that says less than we know, and the compiler
   * only catches that for a status added to the union — not for one whose entry
   * was written and then deleted.
   */
  it("has a sentence for every status the tracking layer can return", () => {
    for (const status of TRACKING_STATUSES) {
      expect(CUSTOMER_DELIVERY_LANGUAGE[status].sentence, status).not.toBe("");
    }
  });

  it("says each milestone in the words the team asked for", () => {
    expect(CUSTOMER_DELIVERY_LANGUAGE.in_transit.sentence).toBe(
      "Your parcel is currently in transit.",
    );
    expect(CUSTOMER_DELIVERY_LANGUAGE.out_for_delivery.sentence).toBe(
      "Your parcel is out for delivery.",
    );
    expect(CUSTOMER_DELIVERY_LANGUAGE.delivered.sentence).toBe("Your parcel has been delivered.");
    expect(CUSTOMER_DELIVERY_LANGUAGE.awaiting_collection.sentence).toBe(
      "Your parcel is ready for collection.",
    );
    expect(DISPATCHED_SENTENCE).toBe("Your order has been dispatched and is on its way.");
  });

  /** The two states that are not a position, and must not be dressed up as one. */
  it("holds the line on exception and unknown", () => {
    expect(CUSTOMER_DELIVERY_LANGUAGE.exception.sentence).toBe(
      "We are checking the delivery status with the courier.",
    );
    expect(CUSTOMER_DELIVERY_LANGUAGE.unknown.sentence).toBe(
      "We are checking the latest delivery information.",
    );
    expect(CUSTOMER_DELIVERY_LANGUAGE.exception.statesAPosition).toBe(false);
    expect(CUSTOMER_DELIVERY_LANGUAGE.unknown.statesAPosition).toBe(false);
    expect(CUSTOMER_DELIVERY_LANGUAGE.pre_transit.statesAPosition).toBe(false);
  });

  /** A date, never a time. The scan's clock reading is not a customer's business. */
  it("gives a date and drops the time of day", () => {
    expect(customerDeliveryDate("2026-08-30 12:35:03")).toBe("30 Aug 2026");
    expect(customerDeliveryDate(null)).toBeNull();
    // An unparseable timestamp yields nothing rather than the raw string.
    expect(customerDeliveryDate("last Tuesday-ish")).toBeNull();
  });

  /**
   * DISPATCH COMES FROM THE ORDER, NEVER FROM A SCAN. "Data Received" means a
   * label exists and the carrier has not touched the parcel; reading it as
   * dispatch would invent a movement out of its absence.
   */
  it("never reads a pre-transit scan as dispatch on its own", () => {
    expect(customerDeliveryStatus(PRE_TRANSIT, false)).toEqual({
      sentence: "We are checking the latest delivery information.",
      statesAPosition: false,
      source: "none",
    });
  });

  it("says dispatched when the order establishes it", () => {
    expect(customerDeliveryStatus(PRE_TRANSIT, true)).toEqual({
      sentence: DISPATCHED_SENTENCE,
      statesAPosition: true,
      source: "order",
    });
  });

  /**
   * A DISPATCHED PARCEL IN TROUBLE IS NOT "ON ITS WAY". Dispatch speaks only
   * where the carrier has nothing to say, never over an exception — the
   * reassurance would contradict the very record it was drawn from.
   */
  it("does not let dispatch speak over an exception", () => {
    expect(customerDeliveryStatus(EXCEPTION, true)).toEqual({
      sentence: "We are checking the delivery status with the courier.",
      statesAPosition: false,
      source: "none",
    });
  });

  /** A carrier position is the more specific claim, so it wins over dispatch. */
  it("prefers what the carrier reports over the order's dispatch", () => {
    expect(customerDeliveryStatus(DELIVERED, true).sentence).toBe("Your parcel has been delivered.");
    expect(customerDeliveryStatus(DELIVERED, true).source).toBe("tracking");
  });
});

/* ------------------------------------------------------------------ */

describe("1. pre transit — a label made and nothing scanned", () => {
  const block = verifiedTrackingBlock(PRE_TRANSIT, DISPATCHED)!;

  it("offers the dispatch sentence, because the order establishes dispatch", () => {
    expect(block).toContain("CUSTOMER-FACING DELIVERY STATUS");
    expect(block).toContain(DISPATCHED_SENTENCE);
  });

  it("keeps the carrier's own event, labelled as evidence and nothing else", () => {
    expect(block).toContain("INTERNAL TRACKING EVIDENCE — FOR YOUR REASONING ONLY");
    expect(block).toContain("Data Received");
    // The evidence sits after the customer wording, never in front of it.
    expect(block.indexOf("CUSTOMER-FACING DELIVERY STATUS")).toBeLessThan(
      block.indexOf("INTERNAL TRACKING EVIDENCE"),
    );
  });

  it("dates nothing from a label scan", () => {
    expect(block).not.toContain("You may also say that this was on");
  });

  /** Without a booked shipment there is no dispatch to state, only a holding line. */
  it("falls back to the holding line when nothing establishes dispatch", () => {
    const unshipped = verifiedTrackingBlock(PRE_TRANSIT, ORDERED)!;
    expect(unshipped).toContain("We are checking the latest delivery information.");
    expect(unshipped).not.toContain(DISPATCHED_SENTENCE);
    expect(unshipped).toContain("Nothing above states where the parcel is");
  });

  it("rejects the reply that quotes the scan", () => {
    const finding = leaks("Royal Mail shows Data Received.", PRE_TRANSIT)[0];
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("critical");
    expect(finding!.regenerationReason).toContain("evidence for your reasoning only");
  });

  /**
   * BY STATUS, NOT BY PHRASE. None of these three appeared in the failure that
   * prompted the work; all three are the same pre-dispatch state wearing
   * different carrier wording.
   */
  it("rejects the pre-dispatch wording the customer has never seen either", () => {
    for (const reply of [
      "Tracking shows Label Created but no movement yet.",
      "The carrier has only recorded Shipment information received so far.",
      "Manifest generated on our side, nothing further.",
    ]) {
      expect(leaks(reply, PRE_TRANSIT), reply).not.toEqual([]);
    }
  });
});

describe("2. dispatched — the word stays available", () => {
  it("passes the sentence the team asked for", () => {
    expect(leaks(DISPATCHED_SENTENCE, PRE_TRANSIT)).toEqual([]);
  });

  /**
   * The whole risk of a leakage check is that it makes the model timid. These
   * are the ordinary things a delivery reply says, and every one of them must
   * survive untouched.
   */
  it("passes ordinary delivery wording", () => {
    for (const reply of [
      "Your order has been dispatched and is on its way.",
      "Your parcel is currently in transit.",
      "Your parcel is out for delivery.",
      "Your parcel has been delivered.",
      "Your parcel is ready for collection.",
      "Your order was dispatched and the courier has it now.",
      "We dispatched your order and it is in transit with Royal Mail.",
    ]) {
      expect(leaks(reply), reply).toEqual([]);
    }
  });
});

describe("3. delivered", () => {
  const block = verifiedTrackingBlock(DELIVERED, DISPATCHED)!;

  it("offers the delivered sentence and the date without a time", () => {
    expect(block).toContain("Your parcel has been delivered.");
    expect(block).toContain("You may also say that this was on 30 Aug 2026");
    expect(block).toContain("Give the date only — never a time of day.");
  });

  it("passes a natural delivered reply", () => {
    expect(leaks("Your parcel has been delivered on 30 Aug 2026.")).toEqual([]);
  });

  it("rejects the scan read aloud", () => {
    expect(leaks("Package delivered event code at 12:35:03.")).not.toEqual([]);
  });
});

describe("4. out for delivery", () => {
  it("offers the out-for-delivery sentence", () => {
    const block = verifiedTrackingBlock(OUT_FOR_DELIVERY, DISPATCHED)!;
    expect(block).toContain("Your parcel is out for delivery.");
  });

  it("passes it in a reply", () => {
    expect(leaks("Your parcel is out for delivery.", OUT_FOR_DELIVERY)).toEqual([]);
  });
});

describe("5. exception — a facility name is not an answer", () => {
  it("offers the holding sentence instead of the carrier's wording", () => {
    const block = verifiedTrackingBlock(EXCEPTION, DISPATCHED)!;
    expect(block).toContain("We are checking the delivery status with the courier.");
    expect(block).toContain("Nothing above states where the parcel is");
    // The carrier's own line is still available to reason from.
    expect(block).toContain("Returned at Sort Facility Birmingham Service Centre - GBR");
  });

  it("passes the holding reply", () => {
    expect(leaks("We are checking the delivery status with the courier.", EXCEPTION)).toEqual([]);
  });

  it("rejects the facility name", () => {
    expect(
      leaks("Returned at Sort Facility Birmingham Service Centre.", EXCEPTION),
    ).not.toEqual([]);
  });
});

describe("our own vocabulary is the likeliest leak", () => {
  it("rejects the internal identifiers and the reviewer's labels", () => {
    for (const reply of [
      "The status is pre_transit at the moment.",
      "Tracking is showing out_for_delivery today.",
      "It is recorded as returned_to_sender.",
      "The parcel is not yet with the carrier.",
      "The carrier has it as Held — needs investigation.",
      "The last scan was 2026-08-28 05:56:12.",
    ]) {
      expect(leaks(reply), reply).not.toEqual([]);
    }
  });

  /**
   * A DELIVERY WINDOW IS NOT A DATABASE TIMESTAMP. A bare clock time is
   * something a correct reply may well contain, and failing it would buy a
   * regeneration on a draft that was right.
   */
  it("leaves a plain time of day alone", () => {
    expect(leaks("The courier delivers in your area between 8:00 and 18:00.")).toEqual([]);
  });

  it("reports the whole failure and buys one regeneration", () => {
    const validation = validateDraftAccuracy({
      reply: "Royal Mail tracking shows Data Received on 28 August and Not yet with the carrier.",
      facts: DISPATCHED,
      messages: [message("Where is my parcel?")],
      tracking: PRE_TRANSIT,
      knowledgeAvailable: true,
    });

    expect(validation.passed).toBe(false);
    expect(validation.regenerationWarranted).toBe(true);
    expect(validation.corrections.join(" ")).toContain(
      "Use the verified delivery status and explain it naturally to the customer",
    );
    // The reviewer sees it too, whether or not the regeneration fixes it.
    expect(validation.notes.join(" ")).toContain("technical tracking language");
  });

  /**
   * The check is about the TEXT, not about the rules or the lookup. A draft
   * naming an internal status with no tracking supplied is worse, not better.
   */
  it("applies with no tracking and with no knowledge base", () => {
    const validation = validateDraftAccuracy({
      reply: "The shipment is pre_transit.",
      facts: [],
      messages: [message("Where is my parcel?")],
      tracking: null,
      knowledgeAvailable: false,
    });
    expect(
      validation.findings.some((finding) => finding.issue === "technical_tracking_language"),
    ).toBe(true);
  });
});

describe("6. the register rule reaches the model", () => {
  const block = verifiedTrackingBlock(DELIVERED, DISPATCHED)!;

  it("states that events are evidence and never customer language", () => {
    expect(block).toContain("TRACKING EVENTS AND CARRIER DESCRIPTIONS ARE EVIDENCE FOR REASONING ONLY.");
    expect(block).toContain("They are not customer-facing language.");
    expect(block).toMatch(/Never repeat a raw carrier event description/);
  });

  it("names the examples the validator actually catches", () => {
    for (const example of [
      "Data Received",
      "Label Created",
      "Shipment information received",
      "Manifest generated",
      "pre_transit",
      "Sort Facility",
    ]) {
      expect(block, example).toContain(example);
    }
  });

  /** It must not read as "say as little as possible about delivery". */
  it("keeps the ordinary delivery words explicitly permitted", () => {
    expect(block).toContain("THE ORDINARY DELIVERY WORDS REMAIN ORDINARY.");
    expect(block).toMatch(/"Dispatched", "in transit", "out for delivery", "delivered"/);
  });

  /** No longer told to repeat the carrier — three sentences used to say so. */
  it("no longer tells the model to say what the carrier recorded", () => {
    expect(block).not.toMatch(/say what the carrier (?:recorded|last recorded)/i);
  });
});
