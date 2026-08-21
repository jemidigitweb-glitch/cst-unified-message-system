import { NextResponse } from "next/server";

import { DraftGenerationUnavailable, generateDraft } from "@/lib/ai/draft-generator";
import { GeminiNotConfigured, GeminiUnavailable, getDraftModelClient } from "@/lib/ai/gemini-client";
import { loadRulesForConversation } from "@/lib/knowledge/cst-rules-files";
import { getAppPool } from "@/lib/db/pools";
import type { VerifiedFact } from "@/lib/domain/draft";
import { getDraft, isDraftStoreMissing } from "@/lib/repositories/draft-repository";
import { getConversation, parseConversationId } from "@/lib/repositories/conversation-repository";
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
    const draft = await getDraft(getAppPool(), id);
    return NextResponse.json({ conversationId: id, draft });
  } catch (cause) {
    if (isDraftStoreMissing(cause)) {
      return NextResponse.json({ conversationId: id, draft: null, storeReady: false });
    }
    console.error("[draft] read failed", cause);
    return NextResponse.json({ error: "Unable to load the draft" }, { status: 500 });
  }
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse> {
  const { conversationId } = await context.params;
  const id = parseConversationId(conversationId);
  if (id === null) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 });
  }

  const client = getDraftModelClient();
  if (client === undefined) {
    return NextResponse.json(
      { error: "Draft generation is not configured." },
      { status: 503 },
    );
  }

  const pool = getAppPool();

  try {
    const detail = await getConversation(pool, id);
    if (detail === null) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    // The WHOLE rule corpus goes to the model — no topic filtering. The only
    // thing this call narrows is the marketplace, which drops another
    // platform's rules; see rule-scoping.ts for why the keyword layer went.
    //
    // Re-read per generation. The cache keys on each workbook's mtime, so an
    // edited rule file takes effect on the next draft without a restart, and an
    // unchanged one costs nothing. Unreadable files degrade the draft to its
    // policy-free mode rather than taking the feature down.
    const { knowledge, corpus } = loadRulesForConversation(
      detail.conversation.marketplace ?? null,
    );

    const generated = await generateDraft(client, {
      messages: detail.messages,
      facts: verifiedFactsFor(),
      knowledge,
      // Both come from the stored conversation, which was written from the
      // marketplace source — neither is inferred from the message text.
      marketplace: detail.conversation.marketplace,
      listingItemRef: detail.conversation.listingItemRef,
    });

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
      await connection.query("COMMIT");

      return NextResponse.json({
        conversationId: id,
        revision: saved.revision,
        draftReply: generated.result.draft_reply,
        sourcesUsed: generated.result.sources_used,
        missingInformation: generated.missingInformation,
        requiresReview: generated.requiresReview,
        rulesAvailable: !generated.restricted,
        // Every area the model was given, and how many rules that was. No
        // longer "what we picked" — it is the whole corpus for this platform.
        ruleAreas: corpus?.categories ?? [],
        rulesConsidered: corpus?.rules.length ?? 0,
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
    if (cause instanceof GeminiNotConfigured) {
      console.error("[draft] gemini not configured", cause.message);
      return NextResponse.json(
        {
          error: "Draft generation is not configured. Set GEMINI_API_KEY on the server.",
          code: "gemini_not_configured",
        },
        { status: 503 },
      );
    }
    if (cause instanceof GeminiUnavailable) {
      console.error("[draft] gemini call failed", cause.message);
      return NextResponse.json({ error: cause.message, code: "gemini_unavailable" }, { status: 503 });
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
