"use client";

import type { ConversationDetail } from "@/lib/domain/inbox";
import {
  CONVERSATION_EXPORT_LABEL,
  buildConversationTextExport,
} from "@/lib/export/conversation-export";

/**
 * Downloads the open conversation as text.
 *
 * ALWAYS AVAILABLE, for every conversation on every marketplace. It used to
 * appear only when no CST rule matched the draft, which made the one thing a
 * reviewer might want at any moment conditional on something unrelated to it —
 * and invisible entirely on a conversation nobody had drafted yet.
 *
 * ITS OWN COMPONENT, and not part of the evidence panel, precisely so it cannot
 * become conditional again: the evidence panel renders nothing without a draft,
 * so a button living inside it inherits that condition whether or not anyone
 * intended it to.
 *
 * ONE CONVERSATION, NEVER A RULE. It is handed a single `ConversationDetail`
 * and nothing else, so there is no argument through which the CST rule library,
 * a matched rule, or a second conversation could enter the file.
 *
 * A download only. Nothing here generates, saves, or transmits anything.
 */
export function ConversationExportButton({ detail }: { detail: ConversationDetail }) {
  const download = () => {
    const file = buildConversationTextExport({ detail, exportedAt: new Date().toISOString() });
    const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="border-t border-black/10 p-4 dark:border-white/15">
      <button
        type="button"
        onClick={download}
        className="rounded-full border border-black/15 px-3 py-1.5 text-xs font-medium transition-colors hover:border-emerald-600/40 hover:bg-emerald-600/[0.10] dark:border-white/20"
      >
        {CONVERSATION_EXPORT_LABEL}
      </button>
    </div>
  );
}
