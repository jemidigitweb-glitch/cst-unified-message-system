import { NextResponse } from "next/server";

import { getAppPool } from "@/lib/db/pools";
import { loadRulesForConversation } from "@/lib/knowledge/cst-rules-files";
import { resolveEvidence } from "@/lib/knowledge/rule-evidence";
import { getDraft, isDraftStoreMissing } from "@/lib/repositories/draft-repository";
import { getConversation, parseConversationId } from "@/lib/repositories/conversation-repository";

/**
 * GET /api/conversations/:id/draft/evidence
 *
 * The documentary trail behind the current draft: which CST rules it cited, and
 * the workbook, sheet and row each one lives at.
 *
 * WHY THIS IS A SEPARATE ROUTE. The draft card deliberately shows no citations
 * — a reviewer reading a reply should read the reply. But the team has to be
 * able to demonstrate that a draft was written against the CST documents, and
 * "we removed it from the screen" is not an answer to that. So the trail is
 * kept, and fetched only when someone asks for it.
 *
 * Read-only. Only GET is exported. Nothing here writes, and nothing here can
 * reach a marketplace source — the rules come from the local workbooks and the
 * citations from cst_app.
 *
 * The corpus is re-read at request time rather than snapshotted, which means a
 * rule edited since the draft was written will show its CURRENT text, and a
 * rule deleted since will come back in `unresolved`. Both are the honest
 * answers: this reports what the citations point at today, and says plainly
 * when a citation no longer lands.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse> {
  const { conversationId } = await context.params;
  const id = parseConversationId(conversationId);
  if (id === null) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 });
  }

  const pool = getAppPool();

  try {
    const draft = await getDraft(pool, id);
    const current = draft?.revisions[0];
    if (current === undefined) {
      return NextResponse.json({ conversationId: id, evidence: null });
    }

    // Scoped to the same marketplace the draft was generated under, so the
    // corpus searched here is the corpus that was supplied then.
    const detail = await getConversation(pool, id);
    const { knowledge } = loadRulesForConversation(detail?.conversation.marketplace ?? null);
    const rules = knowledge.state === "available" ? knowledge.rules : [];

    const citedRefs = current.sources
      .filter((source) => source.kind === "cst_document")
      .map((source) => source.ref);

    const evidence = resolveEvidence(rules, citedRefs);

    return NextResponse.json({
      conversationId: id,
      revision: current.revision,
      origin: current.origin,
      model: current.model ?? null,
      rulesAvailable: knowledge.state === "available",
      evidence,
    });
  } catch (cause) {
    if (isDraftStoreMissing(cause)) {
      return NextResponse.json({ conversationId: id, evidence: null, storeReady: false });
    }
    // The underlying error may name schemas, columns or hosts, so it is logged
    // server-side and never returned to the browser.
    console.error("[draft] evidence lookup failed", cause);
    return NextResponse.json({ error: "Unable to load the evidence" }, { status: 500 });
  }
}
