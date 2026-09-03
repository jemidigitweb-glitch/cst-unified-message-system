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
  /**
   * The thread WITH DIRECTIONS, where our own replies are part of the evidence.
   *
   * Present only on the rows that need it. Almost every boundary is decided by
   * what the customer said, and `thread` says so by carrying nothing else — but
   * an order's LIFECYCLE is most reliably stated by us ("your order has been
   * dispatched"), and a rule that reads it cannot be tested without a way to
   * write it down. When present this is what runs; `thread` still carries the
   * inbound half so the row reads as a conversation either way.
   */
  readonly turns?: readonly { readonly direction: "inbound" | "outbound"; readonly text: string }[];
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
      const actual =
        entry.turns === undefined
          ? classifyConversationCategory([...entry.thread])
          : readConversation(entry.turns.map((turn) => ({ ...turn }))).category;
      expect(actual).toBe(entry.expectedCategory);
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
    expectedCategory: "Defective items",
    reason:
      "A WARRANTY IS A CLAIM ABOUT IN-SERVICE FAILURE, never about transit. " +
      "`broken` belongs to `IS_DAMAGED`, and `physical_damage` outranks " +
      "`functional_failure` in `ISSUE_OWNERSHIP`, so this read as Damage. " +
      "Invoking a warranty with no arrival or transit damage stated now " +
      "suppresses the damage claim, exactly as packaging-only damage does.",
    regressionSource: "brief: warranty/failure gap",
  },
  {
    thread: ["My LED driver broke after 2 years and has warranty"],
    expectedCategory: "Defective items",
    reason: "A part that worked and then stopped, with the warranty named outright.",
    regressionSource: "brief: warranty/failure gap",
  },
  {
    thread: ["Product stopped working"],
    expectedCategory: "Defective items",
    reason: "The plainest in-service failure there is, carrying no damage word at all.",
    regressionSource: "brief: warranty/failure gap",
  },
  {
    thread: ["How do I proceed with warranty for failed product?"],
    expectedCategory: "Defective items",
    reason:
      "`failed` was absent from `IS_DEFECTIVE` altogether, so a warranty claim " +
      "on a failed product reached no fault signal and fell to Admin.",
    regressionSource: "brief: warranty/failure gap",
  },
  {
    thread: ["The product has failed"],
    expectedCategory: "Defective items",
    reason:
      "Failure stated OF THE PRODUCT, which is what binds the word — see the " +
      "negative controls for why a bare `failed` cannot be admitted.",
    regressionSource: "brief: warranty/failure gap",
  },
  {
    thread: ["It failed after 6 months"],
    expectedCategory: "Defective items",
    reason: "The same shape with a pronoun subject and an in-service interval.",
    regressionSource: "brief: warranty/failure gap",
  },
  {
    thread: [
      "I purchased multiple drivers a few months back, 1 of the drivers has failed. What is the warranty on this item?",
    ],
    expectedCategory: "Defective items",
    reason:
      "A live customer message, and the exact shape the failure vocabulary is " +
      "for: a plural subject, an auxiliary, and a warranty question after it.",
    regressionSource: "live inbound message",
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
  {
    thread: ["I ordered wrong size"],
    expectedCategory: "Order change, before shipping queries",
    reason:
      "THE ARTICLE WAS LOAD-BEARING AND SHOULD NOT HAVE BEEN. The phrase table " +
      "held 'ordered the wrong' and 'selected the wrong' and nothing without " +
      "the article, so this reached no order-change signal and fell to Admin — " +
      "one word from a case that already worked.",
    regressionSource: "brief: ordering-mistake gap",
  },
  {
    thread: ["I have ordered wrong size"],
    expectedCategory: "Order change, before shipping queries",
    reason: "The same gap with an auxiliary between the pronoun and the verb.",
    regressionSource: "brief: ordering-mistake gap",
  },
  {
    thread: ["I ordered wrong colour"],
    expectedCategory: "Order change, before shipping queries",
    reason: "The article-free form on a different attribute.",
    regressionSource: "brief: ordering-mistake gap",
  },
  {
    thread: ["I selected wrong item"],
    expectedCategory: "Order change, before shipping queries",
    reason: "The selection verb, article-free, matching its 'selected the wrong' pair.",
    regressionSource: "brief: ordering-mistake gap",
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
    reason:
      "`broken` is Damage's word. No warranty is invoked, so the suppression " +
      "that moves 'warranty for broken item' to Defective does not apply here.",
    regressionSource: "brief: damage boundary",
  },
  {
    thread: ["It arrived broken"],
    expectedCategory: "Damage queries",
    reason: "Damage on arrival — the case Damage is to remain reserved for.",
    regressionSource: "brief: damage boundary",
  },
  {
    thread: ["The glass was cracked on arrival"],
    expectedCategory: "Damage queries",
    reason: "Cracked on arrival, stated in the brief's own words.",
    regressionSource: "brief: damage boundary",
  },
  {
    thread: ["Damaged in transit"],
    expectedCategory: "Damage queries",
    reason: "Physical damage during delivery, named as transit.",
    regressionSource: "brief: damage boundary",
  },
  {
    thread: ["The shade arrived broken, is it still under warranty?"],
    expectedCategory: "Damage queries",
    reason:
      "BOTH SIGNALS AT ONCE, and arrival wins. A warranty question asked about " +
      "goods that arrived damaged is still a damage case; the suppression is " +
      "conditional on no arrival or transit damage being stated.",
    regressionSource: "bound on the warranty suppression",
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
  /*
   * `failed` IS A DELIVERY WORD FAR MORE OFTEN THAN A FAULT WORD, and these
   * three are why the failure vocabulary is bound to a product subject rather
   * than admitted bare. Measured across live inbound messages: 50 use "failed",
   * and the commonest by a distance is a courier failing to deliver.
   */
  {
    thread: ["Royal Mail failed to deliver the order."],
    expectedCategory: "Admin related issues",
    reason:
      "A courier failing is not a product failing, and what is pinned here is " +
      "that `failed` does NOT reach Defective. It lands on the Admin residue " +
      "rather than Delivery, which is a separate delivery-detection gap and not " +
      "this change's to close.",
    regressionSource: "live inbound message",
  },
  {
    thread: [
      "The dispute is because you failed to deliver on time, did not communicate, and provided terrible service.",
    ],
    expectedCategory: "Admin related issues",
    reason:
      "'you failed' names US as the actor, not the goods, so no fault is " +
      "claimed. Again the guarantee is that it is not Defective.",
    regressionSource: "live inbound message",
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

/* ── 4b. AN ADDRESS CHANGE, AGAINST THE ORDER'S LIFECYCLE ───────────────── */

/**
 * "Order change, BEFORE SHIPPING" says in its own name what it is for. Whether
 * a request to change an address belongs to it turns on whether the order can
 * still be changed — which the words alone do not say.
 */
const ADDRESS_STILL_CHANGEABLE: readonly GoldenCase[] = [
  {
    thread: ["I just placed an order, can I change the delivery address?"],
    expectedCategory: "Order change, before shipping queries",
    reason: "An active order and a request we can carry out.",
    regressionSource: "brief: order-change lifecycle",
  },
  {
    thread: ["I just ordered, can you change delivery address?"],
    expectedCategory: "Order change, before shipping queries",
    reason: "Case 1 of the brief: not dispatched, and the customer asks US to do it.",
    regressionSource: "brief: case 1",
  },
  {
    thread: ["Can you update my address before shipping?"],
    expectedCategory: "Order change, before shipping queries",
    reason:
      "Names the dispatch event as something that has NOT happened. The " +
      "lifecycle test uses past participles only, so `shipping` cannot trip it.",
    regressionSource: "brief: order-change lifecycle",
  },
  {
    thread: ["Please change address before dispatch"],
    expectedCategory: "Order change, before shipping queries",
    reason: "`dispatch` is not `dispatched`; a tense is doing real work here.",
    regressionSource: "brief: order-change lifecycle",
  },
  {
    thread: [
      "Hi, I just ordered these but meant to send to my home address - is it possible to change delivery to 41 Sample Lane West, Kingston, KT0 0AA?",
      "Thanks Dhruv, really appreciated, Liz",
    ],
    turns: [
      {
        direction: "inbound",
        text: "Hi, I just ordered these but meant to send to my home address - is it possible to change delivery to 41 Sample Lane West, Kingston, KT0 0AA?",
      },
      {
        direction: "outbound",
        text: "Thank you for letting us know before your order was dispatched. We have now updated the delivery address as requested.",
      },
      { direction: "inbound", text: "Thanks Dhruv, really appreciated, Liz" },
    ],
    expectedCategory: "Order change, before shipping queries",
    reason:
      "A LIVE AMENDMENT WE ACTUALLY MADE, and the reason the lifecycle test has " +
      "to read negation and tense. Our own reply contains the word `dispatched` " +
      "in a sentence whose whole point is that the order had not gone.",
    regressionSource: "live conversation 874",
  },
  {
    thread: [
      "Hi, I have just realised that I accidentally used my old delivery address for this order. If the order has not been dispatched yet, would you be able to update the delivery address?",
    ],
    expectedCategory: "Order change, before shipping queries",
    reason:
      "The customer says `not been dispatched yet` themselves. A bare " +
      "`dispatched` read that as proof the order had shipped.",
    regressionSource: "live conversation 1297",
  },
  {
    thread: ["My old address is saved on eBay. Can you change the delivery address before you send it?"],
    expectedCategory: "Order change, before shipping queries",
    reason:
      "NAMING THE PLATFORM IS CONTEXT, NOT A REQUEST. The customer mentions " +
      "eBay only to explain WHY the address is stale; what they ask for is an " +
      "amendment, from us, before dispatch. The self-service pattern matched " +
      "`address is saved on eBay` and took the whole message.",
    regressionSource: "brief: test 1",
  },
  {
    thread: [
      "Hi, I placed my order yesterday but noticed my old address is saved on eBay. Can you please change the delivery address before you send it?",
    ],
    expectedCategory: "Order change, before shipping queries",
    reason: "The audit's case 1, in full, with the order placed the day before.",
    regressionSource: "audit case 1",
  },
  {
    thread: ["My eBay address is wrong. Please update the delivery address before dispatch."],
    expectedCategory: "Order change, before shipping queries",
    reason:
      "The platform, a wrong address and a direct request in one breath. " +
      "`change THE delivery address` is this order's; the saved-address shape " +
      "requires a determiner naming the account.",
    regressionSource: "brief: test 3",
  },
  {
    thread: ["My eBay address is wrong. Can you change it before you send the parcel?"],
    expectedCategory: "Order change, before shipping queries",
    reason:
      "The brief's precedence example. A direct request to us plus an explicit " +
      "pre-dispatch moment outranks any platform mention — it names something " +
      "we can actually do.",
    regressionSource: "brief: precedence rule",
  },
];

const ADDRESS_IS_THE_MARKETPLACE_S: readonly GoldenCase[] = [
  {
    thread: ["How do I change delivery address on eBay?"],
    turns: [
      { direction: "outbound", text: "Parcel was delivered to address A." },
      { direction: "inbound", text: "How do I change delivery address on eBay?" },
    ],
    expectedCategory: "Admin related issues",
    reason:
      "Case 2 of the brief. The lifecycle comes from OUR message — the most " +
      "reliable statement of the order's state there is — and the question is " +
      "about account management, not an amendment the seller performs.",
    regressionSource: "brief: case 2",
  },
  {
    thread: ["How do l change delivery address on ebay"],
    expectedCategory: "Admin related issues",
    reason: "The live instance of case 2, typo and all.",
    regressionSource: "live conversation 37945",
  },
  {
    thread: ["Can I update my eBay address?"],
    expectedCategory: "Admin related issues",
    reason:
      "Case 4: no order context at all. Naming the PLATFORM is what makes it " +
      "account management, so no lifecycle evidence is needed. Reached by the " +
      "intent layer with no action set, which is why the rule is applied to the " +
      "finished reading rather than to one branch.",
    regressionSource: "brief: case 4",
  },
  {
    thread: ["Can I change my address?"],
    turns: [
      { direction: "outbound", text: "Your order has been dispatched." },
      { direction: "inbound", text: "Can I change my address?" },
    ],
    expectedCategory: "Admin related issues",
    reason:
      "No platform named, so this one turns entirely on the lifecycle: there is " +
      "no amendment left for us to make.",
    regressionSource: "brief: order-change lifecycle",
  },
  {
    thread: ["Where can I change my delivery address on my eBay account?"],
    expectedCategory: "Admin related issues",
    reason:
      "`WHERE` WAS MISSING FROM THE QUESTION FRAME, which only knew `how do/can " +
      "I`, so the plainest account-settings question in the set read as an " +
      "order change — the exact opposite failure to the one above it.",
    regressionSource: "brief: test 2 / audit case 5",
  },
  {
    thread: ["How do I update my saved eBay address?"],
    expectedCategory: "Admin related issues",
    reason: "The saved address named as the thing to change: account management.",
    regressionSource: "brief: test 5",
  },
  {
    thread: ["How do I change my saved address?"],
    expectedCategory: "Admin related issues",
    reason:
      "The same shape with no platform named at all. `saved` is what makes it " +
      "the account's address rather than this order's.",
    regressionSource: "brief: admin examples",
  },
  {
    thread: ["Where can I change my eBay address?"],
    expectedCategory: "Admin related issues",
    reason: "The shortest form of the question, and the brief's first admin example.",
    regressionSource: "brief: admin examples",
  },
];

/** A completed delivery to the wrong place is ours, not an account setting. */
const ADDRESS_IS_A_DELIVERY_FAILURE: readonly GoldenCase[] = [
  {
    thread: ["My parcel went to the wrong address"],
    expectedCategory: "Delivery queries",
    reason: "Case 3 of the brief: a misdelivery, stated with the word `wrong`.",
    regressionSource: "brief: case 3",
  },
  {
    thread: ["My parcel was delivered to another address"],
    expectedCategory: "Delivery queries",
    reason:
      "The same complaint without the word `wrong`. It reached no delivery " +
      "signal at all — no intent, no event, no category — and fell to the Admin " +
      "residue, which is the one place that cannot help with a parcel.",
    regressionSource: "brief: delivery-complaint protection",
  },
  {
    thread: ["Tracking shows delivered but not my address"],
    expectedCategory: "Delivery queries",
    reason: "A completed delivery to somewhere else is a delivery failure.",
    regressionSource: "brief: delivery-complaint protection",
  },
  {
    thread: ["My parcel was delivered to an address I don't recognise."],
    expectedCategory: "Delivery queries",
    reason:
      "THE ADDRESS THEY CANNOT PLACE — the same complaint judged neither by " +
      "`wrong` nor by naming an alternative. The customer simply does not know " +
      "where it went, and the message carried an address, a completed delivery " +
      "and no delivery signal at all, so it landed on the Admin residue.",
    regressionSource: "brief: test 4",
  },
  {
    thread: ["My parcel went to the wrong address"],
    turns: [
      { direction: "outbound", text: "Tracking shows delivered." },
      { direction: "inbound", text: "My parcel went to the wrong address" },
    ],
    expectedCategory: "Delivery queries",
    reason:
      "Every ingredient of the Admin rule is present — an address, a delivery, " +
      "a finished order — and the complaint outranks all of them.",
    regressionSource: "brief: case 3 with lifecycle context",
  },
];

describe("golden set — 4b. an address change against the order's lifecycle", () => {
  describe("the order can still be changed", () => check(ADDRESS_STILL_CHANGEABLE));
  describe("the order has gone, or the marketplace owns the address", () =>
    check(ADDRESS_IS_THE_MARKETPLACE_S));
  describe("the address is a delivery failure, not a setting", () =>
    check(ADDRESS_IS_A_DELIVERY_FAILURE));
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
    ...ADDRESS_STILL_CHANGEABLE, ...ADDRESS_IS_THE_MARKETPLACE_S, ...ADDRESS_IS_A_DELIVERY_FAILURE,
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
      // THE DIRECTIONS ARE PART OF THE IDENTITY. The same customer message
      // with and without one of our replies in front of it are two different
      // cases, and that pairing is precisely how the lifecycle rules are pinned.
      const key =
        entry.turns === undefined
          ? entry.thread.join(" ")
          : entry.turns.map((turn) => `${turn.direction}:${turn.text}`).join(" ");
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

/*
 * The `documented gaps` block that stood here held two `it.fails` rows for the
 * article-free ordering mistake. Both are fixed and have been promoted into the
 * CUSTOMER_MISTAKE table above, which is what that block existed to prompt.
 */

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
