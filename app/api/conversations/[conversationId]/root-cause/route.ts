import { NextResponse } from "next/server";

import { getAppPool, getSourcePool } from "@/lib/db/pools";
import {
  type ConversationRootCauseResponse,
  readRootCauseSelection,
  type RootCausePanelResponse,
} from "@/lib/domain/root-cause-selection";
import { getConversation, parseConversationId } from "@/lib/repositories/conversation-repository";
import {
  getCurrentRootCause,
  isRejectedByConstraint,
  isRootCauseStoreMissing,
  isUnknownConversation,
  recordRootCause,
} from "@/lib/repositories/conversation-root-cause-repository";
import { loadMessageAppRootCause } from "@/lib/repositories/root-cause-repository";

/**
 * GET/POST /api/conversations/:id/root-cause
 *
 * GET returns BOTH root causes for a conversation: the one the production
 * message application recorded, and the one a CST agent recorded here. POST
 * records a CST selection.
 *
 * ---------------------------------------------------------------------------
 * TWO VALUES, TWO SYSTEMS, AND NEITHER OVERWRITES THE OTHER
 * ---------------------------------------------------------------------------
 * CST cannot write to the message application — measured, not assumed: the
 * configured credential holds no write privilege of any kind there. So a CST
 * selection is a CST record, stored in the application database, and the message
 * application will never see it. The panel shows both, each labelled with whose
 * it is, rather than letting one silently stand in for the other.
 *
 * The message-app half is still read STRICTLY READ-ONLY — `getSourcePool()` pins
 * `default_transaction_read_only=on`, so the server would refuse a write from
 * that path even if one were written. The POST below touches only
 * `cst_app.conversation_root_causes` and reaches the source pool not at all.
 *
 * ---------------------------------------------------------------------------
 * POST IS APPEND-ONLY AND THERE IS NO PATCH OR DELETE
 * ---------------------------------------------------------------------------
 * Changing a root cause posts again and inserts a second row; the newest is
 * current. Correcting a mistake is therefore possible and leaves the mistake
 * visible, which is the point — a courier comparison nobody can audit is a
 * number nobody should act on.
 *
 * ITS OWN ROUTE, NOT A FIELD ON /conversations/:id. The message-app value lives
 * in the marketplace source, so fetching it costs a second database and a second
 * statement that the inbox and the thread do not need. Keeping it separate means
 * the conversation detail every screen already loads did not get slower, and a
 * failure here degrades this one sidebar section instead of the whole panel —
 * the same reasoning as `/listing`.
 *
 * THE CONVERSATION IS LOADED FIRST so an unknown id answers 404 rather than an
 * empty result that would render as "nothing recorded". Those are different
 * facts and must not collapse into one.
 *
 * NEVER FAILS SOFT INTO A GUESS. Anything that goes wrong returns an error the
 * panel renders as no section at all, never a label assembled from something
 * else.
 */
export const dynamic = "force-dynamic";

/**
 * A CST selection, or null when there is none and none could be looked for.
 *
 * MIGRATION 0020 IS APPLIED BY HAND, like every migration in this project, so a
 * deployment that has not run it yet is a real state. The message app's half of
 * the panel is what this route existed for first and it must keep working
 * there: an absent table degrades the CST half to "nothing recorded" and is
 * logged, rather than failing the whole request.
 *
 * Every other failure propagates, because a read that broke for a reason nobody
 * anticipated must not render as "this conversation has no root cause".
 */
async function currentCstRootCause(
  app: ReturnType<typeof getAppPool>,
  conversationId: string,
): Promise<RootCausePanelResponse["cst"]> {
  try {
    return await getCurrentRootCause(app, conversationId);
  } catch (cause) {
    if (isRootCauseStoreMissing(cause)) {
      console.warn("[root-cause] 0020 is not applied; CST selections are unavailable");
      return null;
    }
    throw cause;
  }
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

  const app = getAppPool();

  try {
    const detail = await getConversation(app, id);
    if (detail === null) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    const lookup = await loadMessageAppRootCause(app, getSourcePool(), id);
    const cst = await currentCstRootCause(app, id);

    const payload: RootCausePanelResponse = {
      conversationId: id,
      state: lookup.rootCause.state,
      value: lookup.rootCause.value,
      distinctLabelCount: lookup.rootCause.distinctLabelCount,
      sourceRowCount: lookup.sourceRowCount,
      unreadableSourceRowCount: lookup.unreadableRowCount,
      cst,
    };
    return NextResponse.json(payload);
  } catch (cause) {
    // The underlying error may name schemas, hosts or credentials, so it is
    // logged server-side and never returned to the browser.
    console.error("[root-cause] lookup failed", cause);
    return NextResponse.json({ error: "Unable to load root cause" }, { status: 500 });
  }
}

/**
 * Records what a CST agent selected. ONE ROW, IN ONE TABLE.
 *
 * The body is validated by `readRootCauseSelection` before anything is written,
 * so a refusal is a 400 carrying a sentence written for the agent — what to fix,
 * never which constraint disagreed. The database's own CHECKs enforce the same
 * rules behind it; if one of them fires, the two statements of the rules have
 * drifted and that is logged loudly rather than surfacing as a 500.
 */
export async function POST(
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
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const selection = readRootCauseSelection(body);
  if (!selection.ok) {
    return NextResponse.json({ error: selection.error }, { status: 400 });
  }

  try {
    const current = await recordRootCause(getAppPool(), id, selection.record);
    const payload: ConversationRootCauseResponse = { conversationId: id, current };
    return NextResponse.json(payload, { status: 201 });
  } catch (cause) {
    // The conversation is verified by the foreign key rather than by a prior
    // read: checking first and inserting second is a race, and the key is the
    // only thing that actually decides.
    if (isUnknownConversation(cause)) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }
    if (isRootCauseStoreMissing(cause)) {
      console.error("[root-cause] 0020 is not applied; cannot record a selection");
      return NextResponse.json({ error: "Recording a root cause is not available" }, { status: 503 });
    }
    if (isRejectedByConstraint(cause)) {
      console.error("[root-cause] a CHECK rejected a selection the domain rules allowed", cause);
      return NextResponse.json({ error: "That selection cannot be recorded" }, { status: 400 });
    }
    console.error("[root-cause] recording failed", cause);
    return NextResponse.json({ error: "Unable to record root cause" }, { status: 500 });
  }
}
