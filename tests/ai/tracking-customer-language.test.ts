import { describe, expect, it } from "vitest";

import { verifiedTrackingBlock } from "@/lib/ai/draft-assembly";
import { validateDraftAccuracy } from "@/lib/ai/draft-validation";
import type { VerifiedFact } from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";
import {
  CUSTOMER_DELIVERY_LANGUAGE,
  DISPATCHED_NO_MOVEMENT_SENTENCE,
  DISPATCHED_SENTENCE,
  carrierHasReportedMovement,
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

/** The same shipment once the carrier has actually scanned it into the network. */
const IN_TRANSIT = result("in_transit", [
  {
    status: "pre_transit",
    description: "Data Received",
    location: null,
    timestamp: "2026-08-28 05:56:12",
  },
  {
    status: "in_transit",
    description: "Item scanned on its journey",
    location: null,
    timestamp: "2026-08-29 18:56:59",
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

/**
 * The same reply, read for the OTHER failure — a parcel put in the network.
 *
 * Filtered by the rule rather than by `issue`, because `unsupported_claim`
 * covers several checks and only this one is about movement. Every case below
 * is run with `DISPATCHED` facts, so dispatch is established throughout and
 * what varies is solely whether the carrier scanned anything.
 */
function movementFindings(reply: string, tracking: TrackingResult | null) {
  return validateDraftAccuracy({
    reply,
    facts: DISPATCHED,
    messages: [message("Where is my parcel?")],
    tracking,
    knowledgeAvailable: true,
  }).findings.filter((finding) => finding.ruleThatApplies?.includes("movement is the carrier's"));
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
      movementConfirmed: false,
    });
  });

  /**
   * DISPATCH WITHOUT MOVEMENT SAYS SO. The order establishes that the goods
   * left us; the carrier holding a label establishes nothing about where they
   * are. "Dispatched and is on its way" over an unscanned shipment is a
   * reassurance the customer disproves by refreshing the tracking page.
   */
  it("says dispatched, and no more, when nothing has been scanned", () => {
    expect(customerDeliveryStatus(PRE_TRANSIT, true)).toEqual({
      sentence: DISPATCHED_NO_MOVEMENT_SENTENCE,
      statesAPosition: false,
      source: "order",
      movementConfirmed: false,
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
      // The parcel demonstrably moved — it reached a facility — but that is not
      // a licence to call the situation "on its way".
      movementConfirmed: true,
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
    expect(block).toContain(DISPATCHED_NO_MOVEMENT_SENTENCE);
  });

  /** And says plainly which half of it the carrier has not established. */
  it("forbids the movement half while permitting the dispatch half", () => {
    expect(block).toContain("THE CARRIER HAS NOT REPORTED THE PARCEL MOVING.");
    expect(block).toMatch(/you may say the order was dispatched, sent or handed to the courier/);
    expect(block).toMatch(/may NOT say it is "on its way", "in transit", "en route"/);
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
    expect(leaks(DISPATCHED_NO_MOVEMENT_SENTENCE, PRE_TRANSIT)).toEqual([]);
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

/* ------------------------------------------------------------------ */

/**
 * DISPATCH AND MOVEMENT ARE TWO FACTS FROM TWO SOURCES.
 *
 * THE FAILURE THIS SECTION EXISTS FOR. A dispatch confirmed by the order plus
 * no carrier movement at all was being answered "your order has been dispatched
 * and is on its way". The first half is ours to state — a shipment was booked,
 * the goods left us. The second half is the carrier's, and the carrier had said
 * nothing beyond acknowledging a label. The customer chasing that parcel is
 * looking at the same tracking page we are, which shows no movement whatsoever,
 * and a reassurance they can disprove in one click costs more than the silence
 * it replaced.
 *
 * The three cases are held apart deliberately: what changes between A and B is
 * ONLY whether a carrier scan exists, and the wording has to change with it.
 */
describe("dispatch confirmed, and whether the carrier has moved it", () => {
  /* ---------- CASE A — dispatch confirmed, Data Received only ---------- */

  describe("A. dispatch confirmed with Data Received only", () => {
    it("reads no movement from a label the carrier has merely been told about", () => {
      expect(carrierHasReportedMovement(PRE_TRANSIT)).toBe(false);
    });

    /** "Dispatched" survives in full. Taking it away would be the opposite error. */
    it("still says dispatched", () => {
      const spoken = customerDeliveryStatus(PRE_TRANSIT, true);
      expect(spoken.sentence).toContain("dispatched");
      expect(spoken.sentence).toBe(DISPATCHED_NO_MOVEMENT_SENTENCE);
      expect(spoken.movementConfirmed).toBe(false);
    });

    it("does not say on its way, in transit, or anything else that moves it", () => {
      const spoken = customerDeliveryStatus(PRE_TRANSIT, true);
      for (const banned of [/on\s+its\s+way/i, /in\s+transit/i, /en\s+route/i, /through\s+the\s+network/i]) {
        expect(spoken.sentence, String(banned)).not.toMatch(banned);
      }
    });

    /** The prompt says the same thing to the model that the gate enforces after it. */
    it("tells the model which half it may state", () => {
      const block = verifiedTrackingBlock(PRE_TRANSIT, DISPATCHED)!;
      expect(block).toContain("THE CARRIER HAS NOT REPORTED THE PARCEL MOVING.");
      expect(block).not.toContain("so movement is established");
    });

    it("passes the dispatch sentence and the honest no-movement sentence", () => {
      for (const reply of [
        "Your order has been dispatched.",
        "Your order was dispatched and handed to the courier.",
        DISPATCHED_NO_MOVEMENT_SENTENCE,
        "Your order has been dispatched, but the courier has not scanned it yet — scans can take up to 48 hours.",
      ]) {
        expect(movementFindings(reply, PRE_TRANSIT), reply).toEqual([]);
      }
    });

    it("rejects the movement half, whichever words it arrives in", () => {
      for (const reply of [
        "Your order has been dispatched and is on its way.",
        "Your parcel is currently in transit.",
        "Your order has been dispatched and is en route to you.",
        "It is moving through the network and should reach you shortly.",
        "Ihre Bestellung ist unterwegs.",
      ]) {
        const finding = movementFindings(reply, PRE_TRANSIT)[0];
        expect(finding, reply).toBeDefined();
        expect(finding!.severity, reply).toBe("critical");
      }
    });

    /**
     * AND THE REGENERATION IS TOLD WHAT TO KEEP. A correction that only says
     * "remove that" invites the model to drop the dispatch statement too, which
     * is the one true thing there was to tell this customer.
     */
    it("sends the model back with the dispatch half intact", () => {
      const finding = movementFindings("Your order has been dispatched and is on its way.", PRE_TRANSIT)[0];
      expect(finding!.regenerationReason).toContain(DISPATCHED_NO_MOVEMENT_SENTENCE);
      expect(finding!.regenerationReason).toMatch(/keep "dispatched"/);
      expect(finding!.verifiedFact).toContain("no movement");
    });
  });

  /* ---------- CASE B — dispatch confirmed, a real carrier scan ---------- */

  describe("B. dispatch confirmed with a real in-transit scan", () => {
    it("reads the carrier's scan as movement", () => {
      expect(carrierHasReportedMovement(IN_TRANSIT)).toBe(true);
    });

    /**
     * AND READS IT OUT OF THE SCANS, not only off the headline. A row this
     * system could not coarsely classify still carries scans, and a parcel
     * halfway across the country is moving whatever the summary says.
     */
    it("reads movement from a scan under an unmappable headline status", () => {
      const unmapped = result("unknown", [
        {
          status: "in_transit",
          description: "Item scanned on its journey",
          location: null,
          timestamp: "2026-08-29 18:56:59",
        },
      ]);
      expect(carrierHasReportedMovement(unmapped)).toBe(true);
    });

    it("states the carrier's own position, which is the more specific claim", () => {
      expect(customerDeliveryStatus(IN_TRANSIT, true)).toEqual({
        sentence: "Your parcel is currently in transit.",
        statesAPosition: true,
        source: "tracking",
        movementConfirmed: true,
      });
    });

    it("permits the dispatched-and-on-its-way sentence in the block", () => {
      const block = verifiedTrackingBlock(IN_TRANSIT, DISPATCHED)!;
      expect(block).toContain("The carrier has scanned this parcel, so movement is established");
      expect(block).toContain("you may also say the order has been dispatched and is on its way.");
      expect(block).not.toContain("THE CARRIER HAS NOT REPORTED THE PARCEL MOVING.");
    });

    it("lets the movement wording through the accuracy gate", () => {
      for (const reply of [
        DISPATCHED_SENTENCE,
        "Your order has been dispatched and is on its way.",
        "Your parcel is currently in transit.",
        "Your order was dispatched and it is en route to you now.",
      ]) {
        expect(movementFindings(reply, IN_TRANSIT), reply).toEqual([]);
      }
    });

    /** The scan is still evidence, and still must not be read out. */
    it("keeps the carrier's own scan wording out of the reply", () => {
      expect(leaks("Item scanned on its journey at 18:56:59.", IN_TRANSIT)).not.toEqual([]);
    });
  });

  /* ---------- the gate is about the parcel, and only the parcel ---------- */

  /**
   * A REFUND IS NOT A PARCEL AND NO COURIER SCANS IT.
   *
   * The check reads "on its way" as a claim about the carrier's network, which
   * is exactly right for a parcel and exactly wrong for the money going back to
   * a card or the returns label going out by email. Measured: the first version
   * of this gate failed "your refund is on its way back to your original
   * payment method" — a true sentence, on a draft that had nothing to do with
   * tracking — and would have spent the one regeneration rewriting it.
   */
  describe("subjects a courier does not carry", () => {
    it("leaves a refund, a label and an email alone", () => {
      for (const reply of [
        "Your refund is on its way back to your original payment method.",
        "Your return label is on its way to you by email.",
        "The replacement invoice is on its way over to you now.",
        "A reply from our warehouse is on its way to me and I will update you.",
      ]) {
        expect(movementFindings(reply, PRE_TRANSIT), reply).toEqual([]);
      }
    });

    /** The parcel named after the refund is still the parcel. */
    it("still reads the parcel when a sentence names both", () => {
      expect(
        movementFindings(
          "We have issued your refund and your parcel is on its way back to us.",
          PRE_TRANSIT,
        ),
      ).not.toEqual([]);
    });

    /**
     * AN UNRECOGNISED SUBJECT IS CHECKED, NOT WAVED THROUGH. The exemption is a
     * named list of things that plainly do not travel by courier; anything else
     * — including a bare "it" — stays inside the gate.
     */
    it("checks a claim whose subject it cannot name", () => {
      expect(movementFindings("It is moving through the network right now.", PRE_TRANSIT)).not.toEqual(
        [],
      );
      expect(movementFindings("This is on its way to you.", PRE_TRANSIT)).not.toEqual([]);
    });
  });

  /* ---------- CASE C — the milestones that already worked ---------- */

  /**
   * NOTHING DOWNSTREAM OF A REAL SCAN CHANGES. Delivered and out-for-delivery
   * are movement by definition — the carrier physically handled the parcel to
   * produce them — so the new gate must be invisible on exactly the drafts that
   * were already right. A check that cost a regeneration here would be a worse
   * bargain than the leak it was written to stop.
   */
  describe("C. delivered and out for delivery are untouched", () => {
    it("counts every handled state as movement", () => {
      expect(carrierHasReportedMovement(DELIVERED)).toBe(true);
      expect(carrierHasReportedMovement(OUT_FOR_DELIVERY)).toBe(true);
      // Movement in a direction nobody wanted is movement all the same.
      expect(carrierHasReportedMovement(EXCEPTION)).toBe(true);
      // Absence of a lookup is absence of evidence.
      expect(carrierHasReportedMovement(null)).toBe(false);
    });

    it("keeps the milestone sentences exactly as they were", () => {
      expect(customerDeliveryStatus(DELIVERED, true).sentence).toBe("Your parcel has been delivered.");
      expect(customerDeliveryStatus(OUT_FOR_DELIVERY, true).sentence).toBe(
        "Your parcel is out for delivery.",
      );
      expect(customerDeliveryStatus(DELIVERED, true).statesAPosition).toBe(true);
      expect(customerDeliveryStatus(OUT_FOR_DELIVERY, true).statesAPosition).toBe(true);
    });

    it("raises nothing on the ordinary milestone replies", () => {
      expect(movementFindings("Your parcel has been delivered.", DELIVERED)).toEqual([]);
      expect(movementFindings("Your parcel is out for delivery.", OUT_FOR_DELIVERY)).toEqual([]);
      expect(
        movementFindings("Your parcel is out for delivery and on its way to you today.", OUT_FOR_DELIVERY),
      ).toEqual([]);
    });
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
