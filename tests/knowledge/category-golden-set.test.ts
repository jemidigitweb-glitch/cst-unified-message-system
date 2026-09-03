import { describe, expect, it } from "vitest";

import {
  type MessageCategory,
  classifyConversationCategory,
  classifyMessageCategory,
  intentOwningCategory,
  quantityShortfallEvidence,
  readConversation,
  readCorpus,
  resolveEvidenceOwnership,
  semanticsOf,
} from "@/lib/knowledge/message-category";
import { claimStatus, clausesOf, speechActOf } from "@/lib/knowledge/message-semantics";

/**
 * THE GOLDEN SET — one dataset, one shape, one place to look.
 *
 * WHY IT IS SEPARATE FROM `category-regression.test.ts`. That file is a
 * narrative: each case is a judgement that was made once, at some cost, and its
 * comment explains the measurement behind it. This one is a TABLE. Every row
 * carries its own reason and provenance as data rather than prose, so the set
 * can be read as coverage of the category BOUNDARIES rather than as a history
 * of fixes — and so a boundary with no row in it is visible as a gap.
 *
 * WHAT A ROW ASSERTS. The category the classifier produces for a thread today,
 * and nothing else. A golden set that encoded what somebody hoped the answer
 * would be would fail on the day it was written and teach the next reader to
 * ignore it. Where the brief that commissioned a row disagrees with the shipped
 * taxonomy, the row records the taxonomy and says so in its `reason` — see
 * `warranty for broken item` under DEFECTIVE, which the boundary between
 * `IS_DAMAGED` and `IS_DEFECTIVE` settles the other way.
 *
 * WHERE A ROW WOULD BE A LIE, IT IS NOT HERE. Cases the classifier gets wrong
 * live at the bottom under `documented gaps`, as `it.fails`, so they are
 * tracked rather than quietly asserted as correct. When one is fixed that test
 * starts failing, which is the signal to promote it into the table above.
 */

type GoldenCase = {
  /** The customer's messages, oldest first. One entry is a single message. */
  readonly thread: readonly string[];
  readonly expectedCategory: MessageCategory | null;
  /** Why this is the right answer — the rule or distinction being pinned. */
  readonly reason: string;
  /**
   * Where the case came from: a live conversation id, or the brief that asked
   * for it. A row nobody can trace back is a row nobody can safely change.
   */
  readonly regressionSource: string;
};

/** Runs one boundary's rows. Kept here so every group reports identically. */
function check(cases: readonly GoldenCase[]): void {
  it.each(cases.map((entry) => [entry.thread.join(" ⏎ "), entry] as const))(
    "%s",
    (_label, entry) => {
      expect(classifyConversationCategory([...entry.thread])).toBe(entry.expectedCategory);
    },
  );
}

/* ── 1. DEFECTIVE ITEMS ─────────────────────────────────────────────────── */

const DEFECTIVE: readonly GoldenCase[] = [
  {
    thread: ["My LED driver broke"],
    expectedCategory: "Defective items",
    reason: "`broke` is a functional failure; the goods are with the customer.",
    regressionSource: "brief: defective boundary",
  },
  {
    thread: ["Bulb stopped working"],
    expectedCategory: "Defective items",
    reason: "`stopped working` is the plainest statement of a fault after use.",
    regressionSource: "brief: defective boundary",
  },
  {
    thread: ["The item flickers and hardly any light comes out"],
    expectedCategory: "Defective items",
    reason: "Flickering is a fault, not a specification. Thread 145's own wording.",
    regressionSource: "live conversation 145",
  },
  {
    thread: ["One of the items arrived faulty"],
    expectedCategory: "Defective items",
    reason: "`faulty` asserted about goods that arrived.",
    regressionSource: "brief: defective boundary",
  },
  {
    thread: ["How do I proceed with warranty for broken item?"],
    expectedCategory: "Damage queries",
    reason:
      "TAXONOMY BOUNDARY, and it disagrees with the brief that asked for it. " +
      "`IS_DEFECTIVE` matches `broke` but deliberately excludes `broken` " +
      "(`\\bbroke\\b(?!n)`), which `IS_DAMAGED` owns — the same split the brief " +
      "itself applies under DAMAGE, where 'One part is broken' is Damage. Both " +
      "cannot hold; the shipped taxonomy governs.",
    regressionSource: "brief: defective boundary (contradicts brief: damage)",
  },
  {
    thread: [
      "Hallo, ich habe im November einen 12V Trafo bei Ihnen gekauft. Heute musste ich feststellen das der Trafo defekt ist",
    ],
    expectedCategory: "Defective items",
    reason:
      "`defekt` is the German spelling and was absent from IS_DEFECTIVE, so a " +
      "warranty replacement fell to the Admin catch-all.",
    regressionSource: "live conversation 131",
  },
];

/** A defect word is not enough: the customer must be CLAIMING a fault. */
const NOT_DEFECTIVE: readonly GoldenCase[] = [
  {
    thread: ["Will this fitting work with my lamp?"],
    expectedCategory: "Pre sales queries",
    reason:
      "`work` appears, but as compatibility. `INT-DF05` reads 'not working' as a " +
      "fault and must not reach a question about suitability.",
    regressionSource: "brief: defective boundary",
  },
  {
    thread: ["What wattage is this bulb?"],
    expectedCategory: "Pre sales queries",
    reason: "A plain attribute question.",
    regressionSource: "brief: defective boundary",
  },
  {
    thread: [
      "Hi. I have received my order but only just opened it because I have been away. I had no idea that it would be so thick and because it is, it won't work for the item I wanted it for. Can I please return it and receive a refund?",
    ],
    expectedCategory: "Return and refunds",
    reason:
      "SUITABILITY, not failure. `INT-DF05` matched \"won't work\" and outranked " +
      "the return the customer was actually asking for; `semanticsOf` had " +
      "recorded functional_fault: not_stated all along.",
    regressionSource: "live conversation 36983 (salsasalsa52)",
  },
  {
    thread: [
      "hi when will i recieve this please i looked on my blink camera noone tried to deliver on day it says",
    ],
    expectedCategory: "Delivery queries",
    reason:
      "`blink\\w*` matched the doorbell brand 'Blink camera' and turned a " +
      "delivery chase into a flickering light.",
    regressionSource: "live conversation 37520 (mich6730)",
  },
  {
    thread: ["Nothing is broken, I just want to check the wiring"],
    expectedCategory: "Admin related issues",
    reason:
      "A problem the customer RULES OUT is not a case: `claimStatus` reads the " +
      "denial and drops the damage intent. What is pinned here is that it is NOT " +
      "Damage; with no other case established it lands on the Admin residue, " +
      "which is where anything uncategorised goes by policy.",
    regressionSource: "existing claim-reading guarantee",
  },
];

/* ── 2. PRE SALES vs ADMIN ──────────────────────────────────────────────── */

const PRE_SALES: readonly GoldenCase[] = [
  {
    thread: ["Are these bulbs dimmable?"],
    expectedCategory: "Pre sales queries",
    reason: "A feature question, and the brief's own first pre-sales example.",
    regressionSource: "brief: pre-sales boundary",
  },
  {
    thread: ["Is this compatible with E27?"],
    expectedCategory: "Pre sales queries",
    reason: "A compatibility question against a named fitting type, pre-purchase.",
    regressionSource: "brief: pre-sales boundary",
  },
  {
    thread: ["What colour temperature is this?"],
    expectedCategory: "Pre sales queries",
    reason: "A plain attribute question about the product on the listing.",
    regressionSource: "brief: pre-sales boundary",
  },
  {
    thread: ["What size is the shade?"],
    expectedCategory: "Pre sales queries",
    reason: "Attribute question. `size` must not reach a wrong-item rule pre-purchase.",
    regressionSource: "brief: pre-sales boundary",
  },
  {
    thread: [
      "Not sure if the bulbs you sent are dimmable because there is no tick on the box for it and I need them dimmable.",
    ],
    expectedCategory: "Pre sales queries",
    reason:
      "A question with no question in it: no '?', no 'can you', no 'please', so " +
      "nothing recognised it as a request and it fell to the Admin catch-all.",
    regressionSource: "live conversation 145",
  },
];

const ADMIN: readonly GoldenCase[] = [
  {
    thread: ["Can you send me a VAT invoice?"],
    expectedCategory: "Admin related issues",
    reason: "A document request is what Admin is FOR.",
    regressionSource: "brief: admin boundary",
  },
  {
    thread: ["Please send the invoice for my order"],
    expectedCategory: "Admin related issues",
    reason: "Paperwork: not about the product and not about the parcel.",
    regressionSource: "brief: admin boundary",
  },
  {
    thread: ["I need a copy of my receipt for my records"],
    expectedCategory: "Admin related issues",
    reason: "Document request phrased as a need rather than a question.",
    regressionSource: "brief: admin boundary",
  },
];

/* ── 3. DELIVERY vs RETURN / REFUND ─────────────────────────────────────── */

const DELIVERY: readonly GoldenCase[] = [
  {
    thread: ["When will my parcel arrive?"],
    expectedCategory: "Delivery queries",
    reason: "The whereabouts of an outbound parcel, and nothing else.",
    regressionSource: "brief: delivery boundary",
  },
  {
    thread: ["Tracking says attempted delivery"],
    expectedCategory: "Delivery queries",
    reason: "A carrier scan event, quoted back to us by the customer.",
    regressionSource: "brief: delivery boundary",
  },
  {
    thread: ["Parcel is late"],
    expectedCategory: "Delivery queries",
    reason: "Lateness stated with no other complaint attached to it.",
    regressionSource: "brief: delivery boundary",
  },
];

const RETURN: readonly GoldenCase[] = [
  {
    thread: ["I returned it, when will my refund arrive?"],
    expectedCategory: "Return and refunds",
    reason: "The goods went back; the money is what is outstanding.",
    regressionSource: "brief: return boundary",
  },
  {
    thread: ["Can I return this item?"],
    expectedCategory: "Return and refunds",
    reason: "A return being asked for, with no problem behind it.",
    regressionSource: "brief: return boundary",
  },
  {
    thread: ["Waiting for refund"],
    expectedCategory: "Return and refunds",
    reason: "A refund chase is Return's own case, never a delivery matter.",
    regressionSource: "brief: return boundary",
  },
];

/**
 * THE CROSS-CASE THE BRIEF ASKED TO SEPARATE: a delivery problem that also asks
 * for money. The parcel is the problem; the refund is the remedy, and a remedy
 * does not take the problem's place.
 */
const DELIVERY_WITH_REFUND: readonly GoldenCase[] = [
  {
    thread: ["My parcel has not arrived, can I have a refund?"],
    expectedCategory: "Delivery queries",
    reason: "Issue outranks requested action; nothing arrived, so nothing can go back.",
    regressionSource: "brief: delivery/return separation",
  },
  {
    thread: [
      "What's happening with these as we're waiting on them to finish a job",
      "You could just refund it as I need this urgently so I'll just buy some out of CEF",
    ],
    expectedCategory: "Delivery queries",
    reason:
      "A customer giving up on a late parcel states the problem in one message " +
      "and the remedy in the next, which is why the deferral is read across the " +
      "thread rather than per message.",
    regressionSource: "existing delivery/refund deferral",
  },
];

/* ── 4. WRONG ITEM vs CUSTOMER'S OWN MISTAKE ────────────────────────────── */

const WRONG_ITEM: readonly GoldenCase[] = [
  {
    thread: ["You sent black instead of white"],
    expectedCategory: "Wrong item sent messages",
    reason: "The seller is named as the actor, and a substitution is stated.",
    regressionSource: "brief: wrong-item boundary",
  },
  {
    thread: ["Received wrong colour"],
    expectedCategory: "Wrong item sent messages",
    reason: "Receipt plus a mismatch, with no customer mistake claimed.",
    regressionSource: "brief: wrong-item boundary",
  },
  {
    thread: ["Ordered 40cm but received 30cm"],
    expectedCategory: "Wrong item sent messages",
    reason: "An ordered-X-received-Y contrast — the shape `A_MISMATCH` exists for.",
    regressionSource: "brief: wrong-item boundary",
  },
];

const CUSTOMER_MISTAKE: readonly GoldenCase[] = [
  {
    thread: ["I selected wrong colour by mistake"],
    expectedCategory: "Order change, before shipping queries",
    reason: "The customer names themselves as the actor, so it is not a seller error.",
    regressionSource: "brief: wrong-item boundary",
  },
  {
    thread: ["I ordered the wrong size"],
    expectedCategory: "Order change, before shipping queries",
    reason: "`CUSTOMER_OWNS_THE_MISTAKE` vetoes the wrong-item reading.",
    regressionSource: "brief: wrong-item boundary",
  },
  {
    thread: ["I ordered the wrong colour"],
    expectedCategory: "Order change, before shipping queries",
    reason: "The same customer-owns-it shape, on a different attribute.",
    regressionSource: "brief: wrong-item boundary",
  },
];

/* ── 5. DAMAGE vs RETURN ────────────────────────────────────────────────── */

const DAMAGE: readonly GoldenCase[] = [
  {
    thread: ["Item arrived cracked"],
    expectedCategory: "Damage queries",
    reason: "Physical damage discovered on arrival, stated plainly.",
    regressionSource: "brief: damage boundary",
  },
  {
    thread: ["Shade has dents"],
    expectedCategory: "Damage queries",
    reason:
      "`dent` is matched as a closed word, never as a stem — `dent\\w*` once " +
      "matched 'Denton' and 'dental'.",
    regressionSource: "existing house rule on open stems",
  },
  {
    thread: ["One part is broken"],
    expectedCategory: "Damage queries",
    reason: "`broken` is Damage's word, not Defective's. See the DEFECTIVE group.",
    regressionSource: "brief: damage boundary",
  },
];

const RETURN_NOT_DAMAGE: readonly GoldenCase[] = [
  {
    thread: ["I want to return because it does not suit me"],
    expectedCategory: "Return and refunds",
    reason: "Nothing is wrong with the goods; the buyer has changed their mind.",
    regressionSource: "brief: damage/return boundary",
  },
  {
    thread: ["I have received it and it is simply too big for the space. Can I have a refund?"],
    expectedCategory: "Return and refunds",
    reason:
      "A size complaint about goods that are perfectly fine. The " +
      "measurement-mismatch rows read 'too big' as a wrong item.",
    regressionSource: "existing positional false positive",
  },
];

/* ── 6. THREAD-LEVEL READINGS ───────────────────────────────────────────── */

const THREADS: readonly GoldenCase[] = [
  {
    thread: ["Bulb is faulty", "I returned it, waiting refund"],
    expectedCategory: "Return and refunds",
    reason:
      "The customer's closing statement is that the goods went back, so the live " +
      "subject is the return.",
    regressionSource: "brief: thread example A",
  },
  {
    thread: ["Bulb is faulty"],
    expectedCategory: "Defective items",
    reason: "The same fault with no return action stays the fault.",
    regressionSource: "brief: thread example B",
  },
  {
    thread: ["Are these dimmable?", "Can I buy one?"],
    expectedCategory: "Pre sales queries",
    reason: "A purchase intent after a product question is still pre-sales.",
    regressionSource: "brief: thread example C",
  },
  {
    thread: [
      "Hi received and used today - the smell of electric burning and the best off the switch was horrendous. If I hadn't of been at home there would of been a fire",
      "Please could I have a refund",
      "Hi I've managed to print it. Will post tomorrow or Tuesday",
      "Hi parcel has been returned",
    ],
    expectedCategory: "Return and refunds",
    reason:
      "A serious fault, then a refund, then a return the customer signs off on. " +
      "Issue still outranks action; this is the action axis's 'latest statement " +
      "wins' applied to the statement that closes a problem case.",
    regressionSource: "live conversation 33150",
  },
  {
    thread: [
      "Hi, I am sorry, but these bulbs are not dimmable. They flicker badly and hardly any light comes out of them.",
      "Hi, I have not received a refund for the bulbs. Please advise.",
      "Hi, I used your return label. The shop where I took the parcel said that you would send me an email as receipt but I did not received one.",
    ],
    expectedCategory: "Defective items",
    reason:
      "THE COUNTERPART TO 33150. Mentioning a return LABEL is arranging a return, " +
      "not completing one, and the defect claim is still live.",
    regressionSource: "live conversation 145",
  },
  {
    thread: [
      "I ordered 2 blue lampshades, why have you sent me one green and one blue",
      "Please send second blue shade, what to do with spare green one!!!",
    ],
    expectedCategory: "Wrong item sent messages",
    reason: "A later question about sorting a problem out does not replace the problem.",
    regressionSource: "existing question-at-the-end guarantee",
  },
  {
    thread: ["I returned the other one last month", "This one flickers badly"],
    expectedCategory: "Defective items",
    reason:
      "A return mentioned mid-thread is not a return being completed — only the " +
      "customer's LAST message can close the case.",
    regressionSource: "bound on the return-lifecycle rule",
  },
];

/* ── NEGATIVE CONTROLS: over-classification ─────────────────────────────── */

const NEGATIVE: readonly GoldenCase[] = [
  {
    thread: ["Thank you"],
    expectedCategory: "Admin related issues",
    reason:
      "A courtesy establishes no case of its own. Nothing may be left " +
      "uncategorised by policy, so it lands on the Admin residue rather than " +
      "being guessed into a product or delivery case.",
    regressionSource: "over-classification control",
  },
  {
    thread: ["Please refund me"],
    expectedCategory: "Return and refunds",
    reason: "A remedy with no problem behind it is the remedy's own case.",
    regressionSource: "over-classification control",
  },
  {
    thread: ["Please send me an invoice", "Yes it is 8 Sample Close, Denton, M00 0AA"],
    expectedCategory: "Admin related issues",
    reason:
      "An address confirmation carries no category and must not outvote the " +
      "request it answers. 'Denton' must not reach a dent rule.",
    regressionSource: "existing address-only control",
  },
];

describe("golden set — 1. defective items", () => {
  describe("a reported product failure", () => check(DEFECTIVE));
  describe("a question, a suitability complaint, or a brand name is not a failure", () =>
    check(NOT_DEFECTIVE));
});

describe("golden set — 2. pre sales vs admin", () => {
  describe("product questions are pre-sales", () => check(PRE_SALES));
  describe("admin owns paperwork and nothing else", () => check(ADMIN));
});

describe("golden set — 3. delivery vs return and refunds", () => {
  describe("the parcel on its way out", () => check(DELIVERY));
  describe("the parcel going back, and the money", () => check(RETURN));
  describe("a delivery problem that also asks for money", () => check(DELIVERY_WITH_REFUND));
});

describe("golden set — 4. wrong item vs the customer's own mistake", () => {
  describe("the seller sent the wrong thing", () => check(WRONG_ITEM));
  describe("the customer chose the wrong thing", () => check(CUSTOMER_MISTAKE));
});

describe("golden set — 5. damage vs return", () => {
  describe("goods that arrived harmed", () => check(DAMAGE));
  describe("goods that are perfectly fine", () => check(RETURN_NOT_DAMAGE));
});

describe("golden set — 6. thread-level readings", () => check(THREADS));

describe("golden set — negative controls", () => check(NEGATIVE));

/**
 * Structural guarantees about the dataset itself. A row with no reason, or a
 * duplicate row, degrades the set silently.
 */
describe("the dataset is well formed", () => {
  const ALL = [
    ...DEFECTIVE, ...NOT_DEFECTIVE, ...PRE_SALES, ...ADMIN, ...DELIVERY, ...RETURN,
    ...DELIVERY_WITH_REFUND, ...WRONG_ITEM, ...CUSTOMER_MISTAKE, ...DAMAGE,
    ...RETURN_NOT_DAMAGE, ...THREADS, ...NEGATIVE,
  ];

  it("every case states a reason and a source", () => {
    for (const entry of ALL) {
      expect(entry.reason.length, JSON.stringify(entry.thread)).toBeGreaterThan(20);
      expect(entry.regressionSource.length, JSON.stringify(entry.thread)).toBeGreaterThan(5);
      expect(entry.thread.length).toBeGreaterThan(0);
    }
  });

  it("holds no duplicate threads", () => {
    const seen = new Map<string, MessageCategory | null>();
    for (const entry of ALL) {
      const key = entry.thread.join(" ");
      // The same thread twice with the same answer is redundant; with two
      // different answers it is a contradiction. Both are worth failing on.
      expect(seen.has(key), `duplicated: ${key}`).toBe(false);
      seen.set(key, entry.expectedCategory);
    }
  });

  it("covers every boundary the brief named", () => {
    const covered = new Set(ALL.map((entry) => entry.expectedCategory));
    for (const category of [
      "Defective items",
      "Damage queries",
      "Pre sales queries",
      "Admin related issues",
      "Delivery queries",
      "Return and refunds",
      "Wrong item sent messages",
      "Order change, before shipping queries",
    ] as const) {
      expect(covered, `no golden case lands on ${category}`).toContain(category);
    }
  });
});

/**
 * DOCUMENTED GAPS — cases the classifier gets wrong today.
 *
 * `it.fails` rather than a skipped test or a comment: the expectation is
 * written the way it SHOULD read, and the test passes only while the classifier
 * still gets it wrong. Fixing the classifier turns this red, which is the
 * prompt to move the row into the table above.
 */
describe("documented gaps", () => {
  /**
   * `CUSTOMER_OWNS_THE_MISTAKE` already treats the article as optional, and the
   * evidence corpus lists both "ordered wrong" and "wrong size" under order
   * change — but with no article the thread reaches neither, and falls to the
   * Admin catch-all. One word apart from a case that works:
   * "I ordered THE wrong size" is Order change today.
   */
  it.fails("'I ordered wrong size' — no article, so no order-change reading", () => {
    expect(classifyConversationCategory(["I ordered wrong size"])).toBe(
      "Order change, before shipping queries",
    );
  });

  it.fails("'I have ordered wrong size' — same gap with an auxiliary", () => {
    expect(classifyConversationCategory(["I have ordered wrong size"])).toBe(
      "Order change, before shipping queries",
    );
  });
});

/**
 * DEGENERATE INPUT — the classifier declining, rather than guessing.
 *
 * Every entry point takes text from a live source, and live sources produce
 * empty bodies, whitespace-only bodies, undecodable bodies and threads with no
 * inbound message at all. Each of these is a real state, and the guarantee is
 * uniform: an absent input yields an absent answer, never a plausible one.
 *
 * These are the branches a boundary table cannot reach, because a boundary
 * needs two sides and these have one.
 */
describe("an absent input yields an absent answer", () => {
  it.each([[""], ["   "], ["\n\n"], [null]])(
    "readCorpus(%j) admits and refuses nothing",
    (text) => {
      const reading = readCorpus(text);
      expect(reading).toEqual({ admitted: [], refused: [], signals: [], category: null });
    },
  );

  it.each([[""], ["   "], [null]])("resolveEvidenceOwnership(%j) upholds nothing", (text) => {
    expect(resolveEvidenceOwnership(text)).toEqual({ upheld: [], rejected: [] });
  });

  it.each([[""], ["   "], [null]])("quantityShortfallEvidence(%j) finds no shortfall", (text) => {
    expect(quantityShortfallEvidence(text)).toBeNull();
  });

  it.each([[""], ["   "], [null]])("classifyMessageCategory(%j) names no category", (text) => {
    expect(classifyMessageCategory(text ?? "")).toBeNull();
  });

  it("intentOwningCategory(null) owns nothing", () => {
    expect(intentOwningCategory(null)).toBeNull();
  });

  it("a thread with no messages reads as nothing at all", () => {
    const reading = readConversation([]);
    expect(reading).toEqual({ category: null, issue: "none", requestedAction: "none" });
  });

  it("a thread whose only messages are ours reads as nothing at all", () => {
    // Direction matters: a CST reply is the business talking to itself, and
    // reading a category off it would report our own words as the customer's.
    expect(
      readConversation([
        { direction: "outbound", text: "Your parcel was dispatched today" },
        { direction: "outbound", text: "Please let us know if it does not arrive" },
      ]).category,
    ).toBeNull();
  });

  it("a thread of blank and undecodable bodies reads as nothing at all", () => {
    expect(
      readConversation([
        { direction: "inbound", text: null },
        { direction: "inbound", text: "" },
        { direction: "inbound", text: "   " },
      ]).category,
    ).toBeNull();
  });

  it.each([[""], ["   "]])("semanticsOf(%j) states no event and no action", (text) => {
    const semantics = semanticsOf(text);
    expect(semantics.event).toBe("none");
    expect(semantics.requestedAction).toBe("none");
  });

  it.each([[""], ["   "]])("clausesOf(%j) finds no clause", (text) => {
    expect(clausesOf(text)).toEqual([]);
  });

  it.each([[""], ["   "]])("speechActOf(%j) is not a question", (text) => {
    expect(speechActOf(text)).not.toBe("question");
  });

  it("claimStatus over an empty text states nothing", () => {
    expect(claimStatus("", /broken/i)).toBe("not_stated");
  });
});

/**
 * ADDRESS-ONLY MESSAGES contribute to neither axis.
 *
 * A customer answering "what is your address?" sends a line that contains a
 * town, a postcode and nothing else. It is a real inbound message, and reading
 * a category off it would let a street name decide the thread — which is how
 * "Denton" reached a dent rule.
 */
describe("a message that is only an address decides nothing", () => {
  it.each([
    ["a home address", "8 Sample Close, haughton green, Denton, M00 0AA"],
    ["a business address", "Motor parts depot, Unit A1 Sample Business Park, Wirral, CH00 0AA"],
  ])("%s alongside a request leaves the request in charge", (_name, address) => {
    expect(classifyConversationCategory(["Please send me an invoice", address])).toBe(
      "Admin related issues",
    );
  });

  it("but an address alongside a real report leaves the report in charge", () => {
    expect(
      classifyConversationCategory([
        "My parcel has not arrived. My address is 8 Sample Close, Denton, M00 0AA",
      ]),
    ).toBe("Delivery queries");
  });
});
