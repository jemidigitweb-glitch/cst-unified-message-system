import { describe, expect, it } from "vitest";

import { buildDraftInput } from "@/lib/ai/draft-assembly";
import { validateDraftAccuracy } from "@/lib/ai/draft-validation";
import { cstInstructions } from "@/lib/ai/instructions";
import type { DraftRequest } from "@/lib/ai/provider";
import type { ConversationMessageView } from "@/lib/domain/inbox";
import type { TrackingResult } from "@/lib/tracking/provider";

/**
 * BACKGROUND THIS CUSTOMER HAS ALREADY BEEN GIVEN.
 *
 * THE DRAFT THIS EXISTS FOR. Once the accepted-commitment fix landed, the reply
 * carried the resend forward — and then said it again:
 *
 *   "Thank you for confirming. As agreed, we are arranging the resend for you.
 *    The original parcel was last recorded as in transit on 26 August, but we
 *    will proceed with the resend as requested."
 *
 * Every word of the second sentence is true and verified. It is also us
 * repeating our own previous message back to the person who was replying to it.
 *
 * WHAT IS PINNED HERE, and the second is the one that keeps this honest:
 *
 *   - the instruction tells the model not to restate settled background, and
 *     the tracking block says the same thing about its own data
 *   - NOTHING IS REMOVED FROM THE REQUEST. The tracking block, the scan history
 *     and the customer-facing status reach the model in all three scenarios,
 *     byte-identically, including the one where the repetition is unwanted
 *   - a fresh question about the parcel, and a first-contact delivery query,
 *     both leave the tracking rules applying exactly as written
 *
 * Everything under test is pure: no network, no key, no vendor.
 */

function message(
  direction: ConversationMessageView["direction"],
  bodyText: string,
): ConversationMessageView {
  return {
    id: `${direction}-${bodyText.slice(0, 10)}`,
    direction,
    sourceTimestamp: "2026-08-28 09:00:00",
    bodyText,
    bodyDecodeStatus: "decoded",
    attachments: [],
  };
}

const NOT_RECEIVED =
  "I still have not received this item and it's been several weeks, will I be receiving this item or not?";

const CST_GAVE_THE_POSITION_AND_OFFERED =
  "We have checked the tracking, and unfortunately there has been no update since the 26th. Would you be happy for us to resend the item for you?";

const TRACKING: TrackingResult = {
  carrier: "royal_mail",
  trackingNumber: "AB123456789GB",
  currentStatus: "in_transit",
  lastUpdated: "2026-08-26 11:04:00",
  trackingEvents: [
    {
      timestamp: "2026-08-26 11:04:00",
      status: "in_transit",
      description: "Item received at delivery office",
      location: "Sheffield Mail Centre",
    },
  ],
  source: { provider: "royal_mail", retrieval: "live" },
};

const FACTS = [
  { name: "order_number", value: "12-34567-89012" },
  { name: "order_status", value: "Completed" },
  { name: "tracking_number", value: "AB123456789GB" },
];

function request(messages: readonly ConversationMessageView[]): DraftRequest {
  return {
    messages,
    marketplace: "ebay",
    listingItemRef: "123456789012",
    facts: FACTS,
    tracking: TRACKING,
  };
}

/** Scenario 1: explained, offered, accepted. The thread has moved on. */
const SETTLED_THEN_AGREED = [
  message("inbound", NOT_RECEIVED),
  message("outbound", CST_GAVE_THE_POSITION_AND_OFFERED),
  message("inbound", "Yes please resend asap as I really need this soon"),
];

/** Scenario 2: accepted, and asked about the original parcel in the same breath. */
const AGREED_AND_ASKED_AGAIN = [
  message("inbound", NOT_RECEIVED),
  message("outbound", CST_GAVE_THE_POSITION_AND_OFFERED),
  message("inbound", "Yes please resend, but where is the original parcel now?"),
];

/** Scenario 3: first contact. Nothing has been explained and nothing agreed. */
const FIRST_DELIVERY_QUESTION = [
  message("inbound", "Where is my parcel? It was supposed to be here by now."),
];

/** The reply the customer should get on scenario 1: the action, and nothing else. */
const CONTINUES_THE_ACTION =
  "Thank you for confirming. As agreed, we will proceed with the resend for you.";

describe("the instruction tells the model to stop repeating settled background", () => {
  const instruction = cstInstructions("ebay");

  it("states the rule", () => {
    expect(instruction).toMatch(/DO NOT EXPLAIN AGAIN WHAT WE HAVE ALREADY EXPLAINED/);
    expect(instruction).toMatch(/carry the action forward and leave the background where it is/);
  });

  it("lists every case where background is still to be stated", () => {
    const rule = instruction.slice(
      instruction.indexOf("DO NOT EXPLAIN AGAIN WHAT WE HAVE ALREADY EXPLAINED"),
    );
    expect(rule).toMatch(/answers what the customer has just written/i);
    expect(rule).toMatch(/makes the agreed action clear/i);
    expect(rule).toMatch(/asked about it again/i);
    expect(rule).toMatch(/CST rule requires it/i);
  });

  it("governs speaking and not reasoning", () => {
    expect(instruction).toMatch(/keep using all of it to work out what is true/i);
    // The reasoning instruction it must not have quietly replaced.
    expect(instruction).toMatch(/Work out everything the customer is actually raising/);
  });
});

describe("scenario 1 — explained, offered, accepted", () => {
  const input = buildDraftInput(request(SETTLED_THEN_AGREED));

  it("still supplies the tracking, in full", () => {
    expect(input).toMatch(/VERIFIED TRACKING INFORMATION:/);
    expect(input).toMatch(/AB123456789GB/);
    expect(input).toMatch(/Item received at delivery office/);
    expect(input).toMatch(/CUSTOMER-FACING DELIVERY STATUS/);
  });

  it("still supplies the reply that gave the customer the position", () => {
    expect(input).toMatch(/OUR PREVIOUS REPLY/);
    expect(input).toContain(CST_GAVE_THE_POSITION_AND_OFFERED);
  });

  it("tells the model not to give the position a second time", () => {
    expect(input).toMatch(/ALREADY TOLD IS NOT UNTOLD/);
    expect(input).toMatch(/carry the action forward and leave the tracking as reasoning/);
  });

  it("does not fault a reply that leaves the background out", () => {
    const validation = validateDraftAccuracy({
      reply: CONTINUES_THE_ACTION,
      facts: FACTS,
      messages: SETTLED_THEN_AGREED,
      tracking: TRACKING,
      knowledgeAvailable: true,
    });

    // Nothing here may rewrite the reply: a draft that correctly says less is
    // not a draft that got anything wrong. Before the coverage vocabulary knew
    // the word "resend" this raised TWO critical findings, and the regeneration
    // they bought was told to put the tracking sentence back.
    expect(validation.findings.filter((finding) => finding.severity === "critical")).toEqual([]);
    expect(validation.regenerationWarranted).toBe(false);

    /*
     * WHAT IS LEFT IS A REVIEW NOTE, and it is expected. The thread's category
     * is still a delivery case and this reply does not mention delivery, so the
     * reviewer is told so. A minor finding buys no model call and changes no
     * word of the draft — it is the reviewer reading one extra line.
     */
    expect(validation.findings.every((finding) => finding.severity === "minor")).toBe(true);
  });
});

describe("scenario 2 — accepted, and asked where the original parcel is", () => {
  const input = buildDraftInput(request(AGREED_AND_ASKED_AGAIN));

  it("supplies the tracking exactly as it does on any delivery query", () => {
    expect(input).toMatch(/VERIFIED TRACKING INFORMATION:/);
    expect(input).toMatch(/CUSTOMER-FACING DELIVERY STATUS/);
    expect(input).toMatch(/AB123456789GB/);
  });

  it("hands back the relevance decision the moment they ask again", () => {
    expect(input).toMatch(
      /This applies only while they are not asking about it — a new question about where the parcel is/,
    );
  });

  it("keeps the tracking block byte-identical to the settled thread's", () => {
    // The block is decided by the tracking and the facts, never by how the
    // conversation happens to have gone. Only the instruction reads the thread.
    const settled = buildDraftInput(request(SETTLED_THEN_AGREED));
    const block = (text: string) => text.slice(text.indexOf("VERIFIED TRACKING INFORMATION:"));
    expect(block(input)).toBe(block(settled));
  });
});

describe("scenario 3 — a first delivery question, nothing settled", () => {
  const input = buildDraftInput(request(FIRST_DELIVERY_QUESTION));

  it("supplies the tracking and the wording the reply may use", () => {
    expect(input).toMatch(/VERIFIED TRACKING INFORMATION:/);
    expect(input).toMatch(/CUSTOMER-FACING DELIVERY STATUS/);
    expect(input).toMatch(/Tracking history \(most recent first\)/);
  });

  it("leaves the standing relevance rule in force", () => {
    expect(input).toMatch(/IT IS EVIDENCE, NOT SOMETHING YOU MUST REPEAT/);
    expect(input).toMatch(/VERIFIED SHIPMENT TRACKING INFORMATION IS AUTHORITATIVE/);
  });

  it("has no earlier reply for the no-repeat clause to bite on", () => {
    expect(input).not.toMatch(/OUR PREVIOUS REPLY/);
  });
});
