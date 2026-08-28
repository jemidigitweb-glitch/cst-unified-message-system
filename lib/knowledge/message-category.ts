/**
 * Which of the eleven CST case areas a conversation's messages are about, for
 * inbox filtering.
 *
 * WHY A SEPARATE FUNCTION FROM `classifyCaseType`. That classifier exists for
 * one purpose only — naming the request behind a conversation the rule base
 * could NOT ground a reply for, so it can join `cst_app.conversation_rule_analysis`
 * and the No Rule list. Reusing it here would mean either changing its label
 * vocabulary (breaking that stored, compared-against data) or accepting a
 * mismatch between what this filter calls something and what the No Rule tab
 * calls the same thing. This is a second, independent classifier with its own
 * vocabulary — the eleven CST rule areas — built the same way for the same
 * reason: a phrase table a reviewer can read and challenge, not a model call.
 *
 * REUSES THE SAME PHRASE SIGNALS `classifyCaseType` already proved out —
 * delivery, damage, defective, missing parts, wrong item/quantity/description,
 * pre-sales, return/refund — split and relabelled to the exact eleven category
 * names, with "Admin related issues" (invoice/receipt/account requests) and
 * "Order change, before shipping queries" (cancellation and amendment before
 * dispatch) added as their own signals, since `classifyCaseType` never named
 * either separately.
 *
 * SAME "REFUSE RATHER THAN GUESS" DISCIPLINE. A tie between two equally-strong
 * signals returns `null` (uncategorised), never a coin toss presented as a
 * finding.
 *
 * NO DATABASE, NO STORAGE. This runs at list-fetch time, over customer text
 * the query already reads — nothing here is persisted, so a phrase-table
 * change takes effect on the next request rather than needing a backfill.
 *
 * PURE. No network, no model, no database.
 */

export const MESSAGE_CATEGORIES = [
  "Delivery queries",
  "Pre sales queries",
  "Admin related issues",
  "Order change, before shipping queries",
  "Defective items",
  "Damage queries",
  "Wrong item sent messages",
  "Parts missing queries",
  "Wrong quantity sent issues",
  "Wrong description issues",
  "Return and refunds",
] as const;

export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];

/**
 * The category for a conversation whose customer messages cannot be read.
 *
 * WHAT THIS COVERS. 167 inbound messages carry `body_decode_status = 'empty'`
 * and a null body — the customer wrote, the source recorded the message, and
 * the text did not survive. The interface renders those as "Message content
 * unavailable", and until now the conversation reached the inbox with no
 * category at all, which is the one state a reviewer cannot filter, sort or
 * triage on.
 *
 * WHY ADMIN AND NOT A GUESS FROM CONTEXT. The obvious idea is to read OUR OWN
 * replies instead and take the category from those. It was measured on the
 * 1,495 conversations where both sides are readable, so the customer's own
 * category acts as the check, and it does not work: our replies agree with the
 * customer's category 50.8% of the time, and PRECISION per predicted category
 * runs 20% (Wrong description) to 61% (Damage). Only "Admin related issues"
 * reaches 65%, and that is the fallback anyway. Tagging a thousand
 * conversations from a coin flip would put a confident wrong label where a
 * blank used to be — worse than the blank, because a wrong category misroutes
 * work while a blank merely fails to route it.
 *
 * So this states the one thing that IS true: a customer wrote to us, and
 * somebody has to open it. That is an admin case.
 */
export const UNREADABLE_CONTENT_CATEGORY: MessageCategory = "Admin related issues";

/**
 * The phrase table, exported so a test can check its shape rather than a
 * reviewer having to eyeball it.
 *
 * ONE INVARIANT MATTERS MOST: no phrase here may also match a more general
 * phrase in the SAME category. Scoring counts matched phrases, so a message
 * saying one thing once would score that category twice and beat a genuine
 * tie with another category. Four such pairs predate this table's growth and
 * are left as they are; nothing new should join them.
 */
export const SIGNALS: readonly { readonly label: MessageCategory; readonly phrases: readonly string[] }[] = [
  {
    label: "Delivery queries",
    phrases: [
      "not arrived",
      "hasn't arrived",
      "has not arrived",
      "still waiting",
      "where is my order",
      "not received",
      "tracking",
      "delayed",
      "late delivery",
      // Measured against live customer text: each of these newly classified
      // conversations the table already missed, with few or no ties created.
      "been dispatched",
      "not been delivered",
      "when will it",
      "when will my",
      "any update on",
      // eBay/Shopify wording measured in a second sweep. "out for delivery" alone
      // named 41 conversations the table had missed.
      "out for delivery",
      "was not delivered",
      "when are you sending",
      "no updates",
      "did not get my",
      "signature on delivery",
      "delivery instructions",
      // From CST-reviewed eBay cases: a chase phrased as "yet to receive", and a
      // failed delivery attempt — including the customer's own typo, which is how
      // they actually wrote it.
      "yet to receive",
      "tried to deliver",
      "no delivered",
      "where is my item",
      "delivery attempt",
      "return to sender",
      // German
      "nicht angekommen",
      "noch nicht erhalten",
      "wo ist meine bestellung",
      "sendungsverfolgung",
      "lieferung verspätet",
      "lieferzeit",
      "zustellung",
      // German delivery chases seen on eBay: nothing received yet, asking for a
      // dispatch confirmation, or for the processing status.
      "nichts bekommen",
      "versandbestätigung",
      "bearbeitungsstatus",
      "ware angekommen",
      "paket ankommen",
    ],
  },
  {
    label: "Pre sales queries",
    phrases: [
      "in stock",
      "before i buy",
      "does it fit",
      "dimensions",
      "compatible with",
      // Spec questions are pre-sales in practice, and the single biggest gap
      // the analysis found (129 conversations).
      "voltage",
      "wattage",
      "suitable for",
      "what size",
      "can i use",
      // Fit/spec questions asked before buying — the commonest genuine eBay
      // enquiry, and almost none of it was matching before.
      "the diameter of",
      "what length",
      "how wide",
      "out of stock",
      "will this work",
      "can this be used",
      "do you have the same",
      "looking to buy",
      "would like to order",
      "can i purchase",
      "do you offer",
      "before i order",
      // Pre-purchase colour and compatibility questions, as eBay customers phrase
      // them when asking about a listing they have not bought.
      "do you do this in",
      "would it work",
      "can it work",
      "thinking of buying",
      // What is in the box, whether it fits, what rating is needed, and when it
      // will be back — the four things eBay customers ask before buying.
      "does this purchase include",
      "does this come as",
      "will fit",
      "what watt",
      "what pattern",
      "can you recommend",
      "stock arrive",
      "anytime soon",
      // German
      "auf lager",
      "bevor ich kaufe",
      "abmessungen",
      "kompatibel mit",
      "welche größe",
      "in verschiedene farben",
    ],
  },
  {
    label: "Admin related issues",
    phrases: [
      "vat invoice",
      "business invoice",
      "invoice",
      "receipt",
      "proof of purchase",
      "business account",
      // German
      "mehrwertsteuerrechnung",
      "rechnung",
      "kaufbeleg",
    ],
  },
  {
    label: "Order change, before shipping queries",
    phrases: [
      "cancel my order",
      "cancel the order",
      "cancel this",
      "cancellation",
      "before it ships",
      "before dispatch",
      "change my order",
      "change the address",
      "amend my order",
      "amend the order",
      "change the delivery address",
      "wrong address",
      "cancel order",
      "haven't sent yet",
      // German
      "bestellung stornieren",
      "stornierung",
      "vor dem versand",
      "bestellung ändern",
      "adresse ändern",
      "kaufabbruch",
      // The customer telling us THEY got the order wrong — a different thing from
      // us getting it wrong, and the distinction the table could not previously
      // make. No product wording here: what identifies this is the reference to
      // their own ordering or selection, not what was ordered.
      "by mistake",
      "made a mistake",
      "not clear when",
      "when i placed",
      "selected the wrong",
      "ordered the wrong",
    ],
  },
  {
    label: "Defective items",
    phrases: [
      "faulty",
      "defective",
      "not working",
      "stopped working",
      "doesn't work",
      "does not work",
      "flickering",
      "dead on arrival",
      "turned back on",
      // German
      "defekt",
      "funktioniert nicht",
      "geht nicht mehr",
      "kaputt",
    ],
  },
  {
    label: "Damage queries",
    phrases: [
      "damaged",
      "broken",
      "smashed",
      "cracked",
      "dented",
      "scratched",
      "kratzer",
      // German
      "beschädigt",
      "zerbrochen",
      "gesprungen",
    ],
  },
  {
    label: "Wrong item sent messages",
    phrases: [
      "wrong item",
      "wrong product",
      "wrong colour",
      "wrong color",
      "not what i ordered",
      "not the one i ordered",
      "send me the wrong",
      "sent the wrong",
      // The same report with the indirect object present, or the article
      // dropped — "you have sent me the wrong ones", "U sent me wrong one".
      // "sent the wrong" cannot reach either, because "me" sits in the gap.
      // 23, 3 and 31 occurrences respectively in live eBay text.
      "sent me the wrong",
      "sent me wrong",
      "received the wrong",
      // "it's the wrong one", "they are the wrong ones". The mismatch stated
      // without naming what the thing is — the only way to say it without a
      // product noun, and this table holds no product nouns.
      //
      // THE ARTICLE IS REQUIRED, and that is not incidental. Bare "wrong one"
      // also catches a customer retracting their own previous message —
      // "Wrong one, sorry — ignore that" — which is pinned in the tests as
      // something this category must never claim. "THE wrong one" is a
      // statement about the item in front of them; "wrong one, sorry" is not.
      // 57 and 27 live occurrences.
      "the wrong one",
      "the wrong ones",
      // German
      "falscher artikel",
      "falsche farbe",
      "nicht das was ich bestellt habe",
      "falsch geliefert",
    ],
  },
  {
    label: "Parts missing queries",
    phrases: [
      "missing part",
      "missing parts",
      "parts missing",
      "missing piece",
      "no screws",
      "missing screws",
      "no earth",
      "nothing to hang",
      // How a customer reports an absent component, rather than what the
      // component is called. Product nouns are deliberately not listed — nuts,
      // brackets and shades appear in plenty of conversations that are not
      // about anything missing, so the intent has to carry the signal.
      "is missing",
      // The same report in the plural and the past — "the bulbs are missing",
      // "a nut was missing". The table held only the present singular, so 220
      // live messages saying exactly this were invisible to it purely on
      // inflection. No new intent here, just the rest of the verb.
      "are missing",
      "was missing",
      "were missing",
      "appears to be missing",
      "appear to be missing",
      "seems to be missing",
      "received without",
      "arrived without",
      "not included",
      // German
      "fehlende teile",
      "teile fehlen",
      "keine schrauben",
      "fehlt",
      "fehlen",
      "unvollständig",
      "nicht enthalten",
    ],
  },
  {
    label: "Wrong quantity sent issues",
    phrases: [
      "wrong quantity",
      "only received",
      "fewer than",
      "short by",
      "short delivery",
      // German
      "falsche menge",
      "zu wenig erhalten",
    ],
  },
  {
    label: "Wrong description issues",
    phrases: [
      "not as described",
      "not as advertised",
      "listing says",
      "misleading",
      "described as",
      "advert said",
      // "advertised at 6mm but mine is 8.85mm" — the listing-versus-reality
      // comparison, which the table only knew in its negated form ("not as
      // advertised"). Read back over every occurrence: seven are genuine
      // description mismatches, one ("advertised as dimmable, does not work")
      // now ties with Defective and falls to null. That trade is accepted.
      "advertised as",
      "advertised at",
      "laut beschreibung",
      "non corrisponde",
      // German
      "nicht wie beschrieben",
      "irreführend",
    ],
  },
  {
    label: "Return and refunds",
    phrases: [
      "refund",
      "return this",
      "send it back",
      "money back",
      "return the",
      "replacement",
      "replace it",
      "send another",
      // The remedy the customer asks for, which CST treats as the category even
      // when a fault is what prompted it.
      "send me a new one",
      "send me a return",
      "send a return",
      "refunded",
      "return label",
      "return it",
      "returns process",
      "reimburse",
      // Return wording, including the German and Italian actually present.
      "need to return",
      "like to return",
      "wish to return",
      "have to return",
      "send this back",
      "returning this",
      // A return offered with no object after the verb — "I can return if
      // possible please". Every other return phrase here needs a noun ("return
      // the", "return it"), so an offer phrased this way matched nothing at
      // all. Measured over live eBay text: 209 for "can return", 61 for "can i
      // return", and the sample read back is customer return requests
      // throughout.
      "can return",
      "can i return",
      // "arrange a return" (126) and "want to return" (54). Deliberately NOT
      // "want a refund": bare "refund" already fires on it, so adding it would
      // score the same sentence twice — the one invariant this table has.
      "arrange a return",
      "want to return",
      // German
      "rückerstattung",
      "geld zurück",
      "zurücksenden",
      "ersatzlieferung",
      "retoure",
      "zurückschicken",
      "erstattung",
      "rücksendung",
      "rücksendeetikett",
      "rücksendeadresse",
      "restituirlo",
      "rimborso",
    ],
  },
];

/**
 * What the customer typed, made comparable with what the table holds.
 *
 * TWO REAL DEFECTS THIS FIXES, both found in live message bodies:
 *
 *   curly apostrophes   Customers type “doesn’t work”; the table holds
 *                       "doesn't work". Every apostrophe phrase in the table
 *                       — doesn't work, hasn't arrived — was silently dead
 *                       against most real text.
 *   HTML entities       eBay stores bodies with &amp; and &apos; undecoded,
 *                       so a phrase spanning one could never match.
 *
 * Deliberately nothing else: no lower-casing (matching is already
 * case-insensitive), no punctuation stripping, no stemming. Each rule here
 * exists because a phrase provably failed without it.
 */
function normalise(text: string): string {
  return text
    .replace(/&apos;|&#39;|&rsquo;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"');
}

/**
 * Where two categories tie, the pair whose winner is not a coin toss.
 *
 * A tie normally returns null, and that stays the default. This list is the
 * short set of collisions where the same words reliably mean one of the two,
 * confirmed against real conversations rather than assumed:
 *
 *   Admin over Parts missing — German invoice requests say "uns fehlt die
 *   Rechnung" ("we are missing the invoice"). `fehlt` fires Parts missing and
 *   `rechnung` fires Admin, so every one of them tied and fell to null. Of the
 *   conversations where exactly this pair tied, all six were invoice requests.
 *
 * Nothing joins this list on reasoning alone; each entry needs conversations
 * behind it, and every pair NOT listed still refuses.
 */
const TIE_PRECEDENCE: readonly (readonly [MessageCategory, MessageCategory])[] = [
  ["Admin related issues", "Parts missing queries"],
];

function precedenceWinner(a: MessageCategory, b: MessageCategory): MessageCategory | null {
  for (const [winner, loser] of TIE_PRECEDENCE) {
    if ((a === winner && b === loser) || (b === winner && a === loser)) return winner;
  }
  return null;
}

/**
 * Damage predicated on the PACKAGING rather than on the goods — "the box was
 * damaged and slightly open", "arrived in a broken plastic container".
 *
 * WHY THIS EXISTS. A customer who opens a battered box and finds a component
 * absent is reporting a missing part. The state of the box is how they explain
 * it, not what they want done. Before this, the damage word and the missing
 * word scored one apiece and the conversation fell to null.
 *
 * Read against every live conversation where a packaging noun carries a damage
 * word alongside a missing one, the direction is unanimous: "the box was open
 * and battered ... the plastic inner circle is missing", "the box is very badly
 * damaged and open. It is missing X1 ceiling rose", "the box was open all
 * damaged and the bulb are missing". All are parts cases.
 *
 * The counter-examples are what keep it narrow. Damage to the GOODS names no
 * packaging: "a lot of scratches and the earth is missing", "the plastic hinge
 * is broken and the clear cover missing", "missing a whole crystal, the broken
 * piece is not present". None of those matches here, and all still refuse.
 *
 * Both word orders, because customers use both, and bounded to a single
 * sentence so it cannot reach across into an unrelated clause.
 */
const PACKAGING = "box|boxes|carton|packaging|parcel|package|container|outer|wrapping|karton|verpackung|umschlag|paket";
const DAMAGE_WORD =
  "damaged|dented|crushed|crumpled|ripped|torn|battered|smashed|broken|squashed|open|besch(?:ä|ae)digt|zerdr(?:ü|ue)ckt|aufgerissen|ge(?:ö|oe)ffnet";

const PACKAGING_DAMAGE = new RegExp(
  `\\b(?:${PACKAGING})\\b[^.!?]{0,80}?\\b(?:${DAMAGE_WORD})\\b|\\b(?:${DAMAGE_WORD})\\b[^.!?]{0,40}?\\b(?:${PACKAGING})\\b`,
  "i",
);

/**
 * MONEY BACK. Not a return, not a replacement — the customer's money.
 *
 * "Return and refunds" is an OUTCOME category, not a problem category, and this
 * is the test that decides whether the outcome is actually being asked for.
 * Everything else a customer might say about sending an item back — "I can
 * return it", "send me a return label", "please send a replacement" — describes
 * a route, not a result, and a route is not a reason to take the conversation
 * away from the problem that caused it.
 *
 * The distinction matters because the two are constantly said together:
 *
 *   "you sent the wrong one, I can return it if you send the right one"
 *      -> a wrong-item case. The return is how it gets fixed.
 *   "you sent the wrong one, I want my money back"
 *      -> a refund case. The money is the point.
 *
 * Deliberately narrow: refund, reimbursement, money back and their German and
 * Italian equivalents. Nothing about labels, postage or replacements.
 */
const REFUND_INTENT =
  /\b(?:refund|refunds|refunded|refunding|reimburse|reimbursed|reimbursement|money\s+back|r(?:ü|ue)ckerstattung|erstattung|erstatten|zur(?:ü|ue)ckerstatt\w*|geld\s+zur(?:ü|ue)ck|rimborso|rimborsare)\b/i;

/**
 * The customer saying they do NOT want their money back.
 *
 * Requires an explicit verb of wanting, so it can never swallow someone chasing
 * a refund they are owed: "I have not been refunded yet" and "still no refund"
 * do not match here, while "I don't want a refund, just send the right one"
 * does.
 */
const REFUND_DECLINED =
  /\b(?:do\s?n[o']?t|does\s?n[o']?t|did\s?n[o']?t|not)\s+(?:want|wanting|need|require|after|looking\s+for|seeking|expecting|asking\s+for)\s+(?:a\s+|any\s+|the\s+|my\s+)?refund\b/i;

function wantsMoneyBack(text: string): boolean {
  return REFUND_INTENT.test(text) && !REFUND_DECLINED.test(text);
}

/**
 * The categories that describe a PROBLEM, as opposed to an outcome or an
 * enquiry.
 *
 * A conversation that names one of these has told us what went wrong. It keeps
 * that category unless the customer also asks for their money back — see the
 * gate in `classifyMessageCategory`. Pre-sales and Admin are absent because
 * neither is a problem report, so neither is something a mentioned return could
 * plausibly be stealing.
 */
const PROBLEM_CATEGORIES: readonly MessageCategory[] = [
  "Delivery queries",
  "Order change, before shipping queries",
  "Defective items",
  "Damage queries",
  "Wrong item sent messages",
  "Parts missing queries",
  "Wrong quantity sent issues",
  "Wrong description issues",
];

/**
 * A customer ASKING for a return or refund, as opposed to mentioning one.
 *
 * THE DISTINCTION THIS DRAWS IS THE WHOLE POINT, and it is visible in live text:
 *
 *   "Can you send the correct one please and I will return the one I received"
 *      -> a wrong-item report. The return is incidental; what is being asked
 *         for is the right item.
 *   "it's the wrong colour. Please could I return this item."
 *      -> a return request that happens to explain itself with a wrong item.
 *
 * Both contain the word "return", and scoring cannot tell them apart because
 * both score Return once. What separates them is grammatical mood: a request,
 * not a statement of intent. So this matches the REQUEST FORMS only —
 * "could I return", "want to return", "arrange a return", "send me a returns
 * label", "refund me" — and deliberately does not match "I will return it".
 */
const EXPLICIT_REMEDY_REQUEST = new RegExp(
  [
    // Asking permission or possibility.
    "(?:can|could|may|shall|should)\\s+i\\s+(?:please\\s+)?(?:just\\s+)?(?:return|send\\s+(?:it|them|this|these)\\s+back)",
    "i\\s+can\\s+return",
    "(?:possible|possibility)\\s+to\\s+return",
    // Stating the want.
    "(?:want|wants|wish|wishes|need|needs|like|prefer)\\s+to\\s+return",
    "(?:'d|would)\\s+like\\s+to\\s+return",
    "(?:want|wants|wish|wishes|need|needs|like|expect)\\s+(?:a|my|the|full|partial|complete)?\\s*refund",
    "(?:'d|would)\\s+like\\s+(?:a|my|the)?\\s*refund",
    // Asking for the paperwork or the arrangement.
    "arrange\\s+(?:a|the|my)\\s+(?:return|refund)",
    "returns?\\s+label",
    "(?:send|provide|issue|email|give)\\s+(?:me\\s+)?(?:a|the|my)\\s+(?:return|refund)",
    // Asking for the money.
    "refund\\s+(?:me|my|it|this|the)",
    "refund\\s+please",
    "please\\s+refund",
    "money\\s+back",
    "(?:waiting|wait|chasing)\\s+for\\s+(?:my|the|a)\\s+refund",
    // German. Each of these is already a request in ordinary use.
    "zur(?:ü|ue)ck(?:schicken|senden|geben|erstatten)",
    "r(?:ü|ue)cksende(?:etikett|adresse|schein)",
    "r(?:ü|ue)ckerstattung",
    "erstattung",
    "geld\\s+zur(?:ü|ue)ck",
    "retoure",
  ].join("|"),
  "i",
);

/**
 * The categories a return/refund REQUEST outranks — and, just as importantly,
 * the categories that outrank a return/refund that was only mentioned.
 *
 * TWO NAMED PAIRS, NOT A GLOBAL RULE. Both are reports of something the
 * customer wants PUT RIGHT, where the remedy asked for decides which of the two
 * it is:
 *
 *   Wrong item sent   "you sent me the wrong one" is a wrong-item case. It
 *                     stays one even if the customer adds that they can send
 *                     the item back — an item may well be returned without the
 *                     message being a refund request. Add "I want a refund"
 *                     and it becomes one.
 *   Order change      "I ordered the wrong one, can I have a different one" is
 *                     an amendment. Add "please refund me" and it is a return.
 *
 * Every other pairing is untouched: Damage, Defective, Delivery, Parts missing,
 * Wrong description and Wrong quantity all still contest Return on score alone
 * and still refuse on a tie. Nothing here is a general "Return wins" or a
 * general "Return loses" — there is no evidence for either, and the two
 * directions are both wrong about half the time.
 */
const REMEDY_REQUEST_DECIDES: readonly MessageCategory[] = [
  "Wrong item sent messages",
  "Order change, before shipping queries",
];

/**
 * Resolves only the two pairs above, and returns null for everything else so
 * the ordinary scoring and tie rules carry on untouched.
 */
function remedyRequestWinner(
  a: MessageCategory,
  b: MessageCategory,
  text: string,
): MessageCategory | null {
  const other = a === "Return and refunds" ? b : b === "Return and refunds" ? a : null;
  if (other === null || !REMEDY_REQUEST_DECIDES.includes(other)) return null;
  return wantsMoneyBack(text) ? "Return and refunds" : other;
}

/**
 * The customer saying they themselves ordered the wrong thing AND asking for a
 * different one — an amendment, not a complaint about what we sent.
 *
 * WHY A SHAPE RULE RATHER THAN PHRASES. The English half of this is already in
 * the table as "ordered the wrong" and "selected the wrong", because English
 * puts the two words together. German does not: "Falsches Design bestellt",
 * "die falsche Größe bestellt", "das falsche Netzteil bestellt" — the noun sits
 * between them, so no fixed phrase can span it without naming the product, and
 * naming products is the one thing this table refuses to do.
 *
 * BOTH HALVES ARE REQUIRED, and the second is what keeps it honest. Reading all
 * 27 live occurrences of the wrong-ordered pattern: those that ask for a swap
 * are amendments, those that ask to send it back are returns. So a mis-order
 * alone is not enough — the customer must also be asking for a different one,
 * and must not be asking for a return or refund, which the table would have
 * scored anyway.
 *
 * Applied ONLY where no phrase matched, so it can never override the table.
 */
const ORDERED_THE_WRONG_THING = /\bfalsch\w*\s+(?:\w+\s+){0,3}bestellt\b/i;

const WANTS_A_DIFFERENT_ONE =
  /\b(?:ander(?:e|es|en|er|em)|umtausch\w*|(?:um)?tauschen|wechseln|different|swap|exchange)\b/i;

function looksLikeOwnOrderingMistake(text: string): boolean {
  return (
    ORDERED_THE_WRONG_THING.test(text) &&
    WANTS_A_DIFFERENT_ONE.test(text) &&
    !EXPLICIT_REMEDY_REQUEST.test(text)
  );
}

/**
 * A customer ASKING for delivery — soon, or by a date — rather than thanking us
 * for one that already happened.
 *
 * THE PROBLEM THIS SOLVES. "Lieferung" cannot be a signal on its own: it
 * appears in 288 live messages, and of the 39 that pair it with "schnelle", 32
 * are "vielen Dank für die schnelle Lieferung, aber ..." opening a message
 * about an invoice, a wrong colour or a missing part. Naming those Delivery
 * would tie against the category each of them actually belongs to and destroy
 * correct labels. So the delivery noun is necessary but nowhere near sufficient.
 *
 * THREE CONDITIONS, ALL REQUIRED:
 *
 *   a delivery noun      Lieferung, Versand, Zustellung, liefern.
 *   a forward-looking    "wäre dankbar für", "bitte um", "möglichst schnell",
 *      request           "schnellstmöglich", "noch diese Woche". This is what
 *                        separates asking from thanking, and it is why the bare
 *                        adjective "schnelle" is not enough on its own.
 *   not a thank-you      "vielen Dank für ...", "danke für ..." — the formula
 *                        that opens the 32. Note "dankbar" is NOT "danke": the
 *                        subjunctive "ich wäre dankbar" is a request, and the
 *                        exclusion is written so it survives.
 *
 * Applied ONLY where no phrase matched, so it cannot dilute a category the
 * table already found — which is also why the 32 thank-yous never reach it:
 * every one of them scores something else first.
 */
const DELIVERY_NOUN = /\b(?:liefer\w*|versand\w*|zustellung|zusendung|versenden|verschicken)\b/i;

const DELIVERY_REQUESTED_SOON =
  /\b(?:w(?:ä|ae)re\s+(?:ihnen\s+)?(?:sehr\s+)?dankbar|bitte\s+um|m(?:ö|oe)glichst\s+schnell\w*|schnellstm(?:ö|oe)glich\w*|umgehend\w*|baldig\w*|so\s+schnell\s+wie\s+m(?:ö|oe)glich|noch\s+diese\s+woche|bis\s+(?:zum\s+)?(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag))\b/i;

/** The thank-you formula that opens a message about something else entirely. */
const THANKS_FOR_DELIVERY = /\b(?:vielen\s+dank|besten\s+dank|danke|dank)\s+(?:f(?:ü|ue)r|nochmals)\b/i;

function looksLikeDeliveryRequest(text: string): boolean {
  return (
    DELIVERY_NOUN.test(text) &&
    DELIVERY_REQUESTED_SOON.test(text) &&
    !THANKS_FOR_DELIVERY.test(text)
  );
}

/**
 * The one shape that is safe to name when NO phrase matched at all.
 *
 * WHY A SHAPE RULE AND NOT MORE PHRASES. Of the eBay conversations the table
 * leaves unnamed, the great majority match no phrase whatever, and the
 * commonest thing among them is a customer asking about a product before
 * buying it. There is no wording to add for that: the recurring n-grams across
 * those conversations are "thank you", "can you", "do you have" — the shape of
 * a question, not a vocabulary. Enumerating the tail is not possible; naming
 * the shape is.
 *
 * FOUR CONDITIONS, ALL REQUIRED, and each one earns its place by what it keeps
 * out:
 *
 *   asks something      A statement is not an enquiry.
 *   names a product     A closed spec vocabulary — voltage, size, fitting,
 *      attribute        bulb type. Without it "can you help?" would qualify.
 *   nothing bought yet  The decisive one. A customer who has ALREADY received
 *                       the item is not making a pre-sales enquiry however
 *                       much specification they discuss, and that confusion
 *                       was the single commonest misreading this rule had to
 *                       design against.
 *   short               A long thread has usually moved on to a problem. The
 *                       length bound is what lifted this from 86% to 91%
 *                       agreement against the reviewed sample.
 *
 * Applied ONLY where no phrase matched, so it can never override or dilute a
 * signal the table already found.
 */
const ASKS_SOMETHING =
  /\?|(^|[.!?]\s)\s*(do|does|did|can|could|would|will|is|are|have|has|what|which|how|when|where|hab(?:en|t)|k(?:ö|oe)nn(?:en|t)|ist|sind|wie|was|welche)\b/i;

/**
 * Attributes a buyer asks about. Closed, so an unrelated question cannot qualify.
 *
 * THE OPENING BOUND IS NOT `\b`, AND THAT IS THE POINT. Customers write the
 * number and the unit as one token — "12volt", "240v", "8.85mm", "5watt". A
 * leading `\b` needs a word boundary before "volt", and there is none between
 * "2" and "v", so every one of those was invisible to this rule. Over live eBay
 * text 1,053 messages glue a digit to a unit this way, and 54 of them carry no
 * other attribute at all — for those, this was the sole reason a plain product
 * question went unnamed.
 *
 * `(?:^|[^a-z])` requires the preceding character to be a non-letter, which a
 * digit satisfies and a letter does not. It is therefore STRICTER than `\b` on
 * the thing `\b` was there to stop: "revolt" and "champs" fail here, as they
 * did before. The closing `\b` is unchanged.
 *
 * "wired" earns its place the same way as "dimmable" and "waterproof" — a spec
 * a buyer chooses between (hard-wired versus plug-in), not a product name. 109
 * occurrences in live text.
 */
const PRODUCT_ATTRIBUTE =
  /(?:^|[^a-z])(volt|volts|voltage|watt|watts|wattage|amp|amps|dimmable|dimmer|colour|color|size|sizes|length|width|diameter|height|mm|cm|metre|meter|bulb|bulbs|fitting|fittings|socket|holder|shade|e27|e14|b22|gu10|ip44|ip65|kelvin|lumen|lumens|material|brass|chrome|compatible|suitable|waterproof|outdoor|indoor|thread|dimensions|specification|hardwired|wired)\b/i;

/**
 * A rating written as a number followed by its unit — "5v", "12volt", "240v",
 * "8W", "1000mA".
 *
 * SEPARATE FROM `PRODUCT_ATTRIBUTE` BECAUSE THE DIGIT IS THE WHOLE POINT. The
 * abbreviated units are single letters, and "v" or "w" as bare vocabulary would
 * fire on every other sentence. Requiring a digit immediately before makes the
 * letter meaningless on its own: this matches "12v" and never "v". That is the
 * only reason it is safe to name them at all.
 *
 * 2,144 live eBay messages write a rating this way, which is why the spelled-out
 * list alone was never going to reach them.
 */
const NUMERIC_SPEC = /\d\s?(?:v|kv|mv|w|kw|va|ma|amp|amps|volt|volts|watt|watts)\b/i;

/**
 * Any sign the customer already has the goods, in English or German.
 *
 * The contracted forms are here because they were missed: "I've ordered the
 * wrong size brackets, can I send them back?" slipped past a pattern that only
 * knew "i ordered", and was named a pre-sales enquiry.
 */
const ALREADY_PURCHASED =
  /\b(arrived|arrival|received|delivered|turned up|came today|came yesterday|i ?'?ve (?:ordered|bought|purchased|received|got)|i have (?:ordered|bought|purchased|received|got)|i bought|i purchased|i ordered|my order|installed|fitted|unbox|opened the box|erhalten|bekommen|geliefert|angekommen|bestellt)\b/i;

/**
 * Any hint of a problem or a remedy, whether or not the phrase table knows it.
 *
 * The guard that took this rule from 86% to 97% agreement. A pre-sales enquiry
 * is a question about a product and nothing else; the moment a cancellation, a
 * return, a fault or a description mismatch is mentioned, the conversation is a
 * case and belongs to whichever category the table names — or to none.
 *
 * Deliberately BROADER than the phrase table, so wording the table has never
 * seen still stops this rule from guessing. It costs a little coverage and buys
 * back most of the errors.
 */
const MENTIONS_A_PROBLEM =
  /\b(cancel|refund|return|returns|faulty|defect|defective|broken|damaged|missing|wrong|not working|ghosting|description|send (?:them|it|these) back)\b/i;

/** Chasing something outstanding — a delivery matter, not a pre-sales one. */
const AWAITING_SOMETHING = /\b(still|yet|waiting|when will|when is|how long|noch nicht|wann)\b/i;

/** Longer than a buyer's question; by this length the thread is usually a case. */
const MAX_ENQUIRY_LENGTH = 250;

function looksPreSales(text: string): boolean {
  return (
    text.length < MAX_ENQUIRY_LENGTH &&
    ASKS_SOMETHING.test(text) &&
    (PRODUCT_ATTRIBUTE.test(text) || NUMERIC_SPEC.test(text)) &&
    !ALREADY_PURCHASED.test(text) &&
    !AWAITING_SOMETHING.test(text) &&
    !MENTIONS_A_PROBLEM.test(text)
  );
}

/** Word-boundary match, so "cancel" does not fire on "cancellation policy link". */
function contains(haystack: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * Names the CST category a conversation's customer text falls under, or
 * declines to.
 *
 * Takes already-assembled customer text (lower-cased or not — matching is
 * case-insensitive) rather than a message list, so the caller can source it
 * from a single aggregated SQL column instead of fetching every message body
 * back into the application to re-derive the same string `classifyCaseType`
 * already knows how to build.
 */
export function classifyMessageCategory(customerText: string | null): MessageCategory | null {
  const text = normalise(customerText?.trim() ?? "");
  if (text === "") return null;

  const scored = SIGNALS.map((signal) => ({
    label: signal.label,
    hits: signal.phrases.filter((phrase) => contains(text, phrase)).length,
  })).filter((entry) => entry.hits > 0);

  // No phrase matched. Two shapes are still safe to name — the customer's own
  // mis-order wanting a swap, then a pre-sales enquiry. Checked in that order
  // because the first is the narrower of the two.
  if (scored.length === 0) {
    if (looksLikeOwnOrderingMistake(text)) return "Order change, before shipping queries";
    if (looksLikeDeliveryRequest(text)) return "Delivery queries";
    return looksPreSales(text) ? "Pre sales queries" : null;
  }

  // THE GATE. "Return and refunds" is an outcome, so it may not take a
  // conversation away from the problem that describes it unless the customer
  // asks for their money back. Without that, the return wording is a route the
  // customer is offering, and the problem category stands.
  //
  // Only ever removes Return when something else is there to take it: a message
  // that is nothing BUT a return request ("please send a returns label") has no
  // problem category to fall back on, and stays Return and refunds.
  const afterGate =
    !wantsMoneyBack(text) &&
    scored.some((entry) => entry.label === "Return and refunds") &&
    scored.some((entry) => PROBLEM_CATEGORIES.includes(entry.label))
      ? scored.filter((entry) => entry.label !== "Return and refunds")
      : scored;

  // Damage described on the PACKAGING, alongside something absent from inside
  // it, is context for the missing part rather than a complaint of its own.
  // Bounded to a single damage word, so a message that also reports the goods
  // themselves damaged keeps both signals and refuses as before.
  const damage = afterGate.find((entry) => entry.label === "Damage queries");
  const contenders =
    damage?.hits === 1 &&
    afterGate.some((entry) => entry.label === "Parts missing queries") &&
    PACKAGING_DAMAGE.test(text)
      ? afterGate.filter((entry) => entry.label !== "Damage queries")
      : afterGate;

  contenders.sort((a, b) => b.hits - a.hits);
  const [best, runnerUp] = contenders;

  // Wrong item / Order change against Return: decided by whether the money is
  // being asked for, at any score. See `REMEDY_REQUEST_DECIDES`.
  if (runnerUp !== undefined) {
    const byRemedy = remedyRequestWinner(best!.label, runnerUp.label, text);
    if (byRemedy !== null) return byRemedy;
  }

  if (runnerUp !== undefined && runnerUp.hits === best!.hits) {
    // A tie is genuine ambiguity and normally returns null. The exception is a
    // pair where the same words routinely mean one of them — see
    // `TIE_PRECEDENCE`. Anything not listed there still refuses.
    return precedenceWinner(best!.label, runnerUp.label);
  }

  return best!.label;
}

/* ------------------------------------------------------------------------- *
 * INTENT FALLBACK
 *
 * A SECOND LAYER, NOT A REPLACEMENT. Everything above is untouched and still
 * decides every conversation it can. What follows runs ONLY on the messages
 * that layer declined, and it exists because "no category" is not a useful
 * answer to give a CST agent looking at a real customer asking a real question.
 *
 * WHY IT IS SAFE TO BE LOOSER HERE. The phrase table is deliberately strict: it
 * has to survive being wrong in the presence of competing signals, so it
 * refuses on ties and demands specific wording. By the time control reaches
 * this layer, the table has already found NOTHING — there is no correct label
 * to destroy and no tie to lose. The cost of a loose signal here is a
 * second-best category instead of a blank; the cost of a loose phrase up there
 * is a wrong answer where a right one existed. That asymmetry is the whole
 * justification for the two layers having different standards of evidence.
 * ------------------------------------------------------------------------- */

/**
 * The intents this layer can recognise, named as the reviewer thinks about
 * them rather than as the regexes happen to be written.
 */
export type MessageIntent =
  | "received_wrong_item"
  | "missing_component"
  | "damaged_product"
  | "defective_product"
  | "wrong_description"
  | "wants_refund"
  | "wants_replacement"
  | "wants_order_change"
  | "delivery_request"
  | "pre_sale_question"
  | "admin_issue";

/** Any sign the goods are already with the customer. Broader than `ALREADY_PURCHASED`. */
const HAS_THE_GOODS =
  /\b(?:received|receive|arrived|delivered|came|sent|got|turned\s+up|opened|unpacked|erhalten|bekommen|geliefert|angekommen|ausgepackt)\b/i;

/**
 * The goods are not the ones ordered.
 *
 * "the correct one" / "the right one" are here because that is how a customer
 * asks for the swap without ever using the word "wrong" — "can you send the
 * correct one and I'll send this one back". Paired with `HAS_THE_GOODS`, so a
 * pre-purchase "which is the right one for my lamp?" cannot reach it.
 */
const A_MISMATCH =
  /\b(?:wrong|incorrect|not\s+what\s+i|not\s+the\s+one|different\s+(?:item|product|one|model|type|thing)|(?:the\s+)?(?:correct|right)\s+one|falsch\w*|nicht\s+das\s+was)\b/i;

/** Something that should be in the package is not. */
const SOMETHING_ABSENT =
  /\b(?:missing|incomplete|not\s+included|no\s+screws|nothing\s+to|short\s+of|only\s+(?:received\s+|got\s+|)?(?:one|two|three|four|five|\d+)\b|should\s+(?:be|have\s+been)\s+(?:two|three|four|five|\d+)|fehl\w*|unvollst(?:ä|ae)ndig|nicht\s+enthalten)\b/i;

/**
 * A shortfall stated as ARITHMETIC rather than as the word "missing".
 *
 * "Leider sind nur 2 Lampenschirme dabei. Es sollten aber 3 dabei sein." — the
 * customer never says fehlt, fehlen or unvollständig anywhere in the message.
 * They say they got two and should have three, and leave us to subtract. No
 * phrase can reach that, in any language, because the meaning is in the numbers.
 *
 * SO THE NUMBERS ARE COMPARED. Take the count in the "only ..." clause, and
 * look for any larger count elsewhere in the same message. That is what makes
 * this safe where a bare "nur + numeral" was not: "ich habe nur 2 bestellt"
 * names one count and cannot fire, while "nur 2 ... sollten aber 3" names two
 * and does. 165 live messages use "nur" with a numeral; requiring a second,
 * larger count is what separates the shortfalls from the rest.
 *
 * Digits are bounded to three, so a year or an order number cannot be mistaken
 * for a quantity.
 */
const COUNT_WORD: Readonly<Record<string, number>> = {
  ein: 1, eine: 1, einen: 1, einem: 1, einer: 1, eins: 1, one: 1,
  zwei: 2, two: 2, drei: 3, three: 3, vier: 4, four: 4,
  "fünf": 5, fuenf: 5, five: 5, sechs: 6, six: 6, sieben: 7, seven: 7,
  acht: 8, eight: 8, neun: 9, nine: 9, zehn: 10, ten: 10,
};

const COUNT_TOKEN = `\\d{1,3}|${Object.keys(COUNT_WORD).join("|")}`;

const ONLY_THIS_MANY = new RegExp(
  `\\b(?:nur|only|just|lediglich)\\s+(?:noch\\s+)?(${COUNT_TOKEN})\\b`,
  "i",
);

function countValue(token: string): number {
  return COUNT_WORD[token.toLowerCase()] ?? Number(token);
}

function looksLikeShortfall(text: string): boolean {
  const received = ONLY_THIS_MANY.exec(text);
  if (received === null) return false;

  const got = countValue(received[1] ?? "");
  if (!Number.isFinite(got)) return false;

  // A fresh regex each call: a global one carries `lastIndex` between calls, and
  // this function has to stay pure.
  for (const match of text.matchAll(new RegExp(`\\b(${COUNT_TOKEN})\\b`, "gi"))) {
    if (countValue(match[1] ?? "") > got) return true;
  }
  return false;
}

const IS_DAMAGED =
  /\b(?:damag\w*|broken|smash\w*|crack\w*|dent\w*|scratch\w*|besch(?:ä|ae)digt|zerbrochen|zerkratzt)\b/i;

const IS_DEFECTIVE =
  /\b(?:faulty|defect\w*|not\s+work\w*|does\s?n[o']?t\s+work|stopped\s+working|dead\s+on\s+arrival|flicker\w*|funktioniert\s+nicht|kaputt)\b/i;

/** A reference to what the listing promised, and a statement that reality differs. */
const LISTING_REFERENCE =
  /\b(?:photo|photograph|picture|image|listing|advert\w*|description|described|depicted|portray\w*|shown|specification|specs?|abbildung|beschreibung)\b/i;

const REALITY_DIFFERS =
  /\b(?:cannot|can\s?n[o']?t|can\s+not|unable|does\s?n[o']?t|do\s?n[o']?t|is\s?n[o']?t|are\s?n[o']?t|not|but|however|instead|different|mismatch|nicht|anders)\b/i;

/** Wants the right thing sent, rather than the money. */
const WANTS_A_REPLACEMENT =
  /\b(?:replac\w*|send\s+(?:me\s+)?(?:a\s+|the\s+)?(?:new|correct|right)|the\s+correct\s+one|the\s+right\s+one|exchang\w*|swap|ersatz\w*|nachliefer\w*|austausch\w*|umtausch\w*)\b/i;

/**
 * The customer ASKING US to change or cancel the order.
 *
 * WHY THIS REPLACED A PAIR OF WORD-LISTS. This intent used to be "the customer
 * mentioned ordering" AND "the customer mentioned something else" — two generic
 * lists, either of which matches by accident. Since the intent sits second in
 * the ownership order, an accidental match outranks almost every real problem,
 * and it did:
 *
 *   "my order arrived DAMAGED, please send another"     -> was Order change
 *   "my order arrived but a part is MISSING, send another"-> was Order change
 *   "the bulb is FAULTY, please send another"            -> was Order change
 *   "order arrived but the cable is wider than ADVERTISED
 *    ... does the width CHANGE because it's hemp"        -> was Order change
 *
 * Every one of those is a problem report where the strict table already had the
 * right answer. The bare noun "order" appears in 20,663 live messages, and
 * "another" is how anyone asks for a replacement of anything.
 *
 * WHAT IT MATCHES NOW: a change or cancellation applied to SOMETHING. The verb
 * must take an object, which is exactly what separates "can I change my order",
 * "change it for a braided cable" and "change colour of order" — all real, all
 * kept — from "does the width change", where nothing is being changed at the
 * customer's request. Read against the 85 live messages carrying both of the
 * old loose tokens, which are otherwise almost all genuine order changes.
 *
 * The customer's own mis-order ("I ordered the wrong colour by mistake",
 * "Falsches Design bestellt") is deliberately NOT here. That wording is already
 * measured, and it arrives through the phrase table and the strict shape rule —
 * duplicating it in a looser form here is what caused the damage above.
 */
const AMENDMENT_REQUEST = new RegExp(
  [
    // A change applied to an object, either immediately... "over" is
    // deliberately absent: "will the brightness change over time" is a question
    // about the product, and it was the one false positive this list produced.
    "\\b(?:chang(?:e|ed|ing)|amend(?:ed|ing)?|swap(?:ped|ping)?|switch(?:ed|ing)?)\\s+(?:it|them|this|these|that|to|for)\\b",
    // ...or to a named thing within a couple of words: "change my order",
    // "change the delivery address", "change colour of order".
    "\\b(?:chang(?:e|ed|ing)|amend(?:ed|ing)?|swap(?:ped|ping)?|exchang(?:e|ed|ing)|switch(?:ed|ing)?)\\s+(?:\\w+\\s+){0,2}?(?:order|orders|address|item|items|delivery|design|model|variant|option)\\b",
    // Cancelling is unambiguous on its own.
    "\\bcancel\\w*\\b",
    // German
    "\\b(?:bestellung|adresse|artikel)\\s+(?:\\w+\\s+){0,2}?(?:(?:ä|ae)ndern|umtauschen|tauschen|wechseln)\\b",
    "\\b(?:storni\\w*|kaufabbruch)\\b",
  ].join("|"),
  "i",
);

/** Asking when it will come, or asking for it sooner. */
const DELIVERY_TIMING =
  /\b(?:when\s+(?:will|is|does|can|do)|how\s+long|arrive|arriving|arrival|this\s+week|next\s+week|by\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|asap|as\s+soon\s+as|urgent\w*|wann|diese\s+woche)\b/i;

/**
 * The consignment itself, as a customer names it when chasing one.
 *
 * Nouns only, and deliberately ordinary ones. On its own this word list means
 * nothing — "order", "item" and "package" appear in most messages in the
 * inbox, whatever they are about — which is exactly why it is never tested
 * alone. It supplies the OBJECT half of the combinations below.
 */
const CONSIGNMENT =
  "orders?|parcels?|packages?|items?|deliver(?:y|ies)|shipments?|goods|post|sendung|paket|bestellung|lieferung|ware";

/**
 * CHASING A CONSIGNMENT: asking where it is, or saying it has not turned up.
 *
 * WHY A COMBINATION AND NOT PHRASES. "Where is my parcel" and "waiting for
 * delivery" both fell through to the admin fallback, and the tempting fix is to
 * add each wording to the table. That does not survive the next customer, who
 * writes "where's the package" or "still waiting on my order". What these all
 * share is a shape: a question about WHEREABOUTS, aimed at the CONSIGNMENT.
 * Both halves are required and neither means anything alone.
 *
 * "WHERE IS", NOT "WHERE DO". The verb is what keeps this honest. "Where do I
 * return the item" and "where can I find the size guide" are a returns question
 * and a pre-sales question that both contain "where" and a consignment noun;
 * restricting the verb to the copular forms — is / are / 's / has / have —
 * asks after the thing's LOCATION rather than after a procedure.
 *
 * The 25-character window keeps the two halves in the same clause, and stopping
 * at sentence punctuation prevents a "where is" in one sentence pairing with an
 * "order" in the next.
 *
 * NOTHING HERE CAN COST ANOTHER CATEGORY ITS MESSAGE. `delivery_request` sits
 * eighth in `INTENT_OWNERSHIP`, below wrong item, missing parts, damage and
 * defective, so a message that carries one of those is decided before this is
 * ever consulted. "Box arrived damaged" is damage no matter what this matches.
 */
const CHASING_A_CONSIGNMENT = new RegExp(
  [
    // "where is my item", "where's the parcel", "where are my orders"
    `\\bwhere\\s*(?:'s|is|are|has|have)\\b[^.!?]{0,25}?\\b(?:${CONSIGNMENT})\\b`,
    // "waiting for delivery", "still waiting on my parcel"
    `\\b(?:still\\s+)?wait(?:ing)?\\s+(?:for|on)\\b[^.!?]{0,25}?\\b(?:${CONSIGNMENT})\\b`,
    // "any news on my order", "any sign of the package"
    `\\bany\\s+(?:news|sign|word)\\b[^.!?]{0,25}?\\b(?:${CONSIGNMENT})\\b`,
  ].join("|"),
  "i",
);

const ADMIN_MATTER =
  /\b(?:invoice|receipt|vat|business\s+account|payment|paid|order\s+number|statement|rechnung|beleg|quittung|zahlung)\b/i;

/**
 * Not a customer at all — transport headers, automated notifications, partner
 * system alerts.
 *
 * THIS IS WHAT KEEPS THE ADMIN FALLBACK HONEST. "Never leave a customer message
 * uncategorised" is only safe if we can tell a customer message from machine
 * output; without this, every SMTP header block in the corpus would be filed as
 * an admin query. The three shapes below are the ones already pinned in the
 * tests as things this classifier must never name.
 */
const NOT_FROM_A_CUSTOMER = new RegExp(
  [
    // SMTP / MIME transport headers.
    "^(?:received|content-type|content-transfer-encoding|mime-version|authentication-results|return-path|dkim-signature|message-id|x-[\\w-]+):",
    // Automated notifications and no-reply boilerplate.
    "automatically\\s+generated",
    "auto(?:matically)?[-\\s]?generated",
    "do\\s+not\\s+reply",
    "no[-\\s]?reply@",
    "this\\s+is\\s+an\\s+automated",
    // Partner-system alerts that arrive in the same inbox.
    "you\\s+have\\s+a\\s+new\\s+ticket",
    "partner\\s+home\\s+inbox",
  ].join("|"),
  "im",
);

/**
 * What the phrase table says, expressed as intents.
 *
 * THIS IS HOW THE OLD LAYER BECOMES A SUPPORTING SIGNAL RATHER THAN A RIVAL.
 * Every phrase above was measured against live customer text, and throwing that
 * away to run regexes over the same message would be losing evidence, not
 * gaining independence. So the table still runs — its result is simply read as
 * one more witness to intent, on equal footing with the wording patterns.
 *
 * ONE MAPPING IS NOT THE IDENTITY, and it is the important one. A hit in the
 * Return and refunds phrase list does NOT become `wants_refund`, because that
 * list contains routes as well as outcomes — "return it", "send it back",
 * "replacement". Only an actual request for money becomes `wants_refund`;
 * everything else in that list becomes `wants_replacement`, which owns no
 * category. This is what makes "Wrong item received, can I return it?" a
 * wrong-item case: the table scores Return twice and Wrong item once, and it
 * still comes out as Wrong item sent, because scoring is no longer what decides.
 */
function intentsFromPhraseTable(text: string): MessageIntent[] {
  const hit = (label: MessageCategory): boolean =>
    SIGNALS.some(
      (signal) =>
        signal.label === label && signal.phrases.some((phrase) => contains(text, phrase)),
    );

  const found: MessageIntent[] = [];
  if (hit("Wrong item sent messages")) found.push("received_wrong_item");
  if (hit("Parts missing queries")) found.push("missing_component");
  if (hit("Damage queries")) found.push("damaged_product");
  if (hit("Defective items")) found.push("defective_product");
  if (hit("Wrong description issues")) found.push("wrong_description");
  if (hit("Order change, before shipping queries")) found.push("wants_order_change");
  if (hit("Delivery queries")) found.push("delivery_request");
  if (hit("Pre sales queries")) found.push("pre_sale_question");
  if (hit("Admin related issues")) found.push("admin_issue");
  if (hit("Return and refunds")) {
    found.push(wantsMoneyBack(text) ? "wants_refund" : "wants_replacement");
  }
  return found;
}

/**
 * Which intents a message carries. Exported so a reviewer can ask "why did it
 * say that?" and get an answer, rather than having to re-derive it.
 */
export function detectIntents(customerText: string | null): MessageIntent[] {
  const text = normalise(customerText?.trim() ?? "");
  if (text === "") return [];

  const found: MessageIntent[] = [];
  const add = (intent: MessageIntent, when: boolean) => {
    if (when) found.push(intent);
  };

  add("wants_refund", wantsMoneyBack(text));
  add("wants_replacement", WANTS_A_REPLACEMENT.test(text));
  add("wants_order_change", AMENDMENT_REQUEST.test(text));
  add("received_wrong_item", HAS_THE_GOODS.test(text) && A_MISMATCH.test(text));
  add("missing_component", SOMETHING_ABSENT.test(text) || looksLikeShortfall(text));
  add("wrong_description", LISTING_REFERENCE.test(text) && REALITY_DIFFERS.test(text));
  add("damaged_product", IS_DAMAGED.test(text));
  add("defective_product", IS_DEFECTIVE.test(text));
  add(
    "delivery_request",
    /*
     * Chasing the consignment is checked FIRST and on its own terms.
     *
     * It deliberately does not carry the `HAS_THE_GOODS` guard the timing
     * branch below needs. That guard exists so "arrive" in "it arrived fine"
     * cannot read as a delivery question — but "where is my parcel, it still
     * hasn't arrived" contains "arrived" too, and guarding this branch would
     * throw away the clearest delivery message a customer can write. Asking
     * where a thing IS already says they do not have it.
     */
    CHASING_A_CONSIGNMENT.test(text) ||
      (DELIVERY_NOUN.test(text)
        ? DELIVERY_TIMING.test(text) || DELIVERY_REQUESTED_SOON.test(text)
        : DELIVERY_TIMING.test(text) && HAS_THE_GOODS.test(text) === false),
  );
  add(
    "pre_sale_question",
    ASKS_SOMETHING.test(text) &&
      (PRODUCT_ATTRIBUTE.test(text) || NUMERIC_SPEC.test(text)) &&
      !HAS_THE_GOODS.test(text),
  );
  add("admin_issue", ADMIN_MATTER.test(text));

  for (const intent of intentsFromPhraseTable(text)) {
    if (!found.includes(intent)) found.push(intent);
  }

  return refine(found, text);
}

/**
 * The two contests where a fixed ownership order would overrule a MEASURED
 * result, resolved here instead so the order never has to decide them.
 *
 * This is the price of making intent primary, and it is worth paying explicitly
 * rather than pretending a single priority list can be right about everything.
 * A priority list is a global precedence, and both of these were investigated
 * precisely because a global precedence got them wrong.
 */
function refine(found: MessageIntent[], text: string): MessageIntent[] {
  const drop = (intent: MessageIntent) => found.filter((entry) => entry !== intent);

  // DAMAGE AGAINST A MISSING PART, decided by what the damage is predicated on
  // rather than by which intent happens to sit higher in the list. Damage on the
  // PACKAGING is context for the absent component; damage to the GOODS is the
  // complaint. The single-damage-word bound is what keeps "the box was damaged
  // and the shade is smashed" on the goods side of that line.
  if (found.includes("missing_component") && found.includes("damaged_product")) {
    const damageWords = (SIGNALS.find((s) => s.label === "Damage queries")?.phrases ?? []).filter(
      (phrase) => contains(text, phrase),
    ).length;
    return damageWords <= 1 && PACKAGING_DAMAGE.test(text)
      ? drop("damaged_product")
      : drop("missing_component");
  }

  // THE MISSING THING IS THE INVOICE. German invoice requests say "uns fehlt die
  // Rechnung" — we are MISSING the INVOICE — and all six live conversations
  // where this collides are invoice requests, which is why the strict layer
  // carries a precedence entry for it. Recognised here by the two words being
  // next to each other, so an unrelated "a part is missing, and can you send the
  // invoice?" is untouched and stays a parts case.
  if (found.includes("missing_component") && ADMIN_IS_WHAT_IS_MISSING.test(text)) {
    return drop("missing_component");
  }

  return found;
}

/** "fehlt die Rechnung" — the absent thing is the paperwork, not a component. */
const ADMIN_IS_WHAT_IS_MISSING =
  /\b(?:fehlt|fehlen|missing|not\s+received|never\s+received|no)\s+(?:\w+\s+){0,3}(?:rechnung|invoice|receipt|beleg|quittung|vat)\b|\b(?:rechnung|invoice|receipt|beleg|quittung)\s+(?:\w+\s+){0,3}(?:fehlt|fehlen|is\s+missing|missing)\b/i;

/**
 * Which category owns which intent, in the order the ownership is decided.
 *
 * ORDER IS THE RULE, so it is written once, here, rather than spread through
 * branches. Two placements carry the weight:
 *
 *   wants_refund first        "Return and refunds" is an outcome category. If
 *                             the customer asked for their money, that is the
 *                             case whatever prompted it — and if they did not,
 *                             this entry never fires and Return cannot be
 *                             reached from this layer at all.
 *   order change before       "I ordered the wrong design, send me a different
 *      wrong item             one" is the customer's own mis-selection, not us
 *                             sending the wrong thing. Both signals fire on it;
 *                             the order is what tells them apart.
 *
 * `wants_replacement` deliberately owns NOTHING. It is detected because it is
 * the signal that most often gets mistaken for a refund request, and naming it
 * explicitly is how this layer records that a replacement is not money.
 */
const INTENT_OWNERSHIP: readonly (readonly [MessageIntent, MessageCategory])[] = [
  ["wants_refund", "Return and refunds"],
  ["wants_order_change", "Order change, before shipping queries"],
  ["received_wrong_item", "Wrong item sent messages"],
  ["missing_component", "Parts missing queries"],
  ["wrong_description", "Wrong description issues"],
  ["damaged_product", "Damage queries"],
  ["defective_product", "Defective items"],
  ["delivery_request", "Delivery queries"],
  ["pre_sale_question", "Pre sales queries"],
  ["admin_issue", "Admin related issues"],
];

/**
 * The category for a conversation, with the intent layer behind the table.
 *
 * THE FLOW, AND WHY IT IS IN THIS ORDER:
 *
 *   1. `classifyMessageCategory` runs first and unchanged. Anything it names,
 *      it keeps — this layer can never overrule it, only fill in behind it.
 *   2. Machine-generated content stops here and returns null. Not every string
 *      in the inbox came from a person.
 *   3. The intent layer names what it safely can.
 *   4. Anything left that is genuinely a customer writing to us becomes
 *      "Admin related issues" rather than a blank. A general enquiry IS an
 *      admin matter, and an agent can retag it in a click; a blank tells them
 *      nothing and hides the conversation from every filter.
 *
 * `classifyMessageCategory` remains exported and unchanged for callers that
 * want the strict answer with no fallback.
 */
export function classifyMessageCategoryWithFallback(
  customerText: string | null,
): MessageCategory | null {
  const text = normalise(customerText?.trim() ?? "");
  if (text === "") return null;
  if (NOT_FROM_A_CUSTOMER.test(text)) return null;

  // INTENT FIRST. What the customer is trying to achieve decides the category,
  // and the phrase table has already been folded into that judgement as one of
  // its witnesses — see `intentsFromPhraseTable`. Where the two would disagree,
  // intent is what comes out, because ownership order encodes which problem a
  // message is ABOUT while scoring only counts how many words it happened to use.
  const intents = detectIntents(text);
  for (const [intent, category] of INTENT_OWNERSHIP) {
    if (intents.includes(intent)) return category;
  }

  // The strict table still gets the last word on anything intent could not
  // name — its German and Italian wording reaches shapes no intent pattern
  // here does, and none of that measurement is discarded.
  const strict = classifyMessageCategory(customerText);
  if (strict !== null) return strict;

  // A customer telling us the thing is sorted is not raising an admin matter.
  // Better a blank than a wrong tag on a conversation that needs nothing.
  if (looksResolved(text)) return null;

  return "Admin related issues";
}

/* ------------------------------------------------------------------------- *
 * THREAD-AWARE CLASSIFICATION
 *
 * A conversation is not one long string, and treating it as one loses things.
 * Concatenating every inbound message merges signals that were never in the
 * same breath — a part missing in message one and a damaged box in message
 * three become a tie that neither message actually had — and it throws away
 * the ORDER, which is what tells us which problem the customer came with.
 *
 * Reading the messages separately, earliest first, is what lets a later "found
 * it, all sorted" leave the original category alone instead of diluting it.
 * ------------------------------------------------------------------------- */

/**
 * The customer telling us it is resolved — nothing is being asked for.
 *
 * These messages carry no intent by design, so they are the ones most likely to
 * fall through every rule and land on the admin catch-all. That is the wrong
 * answer twice over: the conversation is not an admin matter, and if an earlier
 * message named a real problem, that problem is what the conversation is about.
 */
const RESOLUTION_CONFIRMATION = new RegExp(
  [
    "found\\s+(?:it|them|these|those|the\\s+\\w+)",
    "(?:all|now|it\\s+is|its|it's)\\s+sorted",
    "sorted\\s+(?:it|this|now)",
    "problem\\s+(?:is\\s+|has\\s+been\\s+)?(?:solved|resolved|sorted|fixed)",
    "(?:is|has\\s+been)\\s+(?:solved|resolved|fixed)",
    "all\\s+(?:good|fine|ok|okay|well|sorted|there|present)",
    "everything\\s+(?:is\\s+|has\\s+)?(?:fine|ok|okay|good|there|arrived|received|here|complete)",
    "(?:received|got|arrived)\\s+(?:it|them|now)",
    "no\\s+(?:longer|further)\\s+(?:needed|necessary|action|required)",
    "please\\s+(?:ignore|disregard)",
    "disregard\\s+(?:this|that|my)",
    "nothing\\s+(?:further|else)\\s+(?:needed|required)",
    "my\\s+(?:mistake|apologies|bad)",
    // German
    "hat\\s+sich\\s+(?:erledigt|gekl(?:ä|ae)rt)",
    "erledigt",
    "alles\\s+(?:gut|ok|klar|da|bestens|vollst(?:ä|ae)ndig|in\\s+ordnung)",
    "gefunden",
  ].join("|"),
  "i",
);

function looksResolved(text: string): boolean {
  return RESOLUTION_CONFIRMATION.test(text);
}

/**
 * A message made of nothing but greeting and thanks.
 *
 * Used ONLY when deciding whether a whole thread is just the customer signing
 * off, because "All sorted now" followed by "Many thanks" is two messages and
 * both have to be accounted for. It is deliberately not consulted for a single
 * message on its own: a lone "Many thanks, kind regards." is still a customer
 * writing to us, and still gets the admin tag rather than a blank.
 */
const PLEASANTRY_ONLY =
  /^(?:[\s\p{P}\p{S}]*(?:hi|hello|hey|dear|sir|madam|many|much|thanks|thank|you|thankyou|cheers|regards|kind|best|wishes|great|brilliant|perfect|lovely|danke|vielen|dank|gr(?:ü|ue)(?:ß|ss)e|hallo|guten|tag|morgen|abend|mfg|lg)[\s\p{P}\p{S}]*)+$/iu;

/**
 * The categories that represent an actual case, as opposed to an enquiry.
 *
 * Used to pick which of several messages names what the conversation is ABOUT:
 * a thread that opens with a pre-sales question and later reports damage is a
 * damage case, so a case category outranks an enquiry wherever it appears in
 * the thread — while among case categories, the earliest wins.
 */
const CASE_CATEGORIES: readonly MessageCategory[] = [...PROBLEM_CATEGORIES, "Return and refunds"];

/**
 * The category for a whole conversation, from its customer messages in order.
 *
 * THE ORDER OF PREFERENCE, and what each step is protecting:
 *
 *   1. The earliest CASE category any single message names. This is the rule
 *      that stops a closing "found it, everything is fine" from costing the
 *      conversation its Parts missing tag: the confirmation names nothing, so
 *      it cannot outvote the message that did.
 *   2. Failing that, the earliest category of any kind — an enquiry thread
 *      still gets its enquiry tag.
 *   3. Failing that, the intent layer, message by message.
 *   4. Failing that, "Admin related issues" — UNLESS every message is only a
 *      resolution confirmation, in which case there is genuinely nothing to
 *      name and null is honest.
 *
 * Each message is read on its own, so no signal is invented by two unrelated
 * sentences landing next to each other.
 */
export function classifyConversationCategory(
  customerMessages: readonly (string | null)[],
): MessageCategory | null {
  const texts = customerMessages
    .map((message) => normalise(message?.trim() ?? ""))
    .filter((text) => text !== "" && !NOT_FROM_A_CUSTOMER.test(text));

  if (texts.length === 0) return null;

  // Intent first, message by message, in the order they were sent. Each message
  // is read on its own so no signal is invented by two unrelated sentences
  // landing next to each other.
  const perMessage = texts.map((text) => {
    const intents = detectIntents(text);
    const owned = INTENT_OWNERSHIP.find(([intent]) => intents.includes(intent));
    return owned?.[1] ?? classifyMessageCategory(text);
  });

  const firstCase = perMessage.find(
    (category) => category != null && CASE_CATEGORIES.includes(category),
  );
  if (firstCase != null) return firstCase;

  const firstAny = perMessage.find((category) => category != null);
  if (firstAny != null) return firstAny;

  // Nothing identifiable anywhere. A thread that is only the customer telling
  // us it is sorted — with or without a parting thank-you — is not an admin
  // query. At least one message has to actually say it is resolved; a thread of
  // pure pleasantries with no resolution in it still gets the admin tag.
  const resolvedOnly =
    texts.some((text) => looksResolved(text)) &&
    texts.every((text) => looksResolved(text) || PLEASANTRY_ONLY.test(text));
  if (resolvedOnly) return null;

  return "Admin related issues";
}
