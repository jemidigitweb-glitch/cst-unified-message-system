/**
 * Product details the CUSTOMER stated, in the customer's own words.
 *
 * WHAT THIS IS FOR. A reviewer answering "do you have this in white?" or "I
 * need a 25cm shade" needs those details in front of them, and so does the
 * draft — but they are a different KIND of thing from the order facts sitting
 * above them. An order fact was verified against the source database. This was
 * asserted by a member of the public. Keeping them in separate sections, with
 * separate wording, is what stops the second being read as the first.
 *
 * VERBATIM, NEVER PARAPHRASED. Every value is a slice of the message the
 * customer sent. Nothing here summarises, normalises, corrects a spelling,
 * converts a unit, or infers an attribute — "in white" yields `white`, exactly
 * as typed. That property is what makes the output checkable: a reviewer can
 * find every value by reading the thread.
 *
 * INBOUND ONLY. A previous CST reply quoting "the black one" is the business
 * talking to itself; extracting it would report our own words back as the
 * customer's requirement. Outbound messages and undecodable bodies contribute
 * nothing.
 *
 * NO MODEL, NO CATALOGUE, NO SKU. Deterministic patterns over the message
 * text and nothing else. It never consults the order, the listing, or a
 * product record — an attribute that only the catalogue knows is not something
 * the customer said, and presenting it under this heading would be a lie about
 * its provenance.
 *
 * SILENCE IS THE DEFAULT. Where the patterns match nothing the result is
 * empty and the section disappears. An extractor that always finds something
 * is an extractor that invents things.
 *
 * PURE. No network, no database, no storage. Recomputed from messages already
 * loaded, so nothing is persisted and there is nothing to migrate.
 */

export const CUSTOMER_PRODUCT_DATA_HEADING = "Customer product data";

/** One detail the customer stated, under the label it was recognised as. */
export type CustomerProductDetail = {
  readonly label: string;
  readonly value: string;
};

/** The message fields this reads. A structural subset of `ConversationMessageView`. */
export type CustomerMessage = {
  readonly direction: "inbound" | "outbound";
  readonly bodyText: string | null;
  readonly bodyDecodeStatus: string;
};

export const LABEL_COLOUR = "Requested colour";
export const LABEL_MEASUREMENT = "Requested measurement";
export const LABEL_FINISH = "Requested finish";
export const LABEL_REQUIREMENT = "Requirement";
export const LABEL_COMPATIBILITY = "Compatibility";
/**
 * Something the customer POINTED AT rather than asked for.
 *
 * Shown, not discarded. Suppressing it entirely was the first fix and it was
 * half right: "Found one in Chrome in the seller's other items" is genuinely
 * not a requested colour, but dropping it left a reviewer looking at
 * "Requested colour: white" from an earlier message with no sign that the
 * customer had since raised chrome — a stale preference presented as the
 * current one, which is its own kind of wrong.
 *
 * A third label keeps both true at once: white is what they asked for, chrome
 * is what they raised, and neither is dressed up as the other.
 */
export const LABEL_ALTERNATIVE = "Mentioned alternative";

/**
 * A closed vocabulary, deliberately.
 *
 * An open-ended "any word after `in`" rule would report "in stock", "in the
 * post" and "in touch" as colours. Listing the colours a customer plausibly
 * asks for is duller and correct.
 */
const COLOURS = [
  "black", "white", "grey", "gray", "silver", "gold", "brass", "bronze", "copper",
  "chrome", "beige", "cream", "ivory", "brown", "red", "blue", "green", "yellow",
  "orange", "pink", "purple", "clear", "amber", "walnut", "oak",
] as const;

/**
 * Finishes, kept separate from colours because a customer distinguishes them —
 * "matt black" is a finish AND a colour, and both are worth showing.
 */
const FINISHES = [
  "matt", "matte", "gloss", "glossy", "satin", "brushed", "polished", "frosted",
  "opaque", "textured", "antique", "vintage",
] as const;

/**
 * Words that make a sentence about the product rather than about the order.
 *
 * A requirement clause has to contain one of these (or a colour, finish or
 * measurement) to be reported. Without that gate, "I need a refund" and "I
 * want to cancel" would surface as product data, which they are not.
 */
const DIMENSION_WORDS = [
  "size", "sizes", "width", "wide", "height", "high", "tall", "length", "long",
  "depth", "deep", "diameter", "dimensions", "measurement", "measurements",
] as const;

/**
 * Always returns a GROUPED alternation, never a bare `a|b|c`.
 *
 * `|` binds loosest of all regex operators, so an ungrouped list interpolated
 * into a larger pattern silently reassociates: `(?:${list}\s+)?` parses as
 * "matt, OR matte, OR ... OR vintage-followed-by-space", and the trailing
 * `\s+` attaches to the last alternative alone. That produced a pattern that
 * looked right, compiled fine, and quietly failed to read "in matt black" as a
 * colour. Grouping here makes the mistake unrepeatable at every call site.
 */
const alternation = (words: readonly string[]): string => `(?:${words.join("|")})`;

/**
 * Units the customer might write. `in` is EXCLUDED on purpose: as a unit it is
 * indistinguishable from the preposition, so "in black" would be read as a
 * measurement. `inch`, `inches`, `in.` and `"` carry the meaning unambiguously.
 */
const UNIT = String.raw`mm|cm|m|metres?|meters?|inch(?:es)?|in\.|ft|feet|"`;

const COLOUR_PATTERNS: readonly RegExp[] = [
  // "in white", "in a matt black"
  new RegExp(String.raw`\bin\s+(?:a\s+|an\s+|the\s+)?(?:${alternation(FINISHES)}\s+)?(${alternation(COLOURS)})\b`, "i"),
  // "colour is white", "colour: white", "color white"
  new RegExp(String.raw`\bcolou?r\s*(?:is|:|=)?\s*(${alternation(COLOURS)})\b`, "i"),
  // "the white one", "a black version"
  new RegExp(String.raw`\b(${alternation(COLOURS)})\s+(?:one|ones|version|option|variant|shade|finish)\b`, "i"),
];

const FINISH_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b(${alternation(FINISHES)})\s+finish\b`, "i"),
  new RegExp(String.raw`\bfinish\s*(?:is|:|=)?\s*(${alternation(FINISHES)})\b`, "i"),
  new RegExp(String.raw`\bin\s+(?:a\s+|an\s+|the\s+)?(${alternation(FINISHES)})\b`, "i"),
];

/** "40cm", "25 cm", "30 x 40 cm", "12 inches". */
const MEASUREMENT_PATTERN = new RegExp(
  String.raw`\b\d+(?:[.,]\d+)?\s*(?:[x×]\s*\d+(?:[.,]\d+)?\s*)*(?:${UNIT})(?=\b|$)`,
  "gi",
);

/** Cues that open a stated requirement. */
const REQUIREMENT_CUE = /\b(?:i need|i want|i'?m looking for|i am looking for|looking for|i require|needs? to be|needs? a|need a|please send)\b/i;

/** Cues that open a stated compatibility question. */
const COMPATIBILITY_CUE = /\b(?:compatible with|will (?:it|this|they) fit|can (?:it|this|they) (?:work|fit)|does (?:it|this) (?:fit|work with)|work with my|suitable for|fits? my|to fit my)\b/i;

/**
 * Marks a sub-clause as DESCRIBING something rather than ASKING for it.
 *
 * Two families, both drawn from the message that exposed the bug:
 *
 *   discovery   found / saw / noticed / came across — the customer reporting
 *               what they encountered, not what they want.
 *   elsewhere   "other items", "another listing", "your other" — an explicit
 *               pointer at a different product, which is catalogue information
 *               about something the customer has NOT ordered or requested.
 *
 * Deliberately a blocklist rather than an allowlist of request phrasings. A
 * required-cue design would have dropped plain statements of preference like
 * "the colour is grey, is that right?", which carry no question word and are
 * still the customer telling us what they want.
 */
const REFERENCE_CUE = /\b(?:found|find|saw|seen|noticed|spotted|came across|other items?|another listing|other listings?|your other|sellers?'? other|elsewhere)\b/i;

/**
 * How much of a captured clause is kept.
 *
 * Long enough for a real sentence, short enough that the sidebar stays a
 * summary rather than a second copy of the thread. A clause longer than this
 * is truncated with an ellipsis, so a reader can see it was cut.
 */
const MAX_CLAUSE_LENGTH = 120;

/** Only what the customer sent, and only where it could be read. */
function customerMessages(messages: readonly CustomerMessage[]): string[] {
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
 * Sub-clause fragments, so each thought is judged on its own.
 *
 * Split on commas and semicolons as well as sentence enders, because one
 * sentence routinely carries two different thoughts — "Found one in Chrome in
 * the seller's other items, can it work with my corded pull" is a reference
 * followed by a question, and treating it as one unit means either losing the
 * question or keeping a colour the customer never asked for.
 */
function clausesOf(text: string): string[] {
  return text
    .split(/[.!?\n\r,;]+/)
    .map((clause) => clause.replace(/\s+/g, " ").trim())
    .filter((clause) => clause !== "");
}

function shorten(clause: string): string {
  return clause.length <= MAX_CLAUSE_LENGTH
    ? clause
    : `${clause.slice(0, MAX_CLAUSE_LENGTH - 1).trimEnd()}…`;
}

/** True when a clause is about the product rather than about the order or the money. */
function mentionsProductAttribute(clause: string): boolean {
  const patterns = [
    new RegExp(String.raw`\b(?:${alternation(DIMENSION_WORDS)})\b`, "i"),
    new RegExp(String.raw`\b(?:${alternation(COLOURS)})\b`, "i"),
    new RegExp(String.raw`\b(?:${alternation(FINISHES)})\b`, "i"),
    new RegExp(String.raw`\d+(?:[.,]\d+)?\s*(?:${UNIT})\b`, "i"),
  ];
  return patterns.some((pattern) => pattern.test(clause));
}

/**
 * Every product detail the customer stated, in the order they said it.
 *
 * Deduplicated case-insensitively per label, so a customer repeating "black"
 * three times produces one row. Returns an empty list — and therefore no
 * section at all — whenever nothing matched.
 */
export function extractCustomerProductData(
  messages: readonly CustomerMessage[],
): CustomerProductDetail[] {
  const found: CustomerProductDetail[] = [];
  const seen = new Set<string>();

  const add = (label: string, value: string): void => {
    const trimmed = value.trim();
    if (trimmed === "") return;
    const key = `${label}::${trimmed.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ label, value: trimmed });
  };

  for (const text of customerMessages(messages)) {
    for (const clause of clausesOf(text)) {
      /**
       * A colour or size the customer POINTED AT is not one they asked for.
       *
       * "Found one in Chrome in the seller's other items" names a real colour
       * and requests nothing — the customer is describing a different listing
       * they came across. Recording it as a requested colour puts a preference
       * in front of a reviewer that the customer never expressed, and next to
       * a genuine "do you do this in white?" it is indistinguishable from one.
       *
       * Judged per sub-clause rather than per sentence, so one half of a
       * sentence can be a reference while the other half is a real question —
       * which is exactly the shape of the message that exposed this.
       */
      const referenced = REFERENCE_CUE.test(clause);

      for (const pattern of COLOUR_PATTERNS) {
        const match = pattern.exec(clause);
        if (match?.[1] !== undefined) add(referenced ? LABEL_ALTERNATIVE : LABEL_COLOUR, match[1]);
      }
      for (const pattern of FINISH_PATTERNS) {
        const match = pattern.exec(clause);
        if (match?.[1] !== undefined) add(referenced ? LABEL_ALTERNATIVE : LABEL_FINISH, match[1]);
      }
      // `matchAll` rather than `exec`: "30cm wide and 40cm tall" is two values.
      for (const match of clause.matchAll(MEASUREMENT_PATTERN)) {
        const value = match[0].replace(/\s+/g, " ");
        add(referenced ? LABEL_ALTERNATIVE : LABEL_MEASUREMENT, value);
      }

      /**
       * A compatibility question survives a reference, because referring to
       * something is usually how one is asked — "can it work with my corded
       * pull" is the customer's own question whatever precedes it. Captured
       * from the sub-clause holding the cue, so the answer-worthy part is what
       * a reviewer reads rather than the whole sentence around it.
       */
      if (COMPATIBILITY_CUE.test(clause)) {
        add(LABEL_COMPATIBILITY, shorten(clause));
        continue;
      }

      // Gated on a product attribute so "I need a refund" stays out, and on
      // the reference cue so "found one that's 30cm" is not read as a request.
      if (!referenced && REQUIREMENT_CUE.test(clause) && mentionsProductAttribute(clause)) {
        add(LABEL_REQUIREMENT, shorten(clause));
      }
    }
  }

  return found;
}

/**
 * Labels the SIDEBAR does not show, though the draft still receives them.
 *
 * A compatibility question is a whole sentence, and a reviewer reads it in the
 * thread a few inches away — repeating it in the sidebar made the section long
 * without telling them anything the conversation had not already. The draft is
 * in a different position: it never sees the thread as a reviewer does, so the
 * question stays in the prompt where it changes what gets written.
 *
 * Panel-only filtering, deliberately: dropping it from the extractor would
 * take it out of the prompt too.
 */
const PANEL_HIDDEN_LABELS: ReadonlySet<string> = new Set([LABEL_COMPATIBILITY]);

/** The rows the sidebar renders — everything extracted, minus what it hides. */
export function panelCustomerProductData(
  details: readonly CustomerProductDetail[],
): CustomerProductDetail[] {
  return details.filter((detail) => !PANEL_HIDDEN_LABELS.has(detail.label));
}

/**
 * The prompt block, or null when the customer stated nothing.
 *
 * Null rather than an empty block on purpose, and the opposite choice from the
 * ORDER block above it. "No order has been resolved" is worth saying because
 * the model would otherwise assume it knows one. "The customer mentioned no
 * dimensions" is true of most conversations and worth saying on none of them.
 *
 * The wording does the work that separating the sections does on screen: it
 * says whose claims these are, that they are not verified, that they cannot
 * override an order fact, and that an unclear one is a reason to ask rather
 * than to guess.
 */
export function customerProductDataBlock(
  details: readonly CustomerProductDetail[],
): string | null {
  if (details.length === 0) return null;
  const lines = details.map((detail) => `- ${detail.label}: ${detail.value}`).join("\n");
  return [
    "CUSTOMER PRODUCT DATA (stated by the customer, NOT verified):",
    lines,
    "(these are the customer's own words about what they want or have, and are NOT verified facts.",
    "They must never override the verified order context above.",
    "They must never become a promise about stock, specification, price or suitability.",
    "Never restate one as something you have confirmed.",
    "Where one is unclear or conflicts with the verified context, say so and ask — do not resolve it by guessing.)",
  ].join("\n");
}
