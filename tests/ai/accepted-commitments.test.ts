import { describe, expect, it } from "vitest";

import { threadCommitments, validateDraftAccuracy } from "@/lib/ai/draft-validation";
import { cstInstructions } from "@/lib/ai/instructions";
import type { DraftOutcome, DraftProvider, DraftRequest } from "@/lib/ai/provider";
import { withDraftValidation } from "@/lib/ai/validated-draft-provider";
import { acceptedCommitments, ungroundedClaims } from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";
import { detectIntents } from "@/lib/knowledge/message-category";

/**
 * A REMEDY THIS TEAM OFFERED AND THE CUSTOMER ACCEPTED.
 *
 * THE CONVERSATION THIS EXISTS FOR, which happened:
 *
 *   customer  "I still have not received this item and it's been several weeks"
 *   us        "We have checked the tracking, and unfortunately there has been no
 *              update since the 26th. Would you be happy for us to resend the
 *              item for you?"
 *   customer  "Yes please resend asap as I really need this soon"
 *
 * and the draft refused the resend as an unverified replacement decision. It was
 * refusing an offer we ourselves had made.
 *
 * WHAT IS PINNED HERE, and the second one matters as much as the first:
 *
 *   - a draft carrying out an AGREED remedy is not reported as unsupported, and
 *     does not buy a regeneration that would rewrite it into a refusal
 *   - the same draft with NO such agreement is blocked exactly as before
 *   - agreement establishes the DECISION, never the OUTCOME: "we have arranged"
 *     is groundable, "we have dispatched" is not, agreement or no agreement
 *
 * No network, no key, no vendor: the provider below is a fake and everything
 * else under test is pure.
 */

function message(
  direction: ConversationMessageView["direction"],
  bodyText: string | null,
  overrides: Partial<ConversationMessageView> = {},
): ConversationMessageView {
  return {
    id: `${direction}-${bodyText?.slice(0, 8) ?? "empty"}`,
    direction,
    sourceTimestamp: "2026-08-01 09:00:00",
    bodyText,
    bodyDecodeStatus: "decoded",
    attachments: [],
    ...overrides,
  };
}

const NOT_RECEIVED = "I still have not received this item and it's been several weeks, will I be receiving this item or not?";

const CST_OFFERS_RESEND =
  "We have checked the tracking, and unfortunately there has been no update since the 26th. Would you be happy for us to resend the item for you?";

const CUSTOMER_ACCEPTS = "Yes please resend asap as I really need this soon";

/** The thread as it actually ran: asked, offered, accepted. */
const AGREED_RESEND: ConversationMessageView[] = [
  message("inbound", NOT_RECEIVED),
  message("outbound", CST_OFFERS_RESEND),
  message("inbound", CUSTOMER_ACCEPTS),
];

/** The same request, with nobody from this team having offered anything. */
const NO_OFFER: ConversationMessageView[] = [
  message("inbound", NOT_RECEIVED),
  message("inbound", "Can you resend it please, I still need it."),
];

/**
 * The confirmation the reviewer should get: the agreed action, carried out, and
 * nothing said about where anything is. Deliberately claims no dispatch, no
 * date, no courier and no tracking — none of that is established by an
 * agreement, and this draft must pass without any of it.
 */
const CONFIRMS_THE_RESEND =
  "Thank you for confirming. We have arranged a replacement for you. We will be in touch with an update as soon as we have one, and we are sorry for the delay with this delivery.";

/** The same reply, claiming the goods have gone. Only the backend can say that. */
const CLAIMS_IT_HAS_GONE =
  "Thank you for confirming. We have dispatched a replacement for you.";

const FACTS = [
  { name: "order_number", value: "12-34567-89012" },
  { name: "order_status", value: "Completed" },
];

function underReview(reply: string, messages: readonly ConversationMessageView[]) {
  return {
    reply,
    facts: FACTS,
    messages,
    tracking: null,
    knowledgeAvailable: true,
  };
}

/** Findings that would rewrite the reply, which is what a refusal came out of. */
function criticalIssues(reply: string, messages: readonly ConversationMessageView[]): string[] {
  return validateDraftAccuracy(underReview(reply, messages))
    .findings.filter((finding) => finding.severity === "critical")
    .map((finding) => finding.issue);
}

describe("reading an accepted commitment out of the thread", () => {
  it("finds the remedy this team offered and the customer accepted", () => {
    expect(threadCommitments(AGREED_RESEND)).toEqual(["replacement"]);
  });

  it("finds nothing when the customer asks unprompted", () => {
    expect(threadCommitments(NO_OFFER)).toEqual([]);
  });

  it("finds nothing when we named the remedy without offering it", () => {
    const declined = [
      message("inbound", NOT_RECEIVED),
      message(
        "outbound",
        "We are unable to send a replacement for an item outside the returns window.",
      ),
      message("inbound", "Yes ok"),
    ];
    expect(threadCommitments(declined)).toEqual([]);
  });

  it("does not accept an offer that had not been made yet", () => {
    const backwards = [
      message("inbound", "Yes please, go ahead."),
      message("outbound", CST_OFFERS_RESEND),
    ];
    expect(acceptedCommitments(
      backwards.map((m) => ({ direction: m.direction, text: m.bodyText })),
    )).toEqual([]);
  });

  it("reads a question about the offer as a question, not as agreement", () => {
    const asking = [
      message("inbound", NOT_RECEIVED),
      message("outbound", CST_OFFERS_RESEND),
      message("inbound", "Yes but how long would a resend take?"),
    ];
    expect(threadCommitments(asking)).toEqual([]);
  });

  it("still reads an acceptance that also asks a question", () => {
    const both = [
      message("inbound", NOT_RECEIVED),
      message("outbound", CST_OFFERS_RESEND),
      message("inbound", "Yes please resend asap. How long will it take?"),
    ];
    expect(threadCommitments(both)).toEqual(["replacement"]);
  });

  it("grounds nothing on an offer whose body did not survive", () => {
    const unreadable = [
      message("inbound", NOT_RECEIVED),
      message("outbound", null, { bodyDecodeStatus: "empty" }),
      message("inbound", CUSTOMER_ACCEPTS),
    ];
    expect(threadCommitments(unreadable)).toEqual([]);
  });
});

describe("a draft carrying out what was agreed", () => {
  it("is not reported as an unsupported claim", () => {
    expect(ungroundedClaims(CONFIRMS_THE_RESEND, FACTS, threadCommitments(AGREED_RESEND))).toEqual(
      [],
    );
  });

  it("raises no finding that would rewrite it", () => {
    expect(criticalIssues(CONFIRMS_THE_RESEND, AGREED_RESEND)).toEqual([]);
  });

  it("does not buy a regeneration", async () => {
    let calls = 0;
    const provider: DraftProvider = {
      name: "openai",
      model: "test-model",
      generate: async (): Promise<DraftOutcome> => {
        calls += 1;
        return {
          result: {
            draft_reply: CONFIRMS_THE_RESEND,
            sources_used: [{ kind: "cst_document", ref: "DEL-1", label: null }],
            missing_information: [],
            requires_review: false,
          },
          requiresReview: false,
          missingInformation: [],
          model: "test-model",
          provider: "openai",
          knowledgeAvailable: true,
        };
      },
    };

    const request: DraftRequest = {
      messages: AGREED_RESEND,
      marketplace: "ebay",
      listingItemRef: "123456789012",
      facts: FACTS,
    };

    const outcome = await withDraftValidation(provider).generate(request);

    expect(calls).toBe(1);
    expect(outcome.result.draft_reply).toBe(CONFIRMS_THE_RESEND);
    expect(outcome.missingInformation.join(" ")).not.toMatch(/replacement/i);
  });
});

describe("validation is not weakened by any of this", () => {
  it("still blocks the same promise when nobody offered it", () => {
    expect(ungroundedClaims(CONFIRMS_THE_RESEND, FACTS, threadCommitments(NO_OFFER))).toEqual([
      "replacement arrangement",
    ]);
    expect(criticalIssues(CONFIRMS_THE_RESEND, NO_OFFER)).toContain("unsupported_claim");
  });

  it("still blocks it for a caller that passes no thread at all", () => {
    expect(ungroundedClaims(CONFIRMS_THE_RESEND, FACTS)).toEqual(["replacement arrangement"]);
  });

  it("blocks a claim that the goods have gone, agreement or not", () => {
    expect(ungroundedClaims(CLAIMS_IT_HAS_GONE, FACTS, threadCommitments(AGREED_RESEND))).toEqual([
      "replacement decision",
    ]);
    expect(criticalIssues(CLAIMS_IT_HAS_GONE, AGREED_RESEND)).toContain("unsupported_claim");
  });

  it("does not let a resend agreement ground a refund claim", () => {
    const refundClaim = "We have processed your refund.";
    expect(ungroundedClaims(refundClaim, FACTS, threadCommitments(AGREED_RESEND))).toEqual([
      "refund decision",
    ]);
  });
});

describe("the customer's acceptance is read as a request for goods", () => {
  it("detects the replacement intent in a bare resend acceptance", () => {
    expect(detectIntents(CUSTOMER_ACCEPTS)).toContain("wants_replacement");
  });

  it.each([
    "Please re-send it",
    "Can you send it out again",
    "Please send me another",
    "Bitte erneut senden",
  ])("detects the replacement intent in %j", (text) => {
    expect(detectIntents(text)).toContain("wants_replacement");
  });

  it("does not read an address change as a resend", () => {
    expect(detectIntents("Can you send it to my new address please")).not.toContain(
      "wants_replacement",
    );
  });
});

describe("the instruction tells the model the same thing", () => {
  const instruction = cstInstructions("ebay");

  it("states that a previous reply is authoritative", () => {
    expect(instruction).toMatch(/OUR PREVIOUS REPLY/);
    expect(instruction).toMatch(/AGREED DECISION, NOT A NEW REQUEST/);
  });

  it("still forbids claiming the agreed action is done", () => {
    expect(instruction).toMatch(/YOU STILL MAY NOT SAY IT IS DONE/);
    expect(instruction).toMatch(/only the verified context establishes the OUTCOME/i);
  });

  it("keeps the guard it qualifies, and keeps it first", () => {
    expect(instruction.indexOf("You must NEVER state, imply, guess or reconstruct")).toBeLessThan(
      instruction.indexOf("WHAT THIS TEAM HAS ALREADY SAID IN THIS THREAD"),
    );
  });
});
