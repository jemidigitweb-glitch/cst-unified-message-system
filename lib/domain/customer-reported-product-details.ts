/**
 * What the LISTING says against what the CUSTOMER says they actually received.
 *
 * WHY THIS IS NOT `customer-product-data.ts`. That module answers "what is the
 * customer asking for?" — a pre-sales question, and its labels say so
 * ("Requested colour", "Requested measurement"). This one answers a different
 * question: "the customer says what turned up is not what was sold." Those need
 * different shapes. A request has one value; a discrepancy has two, and showing
 * only one half of it is what makes a reviewer read a claim as a fact.
 *
 * Both modules stay. The draft prompt is built from the other one and is not
 * touched by anything here.
 *
 * THE TWO COLUMNS COME FROM DIFFERENT PLACES AND ARE NEVER MIXED.
 *
 *   Listing / Expected   A verbatim slice of the authoritative listing text for
 *                        the ONE order this conversation resolved to
 *                        (`order_item_info.item_title`, reaching this module as
 *                        the resolved order's product details). Product data.
 *   Customer Reported    A verbatim slice of an INBOUND message. A claim by a
 *                        member of the public, and nothing more.
 *
 * Neither column can ever be filled from the other, because they are extracted
 * by separate functions from separate inputs and merged only at the end. A
 * missing listing value stays null — it is never back-filled from what the
 * customer said, which would turn the customer's claim into the specification
 * it is being compared against.
 *
 * VERBATIM, NEVER PARAPHRASED, NEVER CONVERTED. "13 cm" is reported as `13 cm`.
 * Nothing here normalises units, rounds, corrects spelling, or decides that
 * 130 mm and 13 cm are the same measurement — a reviewer comparing two values
 * is doing so precisely because the system must not make that call.
 *
 * NO VERDICT. This reports the pair and stops. It does not flag a mismatch,
 * score a severity, or conclude that the wrong item was sent. Two values that
 * differ can mean a wrong item, a listing error, a customer measuring the shade
 * rather than the fitting, or a customer who is mistaken. Deciding which is the
 * reviewer's job and there is no data here that could settle it.
 *
 * DRIVEN BY THE CUSTOMER, NOT BY THE CATALOGUE. A row exists only where the
 * customer actually said something about that attribute. Without that rule the
 * section would fill with listing specifications the customer never mentioned,
 * under a heading that says they did.
 *
 * PURE. No network, no database, no clock. Recomputed from data already loaded.
 */

import type { Attachment } from "./attachment";

export const REPORTED_DETAILS_HEADING = "Customer-Reported Product Details";

/**
 * Column headings, named once so the panel and the tests cannot drift apart.
 *
 * THREE SOURCES, THREE LABELS, AND THE WORDING IS THE SAFEGUARD. The listing
 * column was previously "Listing / Expected", which was safe only while there
 * was one notion of "expected". There are now two — what the CATALOGUE says was
 * sold, and what the CUSTOMER says they ordered — and they disagree precisely
 * in the cases this section exists for. Leaving both under the word "expected"
 * would let a customer's recollection be read as the verified specification,
 * which is the one confusion that can turn a claim into a refund decision.
 *
 * So the authoritative column says "Verified" and names no expectation, and
 * both customer columns are prefixed "Customer" so their provenance is legible
 * without reading the surrounding prose.
 */
export const COLUMN_ATTRIBUTE = "Attribute";
export const COLUMN_LISTING = "Listing / Verified";
export const COLUMN_EXPECTED = "Customer Expected / Ordered";
export const COLUMN_REPORTED = "Customer Reported / Received";

/** Shown in place of a listing value the resolved order never carried. */
export const LISTING_VALUE_ABSENT = "Not recorded";

export const ATTRIBUTE_DIMENSIONS = "Dimensions";
export const ATTRIBUTE_COLOUR = "Colour";
export const ATTRIBUTE_WATTAGE = "Wattage";

/**
 * One attribute the customer raised.
 *
 * `listingValue` is null when the listing text carried nothing for this
 * attribute — which is common and is NOT a defect to paper over. A row with a
 * reported value and no listing value still tells a reviewer something true:
 * the customer says the item is 13 cm, and we have nothing on record to compare
 * that against. Inventing an expected value to fill the column would replace a
 * known gap with a fabricated fact.
 */
export type ReportedAttribute = {
  readonly attribute: string;
  readonly listingValue: string | null;
  /**
   * What the CUSTOMER says they ordered. A claim, not a specification.
   *
   * SEPARATE FROM `listingValue` AND NEVER SUBSTITUTED FOR IT. The two answer
   * different questions — "what does the record say was sold" versus "what does
   * this person remember choosing" — and they are allowed to disagree. Merging
   * them, in either direction, would either invent a verified fact from a
   * recollection or silently overwrite a recollection with the catalogue.
   *
   * Null when the customer stated only what arrived, which is the common case.
   */
  readonly expectedValue: string | null;
  readonly reportedValue: string;
  /**
   * The customer's own sentence, kept so the value can be checked against the
   * words it came from.
   *
   * Null in exactly one case: where the claim was negated and `reportedValue`
   * IS already the whole clause (see `NEGATION_CUE`). Repeating it would print
   * the same sentence twice.
   */
  readonly customerWording: string | null;
};

/**
 * The message fields this reads. A structural subset of
 * `ConversationMessageView`, so the workspace passes its messages unchanged.
 */
export type ReportingMessage = {
  readonly direction: "inbound" | "outbound";
  readonly bodyText: string | null;
  readonly bodyDecodeStatus: string;
  readonly attachments?: readonly Attachment[];
};

/**
 * Marketplaces whose customer attachments are ingested.
 *
 * Mirrors `ATTACHMENT_SOURCES` in `scripts/backfill-attachments.mjs`, which is
 * the list that actually populates `cst_app.conversation_messages.attachments`.
 * eBay and Amazon are absent because their source tables carry no attachment
 * column at all — for eBay the upstream importer stores only the plain message
 * text, and the media never reaches this database.
 */
export const ATTACHMENT_INGESTED_MARKETPLACES: ReadonlySet<string> = new Set([
  "shopify",
  "bandq",
  "temu",
]);

/**
 * Why no customer image is on screen. Two states, and they are not the same
 * statement.
 *
 *   none_sent      Attachments ARE ingested for this marketplace and this
 *                  conversation carries none. The customer sent no photograph,
 *                  which is a fact about the customer and usually the cue to
 *                  ask for one.
 *   not_captured   Attachments are NOT ingested for this marketplace. We know
 *                  nothing about whether the customer sent a photograph. On
 *                  eBay they demonstrably do — our own replies thank them for
 *                  photos on conversations whose stored body is empty — and the
 *                  images are absent from the database, not from the message.
 *
 * Collapsing these into "No customer-uploaded images" tells a reviewer the
 * customer sent nothing, on the one marketplace where that is least likely to
 * be true. It invites chasing a customer who already complied.
 */
export type ImageGap = "none_sent" | "not_captured";

/** Everything the panel renders, resolved together so the halves agree. */
export type CustomerReportedProductDetails = {
  readonly attributes: readonly ReportedAttribute[];
  readonly images: readonly Attachment[];
  /**
   * Why there is no image, or null when there are images or no inbound message
   * to have carried one. The panel says which rather than showing nothing,
   * because silence reads as "we did not look".
   */
  readonly imageGap: ImageGap | null;
};

/**
 * The sentence for a gap, naming the marketplace it is true of.
 *
 * `not_captured` deliberately says where the limit is — the message data, not
 * the customer — so nobody reads it as "the customer sent nothing" and nobody
 * treats it as a reason to ask again for a photo already supplied.
 */
export function imageGapMessage(gap: ImageGap, marketplaceLabel: string): string {
  return gap === "none_sent"
    ? "No customer-uploaded images on this conversation."
    : `Customer-uploaded images are unavailable from the current ${marketplaceLabel} message data — attachments are not captured on ingestion.`;
}

/**
 * A closed colour vocabulary, for the same reason as in `customer-product-data`:
 * an open "any word near `colour`" rule reports "the colour of the packaging"
 * and "true colour" as values.
 */
const COLOURS = [
  "black", "white", "grey", "gray", "silver", "gold", "brass", "bronze", "copper",
  "chrome", "beige", "cream", "ivory", "brown", "red", "blue", "green", "yellow",
  "orange", "pink", "purple", "clear", "amber", "walnut", "oak",
] as const;

/**
 * Grouped alternation, never a bare `a|b|c`.
 *
 * `|` binds loosest of every regex operator, so an ungrouped list interpolated
 * into a larger pattern silently reassociates and the surrounding syntax
 * attaches to the last alternative alone. Grouping at the single point of
 * construction makes that unrepeatable.
 */
const alternation = (words: readonly string[]): string => `(?:${words.join("|")})`;

/**
 * Length units. `in` is excluded deliberately: as a unit it is indistinguishable
 * from the preposition, so "in black" would be read as a measurement. `inch`,
 * `inches` and `"` carry the meaning unambiguously.
 *
 * LONGEST ALTERNATIVE FIRST, and bare `m` last. Regex alternation is ordered,
 * not greedy across branches: with `m` ahead of `metres`, "13 metres" matches
 * the `m` and reports the value as `13 m`. That is a silent truncation of the
 * customer's own words in a module whose entire promise is that it does not
 * alter them.
 */
const LENGTH_UNIT = String.raw`mm|cm|metres?|meters?|inch(?:es)?|in\.|feet|ft|m|"`;

/** "10cm", "13 cm", "30 x 40 cm", "12 inches". */
const DIMENSION_PATTERN = new RegExp(
  String.raw`\d+(?:[.,]\d+)?\s*(?:[x×]\s*\d+(?:[.,]\d+)?\s*)*(?:${LENGTH_UNIT})(?=\W|$)`,
  "gi",
);

/**
 * Millimetres per unit, for deciding whether two dimensions measure the same
 * KIND of thing. Never used to convert a value for display.
 */
const UNIT_MM: Readonly<Record<string, number>> = {
  mm: 1, cm: 10, m: 1000, metre: 1000, metres: 1000, meter: 1000, meters: 1000,
  inch: 25.4, inches: 25.4, "in.": 25.4, '"': 25.4, ft: 304.8, feet: 304.8,
};

/**
 * Every magnitude in one dimension token, in millimetres.
 *
 * The unit is read from the END of the token and applied to every number in it,
 * because that is how these values are written: "30 x 40 cm" states one unit
 * for two numbers.
 */
function magnitudesMm(token: string): number[] {
  const unit = /(mm|cm|metres?|meters?|inch(?:es)?|in\.|feet|ft|m|")\s*$/i.exec(token.trim());
  if (unit === null) return [];
  const factor = UNIT_MM[unit[1]!.toLowerCase()];
  if (factor === undefined) return [];
  return [...token.matchAll(/\d+(?:[.,]\d+)?/g)]
    .map((match) => Number(match[0].replace(",", ".")) * factor)
    .filter((value) => Number.isFinite(value) && value > 0);
}

/**
 * How far apart two measurements can be and still plausibly describe the same
 * dimension of the same product.
 *
 * A REFUSAL THRESHOLD, NOT A CORRECTNESS CLAIM. It exists for the case that
 * made it necessary: a listing title reading "…Lighting Cord 0.75mm" states a
 * CABLE GAUGE, and a customer reporting 130cm of length is not disagreeing with
 * it. Placed side by side under one "Dimensions" heading the two read as a
 * discrepancy, and 0.75mm reads as the verified expected length — a fact nobody
 * recorded and the listing never claimed.
 *
 * 0.75mm against 130cm is a factor of ~1,733. Genuine same-dimension
 * disagreements are small by nature: a 10cm shade against a measured 13cm is
 * 1.3. Twenty leaves the second kind untouched with room to spare while
 * refusing the first, and it fails toward "Not recorded" — the honest answer
 * when nothing comparable was recorded.
 */
const COMPARABLE_DIMENSION_RATIO = 20;

/**
 * Whether a listing dimension plausibly measures the same thing the customer
 * measured.
 *
 * NO CUSTOMER MEASUREMENT IS NOT A MISMATCH. When the customer stated no number
 * at all there is nothing to be incomparable with, so the listing value stands
 * exactly as it did before this check existed.
 */
function dimensionsAreComparable(listingToken: string, customerTokens: readonly string[]): boolean {
  const listing = magnitudesMm(listingToken);
  if (listing.length === 0) return false;

  const customer = customerTokens.flatMap(magnitudesMm);
  if (customer.length === 0) return true;

  return listing.some((a) =>
    customer.some((b) => Math.max(a, b) / Math.min(a, b) <= COMPARABLE_DIMENSION_RATIO),
  );
}

/**
 * "12W", "20 w", "12 watts".
 *
 * The trailing boundary is what keeps this off the rest of the language. Without
 * it `\d+\s*w` matches the "5 w" inside "5 weeks" and reports a wattage from a
 * sentence about delivery time.
 */
const WATTAGE_PATTERN = /\d+(?:[.,]\d+)?\s*(?:w|watts?)(?=\W|$)/gi;

/**
 * Words that qualify a colour without being one.
 *
 * "plain black" and "black" are different answers to "what did you order?", and
 * a customer who writes the first and is shown the second has had their own
 * words edited to agree with ours. These are captured as part of the value.
 *
 * `light` and `dark` sit here despite `light` also being the domain's main noun
 * ("pendant light"). That is safe because a modifier is only consumed when a
 * colour follows it immediately: "a light brass one" captures `light brass`,
 * while "the light is black" cannot, because `is` intervenes.
 */
const COLOUR_MODIFIERS = [
  "plain", "matt", "matte", "gloss", "glossy", "satin", "brushed", "polished",
  "frosted", "opaque", "textured", "antique", "vintage", "dark", "light", "pale",
  "bright", "deep", "solid", "pure",
] as const;

/**
 * A colour PHRASE, not a colour token.
 *
 * Token matching cannot express the case this exists for. "I ordered the plain
 * black one and received a black and chrome one" contains the tokens black,
 * black, chrome — which deduplicate to `black, chrome` on both sides of the
 * comparison and report the two halves as agreeing. The phrase form keeps
 * `plain black` and `black and chrome` intact and distinct.
 *
 * The joiner is OPTIONAL so adjacent colours are held together: "green brass"
 * is one finish, not two colours, and the listing variant that sold it is
 * written exactly that way. `or` is deliberately absent from the joiner list —
 * "black or white" offers two alternatives rather than naming one thing, so it
 * captures `black` alone.
 */
const COLOUR_PHRASE_PATTERN = new RegExp(
  String.raw`\b(?:${alternation(COLOUR_MODIFIERS)}\s+)*${alternation(COLOURS)}` +
    String.raw`(?:\s*(?:and|&|/|with)?\s+(?:${alternation(COLOUR_MODIFIERS)}\s+)*${alternation(COLOURS)})*\b`,
  "gi",
);

/**
 * Marks a clause as reporting what ARRIVED rather than requesting something.
 *
 * This is the gate that separates this section from the requested-details one.
 * "Do you have this in red?" is a request and belongs in the other module;
 * "the one I received is not red" is a report and belongs here. Without the
 * cue, every pre-sales colour question would surface as a discrepancy claim.
 *
 * `measures`/`measured` earn their place: "it measures 13cm" reports a received
 * dimension with no arrival verb anywhere in the sentence.
 */
const RECEIVED_CUE =
  /\b(?:received|receive|arrived|arrive|came|come|got|sent|delivered|turned up|showed up|turned out|measures?|measured|actually|instead|but it|it is|it's|its|mine\s+(?:is|are|was|were)|they are|they're|this is|the one i)\b/i;

/**
 * Marks a clause as stating what the customer BELIEVES THEY ORDERED.
 *
 * This is the other half of the discrepancy, and until now it was discarded —
 * "I ordered the plain black one and received a black and chrome one" reported
 * only a smear of every colour token in the sentence, because there was nowhere
 * to put the first half.
 *
 * `ordered` and `wanted` do NOT make this a pre-sales request. A row is still
 * emitted only where a RECEIVED value exists (see `reportedAttributesFrom`), so
 * "I want it in black" with nothing having arrived produces nothing here and
 * stays the other module's business.
 */
const EXPECTED_CUE =
  /\b(?:ordered|order was for|asked for|requested|wanted|expected|expecting|should be|should have been|supposed to be|meant to be|paid for|bought|purchased|i chose|i selected|advertised\s+(?:as|at)|listed\s+(?:as|at))\b/i;

/**
 * Marks a clause whose bare value would MISREPRESENT the claim.
 *
 * "the colour does not look like real red" contains the token `red`, and
 * reporting `red` as the customer's received colour states the exact opposite
 * of what they said. Where one of these appears, the whole clause is carried
 * verbatim instead of the token, which is the only form that stays true.
 *
 * This is the single most important rule in the file. A negated value reduced
 * to its token is not a rounding error; it is a fabricated agreement between
 * the listing and the customer.
 */
const NEGATION_CUE =
  /\b(?:not|n't|nothing like|no way|hardly|barely|doesn't|does not|isn't|is not|wasn't|was not|more like|looks? like|seems?|appears?|rather than|instead of|supposed to)\b/i;

/**
 * Words that are never a colour, however they are framed.
 *
 * The descriptive patterns below capture an arbitrary word, so they need a
 * floor. Without it "the wrong colour" yields `wrong` and "the colour is not
 * what I expected" yields `not` — both grammatically in the slot a colour
 * occupies, neither a colour.
 */
const NOT_A_COLOUR_NAME =
  /^(?:wrong|right|correct|same|different|other|another|similar|exact|only|real|true|actual|whole|nice|good|bad|new|old|not|nothing|what|which|this|that|these|those|item|items|product|one|ones|thing|things|shade|shades|colour|color|version|option)$/i;

/**
 * A colour the customer NAMED but the fixed vocabulary does not know.
 *
 * WHY THE CLOSED LIST IS NOT ENOUGH. It was built for the colours a customer
 * asks for, and it holds. What it cannot do is read a customer describing what
 * turned up in their own words: "I ordered the burgundy colour but it was not
 * burgundy to me it was more a dark mauve" contains neither `burgundy` nor
 * `mauve`, so the whole complaint produced no row at all — the exact case where
 * the section is most worth having.
 *
 * FRAMED, NOT FREE. A bare unknown word is not treated as a colour. Each
 * pattern requires an explicit colour construction around it, so the word is
 * one the CUSTOMER put in a colour slot:
 *
 *   "the burgundy colour"        a name immediately qualifying the noun
 *   "colour is burgundy"         a name predicated of it
 *   "more a dark mauve"          the comparative that names what it looked like
 *
 * USED ONLY AS A FALLBACK, per segment, when the fixed vocabulary matched
 * nothing there. A message naming a known colour is read exactly as before.
 */
const DESCRIBED_COLOUR_PATTERNS: readonly RegExp[] = [
  // "the burgundy colour", "a dark mauve colour"
  /\b(?:the|a|an)?\s*((?:[a-z]+\s+)?[a-z]{3,})\s+colou?r\b/gi,
  // "colour is burgundy", "colour was a dark mauve", "colour looks burgundy"
  /\bcolou?r\s+(?:is|was|were|looks?|looked|seems?|seemed|appears?)\s+(?:more\s+)?(?:of\s+)?(?:a|an|the)?\s*((?:[a-z]+\s+)?[a-z]{3,})\b/gi,
  // "more a dark mauve", "more of a burgundy"
  /\bmore\s+(?:of\s+)?(?:a|an)\s+((?:[a-z]+\s+)?[a-z]{3,})\b/gi,
];

/** Colours named in an explicit colour construction, in order, deduplicated. */
function describedColoursIn(segment: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const pattern of DESCRIBED_COLOUR_PATTERNS) {
    for (const match of segment.matchAll(pattern)) {
      // A leading article is stripped rather than excluded by the pattern.
      // Whether the article lands inside the capture depends on how the engine
      // backtracks, and "the burgundy" is the customer's colour named with a
      // determiner, not a two-word colour.
      const raw = match[1]
        ?.replace(/\s+/g, " ")
        .replace(/^(?:the|a|an)\s+/i, "")
        .trim();
      if (raw === undefined || raw === "") continue;
      // Every word of the phrase has to be plausible, so "not burgundy" and
      // "wrong colour" cannot arrive through a two-word capture.
      if (raw.split(" ").some((word) => NOT_A_COLOUR_NAME.test(word))) continue;
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(raw);
    }
  }
  return out;
}

/**
 * How close a negation has to be, before a value, to be denying that value.
 *
 * "does not look like real red" is 18 characters from `not` to `red`; "not
 * burgundy to me it was more a dark mauve" is 32 from that same `not` to `dark
 * mauve`, and the second is a value the customer is ASSERTING, not denying.
 * The window is what tells those apart without needing to parse the sentence.
 */
const NEGATION_WINDOW = 25;

/**
 * The values a negation is not denying.
 *
 * WHY THIS EXISTS. The whole-clause fallback for a negated claim is right when
 * the only value present is the denied one — reducing "does not look like real
 * red" to `red` asserts the opposite of what was said. It is wrong when the
 * customer denies one value and then states another: "it was not burgundy … it
 * was more a dark mauve" ends in a positive report, and answering it with the
 * whole sentence buries the one thing a reviewer needs.
 *
 * So a value is dropped only when a negation sits immediately before it. If
 * every value is dropped, the caller still falls back to the clause — the
 * original behaviour, untouched.
 */
function valuesNotNegated(segment: string, values: readonly string[]): string[] {
  return values.filter((value) => {
    const at = segment.toLowerCase().indexOf(value.toLowerCase());
    if (at === -1) return true;
    const before = segment.slice(Math.max(0, at - NEGATION_WINDOW), at);
    return !NEGATION_CUE.test(before);
  });
}

/**
 * Values the customer is actually predicating of what arrived.
 *
 * Applied to the RECEIVED side only. The expected side is allowed to carry a
 * desire — that is what makes it the expected side.
 */
function assertedOfWhatArrived(segment: string, values: readonly string[]): string[] {
  return values.filter((value) => {
    const at = segment.toLowerCase().indexOf(value.toLowerCase());
    if (at === -1) return true;

    // A part the value describes, rather than the product that arrived.
    const after = segment.slice(at + value.length);
    if (PART_NOUN_AFTER.test(after)) return false;

    // A width the customer hoped for, sitting beside the one they measured.
    const before = segment.slice(Math.max(0, at - DESIRE_WINDOW), at);
    if (DESIRE_CUE.test(before)) return false;

    return true;
  });
}

/**
 * How far before a value a desire cue still governs it.
 *
 * Wider than the negation window because the constructions are longer — "was
 * hoping it was 6mm wide" puts twelve characters between the two, "I was
 * expecting a deeper red/copper colour" rather more.
 */
const DESIRE_WINDOW = 40;

/**
 * A PART, not the product.
 *
 * The audit's commonest false report by far. "this black RING has holes to
 * accommodate brass SCREWS", "only one white plastic BIT", "the screws sent for
 * the clear PARTS", "the brass screw CONNECTOR that has broken" — in every one
 * the colour describes a component the customer is pointing at, and in every
 * one it was reported as the colour of the product that arrived.
 *
 * A colour immediately followed by one of these is describing that thing. The
 * product itself is named as "one", "it", "them" or the listing's own noun, so
 * "received a black and chrome ONE" and "sent me one GREEN" are untouched.
 */
const PART_NOUN_AFTER = new RegExp(
  String.raw`^\s*(?:${[
    "screw", "screws", "bracket", "brackets", "fixing", "fixings", "fitting", "fittings",
    "connector", "connectors", "ring", "rings", "washer", "washers", "nut", "nuts",
    "bolt", "bolts", "clip", "clips", "part", "parts", "piece", "pieces", "bit", "bits",
    "component", "components", "plastic", "rubber", "metal", "grommet", "gland",
    "thread", "threads", "cap", "caps", "cover", "covers", "plate", "plates",
  ].join("|")})\b`,
  "i",
);

/**
 * A QUESTION, not a report.
 *
 * "are they 100w per wire, do I need to double them up to get 200w" names two
 * wattages and reports neither — the customer is asking what they have, which
 * is the opposite of telling us.
 *
 * MATCHED ON CONSTRUCTION, NOT ON "?". A question mark is unreliable in both
 * directions here: this message has none, and "I ordered the plain black one
 * and I have received a black and chrome one?" is a statement that ends with
 * one. `why have you sent me…` is deliberately absent — it is an accusation
 * with a report inside it, not an enquiry.
 */
const INTERROGATIVE =
  /\b(?:are\s+(?:they|these|those)|is\s+(?:it|this|that)|do\s+i\s+need|do\s+you\s+(?:have|do|sell|stock)|does\s+it\s+(?:come|have|take|fit)|can\s+i\s+(?:use|fit|get|have)|could\s+you\s+(?:check|confirm|tell|advise)|would\s+(?:it|this|they)\s+(?:work|fit)|will\s+(?:it|this|they)\s+(?:work|fit)|how\s+(?:many|much|do\s+i)|what\s+(?:size|wattage|colou?r|fitting)\s+(?:is|are|does))\b/i;

/**
 * ASKING US TO SEND SOMETHING, not describing what came.
 *
 * "Can you please send me the light gold if its 5mm" names the colour the
 * customer WANTS NEXT. Reported as received it says the wrong item arrived in a
 * colour nobody has seen.
 */
const REQUEST_FOR_GOODS =
  /\b(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:send|post|ship|supply|provide|replace)|please\s+(?:send|post|ship|supply|replace)|i(?:'d|\s+would)\s+like\s+(?:you\s+to\s+send|a\s+replacement)|i\s+will\s+re-?order|i\s+need\s+this\s+colou?r)\b/i;

/**
 * WANTED, not received. Sits before the value it governs.
 *
 * "was hoping it was 6mm wide" states the width the customer wanted, in the
 * same breath as the width they got. Without this the two are reported as one
 * received measurement each.
 */
const DESIRE_CUE =
  /\b(?:hoping|hope|wanting|want|wanted|would\s+like|prefer|preferred|looking\s+for|need|needs?\s+to\s+be|expecting|expected)\b/i;

/**
 * The customer has said the attribute is WRONG without saying what arrived.
 *
 * "Lamp arrived not quite the right colour, i was expecting a deeper
 * red/copper colour" — the only colour named is the one they wanted. Reporting
 * it as received states that we sent what they asked for.
 */
const ATTRIBUTE_DENIED =
  /\bnot\s+(?:quite\s+)?(?:the\s+)?(?:right|correct|same)\s+(?:colou?r|size|shade|finish)\b/i;

/** Long enough for a real sentence, short enough to stay a summary. */
const MAX_CLAUSE_LENGTH = 120;

function shorten(clause: string): string {
  return clause.length <= MAX_CLAUSE_LENGTH
    ? clause
    : `${clause.slice(0, MAX_CLAUSE_LENGTH - 1).trimEnd()}…`;
}

/** Only what the customer sent, and only where the body could be read. */
function inboundTexts(messages: readonly ReportingMessage[]): string[] {
  return messages
    .filter(
      (message) =>
        message.direction === "inbound" &&
        message.bodyDecodeStatus === "decoded" &&
        message.bodyText !== null &&
        message.bodyText.trim() !== "",
    )
    .map((message) => message.bodyText as string);
}

/**
 * Sentence fragments, so each thought is judged on its own.
 *
 * SPLITS ON SENTENCE ENDERS ONLY. An earlier version also split on `but`,
 * `however` and `whereas`, which was right while the ordered half of a
 * complaint was being discarded — it kept "I ordered the 10cm one" from being
 * read as something that arrived. Now that both halves are wanted, that same
 * split severs them into separate clauses before they can be paired, and the
 * expected value is lost exactly where the customer stated it most clearly.
 *
 * Separating the two roles is now `segmentsOf`'s job, and it is the only thing
 * that does it. Contrastive conjunctions are where it cuts, so they still carry
 * their meaning — they are read inside the sentence rather than destroying it.
 */
function clausesOf(text: string): string[] {
  return text
    // A FULL STOP BETWEEN TWO DIGITS IS A DECIMAL POINT, not a sentence end.
    // Splitting on it cut "8.85mm" into "…mine is 8" and "85mm has there been
    // …", so the customer's measured width was reported as 85mm — a value they
    // never wrote, in a clause that had lost the words explaining it.
    .split(/(?<!\d)[.](?!\d)|[!?\n\r;]+/)
    .map((clause) => clause.replace(/\s+/g, " ").trim())
    .filter((clause) => clause !== "");
}

/**
 * Where a sentence turns from one claim to the opposing one.
 *
 * `not` is deliberately absent. It is a negation, not a boundary, and cutting
 * on it would move "not what I ordered" out of the received segment — which is
 * what makes `NEGATION_CUE` fire and keeps a denied value from being reported
 * as an agreed one.
 */
const ROLE_BOUNDARY = /\b(?:but|however|whereas|instead|yet|though|although|and)\b/gi;

/** Distinct matches, in the order they appear, with the customer's own casing. */
function matchesOf(text: string, pattern: RegExp): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = match[0].replace(/\s+/g, " ").trim();
    const key = value.toLowerCase();
    if (value === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

const ATTRIBUTE_PATTERNS: readonly { readonly attribute: string; readonly pattern: RegExp }[] = [
  { attribute: ATTRIBUTE_DIMENSIONS, pattern: DIMENSION_PATTERN },
  { attribute: ATTRIBUTE_COLOUR, pattern: COLOUR_PHRASE_PATTERN },
  // Wattage last: "12W" contains no length unit and no colour, so ordering
  // costs nothing here, but keeping the list explicit means a future attribute
  // is added in one place rather than threaded through three functions.
  { attribute: ATTRIBUTE_WATTAGE, pattern: WATTAGE_PATTERN },
];

/**
 * The authoritative expected values, from the resolved order's listing text.
 *
 * AUTHORITATIVE DATA IN, AUTHORITATIVE DATA OUT. The only input is listing
 * text; no message is in scope of this function, so no customer claim can reach
 * its output even by mistake.
 *
 * Several distinct values for one attribute are all kept and joined, rather
 * than one being picked. A title reading "30 x 40 cm shade, 15 cm fitting"
 * genuinely carries two dimensions and choosing between them would be a guess
 * presented as the specification.
 */
export function listingAttributesFrom(listingText: string | null): Map<string, string> {
  const found = new Map<string, string>();
  if (listingText === null || listingText.trim() === "") return found;

  for (const { attribute, pattern } of ATTRIBUTE_PATTERNS) {
    const values = matchesOf(listingText, pattern);
    if (values.length > 0) found.set(attribute, values.join(", "));
  }
  return found;
}

/**
 * What the customer says they received, per attribute, in their own words.
 *
 * INBOUND ONLY. A previous CST reply quoting "the 10cm version" is the business
 * talking to itself, and recording it here would report our own words back as
 * the customer's complaint.
 *
 * First report per attribute wins. A customer who restates the same claim three
 * times has made one claim, and a section that grew a row per restatement would
 * read as three separate problems.
 */
export type AttributeReport = {
  readonly expected: string | null;
  readonly value: string;
  readonly wording: string | null;
  /**
   * The raw tokens behind both sides, kept so the pairing step can judge
   * whether a listing value measures the same thing. `value` is not usable for
   * that — under a negation it is a whole sentence.
   */
  readonly rawValues: readonly string[];
};

/**
 * Values for one attribute in one segment.
 *
 * The fixed vocabulary first, and the descriptive colour patterns only where it
 * found nothing — so a message naming a known colour is read exactly as it was
 * before those patterns existed.
 */
function valuesIn(segment: string, attribute: string, pattern: RegExp): string[] {
  const direct = matchesOf(segment, pattern);
  if (direct.length > 0 || attribute !== ATTRIBUTE_COLOUR) return direct;
  return describedColoursIn(segment);
}

/**
 * Splits one clause into the part about what was ORDERED and the part about
 * what ARRIVED.
 *
 * WHY POSITION, AND WHY ONLY SOMETIMES. Most clauses carry one role, and the
 * value can sit either side of the cue — "a light brass one has been sent" puts
 * it before, "received a black and chrome one" puts it after. Splitting those
 * on cue position would drop half of them, so a single-role clause is used
 * whole.
 *
 * Only when BOTH roles appear in one clause is a boundary needed, and then the
 * cut is made at the CONJUNCTION between the two cues rather than at a cue
 * itself. Cutting at the cue looks simpler and is wrong: a received cue can
 * trail the value it describes, as in "a light brass one has been sent", so
 * slicing at `sent` would leave the received segment holding no colour at all
 * and hand `light brass` to the ordered side. The conjunction sits between the
 * two claims wherever their cues happen to fall.
 *
 * The LAST conjunction in range wins, so the received segment begins as close
 * to its own claim as possible; falling back to the later cue when the sentence
 * offers no conjunction at all.
 */
function segmentsOf(clause: string): { expected: string | null; received: string | null } {
  const expectedAt = clause.search(EXPECTED_CUE);
  const receivedAt = clause.search(RECEIVED_CUE);

  if (expectedAt === -1 && receivedAt === -1) return { expected: null, received: null };
  if (receivedAt === -1) return { expected: clause, received: null };
  if (expectedAt === -1) return { expected: null, received: clause };

  const low = Math.min(expectedAt, receivedAt);
  const high = Math.max(expectedAt, receivedAt);

  let cut = high;
  for (const match of clause.matchAll(ROLE_BOUNDARY)) {
    if (match.index > low && match.index < high) cut = match.index;
  }

  const before = clause.slice(0, cut);
  const after = clause.slice(cut);

  return expectedAt < receivedAt
    ? { expected: before, received: after }
    : { expected: after, received: before };
}

/**
 * What the customer says they received — and, where they said it, what they
 * believe they ordered.
 *
 * INBOUND ONLY. A previous CST reply quoting "the 10cm version" is the business
 * talking to itself, and recording it here would report our own words back as
 * the customer's complaint.
 *
 * A RECEIVED VALUE IS REQUIRED; AN EXPECTED ONE IS NOT. This is what keeps a
 * pre-sales enquiry out of a discrepancy section: "I want it in black", with
 * nothing having arrived, yields an expected value and no received one, so no
 * row is produced at all.
 *
 * First report per attribute wins. A customer who restates the same claim three
 * times has made one claim, and a row per restatement would read as three
 * separate problems.
 */
export function reportedAttributesFrom(
  messages: readonly ReportingMessage[],
): Map<string, AttributeReport> {
  const found = new Map<string, AttributeReport>();

  for (const text of inboundTexts(messages)) {
    for (const clause of clausesOf(text)) {
      const { expected, received } = segmentsOf(clause);
      // The gate. Without a received-cue this is a request or an aside, and
      // belongs to `customer-product-data.ts`, not here.
      if (received === null) continue;

      // A question names attributes and reports none; a request for goods names
      // the one the customer wants next. Neither states what arrived, so the
      // whole clause is out rather than filtered value by value.
      if (INTERROGATIVE.test(clause) || REQUEST_FOR_GOODS.test(clause)) continue;

      for (const { attribute, pattern } of ATTRIBUTE_PATTERNS) {
        if (found.has(attribute)) continue;
        const receivedValues = valuesIn(received, attribute, pattern);
        if (receivedValues.length === 0) continue;

        // Extracted from its own segment, so a colour named on the ordered side
        // can never be reported as one that arrived.
        const expectedValues = expected === null ? [] : valuesIn(expected, attribute, pattern);

        // The customer has said the attribute is wrong without saying what
        // arrived, so every value in reach names what they WANTED.
        if (attribute === ATTRIBUTE_COLOUR && ATTRIBUTE_DENIED.test(received)) continue;

        // What the customer is actually asserting, once anything a negation
        // sits in front of, anything describing a part, and anything a desire
        // governs has been dropped.
        const standing = valuesNotNegated(received, receivedValues);
        const asserted = assertedOfWhatArrived(received, standing);

        /*
         * TWO WAYS TO END UP WITH NOTHING, AND THEY MEAN DIFFERENT THINGS.
         *
         * Every value DENIED ("does not look like real red") is still a report
         * about what arrived — the customer is telling us it is wrong — so the
         * clause is carried whole, which is the long-standing behaviour.
         *
         * Every value belonging to a PART or governed by a DESIRE is not a
         * report about what arrived at all. There is no claim here to render,
         * and falling back to the clause would put a sentence about screws
         * under "Customer Reported / Received". So the attribute is skipped and
         * the row never exists.
         */
        if (asserted.length === 0 && standing.length > 0) continue;

        found.set(attribute, {
          expected: expectedValues.length > 0 ? expectedValues.join(", ") : null,
          rawValues: [...expectedValues, ...(asserted.length > 0 ? asserted : receivedValues)],
          ...(asserted.length > 0
            ? { value: asserted.join(", "), wording: shorten(clause) }
            : // Every value was denied, so there is no positive claim to report.
              // The clause, not the token: reducing "does not look like real
              // red" to `red` would assert the opposite of what was said.
              { value: shorten(clause), wording: null }),
        });
      }
    }
  }

  return found;
}

/**
 * Images the CUSTOMER uploaded. Nothing else, ever.
 *
 * THREE FILTERS, AND ALL THREE ARE LOAD-BEARING:
 *
 *   direction  Inbound only. An outbound attachment is a photo CST sent to the
 *              customer, and showing it as customer evidence would present our
 *              own picture back to us as proof of their complaint.
 *   kind       Images only. The live attachment data holds PDF invoices, which
 *              `attachmentsFrom` has already classified; an <img> pointed at one
 *              renders a broken icon under a heading claiming it is evidence.
 *   provenance The ONLY input is the conversation's own messages. Listing
 *              photos and return-evidence photos live behind
 *              `ebay-image-repository`, are fetched by a different call, and
 *              have no path into this function — there is no parameter they
 *              could arrive through. That is deliberate: the guarantee is
 *              structural, not a filter someone could later loosen.
 *
 * A listing photo is the seller's own marketing shot and a return photo may
 * belong to an entirely different buyer (the return log has no buyer column).
 * Either one displayed under "customer uploaded" is a fabricated piece of
 * evidence in a case that may end in a refund.
 */
export function customerEvidenceImages(
  messages: readonly ReportingMessage[],
): Attachment[] {
  const seen = new Set<string>();
  const out: Attachment[] = [];

  for (const message of messages) {
    if (message.direction !== "inbound") continue;
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind !== "image") continue;
      if (seen.has(attachment.url)) continue;
      seen.add(attachment.url);
      out.push(attachment);
    }
  }

  return out;
}

/**
 * The listing value for one attribute, or null where it would be a false pair.
 *
 * Only DIMENSIONS is filtered. A wattage is a wattage and a colour is a colour;
 * a length, a width, a drop, a diameter and a cable gauge are all "dimensions"
 * written identically, and only their magnitudes tell them apart.
 *
 * A listing carrying several dimensions keeps the ones that are comparable and
 * drops the rest, so "30 x 40 cm with 15 cm fitting" still answers a customer
 * measuring in centimetres without a stray gauge riding along.
 */
function comparableListingValue(
  attribute: string,
  listingValue: string | undefined,
  customerTokens: readonly string[],
): string | null {
  if (listingValue === undefined) return null;
  if (attribute !== ATTRIBUTE_DIMENSIONS) return listingValue;

  const kept = listingValue
    .split(", ")
    .filter((token) => dimensionsAreComparable(token, customerTokens));

  // Nothing comparable was recorded, and that is what the column says.
  return kept.length > 0 ? kept.join(", ") : null;
}

/**
 * The whole section, or an empty one.
 *
 * Rows are produced from the customer's reports and then, and only then, joined
 * to the listing values. That order is the safeguard: an attribute the customer
 * never raised has no row to attach a listing value to, so the catalogue cannot
 * put words in their mouth.
 */
export function customerReportedProductDetails(input: {
  readonly listingText: string | null;
  readonly messages: readonly ReportingMessage[];
  /**
   * Which marketplace this conversation is on, so an absent image can be
   * explained rather than merely reported.
   *
   * Optional, and absent means the conservative reading: `none_sent`, the same
   * statement this returned before the distinction existed. Callers that know
   * the marketplace should always pass it — on eBay the other answer is the
   * true one.
   */
  readonly marketplace?: string;
}): CustomerReportedProductDetails {
  const listing = listingAttributesFrom(input.listingText);
  const reported = reportedAttributesFrom(input.messages);

  const attributes: ReportedAttribute[] = [];
  // Iterated in the fixed vocabulary order rather than the order the customer
  // happened to mention things, so two conversations render comparably.
  for (const { attribute } of ATTRIBUTE_PATTERNS) {
    const report = reported.get(attribute);
    if (report === undefined) continue;
    attributes.push({
      attribute,
      // Authoritative, and populated ONLY from listing text. There is no branch
      // here that could fall back to `report.expected` when the listing carried
      // nothing — a customer's recollection must never occupy the verified
      // column, however plausible it looks and however empty that column is.
      //
      // A dimension additionally has to measure the SAME THING the customer
      // measured. A listing states several dimensions of different kinds and
      // labels none of them, so "is there a number here" is not enough to make
      // one the expected value for this complaint.
      listingValue: comparableListingValue(attribute, listing.get(attribute), report.rawValues),
      expectedValue: report.expected,
      reportedValue: report.value,
      customerWording: report.wording,
    });
  }

  const images = customerEvidenceImages(input.messages);
  const hasInbound = input.messages.some((message) => message.direction === "inbound");

  // No inbound message means nothing could have carried an image, and saying
  // anything about photographs would be a claim about a message that does not
  // exist.
  const ingested =
    input.marketplace === undefined || ATTACHMENT_INGESTED_MARKETPLACES.has(input.marketplace);

  return {
    attributes,
    images,
    imageGap:
      hasInbound && images.length === 0 ? (ingested ? "none_sent" : "not_captured") : null,
  };
}

/**
 * True when there is nothing for the panel to render at all.
 *
 * A gap is content. "Attachments are not captured on this marketplace" is worth
 * showing beside a discrepancy the customer has described, because it tells a
 * reviewer why there is no photograph to look at — but not on its own, where it
 * would put a caveat on a conversation nobody has a question about.
 */
export function isEmptyReportedDetails(details: CustomerReportedProductDetails): boolean {
  return details.attributes.length === 0 && details.images.length === 0;
}
