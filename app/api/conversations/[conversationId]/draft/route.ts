import { NextResponse } from "next/server";

import { getDraftProvider } from "@/lib/ai/draft-service";
import {
  DraftGenerationUnavailable,
  DraftServiceNotConfigured,
  DraftServiceUnavailable,
} from "@/lib/ai/provider";
import { getAppPool } from "@/lib/db/pools";
import type { VerifiedFact } from "@/lib/domain/draft";
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
 * Empty for now: order and product resolution is not built. That is a
 * deliberate empty list, not a placeholder to fill with guesses — the generator
 * is told there is no resolved context and flags the draft accordingly.
 */
function verifiedFactsFor(): VerifiedFact[] {
  return [];
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
    const force = new URL(request.url).searchParams.get("force") === "1";
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
    const generated = await provider.generate({
      messages: detail.messages,
      facts: verifiedFactsFor(),
      // Both come from the stored conversation, which was written from the
      // marketplace source — neither is inferred from the message text.
      marketplace: detail.conversation.marketplace,
      listingItemRef: detail.conversation.listingItemRef,
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
