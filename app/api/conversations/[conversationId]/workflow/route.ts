import { NextResponse } from "next/server";

import { getAppPool } from "@/lib/db/pools";
import { parseConversationId } from "@/lib/repositories/conversation-repository";
import { isDraftStoreMissing } from "@/lib/repositories/draft-repository";
import { advanceWorkflowState, type Writable } from "@/lib/sync/draft-writer";
import { WORKFLOW_STATES, type WorkflowState } from "@/lib/domain/workflow";

/**
 * Moves a conversation along the review workflow.
 *
 *   received -> drafting -> pending_review -> reviewed
 *
 * `reviewed` is TERMINAL. The domain's transition table permits nothing after
 * it, so this route cannot advance a conversation into a sending state — there
 * is no such state, and no transport behind one.
 *
 * The requested state is checked against the declared set before it reaches the
 * database, and the transition itself is validated against the domain rules, so
 * a hand-edited request cannot skip review or reopen a reviewed conversation.
 */
export const dynamic = "force-dynamic";

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
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const requested = (body as { state?: unknown }).state;
  const state = WORKFLOW_STATES.find((candidate) => candidate === requested);
  if (state === undefined) {
    return NextResponse.json({ error: "Unknown workflow state" }, { status: 400 });
  }

  const connection = await getAppPool().connect();
  try {
    await connection.query("BEGIN");
    const outcome = await advanceWorkflowState(
      connection as unknown as Writable,
      id,
      state as WorkflowState,
    );
    await connection.query("COMMIT");

    if (outcome.from === null) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }
    if (!outcome.moved) {
      return NextResponse.json(
        { error: `Cannot move from ${outcome.from} to ${state}`, workflowState: outcome.from },
        { status: 409 },
      );
    }
    return NextResponse.json({ conversationId: id, workflowState: state });
  } catch (cause) {
    await connection.query("ROLLBACK");
    if (isDraftStoreMissing(cause)) {
      return NextResponse.json({ error: "Workflow storage is not available yet." }, { status: 503 });
    }
    console.error("[workflow] transition failed", cause);
    return NextResponse.json({ error: "Unable to update the conversation" }, { status: 500 });
  } finally {
    connection.release();
  }
}
