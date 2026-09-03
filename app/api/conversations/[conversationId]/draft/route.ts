import { NextResponse } from "next/server";

import { getDraftProvider } from "@/lib/ai/draft-service";
import {
  DraftGenerationUnavailable,
  DraftServiceNotConfigured,
  DraftServiceUnavailable,
} from "@/lib/ai/provider";
import { resolveEbayOrderContext } from "@/lib/context/resolve-order-context";
import { resolveEbayReturnContext } from "@/lib/context/resolve-return-context";
import { resolveSelectedOrderContext } from "@/lib/context/resolve-selected-order-context";
import { resolveBundleProductContext } from "@/lib/context/resolve-bundle-product-context";
import { resolveListingContext } from "@/lib/context/resolve-listing-context";
import {
  resolveSotProductContext,
  resolveSotProductContextForSku,
} from "@/lib/context/resolve-sot-product-context";
import { resolveVerifiedTracking } from "@/lib/context/resolve-tracking-context";
import { getAppPool, getSourcePool } from "@/lib/db/pools";
import type { BundleContext } from "@/lib/domain/bundle-context";
import type { VerifiedFact } from "@/lib/domain/draft";
import type { ConversationDetail } from "@/lib/domain/inbox";
import { loadRulesForConversation } from "@/lib/knowledge/cst-rules-files";
import { NO_APPLICABLE_RULE_CODE, coverageFor } from "@/lib/knowledge/rule-coverage";
import { classifyCaseType } from "@/lib/knowledge/case-type";
import { getDraft, isDraftStoreMissing } from "@/lib/repositories/draft-repository";
import { getConversation, parseConversationId } from "@/lib/repositories/conversation-repository";
import { recordUsage } from "@/lib/sync/ai-usage-writer";
import type { Writable as UsageWritable } from "@/lib/sync/ai-usage-writer";
import {
  clearRuleAnalysis,
  readRuleAnalysis,
  recordNoApplicableRule,
} from "@/lib/sync/rule-analysis-writer";
import type { Writable as AnalysisWritable } from "@/lib/sync/rule-analysis-writer";
import { advanceWorkflowState, saveRevision } from "@/lib/sync/draft-writer";
import type { Writable } from "@/lib/sync/draft-writer";

/**
 * Draft for one conversation.
 *
 *   GET    the current draft and its revision history
 *   POST   generate a new revision from the conversation
 *   PATCH  save a human edit as a new revision
 *
 * These are the only mutating handlers in the application, and they mutate
 * exactly one thing: a draft awaiting human review. There is deliberately no
 * DELETE (history is append-only) and no send route of any kind — this phase has
 * no capability to transmit a reply to a customer, and the workflow terminates
 * at `reviewed`.
 *
 * Underlying errors may name schemas, models or customer text, so they are
 * logged server-side and never returned to the browser.
 */
export const dynamic = "force-dynamic";

/**
 * Verified backend facts for grounding.
 *
 * eBay conversations are resolved against `order_management` via
 * `resolveEbayOrderContext` — item_id + buyer, matched to at most one order,
 * never guessed. Every other marketplace still gets an empty list; that is a
 * deliberate empty list, not a placeholder to fill with guesses — the generator
 * is told there is no resolved context and flags the draft accordingly.
 *
 * `resolveEbayReturnContext` adds return_status/return_reason/
 * return_evidence_available — TEXT ONLY, never the photo itself — and only
 * once the order call above has already produced a verified single order.
 * Called second, deliberately: it reads the very snapshot the order call
 * either just wrote or already found, so it never resolves a return against
 * an order this request has not itself already verified.
 *
 * `resolveSotProductContext` adds catalogue attributes — dimensions, fitting,
 * materials, never stock or price — and ONLY for a conversation that resolved no
 * order, which in practice means a pre-sale enquiry. See the call site for why
 * the two must not both contribute.
 *
 * Resolution failure (a source-DB hiccup, an unexpected row shape) must not
 * fail the draft over a context lookup — logged and treated as no context,
 * the same "never fails the caller" discipline as the rule-analysis and
 * usage writers this route already calls. Each call is guarded separately so
 * a return-lookup failure cannot discard order facts that already resolved.
 */
async function verifiedFactsFor(
  conversation: ConversationDetail["conversation"],
  selectedOrderNumber: string | null,
): Promise<{ facts: VerifiedFact[]; bundle: BundleContext | null }> {
  const sourcePool = getSourcePool();
  const appPool = getAppPool();

  let orderFacts: VerifiedFact[] = [];
  try {
    orderFacts = await resolveEbayOrderContext(sourcePool, appPool, conversation);
  } catch (cause) {
    console.error("[draft] order context resolution failed", cause);
  }

  /**
   * The reviewer's choice, and only where the resolver itself found nothing.
   *
   * ORDER OF PRECEDENCE, NOT A MERGE. The resolver speaks first. When it
   * produced facts the conversation resolved to a single order on its own
   * evidence, and a selection cannot override, replace or extend that — the
   * check below is `orderFacts.length === 0`, so the deterministic answer wins
   * whenever there is one and these two sources can never both contribute to
   * the same draft.
   *
   * This is what a reviewer picking one of several matching orders in the
   * sidebar does: it grounds THIS generation in that order's own eight facts,
   * the same eight the resolver would have produced had the match been
   * unambiguous. Not stored, not confirmed, not a resolution — the next
   * generation asks again.
   *
   * `resolveSelectedOrderContext` re-checks the number against the orders this
   * conversation actually matched, so a request naming any other order gets
   * nothing back.
   */
  if (orderFacts.length === 0 && selectedOrderNumber !== null) {
    try {
      orderFacts = await resolveSelectedOrderContext(sourcePool, conversation, selectedOrderNumber);
    } catch (cause) {
      console.error("[draft] selected order context resolution failed", cause);
    }
  }

  let returnFacts: VerifiedFact[] = [];
  try {
    returnFacts = await resolveEbayReturnContext(sourcePool, appPool, conversation);
  } catch (cause) {
    console.error("[draft] return context resolution failed", cause);
  }

  /**
   * The SOT catalogue — for EVERY conversation, resolved by whichever SKU is
   * actually known.
   *
   * THIS USED TO BE GATED ON `orderFacts.length === 0`, and the reason was
   * sound: the listing-based lookup answers from the PARENT row, which on a
   * multi-variation listing is one specific variant and not necessarily the
   * customer's, so running it beside a resolved order would have put two `sku`
   * facts and two product descriptions in front of the model with no way to tell
   * which described the item in the customer's hands.
   *
   * THE GATE SOLVED THAT BY WITHHOLDING THE CATALOGUE FROM EVERY POST-SALE
   * REPLY, which is 735 of the 1,334 live eBay conversations — every wrong
   * description, every missing part, every damage and return case. A draft
   * answering "what's missing from my box?" held the order and no parts list.
   *
   * RESOLVING BY THE ORDER'S OWN SKU REMOVES THE AMBIGUITY INSTEAD OF AVOIDING
   * IT. Where an order resolved it named the exact SKU purchased, so there is
   * nothing to guess: those are that product's attributes, and no second `sku`
   * fact is produced because the order already stated it. Where no order
   * resolved, the listing-based lookup runs exactly as it did before, so every
   * pre-sale conversation is byte-identical to what it was.
   *
   * Guarded separately, like the two above, so a SOT lookup failure cannot
   * discard order or return facts that already resolved.
   */
  const purchasedSku = orderFacts.find((fact) => fact.name === "sku")?.value ?? null;

  let productFacts: VerifiedFact[] = [];
  try {
    productFacts =
      purchasedSku === null
        ? await resolveSotProductContext(sourcePool, conversation)
        : await resolveSotProductContextForSku(sourcePool, purchasedSku);
  } catch (cause) {
    console.error("[draft] SOT product context resolution failed", cause);
  }

  /**
   * THE BUNDLE FALLBACK, and only where the direct lookup found nothing.
   *
   * A listing sold as a bundle has no single product record to resolve — its
   * parent row carries either a placeholder or a combo SKU that no product sheet
   * indexes. The components are described individually, and the order system's
   * own combo table says which they are. See
   * `lib/context/resolve-bundle-product-context.ts`.
   *
   * SECOND, NEVER INSTEAD. A listing that resolved to one product is fully
   * answered already, and asking again could only add a second, competing
   * description of the same thing. Ordered this way, a conversation that works
   * today is byte-identical tomorrow.
   *
   * NO LONGER GATED ON THE ORDER, for the same reason as the catalogue above.
   * What a bundle contributes is what every option of the listing has IN COMMON
   * — the components in the box — and that cannot contradict a record of which
   * option was bought. Withholding it from post-sale replies cost 228 of the 735
   * order-resolved conversations their package contents, 33 of them in "parts
   * missing", which is the one category where what is in the box IS the question.
   *
   * Guarded separately, like the three above, so a bundle lookup failure cannot
   * discard facts that already resolved.
   */
  let bundle: BundleContext | null = null;
  if (productFacts.length === 0) {
    try {
      bundle = await resolveBundleProductContext(sourcePool, conversation);
    } catch (cause) {
      console.error("[draft] bundle context resolution failed", cause);
    }
  }

  /**
   * What the LISTING says about itself — its title and the options it offers.
   *
   * RUNS ON EVERY CONVERSATION, and needs no gate. A list of the colours a
   * listing sells is not a claim about which one this customer has, so it cannot
   * contradict an order, a catalogue record or a bundle. It is also the only one
   * of these four sources with real coverage: a title resolves for 869 of 869
   * live listings where SOT resolves for 3.
   *
   * `listing_title` IS DROPPED WHERE THE ORDER NAMED THE PURCHASED ITEM. Both
   * answer "what is this?", and the order's answer is about the variant in the
   * customer's hands while the listing's is about the advertisement. Two titles
   * would invite the model to choose; one removes the question.
   *
   * Guarded separately, like the four above.
   */
  let listingFacts: VerifiedFact[] = [];
  try {
    listingFacts = await resolveListingContext(sourcePool, conversation);
    if (orderFacts.some((fact) => fact.name === "product_title")) {
      listingFacts = listingFacts.filter((fact) => fact.name !== "listing_title");
    }
  } catch (cause) {
    console.error("[draft] listing context resolution failed", cause);
  }

  return {
    facts: [...orderFacts, ...returnFacts, ...productFacts, ...listingFacts],
    bundle,
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse> {
  const { conversationId } = await context.params;
  const id = parseConversationId(conversationId);
  if (id === null) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 });
  }

  try {
    const pool = getAppPool();
    const draft = await getDraft(pool, id);
    /**
     * The stored no-rule finding travels with the draft read.
     *
     * Without it, reopening a refused conversation looks identical to one
     * nobody has tried: no draft, an inviting Generate button, and the same
     * refusal waiting behind it. The finding is a fact about the conversation,
     * so it outlives the page that produced it.
     *
     * Null once a grounded draft exists — the save clears it in the same
     * transaction, so the two states cannot both be true.
     */
    const ruleAnalysis = await readRuleAnalysis(pool as unknown as AnalysisWritable, id);
    return NextResponse.json({ conversationId: id, draft, ruleAnalysis });
  } catch (cause) {
    if (isDraftStoreMissing(cause)) {
      return NextResponse.json({ conversationId: id, draft: null, ruleAnalysis: null, storeReady: false });
    }
    console.error("[draft] read failed", cause);
    return NextResponse.json({ error: "Unable to load the draft" }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse> {
  const { conversationId } = await context.params;
  const id = parseConversationId(conversationId);
  if (id === null) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 });
  }

  // One call decides which model answers. This handler names no vendor — see
  // lib/ai/draft-service.ts for the preference order and why it is one place.
  /**
   * The clock for the whole user-visible operation.
   *
   * Started here, before anything is read, and stopped once the draft is
   * committed — so it covers retrieval, File Search, the model call, response
   * processing, validation and the save. That is what the reviewer waited for.
   *
   * `performance.now()` and not `Date.now()`: it is monotonic, so an NTP
   * correction mid-request cannot produce a negative duration or a nonsense
   * one. Nothing here is estimated; the number is the difference between two
   * readings taken around the work.
   */
  const startedAt = performance.now();

  const provider = getDraftProvider();
  if (provider === undefined) {
    return NextResponse.json(
      { error: "Draft generation is not configured.", code: "provider_not_configured" },
      { status: 503 },
    );
  }

  const pool = getAppPool();

  try {
    const detail = await getConversation(pool, id);
    if (detail === null) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    /**
     * ONE GENERATION PER CUSTOMER MESSAGE, unless the reviewer asks again.
     *
     * A POST already means a deliberate click, but "deliberate" and "intended
     * twice" are different things: a double-click, a retried request, or two
     * tabs on the same conversation each cost a full model call. This compares
     * the newest inbound message against the newest generated revision and
     * returns the existing draft instead of paying for an identical one.
     *
     * `?force=1` bypasses it, and that is what the Regenerate button sends.
     * Regeneration stays possible and stays explicit; only the accidental
     * repeat is stopped.
     */
    const requestUrl = new URL(request.url);
    const force = requestUrl.searchParams.get("force") === "1";
    /**
     * The order a reviewer picked in the sidebar, when several matched.
     *
     * A query parameter and not a stored field: this helper has no save step
     * by design, so the choice travels with the one generation it grounds and
     * is validated server-side against the orders this conversation actually
     * matched. Absent on every conversation that resolved to a single order,
     * and absent whenever the reviewer picked nothing -- both of which leave
     * the existing behaviour exactly as it was.
     */
    const selectedOrderNumber = requestUrl.searchParams.get("selectedOrder");
    if (!force) {
      const existing = await getDraft(pool, id).catch(() => null);
      const latestGenerated = existing?.revisions.find((r) => r.origin === "generated");
      const newestInbound = [...detail.messages]
        .reverse()
        .find((message) => message.direction === "inbound");

      if (latestGenerated !== undefined && newestInbound !== undefined) {
        // The draft postdates the last thing the customer said, so it already
        // answers it. Anything older would be replying to a stale message.
        if (Date.parse(latestGenerated.createdAt) > Date.parse(newestInbound.sourceTimestamp)) {
          return NextResponse.json({
            conversationId: id,
            revision: latestGenerated.revision,
            draftReply: latestGenerated.bodyText,
            sourcesUsed: latestGenerated.sources,
            missingInformation: latestGenerated.missingInformation,
            requiresReview: latestGenerated.requiresReview,
            rulesAvailable: latestGenerated.sources.length > 0,
            provider: null,
            model: latestGenerated.model,
            // The client can tell "here is your draft" from "I just spent a
            // model call for you", which is the difference this exists to make.
            reused: true,
          });
        }
      }
    }

    /**
     * GATE ONE — BEFORE THE MODEL CALL.
     *
     * With no approved corpus for this marketplace there is nothing to ground a
     * reply in, and whatever the model returned would be written from general
     * knowledge of retail. That is the exact failure the grounding design
     * exists to prevent, so the call does not happen: no request, no revision,
     * no draft. The interface shows the no-rule state and offers the export.
     *
     * This deliberately does NOT decide which rules are relevant. Choosing a
     * subset before the model reads anything is the rule-selection layer this
     * project removed on purpose. It asks only whether there is anything to
     * retrieve from.
     */
    const { knowledge } = loadRulesForConversation(detail.conversation.marketplace);
    const coverage = coverageFor(knowledge);
    if (!coverage.covered) {
      console.info(`[draft] refused for ${id}: ${coverage.reason}`);
      // Written down, so reopening the conversation shows the finding instead
      // of an untried Generate button that would buy the same refusal again.
      // Upserted on one row per conversation, so revisiting cannot accumulate.
      const caseType = classifyCaseType(detail.messages);
      await recordNoApplicableRule(pool as unknown as AnalysisWritable, {
        conversationId: id,
        caseType: caseType.label,
        rulesAvailable: coverage.rulesAvailable,
      });
      return NextResponse.json(
        {
          error: coverage.reason,
          code: NO_APPLICABLE_RULE_CODE,
          conversationId: id,
          caseType: caseType.label,
          ruleCoverage: { covered: false, rulesAvailable: coverage.rulesAvailable },
        },
        { status: 409 },
      );
    }

    // HOW the CST knowledge reaches the model is the provider's business, not
    // this handler's. OpenAI retrieves it from a vector store per conversation;
    // Gemini is handed the rendered corpus. Both are asked for the same
    // behaviour and both return the same validated shape, so nothing here
    // changes when the provider does.
    const { facts, bundle } = await verifiedFactsFor(detail.conversation, selectedOrderNumber);

    /**
     * Carrier tracking, on EVERY category rather than delivery queries alone.
     *
     * WHY THE CATEGORY GATE WENT. It was there to keep a scan history out of
     * the model's context on conversations that had no use for one, and the
     * saving was real but small. The cost was not: a customer who had returned
     * an item was being asked to "send us the latest tracking update" by a
     * draft written on a system that already held the scan showing the parcel
     * delivered. Asking someone for a fact we have is worse than the tokens
     * that fact costs, and it happens on exactly the categories the gate
     * excluded — returns, wrong item, replacement, damage.
     *
     * `resolveVerifiedTracking` is `resolveTrackingContext` without that one
     * check. EVERY OTHER GATE REMAINS, because it is the same function
     * underneath: the tracking number and courier still come from a resolved
     * order and never from the customer's message, the carrier must normalise,
     * and the provider still refuses a reference on two orders, an order sent
     * in several parcels, and a stale non-terminal status.
     *
     * NEVER FAILS THE DRAFT. It returns a result or null, and null is the
     * ordinary case — the draft is then written exactly as it was before this
     * existed. That is why there is no try/catch here: nothing to catch.
     */
    const trackingContext = await resolveVerifiedTracking({ facts });
    if (trackingContext.tracking === null) {
      // The reason, never the reference or the customer's words.
      console.info(`[tracking] no tracking for ${id}: ${trackingContext.reason}`);
    }

    const generated = await provider.generate({
      messages: detail.messages,
      facts,
      // Both come from the stored conversation, which was written from the
      // marketplace source — neither is inferred from the message text.
      marketplace: detail.conversation.marketplace,
      listingItemRef: detail.conversation.listingItemRef,
      tracking: trackingContext.tracking,
      bundle,
    });

    /*
     * THERE IS DELIBERATELY NO SECOND GATE HERE, and the reason is worth
     * recording because a version of this code had one and it was wrong.
     *
     * It discarded any draft whose citations did not resolve against the local
     * corpus. That made CITATION RESOLUTION the definition of rule
     * applicability, and the two are not the same thing. Measured on the live
     * data: a conversation with all 1,329 marketplace-scoped rules available
     * was refused because the model's references, on that one run, did not
     * resolve — the rules applied, the bookkeeping was off, and the reviewer
     * was told the knowledge base had nothing for them.
     *
     * Applicability is decided by the retrieval logic above, once, before the
     * call. A stale ref, a legacy-format ref or one the documents no longer
     * contain is an AUDIT finding about a citation. It is reported by the
     * evidence endpoint and it never suppresses a draft.
     */
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      const saved = await saveRevision(connection as unknown as Writable, {
        conversationId: id,
        origin: "generated",
        bodyText: generated.result.draft_reply,
        requiresReview: generated.requiresReview,
        missingInformation: generated.missingInformation,
        sources: generated.result.sources_used,
        model: generated.model,
        providerResponseId: null,
      });
      await advanceWorkflowState(connection as unknown as Writable, id, "drafting");
      // In the SAME transaction as the draft. A grounded draft and a stored
      // "no rule available" are the contradiction this whole mechanism exists
      // to remove, so they must never both be true, not even between commits.
      await clearRuleAnalysis(connection as unknown as AnalysisWritable, id);
      await connection.query("COMMIT");

      // AFTER the commit, and never inside it. An accounting row is not worth
      // rolling back a draft the reviewer is waiting for, and `recordUsage`
      // swallows its own errors for the same reason.
      await recordUsage(pool as unknown as UsageWritable, {
        provider: generated.provider,
        model: generated.model,
        conversationId: id,
        draftRevisionId: saved.revisionId,
        usage: generated.usage,
        outcome: "ok",
        // Stopped AFTER the commit, because a draft is not generated until it
        // is saved — that is the moment the reviewer can act on it.
        durationMs: performance.now() - startedAt,
      });

      return NextResponse.json({
        conversationId: id,
        revision: saved.revision,
        draftReply: generated.result.draft_reply,
        sourcesUsed: generated.result.sources_used,
        missingInformation: generated.missingInformation,
        requiresReview: generated.requiresReview,
        rulesAvailable: generated.knowledgeAvailable,
        // Recorded so a reviewer can tell which model wrote a draft, and so a
        // provider comparison has something to compare on.
        provider: generated.provider,
        model: generated.model,
      });
    } catch (cause) {
      await connection.query("ROLLBACK");
      throw cause;
    } finally {
      connection.release();
    }
  } catch (cause) {
    // Every failure this route can actually produce is named here.
    //
    // GeminiUnavailable used to fall through to the generic 500 below, so a
    // rejected request, a dead model and a genuine outage all surfaced as
    // "Unable to generate a draft" — a message that says nothing and sent
    // debugging to the wrong place entirely. The provider's own message never
    // reaches the browser (it can quote the request, which contains customer
    // text); what is returned is our wording for what went wrong, plus a stable
    // `code` the UI can branch on.
    if (cause instanceof DraftServiceNotConfigured) {
      console.error("[draft] provider not configured", cause.message);
      return NextResponse.json(
        { error: cause.message, code: "provider_not_configured" },
        { status: 503 },
      );
    }
    if (cause instanceof DraftServiceUnavailable) {
      console.error("[draft] provider call failed", cause.message);
      return NextResponse.json(
        { error: cause.message, code: "provider_unavailable" },
        { status: 503 },
      );
    }
    if (cause instanceof DraftGenerationUnavailable) {
      return NextResponse.json({ error: cause.message, code: "generation_unavailable" }, { status: 503 });
    }
    if (isDraftStoreMissing(cause)) {
      return NextResponse.json(
        {
          error: "Draft storage is not available yet. Apply migration 0004_draft_workflow.",
          code: "draft_store_missing",
        },
        { status: 503 },
      );
    }
    console.error("[draft] generation failed", cause);
    return NextResponse.json({ error: "Unable to generate a draft" }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse> {
  const { conversationId } = await context.params;
  const id = parseConversationId(conversationId);
  if (id === null) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const bodyText = (body as { bodyText?: unknown }).bodyText;
  if (typeof bodyText !== "string" || bodyText.trim() === "") {
    return NextResponse.json({ error: "A draft cannot be empty" }, { status: 400 });
  }

  const pool = getAppPool();
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    // A human edit is a new revision, never an overwrite: what the model
    // proposed and what the agent changed both stay on the record. It carries
    // no model, and review is still required — editing is not approving.
    const saved = await saveRevision(connection as unknown as Writable, {
      conversationId: id,
      origin: "edited",
      bodyText,
      requiresReview: true,
      missingInformation: [],
      sources: [],
    });
    await connection.query("COMMIT");
    return NextResponse.json({ conversationId: id, revision: saved.revision });
  } catch (cause) {
    await connection.query("ROLLBACK");
    if (isDraftStoreMissing(cause)) {
      return NextResponse.json({ error: "Draft storage is not available yet." }, { status: 503 });
    }
    console.error("[draft] edit failed", cause);
    return NextResponse.json({ error: "Unable to save the draft" }, { status: 500 });
  } finally {
    connection.release();
  }
}
