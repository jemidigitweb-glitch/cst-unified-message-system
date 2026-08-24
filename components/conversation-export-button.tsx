"use client";

import type { ConversationDetail } from "@/lib/domain/inbox";
import {
  CONVERSATION_EXPORT_LABEL,
  buildConversationTextExport,
} from "@/lib/export/conversation-export";
import { classifyCaseType } from "@/lib/knowledge/case-type";

import { NO_RULE_REASON } from "./no-rule-flag";

/**
 * Downloads the open conversation as text, for a case CST cannot answer.
 *
 * THIS IS A GAP REPORT, not a general download. It is offered in exactly one
 * situation: retrieval ran and no applicable CST rule or approved template came
 * back. What the team does with the file is write the missing rule — so the
 * useful content is the customer's own words in order, and the rule base is
 * precisely what must NOT be in it.
 *
 * ONE CONVERSATION, NEVER A RULE. It is handed a single `ConversationDetail`
 * and nothing else, so there is no argument through which the CST rule library,
 * a matched rule, or a second conversation could enter the file.
 *
 * A download only. Nothing here generates, saves or transmits anything, and
 * nothing here creates or edits a CST rule.
 */
export function ConversationExportButton({ detail }: { detail: ConversationDetail }) {
  const download = () => {
    const file = buildConversationTextExport({
      detail,
      // The same classifier the flag on screen used, so the file and the
      // sidebar cannot name the case differently.
      caseType: classifyCaseType(detail.messages).label,
      reason: NO_RULE_REASON,
      exportedAt: new Date().toISOString(),
    });
    const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <button
      type="button"
      onClick={download}
      className="mt-3 rounded-full border border-amber-700/30 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-amber-600/[0.12] dark:border-amber-300/30"
    >
      {CONVERSATION_EXPORT_LABEL}
    </button>
  );
}
