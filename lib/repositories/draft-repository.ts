import "server-only";

import type { DraftOrigin, DraftSource } from "@/lib/domain/draft";

/**
 * Read-only access to stored drafts.
 *
 * SELECT only. Writes live in `lib/sync/draft-writer.ts`, so a read path can
 * never mutate a draft by accident. Every query is parameterised and the client
 * is injected, so this is testable without a database.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

export type DraftRevisionView = {
  readonly revision: number;
  readonly origin: DraftOrigin;
  readonly bodyText: string;
  readonly requiresReview: boolean;
  readonly missingInformation: readonly string[];
  readonly model: string | null;
  readonly createdAt: string;
  readonly sources: readonly DraftSource[];
};

export type DraftView = {
  readonly conversationId: string;
  readonly currentRevision: number;
  readonly revisions: readonly DraftRevisionView[];
};

/**
 * Newest revision first, so the current draft is `revisions[0]` and the rest is
 * history a reviewer can page back through.
 */
const GET_DRAFT = `
SELECT r.revision,
       r.origin,
       r.body_text,
       r.requires_review,
       r.missing_information,
       r.model,
       r.created_at::text          AS created_at,
       d.current_revision,
       COALESCE(
         json_agg(
           json_build_object('kind', s.source_kind, 'ref', s.source_ref, 'label', s.source_label)
           ORDER BY s.source_kind, s.source_ref
         ) FILTER (WHERE s.id IS NOT NULL),
         '[]'::json
       )                            AS sources
FROM cst_app.draft_replies d
JOIN cst_app.draft_revisions r ON r.draft_reply_id = d.id
LEFT JOIN cst_app.draft_revision_sources s ON s.draft_revision_id = r.id
WHERE d.conversation_id = $1::bigint
GROUP BY r.id, d.current_revision
ORDER BY r.revision DESC`;

type RevisionRow = {
  revision: number;
  origin: string;
  body_text: string;
  requires_review: boolean;
  missing_information: string[];
  model: string | null;
  created_at: string;
  current_revision: number;
  sources: DraftSource[];
};

/** Postgres `undefined_table` — the draft migration has not been applied. */
const UNDEFINED_TABLE = "42P01";

export function isDraftStoreMissing(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === UNDEFINED_TABLE
  );
}

/**
 * Loads a conversation's draft with its full revision history.
 *
 * Returns null when there is no draft yet, so callers can distinguish "nobody
 * has drafted this" from "the draft is empty" — different states with different
 * next actions.
 */
export async function getDraft(
  client: Queryable,
  conversationId: string,
): Promise<DraftView | null> {
  const { rows } = await client.query({ text: GET_DRAFT, values: [conversationId] });
  const revisions = rows as RevisionRow[];
  if (revisions.length === 0) return null;

  return {
    conversationId,
    currentRevision: Number(revisions[0]!.current_revision),
    revisions: revisions.map((row) => ({
      revision: Number(row.revision),
      origin: row.origin as DraftOrigin,
      bodyText: row.body_text,
      requiresReview: row.requires_review,
      missingInformation: row.missing_information ?? [],
      model: row.model,
      createdAt: row.created_at,
      sources: row.sources ?? [],
    })),
  };
}
