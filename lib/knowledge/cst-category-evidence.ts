import type { MessageCategory } from "./message-category";

/**
 * The customer language the CST rule books approve, as evidence a classifier
 * can cite.
 *
 * WHY THIS FILE EXISTS AT ALL. The category classifier was built from live
 * customer text and measured against it, which makes it accurate but
 * unaccountable: when it names a category there is nothing to point at except
 * the regex that fired. The eleven CST rule books each carry a section of
 * approved customer phrasing written by the business, and that is the thing a
 * reviewer actually trusts. This module is that section, extracted once,
 * reviewed, and checked in — so a classification can name the workbook, the
 * sheet and the rule behind it.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS CHECKED IN RATHER THAN READ FROM THE WORKBOOKS
 * ------------------------------------------------------------------------
 * `cst-rules-files.ts` already parses `Knowledge-source/` at runtime, and that
 * is right for DRAFTING: one model call per conversation can afford a couple of
 * seconds and a cache. Classification cannot. It runs at list-fetch time, over
 * every conversation in the inbox, inside a query the interface waits on. Ten
 * workbooks and roughly 250 sheets is not something to do per message, and a
 * classifier that silently changes behaviour because somebody edited a
 * spreadsheet is not one anybody can test.
 *
 * So the extraction happened once, against the files named in
 * `CST_TRIGGER_SOURCES`, and the result was READ AND CUT DOWN BY HAND. What is
 * here is not the raw phrase dump.
 *
 * ------------------------------------------------------------------------
 * WHY THE PHRASES ARE NOT SIMPLY MERGED INTO ONE KEYWORD LIST
 * ------------------------------------------------------------------------
 * Because doing that produces a classifier that is wrong in a way no amount of
 * extra phrases can fix. The rule books were written to route a message WITHIN
 * one area, by a person who already knows which area it is, so each of them
 * claims vocabulary that plainly belongs to another:
 *
 *   Wrong item INT-WI16      claims "wrong quantity", "received fewer",
 *                            "one short", "missing from order"
 *   Parts missing INT-MP17   claims "box was damaged", "packaging damaged"
 *   Delivery sheet 9.3       claims "item smashed / shattered", "arrived broken"
 *   Defective INT-DF12       claims "shade smashed", "shade cracked"
 *   Order change INT-OS08    claims "where is my parcel", "hasn't arrived"
 *   Damage · Bulbs           claims "bulb faulty / bulb dead / not lighting"
 *
 * Merged into one table, "shade smashed" is evidence for three categories at
 * once and "where is my parcel" is evidence for a pre-dispatch amendment. The
 * overlap is not a defect in the documents — INT-OS08 is a genuine rule about
 * restricted-price orders, and it is correct WHEN the internal restricted-price
 * flag is set, which is a condition no incoming message can satisfy on its own.
 *
 * SO EVIDENCE IS NOT A VOTE. Every entry below carries the CONCEPT it is
 * evidence of, and a category owns a concept rather than a word. Two rule books
 * claiming "smashed" produce two candidates for the same concept — physical
 * damage to the goods received — and that concept has exactly one owner.
 * `resolveEvidenceOwnership` then drops the candidates whose context does not
 * fit. See `OwnershipConcept` for the concept list and `CONCEPT_OWNER` for who
 * owns what.
 *
 * PURE. No files, no network, no database, no model call. Nothing here reads
 * `Knowledge-source/`; the workbooks are the provenance, not a dependency.
 */

/* ------------------------------------------------------------------------- *
 * THE ELEVEN SOURCES
 * ------------------------------------------------------------------------- */

export type CstTriggerSource = {
  readonly category: MessageCategory;
  /** Workbook filename, exactly as it sits in `Knowledge-source/`. */
  readonly file: string;
  /** Where the approved customer language lives inside that workbook. */
  readonly sheet: string;
  /** The heading over it, as written. NOT normalised to a common wording. */
  readonly heading: string;
  /**
   * The workbook's own scenario identifiers, where it has any.
   *
   * Ten of the eleven number their intents (`INT-WI09`, `INT-MP04`). The Damage
   * guide does not — see the note on that entry — so this is null there, and
   * evidence taken from it is keyed on its Damage Type label instead.
   */
  readonly intentIdPrefix: string | null;
};

/**
 * One workbook per category, and the mapping is not a guess.
 *
 * Eleven categories, eleven workbooks, each named in full and matched against
 * `APPROVED_KNOWLEDGE_FILES` by a test — a renamed file fails loudly rather
 * than quietly sourcing a category from nothing. The twelfth approved workbook,
 * `MESSAGE HANDLING RULES .xlsx`, is deliberately absent: it governs HOW to
 * reply across every area and defines no category of its own.
 *
 * TWO OF THE ELEVEN ARE SHAPED DIFFERENTLY, and both were checked rather than
 * assumed:
 *
 *   Delivery   has no single intent-map sheet. Its triggers sit per scenario,
 *              in column F of each of its 26 numbered sheets, under the same
 *              heading each time.
 *   Damage     has no sheet titled "Trigger Keywords" and no intent map at all.
 *              Its approved customer language is a COLUMN — "What Customer
 *              Typically Says" — on each of its nine product sheets, keyed by
 *              Damage Type and Severity rather than by an intent id. It is a
 *              functional equivalent, and requiring the literal heading is what
 *              previously made this workbook look as though it had no trigger
 *              vocabulary. It has plenty; it is simply not laid out like the
 *              other ten.
 */
export const CST_TRIGGER_SOURCES: readonly CstTriggerSource[] = [
  {
    category: "Delivery queries",
    file: "Delivery_Master_Rules final.xlsx",
    sheet: "sheets 1–26, column F (per scenario)",
    heading: "🔑 AI Trigger Keywords (Actual customer phrases — match against incoming message)",
    intentIdPrefix: null,
  },
  {
    category: "Pre sales queries",
    file: "PRE-SALES QUERIES.xlsx",
    sheet: "🔑 TRIGGER KEYWORDS",
    heading: "Customer Trigger Phrases (real messages)",
    intentIdPrefix: "INT-PS",
  },
  {
    category: "Admin related issues",
    file: "ADMIN.xlsx",
    sheet: "12 — TRIGGER KEYWORDS",
    heading: "Customer Trigger Phrases",
    intentIdPrefix: "INT-AD",
  },
  {
    category: "Order change, before shipping queries",
    file: "ORDER BEFORRE SHIPPING And cancelation .xlsx",
    sheet: "17 — TRIGGER KEYWORDS",
    heading: "Customer Trigger Phrases (match any)",
    intentIdPrefix: "INT-OS",
  },
  {
    category: "Defective items",
    file: "DEFECTIVE .xlsx",
    sheet: "14 — TRIGGER KEYWORDS",
    heading: "Customer Trigger Phrases real messages",
    intentIdPrefix: "INT-DF",
  },
  {
    category: "Damage queries",
    file: "DAMAGE DECISION GUIDE.xlsx",
    sheet: "9 product sheets, column B",
    heading: "What Customer Typically Says",
    intentIdPrefix: null,
  },
  {
    category: "Wrong item sent messages",
    file: "Wrong item sent  final.xlsx",
    sheet: "13 — TRIGGER KEYWORDS",
    heading: "Customer Trigger Phrases (real messages)",
    intentIdPrefix: "INT-WI",
  },
  {
    category: "Parts missing queries",
    file: "missing parts query .xlsx",
    sheet: "13 — TRIGGER KEYWORDS",
    heading: "Customer Trigger Phrases",
    intentIdPrefix: "INT-MP",
  },
  {
    category: "Wrong quantity sent issues",
    file: "wrong quantity.xlsx",
    sheet: "12 — TRIGGER KEYWORDS",
    heading: "Customer Trigger Phrases (real messages)",
    intentIdPrefix: "INT-WQ",
  },
  {
    category: "Wrong description issues",
    file: "WRONG DESCRIPTION.xlsx",
    sheet: "13 — TRIGGER KEYWORDS",
    heading: "Customer Trigger Phrases (real messages)",
    intentIdPrefix: "INT-WD",
  },
  {
    category: "Return and refunds",
    file: "RETURNS & REFUNDS — COMPLETE CASE HANDLING MASTER SHEET    final.xlsx",
    sheet: "21 TRIGGER KEYWORDS",
    heading: "CUSTOMER TRIGGER PHRASES",
    intentIdPrefix: "INT",
  },
];

/* ------------------------------------------------------------------------- *
 * CONCEPTS, AND WHO OWNS THEM
 * ------------------------------------------------------------------------- */

/**
 * WHAT THE CUSTOMER IS ACTUALLY REPORTING — the unit of ownership.
 *
 * A category owns a CONCEPT, never a word. This is the whole mechanism: the
 * word "smashed" is claimed by three rule books, but the concept "the goods
 * that arrived are physically damaged" is claimed by one. Anything that reads
 * as that concept goes to Damage, whichever workbook the phrase was found in.
 */
export type OwnershipConcept =
  /** The goods themselves came broken, cracked, dented, scratched. */
  | "PHYSICAL_PRODUCT_DAMAGE"
  /** The BOX came battered. Says nothing about the goods inside it. */
  | "PACKAGING_OR_TRANSIT_DAMAGE"
  /** It is intact and it does not work. */
  | "FUNCTIONAL_FAULT"
  /** Where is it, has it been sent, tracking says delivered and it is not here. */
  | "CONSIGNMENT_WHEREABOUTS"
  /**
   * It simply has not turned up. Sheet 13's own framing — "the FIRST catch-all
   * for basic non-receipt messages" — and deliberately separate from
   * `CONSIGNMENT_WHEREABOUTS`, which is a question about location. "I did not
   * receive my order" asks nothing and states no tracking claim.
   */
  | "CONSIGNMENT_NOT_RECEIVED"
  /** Tracking says delivered; the customer says it is not here. */
  | "DELIVERED_NOT_RECEIVED"
  /** An electrician, a job or an event is waiting on the parcel. */
  | "URGENT_DELIVERY_DEADLINE"
  /** The parcel is at a depot, parcel shop or collection point. */
  | "COLLECTION_POINT_QUERY"
  /** Fewer UNITS arrived than were ordered. */
  | "UNIT_QUANTITY_SHORTFALL"
  /** The unit is here; a component that belongs with it is not. */
  | "ABSENT_COMPONENT"
  /** A materially different product from the one ordered. */
  | "DIFFERENT_ITEM_RECEIVED"
  /** The listing promised one thing and the goods are another. */
  | "LISTING_MISMATCH"
  /** It arrived, nothing is wrong with it, and they want to send it back. */
  | "POST_DELIVERY_RETURN"
  /** Change or cancel it before it goes out. */
  | "PRE_DISPATCH_AMENDMENT"
  /** Asking about a product they have not bought. */
  | "PRE_PURCHASE_ENQUIRY"
  /** Invoices, VAT, receipts, accounts, payment. */
  | "ACCOUNT_OR_PAPERWORK";

/**
 * The semantic ownership table — one owner per concept, no exceptions.
 *
 * Read against the CST distinctions rather than against how often a word
 * appears. The two pairs that cause the most trouble are written out here
 * because they are the ones every merged keyword list gets wrong:
 *
 *   damaged GOODS vs damaged PACKAGING
 *     Damage owns the first. Delivery owns the second — its sheet 9 is titled
 *     "Damaged in Transit" and its 9.1 condition is literally "Outer box
 *     damaged — customer says contents appear OK". A parcel that arrived
 *     battered with the contents fine is a courier matter, not a product one.
 *
 *   short on UNITS vs missing a COMPONENT
 *     Wrong quantity owns the first, Parts missing the second. "I ordered 6
 *     bulbs and 3 came" is not a bulb with a part absent from it; every bulb
 *     that arrived is complete.
 */
export const CONCEPT_OWNER: Readonly<Record<OwnershipConcept, MessageCategory>> = {
  PHYSICAL_PRODUCT_DAMAGE: "Damage queries",
  PACKAGING_OR_TRANSIT_DAMAGE: "Delivery queries",
  FUNCTIONAL_FAULT: "Defective items",
  CONSIGNMENT_WHEREABOUTS: "Delivery queries",
  CONSIGNMENT_NOT_RECEIVED: "Delivery queries",
  DELIVERED_NOT_RECEIVED: "Delivery queries",
  URGENT_DELIVERY_DEADLINE: "Delivery queries",
  COLLECTION_POINT_QUERY: "Delivery queries",
  UNIT_QUANTITY_SHORTFALL: "Wrong quantity sent issues",
  ABSENT_COMPONENT: "Parts missing queries",
  DIFFERENT_ITEM_RECEIVED: "Wrong item sent messages",
  LISTING_MISMATCH: "Wrong description issues",
  POST_DELIVERY_RETURN: "Return and refunds",
  PRE_DISPATCH_AMENDMENT: "Order change, before shipping queries",
  PRE_PURCHASE_ENQUIRY: "Pre sales queries",
  ACCOUNT_OR_PAPERWORK: "Admin related issues",
};

/* ------------------------------------------------------------------------- *
 * THE EVIDENCE
 * ------------------------------------------------------------------------- */

/**
 * The Conditions / When-to-Use checks an entry needs before it counts.
 *
 * THIS IS THE "VALIDATE CONDITIONS" STEP, and it is what stops the rule books'
 * internal routing from leaking out of them. Each rule book was written for
 * someone who already knows which area they are in, so several of its rows are
 * only correct under a condition the row states in prose — "not dispatched",
 * "customer says contents appear OK", "customer has not purchased yet". A
 * pattern lifted out of such a row and matched blind is wrong exactly as often
 * as the condition is false.
 *
 * The checks are named rather than written as predicates here because this
 * module holds no message context. `resolveEvidenceOwnership` in
 * `message-category.ts` implements them, next to the arrival, quantity and
 * packaging predicates they need.
 */
export type EvidenceCondition =
  /** The parcel is with the customer. */
  | "goods_have_arrived"
  /** The parcel is NOT yet with the customer — pre-dispatch, or pre-purchase. */
  | "goods_not_yet_arrived"
  /** The damage word attaches to the goods, not only to the box. */
  | "damage_is_on_the_goods"
  /** The damage word attaches only to the box. */
  | "damage_is_on_the_packaging"
  /**
   * No return is already under way.
   *
   * Distinct from `goods_not_yet_arrived`, which reads the message for an
   * ARRIVAL. A customer arguing about the postage on a parcel they are sending
   * back never says it arrived, so that condition holds — and the message is
   * still unmistakably post-purchase.
   */
  | "not_a_return_in_progress"
  /** Not a count of units measured against the order — that belongs to Wrong quantity. */
  | "not_a_unit_shortfall"
  /** The absent thing is not an invoice or receipt — that belongs to Admin. */
  | "not_the_paperwork"
  /** Two DIFFERENT things are named either side of an ordered/received contrast. */
  | "two_different_things_named";

export type CategoryEvidence = {
  /** Stable id for this entry. The CST intent id where the workbook has one. */
  readonly id: string;
  readonly concept: OwnershipConcept;
  /**
   * Conditions that must hold for this row to count. All of them, not any.
   * Empty when the row's own wording is specific enough to stand alone.
   */
  readonly requires?: readonly EvidenceCondition[];
  /** Workbook this was taken from. */
  readonly file: string;
  /** Sheet within it. */
  readonly sheet: string;
  /**
   * The workbook's own Conditions / When-to-Use text for the scenario, cut to
   * one line. This is what `resolveEvidenceOwnership` checks context against —
   * not decoration.
   */
  readonly condition: string;
  /**
   * The CST phrases this pattern stands for, quoted from the workbook.
   *
   * A SAMPLE, NOT THE WHOLE ROW. Rows run to twenty or thirty phrases and
   * reproducing them wholesale would put CST documents in a source file for no
   * gain. What is here is enough for a reviewer to open the sheet and find the
   * row, which is what provenance is for.
   */
  readonly phrases: readonly string[];
  /** What the phrases generalise to. Case-insensitive, never global. */
  readonly pattern: RegExp;
};

/**
 * "I ASKED FOR THIS AND THAT TURNED UP" — the shape behind CST INT-WI09.
 *
 * WHY A SHAPE AND NOT PHRASES. Every phrase in that row names two specific
 * products or attributes either side of an ordered/received contrast — "I
 * ordered black got gold", "ordered 30cm got 20cm", "received E27 ordered E14",
 * "I ordered rustic red you sent copper". The row is 22 phrases long and could
 * be 2,200: what recurs is not the colours or the fittings, it is the contrast.
 * Enumerating the pairs is not possible; naming the shape is.
 *
 * TWO CAPTURES, AND BOTH MATTER. Group 1 is what was ordered, group 2 is what
 * came, and `namesTwoDifferentThings` compares them. Without that comparison
 * "I ordered it and received it" is the same shape as "I ordered black and
 * received gold", and only one of them is a wrong item.
 *
 * Exported so the ownership resolver can re-read the captures; nothing else
 * uses it.
 */
/**
 * A COUNT AND AN INDIRECT OBJECT ARE NOT THE THING.
 *
 * "I ordered 2 blue lampshades, why have you sent me one green and one blue"
 * captured `2 dep` as what was ordered and `me one` as what arrived — a
 * quantity and a pronoun, neither of them the product. The contrast the row
 * exists to read is between the two DESCRIPTIONS, so the count and the "me" are
 * skipped before the capture starts.
 *
 * Both skips are optional, so every shape this already matched still matches.
 */
/**
 * `order` IS A NOUN FAR MORE OFTEN THAN IT IS A VERB HERE.
 *
 * "I have just received my ORDER and unfortunately one of the bulbs GOT
 * smashed in the post" is a damage report. This row read the noun as the verb,
 * took "and unfortunately" as the thing ordered and "smashed in" as the thing
 * received, found them different, and asserted a wrong item — which outranks
 * damage in the ownership table, so the whole conversation became Wrong item
 * sent.
 *
 * The lookbehind keeps the verb sense ("I order these regularly and received
 * the wrong one") and refuses the noun after a determiner or possessive, which
 * is how customers write "my order", "the order", "your order". `ordered` is
 * unaffected and is the form nearly every real contrast uses.
 */
export const ORDERED_ONE_THING_RECEIVED_ANOTHER =
  /\b(?:ordered|(?<!\b(?:my|the|your|our|his|her|their|its|this|that|a|an|each|every|first|last|whole|entire|original|recent|previous)\s)order|bought|purchased|asked\s+for|paid\s+for|requested)\s+(?:the\s+|a\s+|an\s+|some\s+|my\s+)?(?:\d+\s+|one\s+|two\s+|three\s+|four\s+)?([\w.\-]+(?:\s+[\w.\-]+)?)\b[^.!?]{0,40}?\b(?:received|recieved|got\s+sent|got|you\s+sent|sent\s+me|arrived\s+was|came\s+as|delivered\s+was)\s+(?:me\s+)?(?:the\s+|a\s+|an\s+|some\s+|my\s+)?(?:\d+\s+|one\s+|two\s+|three\s+|four\s+)?([\w.\-]+(?:\s+[\w.\-]+)?)/i;

/**
 * Words that are not a product, so cannot be one side of the contrast.
 *
 * "I ordered on Monday but received it Friday" has the shape and no mismatch:
 * a date is not a thing we sent, and a pronoun names nothing. Requiring the
 * HEAD of each captured phrase to be a real noun is what separates that from
 * "ordered shade A but received shade B".
 */
export const NOT_A_PRODUCT_WORD = new Set([
  "it", "them", "they", "this", "that", "these", "those", "one", "ones", "mine",
  "yours", "his", "hers", "theirs", "something", "anything", "nothing",
  "on", "in", "at", "from", "for", "by", "with", "to", "of", "about",
  "today", "yesterday", "tomorrow", "monday", "tuesday", "wednesday",
  "thursday", "friday", "saturday", "sunday", "week", "month", "year",
  "online", "again", "already", "recently", "back",
]);

/**
 * The reviewed evidence map.
 *
 * ORDER IS IRRELEVANT — every entry is tested and ownership resolves the
 * result, so nothing here depends on sitting above anything else. Entries are
 * grouped by workbook purely so a reviewer can read one area at a time.
 */
export const CST_EVIDENCE: readonly CategoryEvidence[] = [
  /* ---------------- Damage ---------------- */
  {
    id: "DMG-BREAKAGE",
    requires: ["damage_is_on_the_goods"],
    concept: "PHYSICAL_PRODUCT_DAMAGE",
    file: "DAMAGE DECISION GUIDE.xlsx",
    sheet: "🔵 Glass Lampshade · 💡 Ceiling Pendant Wall Lights · 💡 Bulbs",
    condition: "Damage Type 'Broken or shattered' / 'Glass shade cracked or broken' — Severity Severe or COMPLETE (safety)",
    phrases: [
      "arrived broken / smashed / shattered",
      "shade cracked / shade broken / arrived smashed",
      "arrived broken / glass smashed",
    ],
    // "shattered" was the gap this entry closes: the classifier knew "smashed"
    // and "broken" and had never been given the third word the same CST row
    // uses for the same thing.
    pattern: /\b(?:smash\w*|shatter\w*|broken|breakage|zerbrochen|zersplittert)\b/i,
  },
  {
    id: "DMG-CRACK",
    requires: ["damage_is_on_the_goods"],
    concept: "PHYSICAL_PRODUCT_DAMAGE",
    file: "DAMAGE DECISION GUIDE.xlsx",
    sheet: "🔵 Glass Lampshade · 🔌 Lamp Holders · ⚡ LED Driver – Metal Case",
    condition: "Damage Type 'Crack / fracture' — Severity Significant, conditional on whether it affects use",
    phrases: ["cracked glass / line crack / fracture", "cracked holder / crack in socket", "cover cracked / diffuser cracked / plastic cover damaged"],
    pattern: /\b(?:crack\w*|fractur\w*|gesprungen)\b/i,
  },
  {
    id: "DMG-DENT",
    requires: ["damage_is_on_the_goods"],
    concept: "PHYSICAL_PRODUCT_DAMAGE",
    file: "DAMAGE DECISION GUIDE.xlsx",
    sheet: "🔩 Metal Lampshade · 🪔 Wall & Pipe Lights · ⚡ LED Driver – Metal Case",
    condition: "Damage Type 'Small dent' (cosmetic) through 'badly dented / crushed / collapsed' (severe)",
    phrases: ["small dent / slight indent", "badly dented / crushed / collapsed", "case crushed / badly dented / collapsed"],
    pattern: /\b(?:dent\w*|crush\w*|verbeult|zerdr(?:ü|ue)ckt)\b/i,
  },
  {
    id: "DMG-SURFACE",
    requires: ["damage_is_on_the_goods"],
    concept: "PHYSICAL_PRODUCT_DAMAGE",
    file: "DAMAGE DECISION GUIDE.xlsx",
    sheet: "🔵 Glass Lampshade · 🔩 Metal Lampshade · 🔌 Lamp Holders",
    condition: "Damage Type 'Small scratch / surface mark' / 'Paint chipped' — Severity Slight, cosmetic",
    phrases: ["small scratch / surface mark on glass", "paint chipped / finish damaged", "chip on shade / small piece missing", "scratch / mark / surface scuff"],
    // "chipped" and "scuffed" are the additions. Bounded to the damage senses:
    // `chip` alone would fire on a chip shop, and `chipped` on a chipped tooth,
    // but neither is a thing this inbox discusses.
    pattern: /\b(?:scratch\w*|chipped|chip\s+(?:on|off|out\s+of)|scuff\w*|zerkratzt)\b/i,
  },
  {
    id: "DMG-GENERAL",
    requires: ["damage_is_on_the_goods"],
    concept: "PHYSICAL_PRODUCT_DAMAGE",
    file: "DAMAGE DECISION GUIDE.xlsx",
    sheet: "🪔 Wall & Pipe Lights · 🔗 Fabric  Cables",
    condition: "Damage Type 'Item damaged' across product sheets — severity decided by the Severity column",
    phrases: ["paint chipped off / paint missing patch", "plastic broken / can see inside / parts falling out"],
    pattern: /\b(?:damag\w*|besch(?:ä|ae)digt)\b/i,
  },

  /* ---------------- Delivery ---------------- */
  {
    id: "DEL-9.1",
    requires: ["damage_is_on_the_packaging"],
    concept: "PACKAGING_OR_TRANSIT_DAMAGE",
    file: "Delivery_Master_Rules final.xlsx",
    sheet: "💥 9 – Damaged in Transit",
    condition: "Outer box damaged — customer says contents appear OK",
    phrases: [
      "Box arrived damaged",
      "Packaging was damaged",
      "Outer box was crushed",
      "Box damaged but contents seem okay",
    ],
    // The packaging noun and the damage word have to be in the same clause. The
    // pattern is deliberately the OBJECT half only — whether the goods are also
    // damaged is decided in ownership resolution, not here.
    pattern:
      /\b(?:box|boxes|carton|packaging|parcel|package|container|outer|wrapping|karton|verpackung|paket)\b[^.!?]{0,80}?\b(?:damaged|dented|crushed|crumpled|ripped|torn|battered|smashed|broken|squashed|besch(?:ä|ae)digt)\b|\b(?:damaged|dented|crushed|crumpled|ripped|torn|battered|smashed|broken|squashed)\b[^.!?]{0,40}?\b(?:box|boxes|carton|packaging|parcel|package|container|outer|wrapping|karton|verpackung|paket)\b/i,
  },
  {
    id: "DEL-1.1",
    concept: "CONSIGNMENT_WHEREABOUTS",
    file: "Delivery_Master_Rules final.xlsx",
    sheet: "📦 1 – Tracking Update · 📭 13 – Not Received (General)",
    condition: "Customer says item not arrived — no tracking claim, no specific context",
    phrases: [
      "Where is my order?",
      "Where is my parcel?",
      "Still waiting for delivery",
      "When will it arrive?",
      "Still haven't received it",
    ],
    pattern:
      /\bwhere\s*(?:'s|is|are|has|have)\b[^.!?]{0,25}?\b(?:orders?|parcels?|packages?|items?|deliver(?:y|ies)|shipments?|goods)\b|\b(?:still\s+)?wait(?:ing)?\s+(?:for|on)\b[^.!?]{0,25}?\b(?:orders?|parcels?|packages?|items?|deliver(?:y|ies)|shipments?|goods)\b/i,
  },
  {
    id: "DEL-13.1",
    requires: ["not_the_paperwork", "not_a_return_in_progress"],
    concept: "CONSIGNMENT_NOT_RECEIVED",
    file: "Delivery_Master_Rules final.xlsx",
    sheet: "📭 13 – Not Received (General)",
    condition:
      "Customer simply says the item has not arrived, with no tracking claim and no other context — the FIRST catch-all for basic non-receipt",
    phrases: [
      "I have not received my order",
      "Nothing has been delivered",
      "Order never arrived",
      "I didn't get the package",
      "Did not receive the item",
      "No parcel received",
    ],
    // A NEGATED RECEIPT, which is what all 26 of the sheet's phrases are. The
    // classifier already knew how to recognise a non-arrival — `HAS_NOT_ARRIVED`
    // uses it to rule OUT a delivery having happened — but nothing said that a
    // stated non-arrival IS a delivery query, so "Hello I did not receive my
    // order" reached the admin catch-all.
    //
    // DIRECTION MATTERS. The negator must come FIRST, within a short window of
    // the receipt word. Reading it the other way round would swallow "Lamp
    // arrived but does not work", where the arrival is not in dispute at all.
    //
    // THE CONTRACTION NEEDS ITS OWN ALTERNATIVE. A `\b`-anchored negator cannot
    // reach the "n't" in "didn't" or "hasn't" — the preceding character is a
    // letter, so there is no word boundary — and "I didn't get the package" is
    // quoted verbatim on this sheet. The auxiliaries are listed rather than
    // matched with `\w+n't`, so the pattern stays readable and cannot fire on
    // an arbitrary word ending in those letters.
    pattern:
      /(?:\b(?:not|never|no|none|nothing)\b|\b(?:do|does|did|has|have|had|is|are|was|were|will|wo|ca|could|should|would)\s?n[o']?t\b)[^.!?]{0,22}?\b(?:receiv\w*|recieved|arriv\w*|deliver\w*|dispatch\w*|turned\s+up|got\s+(?:it|them|my|the)|get\s+(?:it|them|my|the)|come|came)\b/i,
  },
  {
    id: "DEL-13.2",
    requires: ["not_the_paperwork", "not_a_return_in_progress"],
    concept: "CONSIGNMENT_NOT_RECEIVED",
    file: "Delivery_Master_Rules final.xlsx",
    sheet: "📭 13 – Not Received (General)",
    condition:
      "Customer has waited past the estimated delivery date and is frustrated or escalating",
    phrases: [
      "It was meant to be here last week",
      "Way past the delivery date",
      "Massively overdue",
      "This is taking too long",
      "It has been weeks and nothing",
    ],
    // The overdue statement, which names no negation at all — "this should have
    // been delivered yesterday" asserts an arrival that was due, not one that
    // did not happen. "should have RECEIVED" is deliberately absent: that is a
    // count against the order and belongs to Wrong quantity.
    pattern:
      /\bshould\s+have\s+(?:been\s+)?(?:arrived|delivered|come|been\s+here)\b|\bmeant\s+to\s+(?:be\s+here|have\s+arrived|arrive)\b|\b(?:way\s+)?(?:past|overdue|beyond)\s+(?:the\s+)?(?:delivery\s+|estimated\s+)?date\b|\b(?:massively\s+)?overdue\b|\btaking\s+(?:too\s+long|so\s+long|ages)\b|\bbeen\s+waiting\s+(?:so\s+long|weeks|ages|for\s+ages)\b/i,
  },
  {
    id: "DEL-2.1",
    requires: ["not_a_return_in_progress"],
    concept: "DELIVERED_NOT_RECEIVED",
    file: "Delivery_Master_Rules final.xlsx",
    sheet: "✅ 2 – Delivered Not Received",
    condition: "Tracking status is 'Delivered'. Customer says they have not received the parcel. Address on order matches",
    phrases: [
      "It says delivered but I haven't received it",
      "Marked as delivered but nothing here",
      "Says left at door but there's nothing",
      "I was in all day and there was no delivery",
      "No delivery card through my door",
    ],
    // THE SUBJECT IS NOW OPTIONAL, and that was the defect. Requiring
    // "tracking"/"Amazon"/"the courier" to be named meant "Marked as delivered
    // but nothing here" — a phrase quoted verbatim on this sheet — matched
    // nothing, because the customer never says who marked it.
    pattern:
      /\b(?:says?|shows?|showing|marked\s+as|status\s+is)\b[^.!?]{0,25}?\bdeliver\w*\b[^.!?]{0,45}?\b(?:not|no|nothing|haven'?t|have\s+not|don'?t|isn'?t|wasn'?t)\b|\b(?:says?|shows?)\s+(?:it\s+was\s+)?left\b[^.!?]{0,40}?\b(?:nothing|not\s+there|no\s+sign)\b|\bno\s+delivery\s+(?:card|note)\b/i,
  },
  {
    id: "DEL-18.1",
    // NO `not_a_return_in_progress` HERE, deliberately — unlike the non-receipt
    // families. Sheet 18 lists "I've had to buy it elsewhere because of the
    // delay" among its OWN triggers, because a customer with an electrician
    // waiting says exactly that: "I need this today or I'll have to go to B&Q
    // and buy another and send this back". Vetoing on the threatened return
    // would throw away the scenario at the moment it is most urgent. Nothing is
    // lost by allowing it: `wants_refund` and `wants_post_delivery_return` both
    // outrank `delivery_request`, so a real return still wins.
    requires: ["goods_not_yet_arrived"],
    concept: "URGENT_DELIVERY_DEADLINE",
    file: "Delivery_Master_Rules final.xlsx",
    sheet: "🔴 18 – Urgent Deadline",
    condition:
      "Customer explicitly mentions a hard deadline — electrician, builder, event, opening, specific date. NEVER treat as a standard delay. Always escalate",
    phrases: [
      "My electrician is coming tomorrow",
      "I can't keep the electrician waiting",
      "The job has to be done by [date]",
      "We are opening on [date] and need it",
      "This is urgent — I need it today",
    ],
    // THE TRADE NOUN IS NOT THE TRIGGER — the WAITING is.
    //
    // A bare "electrician" was enough here, and it cost two real conversations:
    // "our electrician is refusing to fit this fitting" is a compatibility
    // question, and "received two wall lamps ... the electrician says the wire
    // is too short" is a wrong-size report. Neither has anybody waiting on a
    // parcel, which is the entire premise of sheet 18 — its own title is "Item
    // not arrived — customer has booked electrician or has a hard deadline".
    //
    // So the deadline word and the dependency have to appear together, which
    // is what every phrase on the sheet does: "electrician is COMING
    // tomorrow", "electrician is HERE NOW and needs it", "can't keep the
    // electrician WAITING", "the job has to be DONE BY [date]".
    pattern:
      /\b(?:electrician|electricians|builder|builders|fitter|fitters|contractor|contractors|installer|plumber|joiner|decorator|job|jobs|installation|install|fitting|opening|event|wedding|deadline)\b[^.!?;\n]{0,45}?\b(?:coming|comes|arriv\w*|here\s+(?:now|today|tomorrow)|waiting|booked|attend\w*|due|urgent\w*|held\s+up|tomorrow|today|by\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b|\b(?:waiting\s+(?:on|for)|can'?t\s+keep|need(?:s|ed)?\s+(?:it|this|them)\s+(?:by|for|before)|booked|fast\s?track)\b[^.!?;\n]{0,45}?\b(?:electrician|builder|fitter|contractor|installer|plumber|joiner|job|jobs|installation|install|fitting|opening|event|wedding|deadline)\b|\b(?:today|tomorrow|urgent\w*|asap|this\s+week|by\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b[^.!?;\n]{0,45}?\b(?:electrician|builder|fitter|contractor|installer|plumber|joiner|job|jobs|installation|install|fitting|opening|event|wedding|deadline)\b/i,
  },
  {
    id: "DEL-2.4",
    requires: ["not_a_return_in_progress"],
    concept: "COLLECTION_POINT_QUERY",
    file: "Delivery_Master_Rules final.xlsx",
    sheet: "✅ 2 – Delivered Not Received (2.4) · 🏠 6 – Failed Delivery (6.3)",
    condition:
      "Parcel was taken to a collection point and the customer was not notified, or is held at the local depot after failed attempts",
    phrases: [
      "It's at a collection point",
      "Package at the parcel shop",
      "I need to collect it from somewhere",
      "No notification to collect",
      "Parcel is at the depot",
      "I need to collect from the depot",
    ],
    pattern:
      /\b(?:collection\s+(?:point|code|email|note|notification)|parcel\s+shop|pick[-\s]?up\s+point|relay\s+point|post\s+office|depot|collect\s+point)\b|\b(?:email|code|notification|note|card)\s+for\s+collection\b|\bwhere\s+(?:and\s+when\s+)?(?:can|do|should)\s+i\s+(?:collect|pick\s+(?:it|them|this|the\s+\w+)?\s*up)\b|\b(?:can|when)\s+(?:and\s+where\s+)?(?:can\s+)?i\s+(?:collect|pick\s+up)\b[^.!?]{0,30}?\b(?:it|item|items|parcel|package|order|from)\b/i,
  },
  {
    id: "DEL-3.1",
    concept: "CONSIGNMENT_WHEREABOUTS",
    file: "Delivery_Master_Rules final.xlsx",
    sheet: "🚚 3 – In Transit Normal · ⏳ 4 – In Transit Delayed · 📭 5 – Not Dispatched",
    condition: "Customer asks when the consignment will be dispatched or arrive",
    phrases: ["Have you sent it?", "Has it been dispatched?", "When will I get my parcel?"],
    pattern:
      /\b(?:has|have)\s+(?:it|they|you|my\s+\w+)\s+(?:been\s+)?(?:sent|dispatched|shipped|posted)\b|\bwhen\s+(?:will|would|can|do|does)\b[^.!?]{0,30}?\b(?:sent|send|dispatch\w*|ship\w*|arrive|receive|get|come)\b/i,
  },

  /* ---------------- Defective ---------------- */
  {
    id: "INT-DF05",
    concept: "FUNCTIONAL_FAULT",
    file: "DEFECTIVE .xlsx",
    sheet: "14 — TRIGGER KEYWORDS",
    condition: "TRANSFORMER / DRIVER Not working — compatibility check first",
    phrases: ["driver not working", "power supply dead", "transformer stopped", "it doesn't pass on electricity"],
    pattern:
      /\b(?:not\s+work\w*|does\s?n[o']?t\s+work|do\s?n[o']?t\s+work|stopped\s+working|is\s+dead|dead\s+on\s+arrival|no\s+output|won'?t\s+(?:turn\s+on|work|light)|funktioniert\s+nicht)\b/i,
  },
  {
    id: "INT-DF08",
    concept: "FUNCTIONAL_FAULT",
    file: "DEFECTIVE .xlsx",
    sheet: "14 — TRIGGER KEYWORDS",
    condition: "BULB Multiple failing or flickering — dimmable means check dimmer first",
    phrases: ["bulbs flickering", "flickering when on", "none of them light", "bulb is defective"],
    pattern: /\b(?:flicker\w*|faulty|defect\w*|kaputt)\b/i,
  },
  {
    id: "INT-DF01",
    concept: "FUNCTIONAL_FAULT",
    file: "DEFECTIVE .xlsx",
    sheet: "14 — TRIGGER KEYWORDS",
    condition: "SAFETY — burning, bang, sparks, smell. IMMEDIATE disconnect",
    phrases: ["burning smell", "smells burnt", "loud bang", "sparks", "burned out"],
    pattern: /\b(?:burning\s+smell|smells?\s+(?:burnt|burned|like\s+burning)|burnt\s+out|burned\s+out|sparks?\b[^.!?]{0,20}\bwhen|loud\s+bang)\b/i,
  },

  /* ---------------- Wrong item sent ---------------- */
  {
    id: "INT-WI11",
    concept: "DIFFERENT_ITEM_RECEIVED",
    file: "Wrong item sent  final.xlsx",
    sheet: "13 — TRIGGER KEYWORDS",
    condition: "WRONG ITEM — General, no images yet. Internal check first before responding",
    phrases: [
      "wrong item",
      "received wrong",
      "incorrect item",
      "not what I ordered",
      "received different item",
      "got sent the wrong",
      "order has been dispatched incorrectly",
    ],
    // THE ARTICLE IS REQUIRED BEFORE "one" / "ones", and the reason is already
    // pinned in the strict phrase table: bare "wrong one" also catches a
    // customer retracting their own previous message — "Wrong one, sorry —
    // ignore that" — which this category must never claim. "THE wrong one" is a
    // statement about the item in front of them.
    pattern:
      /\b(?:wrong\s+(?:item|items|product|thing)|the\s+wrong\s+(?:one|ones)|received\s+(?:the\s+)?(?:wrong|incorrect|different)|got\s+(?:sent\s+)?the\s+wrong|sent\s+(?:me\s+)?(?:the\s+)?wrong|incorrect\s+item|mix[-\s]?up\s+with\s+my\s+order|dispatched\s+incorrectly)\b/i,
  },
  {
    id: "INT-WI09",
    // ORDER MATTERS ONLY FOR THE REPORTED REASON — the first failing condition
    // is the one named. The quantity split is checked first because it is the
    // cross-category judgement a reviewer needs to see: "this looked like a
    // wrong item and it is a count" is a more useful thing to read than "the
    // second noun was a number".
    requires: ["not_a_unit_shortfall", "two_different_things_named"],
    concept: "DIFFERENT_ITEM_RECEIVED",
    file: "Wrong item sent  final.xlsx",
    sheet: "13 — TRIGGER KEYWORDS",
    condition: "COLOUR — Wrong colour received. Ask for photo in good lighting first",
    phrases: [
      "I ordered black got gold",
      "I ordered rustic red you sent copper",
      "not the colour I ordered",
      "ordered gold received rose gold",
    ],
    // THE SHAPE, NOT THE COLOURS. Every phrase in this CST row names two
    // specific products or attributes either side of an ordered/received
    // contrast, and no fixed phrase can enumerate the pairs. What generalises is
    // "I asked for THIS and THAT turned up" with two different things named.
    // `differentThingsNamed` in the classifier checks that the two are actually
    // different, which is what stops "I ordered it and received it" matching.
    pattern: ORDERED_ONE_THING_RECEIVED_ANOTHER,
  },

  {
    id: "INT-WI08",
    requires: ["goods_have_arrived", "not_a_unit_shortfall"],
    concept: "DIFFERENT_ITEM_RECEIVED",
    file: "Wrong item sent  final.xlsx",
    sheet: "13 — TRIGGER KEYWORDS",
    condition: "MEASUREMENT — wrong shade/bracket size. Ask the customer to measure, with a photo",
    phrases: [
      "wrong size shade",
      "too big",
      "too small",
      "wrong dimensions",
      "this item should have been the 30cm shade and it is 20cm",
      "the ones I have received are much shorter",
    ],
    // A SIZE THAT DOES NOT FIT is a wrong-item case in CST, not a parts case
    // and not a description one: the customer was sent a different size from
    // the one the order calls for. `goods_have_arrived` is what separates it
    // from the pre-sales question "will a 30cm shade be too big for this?".
    pattern:
      /\b(?:too\s+(?:big|large|small|short|wide|narrow|thick)|wrong\s+(?:size|sizes|diameter|dimensions?|length)|(?:does|do|did)\s?n[o']?t\s+fit|wo\s?n[o']?t\s+fit|unable\s+to\s+(?:fit|assemble)|much\s+(?:shorter|smaller|bigger|larger)|not\s+(?:the\s+)?right\s+(?:size|length|diameter))\b/i,
  },

  /* ---------------- Parts missing ---------------- */
  {
    id: "INT-MP04",
    requires: ["not_a_unit_shortfall", "not_the_paperwork"],
    concept: "ABSENT_COMPONENT",
    file: "missing parts query .xlsx",
    sheet: "13 — TRIGGER KEYWORDS",
    condition: "MISSING PART — no images yet. Check internally first",
    phrases: [
      "part is missing",
      "part wasn't in the box",
      "part not included",
      "didn't receive all",
      "incomplete",
      "forgot to include",
    ],
    pattern:
      /\b(?:missing|incomplete|not\s+included|wasn'?t\s+in\s+the\s+box|forgot\s+to\s+include|fehl\w*|unvollst(?:ä|ae)ndig|nicht\s+enthalten)\b/i,
  },
  {
    id: "INT-MP05",
    requires: ["not_a_unit_shortfall", "not_the_paperwork"],
    concept: "ABSENT_COMPONENT",
    file: "missing parts query .xlsx",
    sheet: "13 — TRIGGER KEYWORDS",
    condition: "CRITICAL PART — product unusable without it. Urgent priority",
    phrases: ["LED driver missing", "lamp holder missing", "key component missing", "can't install"],
    pattern:
      /\b(?:arrived|received|recieved|came|delivered)\s+without\b|\bno\s+(?:screws|bracket|brackets|fixings|driver|instructions)\b/i,
  },

  /* ---------------- Wrong quantity ---------------- */
  {
    id: "INT-WQ03",
    concept: "UNIT_QUANTITY_SHORTFALL",
    file: "wrong quantity.xlsx",
    sheet: "12 — TRIGGER KEYWORDS",
    condition: "PACKING ERROR — received fewer than ordered. Internal check + send missing quantity",
    phrases: [
      "ordered 2 got 1",
      "I ordered 8 only 5 arrived",
      "only got 2 of 3",
      "one short",
      "short delivered",
    ],
    pattern:
      /\b(?:one\s+short|short\s+deliver\w*|short\s+of|fewer\s+than|less\s+than\s+(?:i\s+)?ordered|wrong\s+(?:quantity|number)|zu\s+wenig)\b/i,
  },
  {
    id: "INT-WQ06",
    concept: "UNIT_QUANTITY_SHORTFALL",
    file: "wrong quantity.xlsx",
    sheet: "12 — TRIGGER KEYWORDS",
    condition: "MULTI-ITEM ORDER — one product missing entirely. Check split dispatch first",
    phrases: ["only received part of my order", "not all products arrived", "only one from the order"],
    pattern:
      /\b(?:only|just)\s+(?:half|part|some|a\s+few|a\s+couple)\s+of\s+(?:my|the|our|this)\s+(?:order|orders|parcel|package|delivery|shipment|items?|goods)\b/i,
  },

  /* ---------------- Wrong description ---------------- */
  {
    id: "INT-WD07",
    concept: "LISTING_MISMATCH",
    file: "WRONG DESCRIPTION.xlsx",
    sheet: "13 — TRIGGER KEYWORDS",
    condition: "DESCRIPTION — listing claimed vs received. Internal verification first",
    phrases: [
      "not as described",
      "the listing said",
      "description doesn't match",
      "not as advertised",
      "the website said",
    ],
    pattern:
      /\b(?:not\s+as\s+(?:described|advertised|listed)|listing\s+(?:says?|said|showed|states?|is\s+(?:wrong|inaccurate))|description\s+(?:says?|said|is\s+(?:wrong|incorrect)|does\s?n[o']?t\s+match)|advertised\s+as|wrongly\s+described|laut\s+beschreibung|nicht\s+wie\s+beschrieben)\b/i,
  },

  /* ---------------- Return and refunds ---------------- */
  {
    id: "INT-WD12",
    requires: ["goods_have_arrived"],
    concept: "POST_DELIVERY_RETURN",
    file: "WRONG DESCRIPTION.xlsx",
    sheet: "13 — TRIGGER KEYWORDS",
    condition: "EXCHANGE / REPLACEMENT REQUEST — check stock, TL for alternative",
    phrases: ["I would like to exchange", "can I exchange", "swap for another colour", "I would like to swap"],
    pattern: /\b(?:exchange|exchanged|exchanging|swap|swapped|swapping|umtausch\w*|tauschen)\b/i,
  },
  {
    id: "INT-WI14",
    concept: "POST_DELIVERY_RETURN",
    file: "Wrong item sent  final.xlsx",
    sheet: "13 — TRIGGER KEYWORDS",
    condition: "REFUND — customer wants refund. Return label + full refund",
    phrases: ["I want a full refund", "please refund", "I want my money back", "just refund me"],
    pattern:
      /\b(?:refund|refunds|refunded|reimburse\w*|money\s+back|r(?:ü|ue)ckerstattung|erstattung|geld\s+zur(?:ü|ue)ck|rimborso)\b/i,
  },

  /* ---------------- Order change before shipping ---------------- */
  {
    id: "INT-OS01",
    requires: ["goods_not_yet_arrived"],
    concept: "PRE_DISPATCH_AMENDMENT",
    file: "ORDER BEFORRE SHIPPING And cancelation .xlsx",
    sheet: "17 — TRIGGER KEYWORDS",
    condition: "CANCELLATION — not dispatched. Check dispatch status first",
    phrases: ["cancel my order", "please cancel", "I want to cancel", "stop my order", "I changed my mind"],
    pattern: /\bcancel\w*\b|\bstorni\w*\b|\bkaufabbruch\b/i,
  },
  {
    id: "INT-OS13",
    requires: ["goods_not_yet_arrived"],
    concept: "PRE_DISPATCH_AMENDMENT",
    file: "ORDER BEFORRE SHIPPING And cancelation .xlsx",
    sheet: "17 — TRIGGER KEYWORDS",
    condition: "ORDER AMENDMENT — variant, quantity or item. Check dispatch, amend or cancel+reorder",
    phrases: ["change colour", "change size", "increase quantity", "add another", "remove one item"],
    pattern:
      /\b(?:chang(?:e|ed|ing)|amend(?:ed|ing)?|switch(?:ed|ing)?|increase|decrease|reduce|add)\s+(?:\w+\s+){0,2}?(?:order|orders|address|item|items|quantity|colour|color|size|variant|design|model|option|delivery)\b|\b(?:bestellung|adresse|artikel)\s+(?:\w+\s+){0,2}?(?:(?:ä|ae)ndern|wechseln)\b/i,
  },
  {
    id: "INT-OS11",
    requires: ["goods_not_yet_arrived"],
    concept: "PRE_DISPATCH_AMENDMENT",
    file: "ORDER BEFORRE SHIPPING And cancelation .xlsx",
    sheet: "17 — TRIGGER KEYWORDS",
    condition: "ADDRESS CHANGE — not dispatched. Act immediately, time sensitive",
    phrases: ["change my address", "I put the wrong address", "wrong postcode", "update shipping address"],
    pattern: /\b(?:wrong|incorrect|different|update|change|amend)\s+(?:\w+\s+){0,2}?(?:address|postcode|post\s+code)\b/i,
  },

  /* ---------------- Pre sales ----------------
   *
   * NINE ENTRIES FOR TWENTY-TWO CST INTENT FAMILIES, and the selection is not
   * arbitrary: these are the families a read-only audit of 50 real Admin
   * conversations actually found falling through. The families left out —
   * discount requests, warehouse visits, free samples, bulk/trade quotes,
   * postage cost, international shipping, return policy — are real, and none of
   * them appeared in the audit. They are deliberately not guessed at here.
   *
   * Each entry keeps the workbook's own INT-PS id, so a reviewer can open the
   * 🔑 TRIGGER KEYWORDS sheet and find the row.
   */
  {
    id: "INT-PS09",
    requires: ["goods_not_yet_arrived", "not_a_return_in_progress"],
    concept: "PRE_PURCHASE_ENQUIRY",
    file: "PRE-SALES QUERIES.xlsx",
    sheet: "🔑 TRIGGER KEYWORDS · G — STOCK AND AVAILABILITY",
    condition: "STOCK AND AVAILABILITY — check internally first. Customer has not purchased yet",
    phrases: ["is this in stock", "do you have this in stock", "do you sell", "have you got", "is it available"],
    pattern:
      /\b(?:in\s+stock|out\s+of\s+stock|back\s+in\s+stock|auf\s+lager)\b|\bdo\s+you\s+(?:sell|stock)\b|\bhave\s+you\s+got\b|\b(?:is|are)\s+(?:it|this|these|they)\s+available\b/i,
  },
  {
    id: "INT-PS03",
    requires: ["goods_not_yet_arrived", "not_a_return_in_progress"],
    concept: "PRE_PURCHASE_ENQUIRY",
    file: "PRE-SALES QUERIES.xlsx",
    sheet: "🔑 TRIGGER KEYWORDS · B — DIMENSIONS AND SPECS",
    condition: "DIMENSIONS AND SPECS — check the listing first before answering",
    phrases: [
      "what are the dimensions",
      "what are the measurements",
      "could you tell me the measurement",
      "how big",
      "what is the depth",
    ],
    pattern:
      /\b(?:dimension|measurement)s?\b|\bhow\s+(?:big|wide|tall|long|deep)\b|\bwhat\s+(?:is\s+the\s+|are\s+the\s+)?(?:size|width|height|depth|diameter|length)\b/i,
  },
  {
    id: "INT-PS04",
    requires: ["goods_not_yet_arrived", "not_a_return_in_progress"],
    concept: "PRE_PURCHASE_ENQUIRY",
    file: "PRE-SALES QUERIES.xlsx",
    sheet: "🔑 TRIGGER KEYWORDS · B — TECHNICAL ELECTRICAL SPECS",
    condition: "TECHNICAL ELECTRICAL SPECS — never guess electrical specs",
    phrases: ["what wattage", "what voltage", "how many amps", "maximum wattage", "power range"],
    pattern:
      /\bwhat\s+(?:is\s+the\s+)?(?:wattage|voltage|power)\b|\bhow\s+many\s+amps\b|\b(?:max(?:imum)?|input|output|constant)\s+(?:wattage|voltage|current)\b|\bpower\s+(?:consumption|range|supply)\b/i,
  },
  {
    id: "INT-PS17",
    requires: ["goods_not_yet_arrived", "not_a_return_in_progress"],
    concept: "PRE_PURCHASE_ENQUIRY",
    file: "PRE-SALES QUERIES.xlsx",
    sheet: "🔑 TRIGGER KEYWORDS · M — OUTDOOR AND IP RATING",
    condition: "OUTDOOR AND IP RATING — check listing, never guess an IP rating",
    phrases: [
      "is this suitable for outdoor use",
      "can I use this outside",
      "is it weatherproof",
      "what is the IP rating",
      "is it IP44",
    ],
    // The bare word "outside" is not the claim — a delivery instruction says it
    // too. What makes it a pre-sales question is asking whether the product is
    // FIT for outdoors, so a suitability word has to sit beside it.
    pattern:
      /\b(?:suitable|safe|ok|okay|rated|rating|use|used|using|go|goes|put|leave)\b[^.!?]{0,25}?\b(?:outdoors?|outside)\b|\b(?:outdoors?|outside)\b[^.!?]{0,25}?\b(?:use|used|rated|rating|suitable|safe)\b|\bweatherproof\b|\bwaterproof\b|\bip\s?\d{2}\b|\bip\s+rat(?:ing|ed)\b/i,
  },
  {
    id: "INT-PS18",
    requires: ["goods_not_yet_arrived", "not_a_return_in_progress"],
    concept: "PRE_PURCHASE_ENQUIRY",
    file: "PRE-SALES QUERIES.xlsx",
    sheet: "🔑 TRIGGER KEYWORDS · N — COLOUR AND FINISH",
    condition: "COLOUR AND FINISH — be honest about screen variation, share a real photo",
    phrases: [
      "what colour is",
      "what finish is it",
      "what is it made of",
      "is it metal or plastic",
      "do you do it in black",
      "any other colours",
    ],
    pattern:
      /\bwhat\s+(?:\w+\s+){0,2}?(?:colour|color|finish|material)\b|\bwhat\s+is\s+it\s+made\s+of\b|\bis\s+it\s+(?:metal|plastic|enamel|brass|chrome|solid\s+brass)\b|\bdo\s+you\s+do\s+(?:it\s+|this\s+|these\s+)?in\b|\bany\s+other\s+colou?rs?\b|\b(?:colou?r|finish)(?:es|s)?\s+(?:are\s+)?available\b/i,
  },
  {
    id: "INT-PS19",
    requires: ["goods_not_yet_arrived", "not_a_return_in_progress"],
    concept: "PRE_PURCHASE_ENQUIRY",
    file: "PRE-SALES QUERIES.xlsx",
    sheet: "🔑 TRIGGER KEYWORDS · O — WIRING AND INSTALLATION",
    condition: "WIRING / DRIVER / TRANSFORMER ADVICE — ask wattage and voltage first, never guess",
    phrases: ["which driver do I need", "which transformer do I need", "what cable do I need", "2 core or 3 core"],
    pattern:
      /\bwhich\s+(?:driver|transformer|power\s+supply|cable|flex)\b|\bwhat\s+cable\b|\b\d\s*[-\s]?core\b|\b(?:braided|twisted|fabric)\s+(?:cable|flex)\b|\bwiring\s+(?:diagram|instructions)\b/i,
  },
  {
    id: "INT-PS20",
    requires: ["goods_not_yet_arrived", "not_a_return_in_progress"],
    concept: "PRE_PURCHASE_ENQUIRY",
    file: "PRE-SALES QUERIES.xlsx",
    sheet: "🔑 TRIGGER KEYWORDS · P — SHADE COMPATIBILITY",
    condition: "SHADE COMPATIBILITY — ask for the top hole diameter",
    phrases: ["what size shade fits", "will a shade fit", "shade ring size", "what size lampshade"],
    pattern:
      /\b(?:what|which)\s+size\s+(?:of\s+)?(?:shade|lampshade)\b|\b(?:will|can|does|would)\s+(?:a|my|this|the|it)\s+(?:\w+\s+){0,2}?shade\s+(?:fit|work|be\s+fitted)\b|\bshade\s+(?:ring|size|compatib\w*|hole)\b/i,
  },
  {
    id: "INT-PS08",
    requires: ["goods_not_yet_arrived", "not_a_return_in_progress"],
    concept: "PRE_PURCHASE_ENQUIRY",
    file: "PRE-SALES QUERIES.xlsx",
    sheet: "🔑 TRIGGER KEYWORDS · F — COMPATIBILITY QUERIES",
    condition: "COMPATIBILITY QUERY — ask for setup details first, never guess",
    phrases: ["will this work with", "is this compatible with", "will this fit", "is this suitable for"],
    pattern:
      /\b(?:will|would|does|can|is)\s+(?:this|it|these|they|i)\s+(?:\w+\s+){0,3}?(?:work\s+(?:with|for|in|on)|fit|compatible|suitable)\b|\b(?:compatible|suitable)\s+(?:with|for)\b/i,
  },
  {
    id: "INT-PS-Y",
    requires: ["goods_not_yet_arrived", "not_a_return_in_progress"],
    concept: "PRE_PURCHASE_ENQUIRY",
    file: "PRE-SALES QUERIES.xlsx",
    sheet: "Y — WEIGHT AND LOAD",
    condition: "WEIGHT AND LOAD — the sheet has no INT id; keyed on its own trigger row",
    phrases: ["what is the weight", "what weight can it hold", "maximum load", "load capacity", "how heavy is it"],
    pattern:
      /\bhow\s+heavy\b|\bhow\s+much\s+does\s+it\s+weigh\b|\bwhat\s+weight\b|\b(?:weight|load)\s+capacity\b|\b(?:max(?:imum)?|total)\s+(?:weight|load)\b|\bload\s+bearing\b|\bhow\s+much\s+(?:can|will)\s+it\s+(?:hold|support|take)\b/i,
  },
  {
    id: "INT-PS15",
    requires: ["goods_not_yet_arrived", "not_a_return_in_progress"],
    concept: "PRE_PURCHASE_ENQUIRY",
    file: "PRE-SALES QUERIES.xlsx",
    sheet: "🔑 TRIGGER KEYWORDS · K — BULB QUESTIONS",
    condition: "BULB QUESTIONS / unit of sale — check the listing for bulb and pack details",
    phrases: ["how many are included", "is a bulb included", "does the price include the bulb", "is it just one", "sold as a pair"],
    pattern:
      /\bhow\s+many\b|\bis\s+(?:it|this|that)\s+(?:just\s+)?(?:one|1|a\s+single)\b|\b(?:sold|come|comes|supplied|priced)\s+(?:as|in)\s+(?:a\s+)?(?:pair|pairs|set|sets|single)\b|\bwie\s+viele?\b|\b(?:is|are)\s+(?:a\s+|the\s+)?bulbs?\s+included\b|\bwhat\s+bulb\s+(?:does|do|can|is|are)\b/i,
  },

  /* ---------------- Admin ---------------- */
  {
    id: "INT-AD-INVOICE",
    concept: "ACCOUNT_OR_PAPERWORK",
    file: "ADMIN.xlsx",
    sheet: "12 — TRIGGER KEYWORDS",
    condition: "A — INVOICE & VAT. Customer requests an invoice, VAT invoice or receipt",
    phrases: ["VAT invoice", "can I have a receipt", "proof of purchase", "business invoice"],
    pattern: /\b(?:invoice|vat|receipt|proof\s+of\s+purchase|rechnung|beleg|quittung|kaufbeleg)\b/i,
  },
];

/* ------------------------------------------------------------------------- *
 * COLLECTION
 * ------------------------------------------------------------------------- */

/** One CST row that matched, with everything needed to look it up. */
export type EvidenceMatch = {
  readonly id: string;
  readonly concept: OwnershipConcept;
  /** Who owns the concept. NOT necessarily the workbook the phrase came from. */
  readonly category: MessageCategory;
  /** The text that matched, for the reviewer. Never the whole message. */
  readonly matched: string;
  readonly sourceFile: string;
  readonly sourceSheet: string;
  readonly condition: string;
};

/**
 * Every CST row whose language is present in the message.
 *
 * CANDIDATES, NOT A DECISION. Overlap is expected here and is not an error:
 * "the shade arrived smashed" legitimately matches Damage's breakage row, and
 * "the box was smashed" matches Delivery's 9.1 row as well. Narrowing happens
 * in `resolveEvidenceOwnership`, which has the message context this does not.
 *
 * The matched text is truncated because it is written to an explanation a
 * reviewer reads, and a long match is the message rather than the evidence.
 */
const MAX_MATCH = 60;

export function collectCategoryEvidence(text: string): EvidenceMatch[] {
  const matches: EvidenceMatch[] = [];
  for (const evidence of CST_EVIDENCE) {
    const found = evidence.pattern.exec(text);
    if (found === null) continue;
    const matched = found[0].replace(/\s+/g, " ").trim();
    matches.push({
      id: evidence.id,
      concept: evidence.concept,
      category: CONCEPT_OWNER[evidence.concept],
      matched: matched.length > MAX_MATCH ? `${matched.slice(0, MAX_MATCH - 1)}…` : matched,
      sourceFile: evidence.file,
      sourceSheet: evidence.sheet,
      condition: evidence.condition,
    });
  }
  return matches;
}

/** Whether any surviving evidence supports a concept. */
export function hasConcept(
  matches: readonly EvidenceMatch[],
  concept: OwnershipConcept,
): boolean {
  return matches.some((match) => match.concept === concept);
}
