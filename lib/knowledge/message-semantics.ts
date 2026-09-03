/**
 * What the customer is actually SAYING, as opposed to which words they used.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT CLASS THIS EXISTS FOR
 * ------------------------------------------------------------------------
 * Every category in this system is raised by a pattern, and a pattern answers
 * only "does this string occur". That is not the same question as "is the
 * customer telling us this happened", and the gap between the two produced a
 * run of wrong categories that look unrelated until you line them up:
 *
 *   "However, it unfortunately has nothing to do with my actual question!
 *    I wanted to know whether this transformer has two isolated windings."
 *      -> Parts missing, because "nothing to" was in the absent-component
 *         pattern. The customer is CORRECTING us, and asserts no absence at all.
 *
 *   "one of the shades arrived smashed as per the photograph. Can you advise"
 *      -> Wrong description, because "photograph" is a listing word and
 *         "however" is a contrast word. The two are 53 characters apart in
 *         unrelated clauses and neither says the listing was wrong.
 *
 *   "Can you please let me know if this is suitable for bathroom as our
 *    electrician is refusing to fit this fitting."
 *      -> Delivery, because "electrician" is in the urgent-deadline vocabulary.
 *         Nobody is waiting for a parcel.
 *
 * In each case a fragment fired inside a clause whose MEANING was a question, a
 * denial or a correction. The category was decided by a substring rather than
 * by the message.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS MODULE DOES, AND WHAT IT DELIBERATELY DOES NOT
 * ------------------------------------------------------------------------
 * It answers one question about one concept: is the customer ASSERTING it,
 * ASKING about it, DENYING it, or not raising it at all. That answer is then
 * available to the classifier as a gate, so a problem category can require an
 * actual claim that the problem exists.
 *
 * IT IS NOT A PARSER, and it does not try to be. It segments the message into
 * clauses and reads the clause the concept landed in. That is enough to
 * separate "the screws are missing" from "does it come with screws?" and from
 * "nothing to do with my question", which is the whole of the problem in
 * practice, and it stays something a reviewer can check by eye.
 *
 * PURE. No files, no network, no database, no model call. Every function here
 * is a function of the string alone.
 */

/** What the message does with a concept. */
export type ClaimStatus =
  /** Stated as fact: "the screws are missing". */
  | "asserted"
  /** Raised as a question: "does it come with screws?". */
  | "asked"
  /** Denied, or explicitly ruled out: "nothing is broken", "I didn't ask about that". */
  | "negated"
  /** Not present in the message at all. */
  | "not_stated";

/* ------------------------------------------------------------------------- *
 * CLAUSES
 * ------------------------------------------------------------------------- */

/**
 * Where one clause ends and the next begins.
 *
 * SENTENCE PUNCTUATION AND CONTRAST WORDS, because customers use both to change
 * subject mid-message and the contrast words are the ones that matter most:
 * "the box was damaged BUT the item is fine" turns on exactly that word. Line
 * breaks count too — the rollert4 message puts each thought on its own line
 * with no full stop at all.
 *
 * Deliberately NOT a bare comma. "I received the lamp, the screws are missing"
 * is one thought in two comma-separated pieces, and splitting there would
 * strand the subject from its verb far more often than it would help.
 *
 * A COMMA FOLLOWED BY A CONJUNCTION IS DIFFERENT, and it earns its place: "A
 * part is missing, and can you send the invoice too?" puts a report and a
 * question in one sentence, and without the split the question mark at the end
 * makes the whole thing read as a question — which turned a genuine parts case
 * into an enquiry.
 *
 * ------------------------------------------------------------------------
 * A REASON IS ITS OWN CLAUSE, AND IT IS A STATEMENT EVEN WHEN THE REQUEST IS
 * A QUESTION.
 * ------------------------------------------------------------------------
 * The commonest shape in this inbox is a polite request with the reason for it
 * attached:
 *
 *   "Could you send me another screw on piece that holds shade to pendant
 *    AS one on pendant was broken"
 *   "Can you send another part BECAUSE the item arrived broken"
 *
 * With no boundary between the two halves, the whole sentence was one clause,
 * `INTERROGATIVE_FRAME` matched "Could you" at the front of it, and the
 * breakage — stated as flat fact in the subordinate clause — came back as
 * `asked` rather than `asserted`. A problem the customer has REPORTED then read
 * as a problem they were ENQUIRING about, and the message was filed as a
 * pre-sales question from somebody who already owns the product.
 *
 * `because` and `cos` are unambiguous and split on the word alone. `as` is NOT:
 * it is a preposition far more often than a subordinator, and splitting a bare
 * `as` would cut "not AS described" and "AS per the photograph" in half —
 * destroying the wrong-description claim, which is built out of exactly that
 * phrase. So `as` splits only where a subject follows it, which is what makes
 * it a clause: "as ONE on pendant was broken", "as IT is not working", "as THE
 * item arrived damaged".
 *
 * `since` is deliberately absent. It is temporal at least as often as causal —
 * "since receiving it" — and nothing measured needs it.
 */
const CLAUSE_BOUNDARY =
  /[.!?;]+|\n+|\s[-–—]+\s|,\s*(?:and|or|so|then|plus)\b|,\s*(?=(?:can|could|would|will|shall|may|please|do|does|is|are|any)\b)|\b(?:but|however|although|though|whereas|except\s+that|aber|jedoch|allerdings)\b|\b(?:because|cos|'cause|weil)\b|\bas\s+(?=(?:one|it|its|they|this|that|these|those|the|my|our|his|her|their|i|we|you|he|she|there)\b)/gi;

/** The message split into clauses, with their offsets in the original text. */
export type Clause = { readonly text: string; readonly start: number; readonly end: number };

export function clausesOf(text: string): Clause[] {
  const clauses: Clause[] = [];
  let cursor = 0;
  for (const boundary of text.matchAll(CLAUSE_BOUNDARY)) {
    clauses.push({ text: text.slice(cursor, boundary.index), start: cursor, end: boundary.index });
    cursor = boundary.index + boundary[0].length;
  }
  clauses.push({ text: text.slice(cursor), start: cursor, end: text.length });
  return clauses.filter((clause) => clause.text.trim() !== "");
}

/** The clause a given offset falls in, or the whole text if segmentation found none. */
export function clauseAt(text: string, index: number): Clause {
  const clause = clausesOf(text).find((candidate) => index >= candidate.start && index < candidate.end);
  return clause ?? { text, start: 0, end: text.length };
}

/* ------------------------------------------------------------------------- *
 * WHAT A CLAUSE IS DOING
 * ------------------------------------------------------------------------- */

/**
 * A clause that ASKS rather than tells.
 *
 * Two independent routes, because customers use both and neither covers the
 * other: an explicit question mark, or an interrogative frame. The frames are
 * the auxiliary-inversion and wh- shapes that open a question in English, plus
 * the embedded forms ("I wanted to know WHETHER it has", "let me know IF this
 * is") that carry a question without the punctuation.
 *
 * THIS IS THE ROLLERT4 DISTINCTION IN ONE PATTERN. "Does this transformer have
 * two isolated windings?" and "One winding is missing" name the same component
 * and the same count; only the frame separates a specification question from a
 * report of an absent part.
 */
/**
 * A WH-WORD IS ONLY A QUESTION WHERE IT OPENS ONE.
 *
 * "which", "what" and "how" are relative pronouns at least as often as they are
 * interrogatives, and a bare match on them read a diagnosis as an enquiry:
 *
 *   "yours is constant voltage WHICH is probably causing the led to pulse"
 *
 * That is a customer telling us what is wrong with a thing they own. Requiring
 * the wh-word to START the clause, or to sit inside an embedded-question frame
 * ("let me know WHAT", "confirm WHETHER"), keeps the questions and loses the
 * relatives. An explicit question mark still counts on its own.
 *
 * "WONDERING IF" IS DELIBERATELY NOT A FRAME. "I'm just wondering if something
 * is missing?" is a hedged REPORT — the customer believes a part is absent and
 * is being polite about it — and INT-MP07 lists the same shape ("I think
 * something is missing") as a missing-parts trigger. Reading the hedge as a
 * question threw the claim away.
 */
/**
 * AN AUXILIARY IS ONLY A QUESTION WHERE IT OPENS ONE — the same rule as the
 * wh-words above, and the one place it had never been applied.
 *
 * WHAT MAKES AN AUXILIARY INTERROGATIVE IS INVERSION: the verb moves in FRONT of
 * its subject. "IS THIS the correct size?" asks; "This IS THE wrong size" tells.
 * Matched anywhere in the clause, `is the` / `are the` / `was the` occur in
 * plain statements constantly, and every one of them came back as a question:
 *
 *   "They are the wrong colour"             claim: asked, event: none
 *   "This is the wrong item"                claim: asked, event: none
 *   "The ceiling roses are the wrong ones"  claim: asked, event: none
 *   "It was the wrong type sent again"      claim: asked, event: none
 *
 * Each is a customer REPORTING a wrong item, and because the claim came back
 * `asked` rather than `asserted`, `semanticsOf` recorded no event and the issue
 * axis was blind to the whole family. Measured over 1,335 live eBay threads, 51
 * of the 362 messages carrying a problem intent had `event: "none"`, and this
 * was the largest single cause.
 *
 * ANCHORED TO THE CLAUSE, NOT THE MESSAGE, which is what makes it safe: the
 * clause splitter already breaks before a mid-sentence question ("Thanks for
 * that, IS THIS suitable for outdoors"), so the inverted auxiliary still opens
 * its own clause wherever a customer actually asks something. An explicit
 * question mark still counts on its own, independently of any of this.
 */
const INTERROGATIVE_FRAME =
  /\?|^\s*[\p{P}\s]*(?:does|do|did|is|are|was|were|has|have|can|could|would|will|shall|should)\s+(?:it|this|that|these|they|the|you|i|there|my)\b|^\s*[\p{P}\s]*(?:what|which|how|when|where|why|whether)\b|\b(?:know|tell\s+me|let\s+me\s+know|confirm|advise|clarify)\b[^.!?;\n]{0,25}?\b(?:what|which|how|when|where|why|whether|if)\b|\b(?:wanted|want|need|like)\s+to\s+know\b|\bif\s+(?:it|this|that|they|these)\s+(?:has|have|is|are|comes?|contains?)\b/iu;

/**
 * A clause that says the message is NOT about something.
 *
 * The correction, which is a customer's way of telling us we answered the wrong
 * question. It is not a claim about the goods at all, and anything matching
 * inside it is stray vocabulary rather than evidence — which is precisely how
 * "nothing to do with my actual question" became a missing part.
 *
 * TWO KINDS OF CORRECTION, AND THE SECOND WAS MISSING.
 *
 * The shapes above all correct US. A customer also corrects THEMSELVES, and
 * that turned out to matter just as much:
 *
 *   "Hello does the big rustic refund (36cm diameter) come with a reduced plate?"
 *   "Refund = red colour, apologies predictive text strikes again"
 *
 * The buyer typed "refund" where they meant "red", noticed, and said so. The
 * word is a product colour in a pre-sales question, and the classifier read a
 * refund request out of both messages — out of the typo, and then again out of
 * the retraction of the typo. A message whose subject is its own wording is not
 * evidence about the goods, however the mistyped word happens to read.
 *
 * DELIBERATELY THE EXPLICIT VOCABULARY ONLY — predictive text, autocorrect,
 * typo, spellcheck. Bare "I meant" is NOT here: "I meant to order two of them"
 * is a real order amendment, and reading it as a correction would throw the
 * amendment away.
 */
const CORRECTION =
  /\bnothing\s+to\s+do\s+with\b|\bnot\s+(?:my|the)\s+(?:actual\s+)?question\b|\b(?:did\s?n[o']?t|do\s?n[o']?t|was\s?n[o']?t)\s+ask(?:ing)?\b|\bthat\s+(?:is|was)\s?n[o']?t\s+what\s+i\b|\bmisunderstood\b|\bnicht\s+meine\s+frage\b|\bpredictive\s+text\b|\bauto[-\s]?correct(?:ed|ion|s)?\b|\btypo\b|\bspell\s?check(?:er)?\b|\btippfehler\b|\bautokorrektur\b/i;

/**
 * A negator standing in front of the concept, inside the same clause.
 *
 * MEASURED FROM THE MATCH BACKWARDS, and only backwards, because that is the
 * only position where a negator reverses the concept. It also means a concept
 * whose own wording contains a negation — "not included", "are not there",
 * "nothing to hang it with" — is read as the assertion it is, since the negator
 * inside the match is not in front of it.
 */
const NEGATOR_BEFORE =
  /\b(?:not|never|no|none|nothing|neither|nor|without|kein\w*|nicht)\b[^.!?;\n]{0,18}$|\b(?:do|does|did|is|are|was|were|has|have|had|can|could|will|would)\s?n[o']?t\b[^.!?;\n]{0,18}$/i;

/**
 * How the message treats one concept.
 *
 * The pattern is matched against the WHOLE text so a concept spanning a clause
 * boundary still matches — several CST patterns deliberately span a "but" —
 * and only the resulting position is read at clause level. Reading the clause
 * is what supplies the meaning; matching it would lose half the evidence.
 *
 * Order of tests is deliberate. A correction wins over everything, because a
 * clause disclaiming the subject is not evidence whatever else it contains. A
 * negation is then checked before a question, so "isn't it broken?" reads as a
 * denial rather than a report.
 */
export type ClaimOptions = {
  /**
   * Whether a negator in front of the concept reverses it. True for almost
   * everything — "nothing is broken" is not a breakage.
   *
   * SET FALSE WHERE THE NEGATION IS PART OF THE CLAIM. A description complaint
   * is built out of negatives: "cannot assemble as the photograph portrays",
   * "does not match the listing", "not as described". Reversing on the negator
   * there would throw away the complaint at the moment the customer makes it.
   * The correction and question tests still apply, so "is it as described?"
   * remains a question either way.
   */
  readonly negationReverses?: boolean;
};

export function claimStatus(
  text: string,
  concept: RegExp,
  { negationReverses = true }: ClaimOptions = {},
): ClaimStatus {
  // EVERY OCCURRENCE, NOT THE FIRST. "The item is not damaged but the shade is
  // smashed" denies the concept and then asserts it, and reading only the first
  // hit would file that as a denial. The strongest reading wins: one asserted
  // occurrence makes the message a claim, however many denials surround it.
  const scan = new RegExp(concept.source, `${concept.flags.replace(/[gy]/g, "")}g`);
  const clauses = clausesOf(text);
  const clauseOf = (index: number) =>
    clauses.find((candidate) => index >= candidate.start && index < candidate.end) ?? {
      text,
      start: 0,
      end: text.length,
    };

  let strongest: ClaimStatus = "not_stated";
  const rank: Record<ClaimStatus, number> = { not_stated: 0, negated: 1, asked: 2, asserted: 3 };

  for (const match of text.matchAll(scan)) {
    const clause = clauseOf(match.index);
    let status: ClaimStatus;
    if (CORRECTION.test(clause.text)) {
      status = "negated";
    } else if (negationReverses && NEGATOR_BEFORE.test(text.slice(clause.start, match.index))) {
      status = "negated";
    } else {
      status = INTERROGATIVE_FRAME.test(clause.text) ? "asked" : "asserted";
    }
    if (rank[status] > rank[strongest]) strongest = status;
    if (strongest === "asserted") break;
  }

  return strongest;
}

/**
 * Whether the customer states the concept as something that happened.
 *
 * The gate a problem category should sit behind: a fault, a breakage, an absent
 * part and a wrong item are all things the customer has to CLAIM before they
 * are a case.
 */
export function asserts(text: string, concept: RegExp, options?: ClaimOptions): boolean {
  return claimStatus(text, concept, options) === "asserted";
}

/**
 * Whether the customer is asking ABOUT the concept rather than reporting it.
 *
 * Exported for the pre-sales side of the same coin: "how many windings does it
 * have" is a specification question precisely because the count is asked and
 * not asserted.
 */
export function asks(text: string, concept: RegExp): boolean {
  return claimStatus(text, concept) === "asked";
}

/* ------------------------------------------------------------------------- *
 * WHAT THE MESSAGE IS DOING, TAKEN AS A WHOLE
 * ------------------------------------------------------------------------- */

/** What the customer is doing with the message. */
export type SpeechAct =
  /** Asking us something. */
  | "question"
  /** Telling us to do something. */
  | "request"
  /** Telling us we answered the wrong thing. */
  | "correction"
  /** Stating something as fact. */
  | "assertion"
  /** Thanking, confirming, closing. */
  | "acknowledgement";

/** "please send", "could you arrange", "I would like you to" — an instruction. */
const REQUEST_FRAME =
  /\bplease\b|\bcould\s+you\b|\bcan\s+you\b|\bwould\s+you\b|\bi\s+(?:would\s+like|want|need)\s+(?:you\s+to|a|an|the|my)\b|\b(?:send|arrange|issue|refund|replace|cancel|collect|dispatch)\s+(?:me|us|it|them|this|the|a|my)\b/i;

/** Thanks, and nothing else being asked. */
const ACKNOWLEDGEMENT =
  /\b(?:thank\s?you|thanks|many\s+thanks|much\s+appreciated|noted|understood|received\s+with\s+thanks|all\s+sorted|sorted\s+now|that'?s\s+(?:great|fine|perfect))\b/i;

/**
 * The act the message performs.
 *
 * ORDERED BY WHAT OVERRIDES WHAT. A correction is checked first because it is
 * the one act that tells us the rest of the message is not about what we
 * thought. A question beats a request, because "could you confirm whether it is
 * dimmable" is both and the answer wanted is information. An acknowledgement
 * only wins when nothing is being asked at all, so "thanks, but when will it
 * arrive?" stays a question.
 */
export function speechActOf(text: string): SpeechAct {
  if (CORRECTION.test(text)) return "correction";
  const interrogative = clausesOf(text).some((clause) => INTERROGATIVE_FRAME.test(clause.text));
  if (interrogative) return "question";
  if (REQUEST_FRAME.test(text)) return "request";
  if (ACKNOWLEDGEMENT.test(text)) return "acknowledgement";
  return "assertion";
}
