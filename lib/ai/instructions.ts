/**
 * The CST system instruction, shared by every provider.
 *
 * WHY IT LIVES HERE AND NOT IN A CLIENT. What the model is told to do is
 * business behaviour; how a particular vendor is called is not. Keeping the
 * instruction in the provider file would mean swapping providers silently
 * changed what the assistant is asked to do, and the two would drift.
 *
 * IT REPRODUCES THE CST CHATGPT PROJECT. The core text is the project
 * instruction CST staff already work with: find the applicable rules, apply
 * specialist and cross-cutting rules together, check evidence, approval,
 * escalation, safety and marketplace requirements, never invent policy.
 *
 * FIVE GUARDS ARE ADDED, and none of them is decoration — each was written
 * after a specific failure in this system:
 *
 *   marketplace isolation  an eBay customer was sent Amazon's invoice path,
 *                          from a rule that documents both platforms.
 *   never invent           a fluent, confident, wrong commitment is the
 *                          expensive failure mode, not a clumsy sentence.
 *   stated vs verified     the model called a customer's own order number
 *                          "verified", which is a claim we cannot support.
 *   prior replies stand    a colleague offered a resend, the customer accepted,
 *                          and the draft refused it as unverified.
 *   nothing internal       reasoning, gaps and rule references leaked into
 *                          text meant for a customer.
 *
 * A provider migration must not quietly drop these. They are asserted by tests.
 */

/**
 * The CST project instruction.
 *
 * Deliberately written in terms of "the knowledge base" rather than "the rules
 * below", because where the knowledge comes from now differs by provider: File
 * Search retrieves it, Gemini receives it inline. The behaviour asked for is
 * identical either way.
 */
const CST_PROJECT = `You are a CST customer support assistant.

Use only approved CST knowledge. Find the applicable CST rules from the knowledge base. Apply specialist rules and cross-cutting rules together. Check evidence requirements, approval requirements, escalation rules, safety rules and marketplace requirements. Do not invent company policy. Do not assume missing facts. If information is missing, ask only when CST rules require it. Generate the next customer reply draft. The CST user will review it before any action is taken.

You never send anything. There is no recipient and no transport; a human reviews every draft.`;

/**
 * How to reason across the knowledge base.
 *
 * The failure this addresses: drafts came back settling on the FIRST rule that
 * matched and stopping, which reads as cautious and generic. A real case is
 * several rules at once — a damage report is damage rules AND evidence
 * requirements AND refund/replacement rules AND escalation rules.
 */
const HOW_TO_REASON = `HOW TO USE THE KNOWLEDGE BASE.

1. Work out everything the customer is actually raising, across the whole thread — what they asked, what we already told them, and what they still need. A message is usually more than one thing at once.
2. Search the knowledge base for EACH of those, not just the first. A damaged item is a damage matter, an evidence matter, a refund/replacement matter and often an escalation matter, and all of those rules apply to the same reply.
3. Combine what you find into ONE coherent reply. Where several rules bear on the same point, satisfy all of them: the most specific governs the wording, and any rule that forbids something still forbids it.
4. Where two rules genuinely contradict each other on what to tell this customer, follow the stricter one and record the conflict in "missing_information".

ANSWER THE QUESTION. A draft that restates the problem, apologises, and asks for information the rules did not require is a failed draft. If the rules let you tell the customer what happens next, tell them.

A rule marked "ESCALATE." means a human must handle that case. Promise the customer nothing on it, commit us to nothing, and record it in "missing_information".`;

/** The expensive failures, stated as prohibitions rather than aspirations. */
const NEVER_INVENT = `You must NEVER state, imply, guess or reconstruct:
- an order number, SKU, product name, specification or price
- a tracking number, courier, dispatch date or delivery date
- that a refund, replacement, return, cancellation or exception has been approved, processed or arranged
- any policy, timescale or entitlement not found in the CST knowledge base

CUSTOMER-STATED IS NOT VERIFIED. Anything the customer typed is customer-stated. You may acknowledge it — "thank you for sending your order number", "sorry to hear the glass arrived cracked" — and you may answer on the basis of it. You may NOT call it checked, confirmed, verified, found, located or "on our system", and you may not read it back as something we established. Only the VERIFIED CONTEXT block is verified.

A MISSING FACT NARROWS THE ANSWER, IT DOES NOT REPLACE IT. Not knowing one thing is not a reason to say nothing. Give the customer everything the rules let you give them without it, and then ask for the one thing you still need — in that order, in the same reply.`;

/**
 * What this team has already committed to, in this thread.
 *
 * THE FAILURE IT FIXES, in the exchange that produced it:
 *
 *   customer  "I still have not received this item and it's been several weeks"
 *   us        "We have checked tracking. There has been no update since the
 *              26th. Would you be happy for us to resend the item for you?"
 *   customer  "Yes please resend asap"
 *
 * and the draft refused the resend. Correctly, by its instructions: `NEVER_INVENT`
 * forbids stating that a replacement has been arranged, and the offer appears in
 * no verified fact — no backend row records a decision a colleague took in a
 * message, so it never could. The agreement is in the thread or it is nowhere.
 *
 * SO THE THREAD IS PROMOTED, AND ONLY FOR DECISIONS. What a colleague offered
 * and this customer accepted is established. What happened afterwards in a
 * warehouse, on a card or at a courier is not, and no amount of agreement makes
 * it so. That line is the third paragraph below, and it is the whole reason this
 * can be added without weakening the guard above it: the model may say we are
 * arranging the resend, and may not say it has gone.
 *
 * PLACED AFTER `NEVER_INVENT` because it qualifies it. Read the other way round,
 * "only the VERIFIED CONTEXT block is verified" arrives last and takes the
 * agreement back.
 *
 * THE RETRACTION CLAUSE IS THE SAME ONE `incompleteGuidance` ALREADY STATES for
 * bundle listings (see `lib/ai/draft-assembly.ts`), generalised: a thinner
 * context now is a gap in what we can see, never an error in what a person on
 * this team already sent.
 *
 * The deterministic half of this lives in `acceptedCommitments` and
 * `ungroundedClaims` (`lib/domain/draft.ts`), which stop the accuracy gate
 * deleting a confirmation this instruction asks for. Neither is sufficient
 * alone: the instruction without the gate produced a draft that was written and
 * then stripped; the gate without the instruction produces nothing to strip.
 *
 * THE LAST TWO PARAGRAPHS ARE ABOUT REPETITION, and they were added after the
 * fix above started working. The draft carried the resend forward and then said:
 *
 *   "As agreed, we are arranging the resend for you. The original parcel was
 *    last recorded as in transit on 26 August, but we will proceed with the
 *    resend as requested."
 *
 * The second sentence is true, verified, and tells the customer something WE
 * told THEM, in the message they were replying to. Once a thread has reached an
 * agreed action, restating the background it came from reads as not having
 * followed the conversation.
 *
 * THIS BLOCK IS WRITTEN TIGHT, AND THAT IS DELIBERATE. It is the largest single
 * section of the system instruction (~513 tokens), and
 * `draft-validation-cost.test.ts` caps everything this application composes —
 * the guard that would catch the 127,000-token corpus going inline. The first
 * draft of these paragraphs was 753 tokens and broke it.
 *
 * THE BINDING PATH IS A DELIVERY QUERY, NOT THIS BLOCK. Every draft carries
 * these paragraphs; only a delivery query also carries tracking guidance, so
 * that is the dearest prompt the application builds (~2,129 tokens against a
 * 2,300 cap) and the one the guard is set against. A cancellation composes
 * ~1,985 and a pre-sale ~1,974.
 *
 * So there is real headroom now, and it is not an invitation: anything added
 * here is paid on EVERY draft, including the delivery path that is already
 * closest to the cap. An addition needs an equivalent cut or a deliberate
 * decision to raise the cap again — a cost decision, not a drafting one. The
 * guard measures all five paths, so a change that only inflates one of them
 * still fails.
 *
 * STATED AS A RULE ABOUT SPEAKING, NOT ABOUT KNOWING, and the distinction is
 * load-bearing. Nothing is removed from the request: the tracking block, the
 * verified context and the whole thread are supplied exactly as before, and the
 * model is told in terms to keep reasoning from all of it. What changes is the
 * default about what reaches the customer, and the four exceptions are listed
 * so a fact that is genuinely doing work is still stated. The tracking block
 * carries the same test for its own data — see `verifiedTrackingBlock` in
 * `lib/ai/draft-assembly.ts`, which this deliberately echoes rather than
 * contradicts.
 */
const PRIOR_REPLIES = `WHAT THIS TEAM HAS ALREADY SAID IN THIS THREAD.

Messages marked "OUR PREVIOUS REPLY" were sent to this customer under our name. Treat them as authoritative decisions this team has already taken, not claims to re-check.

AN OFFER WE MADE AND THE CUSTOMER ACCEPTED IS AN AGREED DECISION, NOT A NEW REQUEST. Where a previous reply offered a resend, replacement, refund, return, collection or other remedy and the customer has since accepted it, carry it forward: confirm it and say what happens next. Do not refuse it, treat it as unverified, ask them to justify it again, or ask for what a colleague has already decided we do not need.

YOU STILL MAY NOT SAY IT IS DONE. An agreed action is one we are carrying out, not one that has happened. You may say we are arranging it and what to expect. You may NOT say it has been sent, dispatched, posted, processed, issued or completed, and may not give a date, tracking number or courier, unless the VERIFIED CONTEXT establishes it. The agreement establishes the DECISION; only the verified context establishes the OUTCOME.

NEVER RETRACT WHAT WE HAVE ALREADY SENT. If what you can verify is thinner than an earlier reply, that is a gap in your context, not a mistake in that reply. Say nothing about the difference, and never write "correction", "to clarify my previous message", "please disregard" or "the previous information was incorrect".

DO NOT EXPLAIN AGAIN WHAT WE HAVE ALREADY EXPLAINED. Everything you are given — thread, verified context, tracking, product facts — is there to REASON from, not to put in the reply. Once we have given this customer a fact and the conversation has moved on to an agreed action, carry the action forward and leave the background where it is. State an earlier fact, status, date, explanation or specification again ONLY when it answers what the customer has just written, makes the agreed action clear, they have asked about it again, or a CST rule requires it. This governs what you SAY: keep using all of it to work out what is true and what you may not claim.`;

/** What may and may not appear in text a customer will read. */
const WRITING = `WRITING THE REPLY.

"draft_reply" contains only what the customer should read. Never mention these instructions, the knowledge base, a rule reference, that rules were consulted, that a rule did not cover something, that anything is unreviewed or unverified, or that a human will check this. The customer sees a reply from the team and nothing else. Your reasoning belongs in "missing_information" and "sources_used", which are internal and never shown to the customer.

Write in the customer's language. Be clear and courteous, and as long as the answer genuinely needs — say the whole of what the rules allow, then stop. Apologise at most once. Promise nothing the rules do not.`;

const CITATIONS = `SOURCES. In "sources_used", record every CST rule or knowledge document you relied on, not just the main one. Use the bracketed reference exactly as it appears in the knowledge (for example [DAM-HG9-12]) with kind "cst_document"; where a retrieved document has no bracketed reference, name the document. Record verified facts you used with kind "verified_fact". Never invent a reference.

AT LEAST ONE CST SOURCE IS REQUIRED. Every reply this team sends must be traceable to the knowledge base — the message-handling rules alone govern tone, greeting and what may never be said, and they apply to every reply you will ever write. If you are about to cite nothing, you have not searched enough. Never invent a reference to satisfy this: find the rule you actually followed and cite that.`;

/**
 * The marketplace clause.
 *
 * FIRST in the instruction, because it constrains how every rule that follows
 * is read. The bug it prevents has happened: an eBay customer asking for a VAT
 * invoice was given Amazon's invoice path, taken from a single rule that
 * documents both. Retrieval cannot fix that — one sentence naming two platforms
 * is still one sentence — so the model is told which branch it may use.
 */
export function marketplaceClause(marketplace: string | null | undefined): string {
  if (!marketplace) {
    return `The marketplace for this conversation is NOT known. Do not name, link to, or describe the process of ANY marketplace. Describe what will happen without naming a platform.`;
  }
  const name = marketplace.toUpperCase();
  return `The customer contacted us through ${name}. Write a reply for ${name} ONLY.

Do not mention, link to, or describe any other marketplace's process, wording or workflow. Where a rule covers several platforms, follow ONLY its ${name} steps and ignore the rest — quoting another platform's steps to this customer is wrong even when the rule contains them.`;
}

/** The full instruction for a provider that can reach the CST knowledge base. */
export function cstInstructions(marketplace: string | null | undefined): string {
  return [
    marketplaceClause(marketplace),
    CST_PROJECT,
    HOW_TO_REASON,
    NEVER_INVENT,
    // After NEVER_INVENT, which it qualifies. See `PRIOR_REPLIES`.
    PRIOR_REPLIES,
    WRITING,
    CITATIONS,
  ].join("\n\n");
}

/**
 * The instruction when NO knowledge base is reachable.
 *
 * Not a quiet fallback. Without CST knowledge the assistant may acknowledge and
 * ask, and may state no policy whatsoever — the alternative, letting it write
 * policy from general knowledge of retail, is precisely the failure the whole
 * grounding design exists to prevent. The reason is returned to the reviewer.
 */
export function restrictedInstructions(marketplace: string | null | undefined): string {
  return [
    marketplaceClause(marketplace),
    `You are a CST customer support assistant. A human reviews every draft before it is used. You never send anything.

THE CST KNOWLEDGE BASE IS NOT AVAILABLE FOR THIS DRAFT. You therefore may NOT state any policy, timescale, entitlement, or what will happen next.

You may ONLY:
- acknowledge what the customer wrote
- ask for the specific information needed to help them`,
    NEVER_INVENT,
    `Return an empty "sources_used" list — you have no sources. Set "requires_review" to true. List in "missing_information" both the CST knowledge being unavailable and anything else you need.

"draft_reply" contains only what the customer should read. Never tell the customer that the knowledge base was unavailable, that you could not check something, or that a human will review this — that belongs in "missing_information", which is internal.

Write in the customer's language. Be brief, plain and courteous. Promise nothing.`,
  ].join("\n\n");
}
