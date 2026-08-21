import type { DraftOrigin, DraftSource } from "@/lib/domain/draft";
import { type WorkflowState, canTransition } from "@/lib/domain/workflow";

/**
 * Draft persistence.
 *
 * Writes ONLY to cst_app.draft_replies, cst_app.draft_revisions,
 * cst_app.draft_revision_sources and cst_app.conversations.workflow_state.
 * Nothing here reaches the read-only source database or another project's
 * schema, and nothing here can transmit a reply.
 *
 * APPEND-ONLY HISTORY. A regeneration or an edit adds a revision; no revision
 * is ever updated or deleted. What the model proposed and what a human changed
 * both stay on the record, which is the only way a reviewed draft can later be
 * accounted for.
 *
 * The workflow ends at `reviewed`. `cst_app.conversations.workflow_state` has no
 * state after it and this module writes no other value, so there is nothing to
 * advance a conversation into a sending state — there being no such state.
 */

export type Writable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

export type SaveRevisionInput = {
  readonly conversationId: string;
  readonly origin: DraftOrigin;
  readonly bodyText: string;
  readonly requiresReview: boolean;
  readonly missingInformation: readonly string[];
  readonly sources: readonly DraftSource[];
  /** Present only for a generated revision. */
  readonly model?: string | null;
  readonly providerResponseId?: string | null;
  readonly authorUserId?: string | null;
};

export type SavedRevision = {
  readonly revision: number;
  readonly draftReplyId: string;
  /**
   * The revision row's own id.
   *
   * Distinct from `revision`, which is the per-draft sequence number a reviewer
   * sees. This is the primary key, needed by anything that must reference the
   * revision — the AI usage log points at it so a token count can be traced to
   * the exact generation that incurred it.
   */
  readonly revisionId: string;
};

/** Creates the conversation's draft on first use; returns it thereafter. */
const UPSERT_DRAFT = `
INSERT INTO cst_app.draft_replies (conversation_id)
VALUES ($1::bigint)
ON CONFLICT (conversation_id) DO UPDATE SET updated_at = now()
RETURNING id::text AS id, current_revision`;

/**
 * Appends the next revision.
 *
 * The revision number is computed inside the statement from the existing
 * maximum, so two concurrent saves cannot both claim the same number — the
 * unique index on (draft_reply_id, revision) turns the loser into an error
 * rather than a silently overwritten draft.
 */
const INSERT_REVISION = `
INSERT INTO cst_app.draft_revisions (
  draft_reply_id, revision, origin, body_text,
  missing_information, requires_review, model, provider_response_id, created_by_user_id
)
SELECT $1::bigint,
       COALESCE(MAX(revision), 0) + 1,
       $2, $3, $4::text[], $5::boolean, $6, $7, $8::bigint
FROM cst_app.draft_revisions WHERE draft_reply_id = $1::bigint
RETURNING id::text AS id, revision`;

const INSERT_SOURCES = `
INSERT INTO cst_app.draft_revision_sources (draft_revision_id, source_kind, source_ref, source_label)
SELECT $1::bigint, k, r, l
FROM unnest($2::text[], $3::text[], $4::text[]) AS s(k, r, l)
ON CONFLICT (draft_revision_id, source_kind, source_ref) DO NOTHING`;

const POINT_AT_REVISION = `
UPDATE cst_app.draft_replies
   SET current_revision = $2::int, updated_at = now()
 WHERE id = $1::bigint`;

const SET_WORKFLOW_STATE = `
UPDATE cst_app.conversations
   SET workflow_state = $2, updated_at = now()
 WHERE id = $1::bigint AND workflow_state = $3
RETURNING workflow_state`;

const READ_WORKFLOW_STATE = `
SELECT workflow_state FROM cst_app.conversations WHERE id = $1::bigint`;

/**
 * Saves one revision and points the draft at it.
 *
 * The caller owns the transaction, so a partially written revision — a body
 * without its citations — cannot be committed.
 */
export async function saveRevision(
  client: Writable,
  input: SaveRevisionInput,
): Promise<SavedRevision> {
  const draftResult = await client.query({
    text: UPSERT_DRAFT,
    values: [input.conversationId],
  });
  const draft = (draftResult.rows as { id: string }[])[0];
  if (draft === undefined) throw new Error("Draft upsert returned no row");

  const revisionResult = await client.query({
    text: INSERT_REVISION,
    values: [
      draft.id,
      input.origin,
      input.bodyText,
      [...input.missingInformation],
      input.requiresReview,
      input.model ?? null,
      input.providerResponseId ?? null,
      input.authorUserId ?? null,
    ],
  });
  const revision = (revisionResult.rows as { id: string; revision: number }[])[0];
  if (revision === undefined) throw new Error("Revision insert returned no row");

  if (input.sources.length > 0) {
    await client.query({
      text: INSERT_SOURCES,
      values: [
        revision.id,
        input.sources.map((source) => source.kind),
        input.sources.map((source) => source.ref),
        input.sources.map((source) => source.label),
      ],
    });
  }

  await client.query({
    text: POINT_AT_REVISION,
    values: [draft.id, revision.revision],
  });

  return {
    revision: Number(revision.revision),
    draftReplyId: draft.id,
    revisionId: revision.id,
  };
}

/**
 * Advances a conversation's workflow state.
 *
 * The transition is validated against the domain rules first and the UPDATE is
 * guarded on the expected current state, so a stale browser tab cannot skip a
 * step or move a conversation backwards. `reviewed` is terminal — no call can
 * move past it, because `canTransition` permits nothing after it.
 */
export async function advanceWorkflowState(
  client: Writable,
  conversationId: string,
  to: WorkflowState,
): Promise<{ moved: boolean; from: WorkflowState | null }> {
  const currentResult = await client.query({
    text: READ_WORKFLOW_STATE,
    values: [conversationId],
  });
  const current = (currentResult.rows as { workflow_state: WorkflowState }[])[0];
  if (current === undefined) return { moved: false, from: null };

  const from = current.workflow_state;
  if (from === to) return { moved: false, from };
  if (!canTransition(from, to)) return { moved: false, from };

  const updated = await client.query({
    text: SET_WORKFLOW_STATE,
    values: [conversationId, to, from],
  });
  return { moved: updated.rows.length === 1, from };
}
