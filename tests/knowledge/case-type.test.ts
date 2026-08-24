import { describe, expect, it } from "vitest";

import type { ConversationMessageView } from "@/lib/domain/inbox";
import { UNCLASSIFIED_CASE_TYPE, classifyCaseType } from "@/lib/knowledge/case-type";

/**
 * Naming the case type on a conversation the rule base could not answer.
 *
 * The label is a FILING AID for the team writing the missing rule, and these
 * tests are written against that narrow claim. What matters most is not how
 * often it gets the label right — it is that it declines when it cannot be
 * sure, because a confident wrong label sends someone to write the wrong rule.
 *
 * Synthetic message text throughout. No customer content appears here.
 */

function inbound(bodyText: string): ConversationMessageView {
  return {
    id: "1",
    direction: "inbound",
    sourceTimestamp: "2026-08-01 09:00:00",
    bodyText,
    bodyDecodeStatus: "decoded",
    attachments: [],
  };
}

function outbound(bodyText: string): ConversationMessageView {
  return { ...inbound(bodyText), id: "2", direction: "outbound" };
}

describe("naming what the customer asked for", () => {
  it("names an invoice request", () => {
    const result = classifyCaseType([inbound("Could you send me a VAT invoice for this order?")]);
    expect(result.label).toContain("invoice");
    expect(result.matchedPhrase).toBe("vat invoice");
  });

  it("names a delivery problem", () => {
    const result = classifyCaseType([
      inbound("My parcel has not arrived and the tracking has not updated in a week."),
    ]);
    expect(result.label).toContain("delivery");
  });

  it("names damaged goods", () => {
    expect(classifyCaseType([inbound("It turned up cracked and dented.")]).label).toContain(
      "damaged",
    );
  });

  /**
   * The evidence travels with the label. Showing the phrase that produced it is
   * what lets a reviewer judge the label rather than trust it.
   */
  it("reports the phrase that produced the label", () => {
    const result = classifyCaseType([inbound("The listing says oak but this is not as described")]);
    expect(result.matchedPhrase).toBe("not as described");
  });
});

describe("declining rather than guessing", () => {
  it("is unclassified when nothing recognisable was said", () => {
    const result = classifyCaseType([inbound("Hello, please advise on the below. Thanks.")]);
    expect(result.label).toBe(UNCLASSIFIED_CASE_TYPE);
    expect(result.matchedPhrase).toBeNull();
  });

  /**
   * A message about a damaged item AND a refund is genuinely both. Picking one
   * would be a coin toss presented as a finding.
   */
  it("is unclassified when two signals tie", () => {
    const result = classifyCaseType([inbound("It arrived damaged so I would like a refund.")]);
    expect(result.label).toBe(UNCLASSIFIED_CASE_TYPE);
  });

  it("breaks a tie only on a clear majority of signals", () => {
    const result = classifyCaseType([
      inbound("It arrived damaged, broken and cracked. Also I would like a refund."),
    ]);
    expect(result.label).toContain("damaged");
  });

  it("is unclassified when there is no customer message at all", () => {
    expect(classifyCaseType([]).label).toBe(UNCLASSIFIED_CASE_TYPE);
    expect(classifyCaseType([outbound("We have issued your refund.")]).label).toBe(
      UNCLASSIFIED_CASE_TYPE,
    );
  });

  it("is unclassified when the body could not be decoded", () => {
    const undecodable: ConversationMessageView = {
      ...inbound(""),
      bodyText: null,
      bodyDecodeStatus: "failed",
    };
    expect(classifyCaseType([undecodable]).label).toBe(UNCLASSIFIED_CASE_TYPE);
  });

  /**
   * Reads the CUSTOMER, not us. Classifying by what a CST agent already wrote
   * would describe the reply instead of the request.
   */
  it("ignores what CST said in reply", () => {
    const result = classifyCaseType([
      inbound("Hello, please advise."),
      outbound("We can offer a refund, a replacement, or a return label."),
    ]);
    expect(result.label).toBe(UNCLASSIFIED_CASE_TYPE);
  });

  it("does not fire on a word inside another word", () => {
    // "cancellation" must not be reached through "cancel" inside it, nor
    // "invoice" through "invoiced" appearing in unrelated prose.
    const result = classifyCaseType([inbound("Uncancellable preinvoiced widgets, apparently.")]);
    expect(result.label).toBe(UNCLASSIFIED_CASE_TYPE);
  });
});
