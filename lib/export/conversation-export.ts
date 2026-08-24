import { isUnresolvedReference } from "@/lib/domain/conversation-reference";
import {
  type ConversationDetail,
  type ConversationMessageView,
  conversationTitle,
  displayBody,
} from "@/lib/domain/inbox";
import { capabilityOf } from "@/lib/domain/marketplace-capabilities";

/**
 * The conversation, written out as plain text.
 *
 * ONE EXPORT, ONE PURPOSE. This exists for a single case: the draft cited no
 * CST rule, so there is nothing for a reviewer to check the reply against and
 * the conversation has to go to a person instead. What they need is the
 * customer's own words, in order, complete.
 *
 * THERE IS DELIBERATELY NO RULE EXPORT HERE. Not the corpus — 1,329 rules
 * across fourteen workbooks answers no question anyone is asking — and not the
 * matched rules either. Matched rules are for reading in the sidebar; they are
 * review material, not a download. If a rules export ever reappears, it should
 * be because someone asked for one, not because this module drifted.
 *
 * PURE. No DOM, no network, no database. Given a conversation this returns a
 * filename and a string; the panel does the download. That is what makes it
 * testable, since this project runs no DOM in tests.
 */

export type ExportFile = {
  readonly filename: string;
  readonly mimeType: string;
  readonly content: string;
};

export type ConversationExportInput = {
  readonly detail: ConversationDetail;
  /**
   * The case type the classifier named, for the team triaging these files.
   *
   * Optional, and printed verbatim. Whether it could be determined at all is
   * the classifier's decision, not this module's — an absent value prints
   * "not recorded" like any other, rather than a guess made here.
   */
  readonly caseType?: string | null;
  /** Why no rule applied. Stated in the file so it needs no covering note. */
  readonly reason?: string | null;
  /** Passed in rather than read from the clock, so the output is testable. */
  readonly exportedAt: string;
};

/**
 * The button's text.
 *
 * Names a conversation, because that is the only thing this button can
 * produce. No file extension: the format is the download's business, not the
 * reviewer's, and the button reads as a plain action without it.
 */
export const CONVERSATION_EXPORT_LABEL = "Export complete conversation";

/** What the sidebar says when the draft cited nothing. */
export const NO_COMPATIBLE_RULE_HEADING = "No compatible CST rule found";

const RULE_LINE = "-".repeat(70);

/**
 * CRLF, not LF.
 *
 * This file is opened on Windows, sometimes in tools older than the machine it
 * runs on. A newline choice is not worth a reviewer seeing one run-on line.
 */
function joinLines(lines: readonly string[]): string {
  return lines.join("\r\n");
}

function field(label: string, value: string | null): string {
  // "not recorded" rather than a blank: a blank field reads as an empty value
  // the source supplied, which is a different claim from one it never had.
  return `${label.padEnd(20)}${value === null || value.trim() === "" ? "not recorded" : value}`;
}

/** The customer reference, unless it is the internal ungrouped sentinel. */
function referenceOf(detail: ConversationDetail): string | null {
  const reference = detail.conversation.counterpartyRef;
  return isUnresolvedReference(reference) ? null : reference;
}

/**
 * The order reference, where the marketplace's reference IS an order number.
 *
 * Order resolution against the source order tables is a separate, unfinished
 * piece of work, so this never claims a verified purchase. It reports the
 * reference the marketplace itself put on the message, and only for the
 * marketplaces whose capability says that is what it is.
 */
function orderReferenceOf(detail: ConversationDetail): string | null {
  const capability = capabilityOf(detail.conversation.marketplace);
  if (capability.referenceNoun !== "Order") return null;
  return referenceOf(detail);
}

function directionLabel(message: ConversationMessageView): string {
  return message.direction === "inbound" ? "CUSTOMER" : "CST REPLY";
}

function messageBlock(message: ConversationMessageView, position: number): string[] {
  const body = displayBody(message);
  const lines: string[] = [
    `[${position}] ${directionLabel(message)}  ${message.sourceTimestamp}`,
    `    Message id: ${message.id}`,
    "",
  ];

  // Indented so the boundary between one message and the next survives a body
  // that itself contains blank lines and quoted mail.
  for (const line of body.text.replace(/\r\n/g, "\n").split("\n")) {
    lines.push(line === "" ? "" : `    ${line}`);
  }

  if (message.attachments.length > 0) {
    lines.push("", `    Attachments (${message.attachments.length}):`);
    for (const attachment of message.attachments) {
      lines.push(`      - ${attachment.label} [${attachment.kind}]`, `        ${attachment.url}`);
    }
  }

  lines.push("");
  return lines;
}

/**
 * Writes one conversation out, oldest message first.
 *
 * Takes a `ConversationDetail` and nothing else, so there is no argument by
 * which a second conversation or a rule could enter the file.
 */
export function buildConversationTextExport(input: ConversationExportInput): ExportFile {
  const { conversation, messages } = input.detail;
  const capability = capabilityOf(conversation.marketplace);

  // Ordered here rather than trusted from the caller. The API already returns
  // source order, but this file states "oldest first" on its own face and must
  // not be able to contradict itself.
  const ordered = [...messages].sort((a, b) =>
    a.sourceTimestamp === b.sourceTimestamp
      ? Number(a.id) - Number(b.id)
      : a.sourceTimestamp < b.sourceTimestamp
        ? -1
        : 1,
  );

  const lines: string[] = [
    "CST UNIFIED MESSAGE SYSTEM - CONVERSATION EXPORT",
    RULE_LINE,
    "",
    field("Conversation:", conversation.id),
    field("Title:", conversationTitle(conversation, capability)),
    field("Marketplace:", capability.label),
    field("Account:", conversation.subSourceId === null ? null : String(conversation.subSourceId)),
    field("Customer:", referenceOf(input.detail)),
    field("Order reference:", orderReferenceOf(input.detail)),
    field("Item reference:", conversation.listingItemRef),
    field("Messages:", String(ordered.length)),
    field("Exported:", input.exportedAt),
    "",
    field("Message type:", input.caseType ?? null),
    field("Reason:", input.reason ?? null),
    "",
    "No applicable CST rule or approved template covered this conversation, so it",
    "is exported for the CST team to review and write the missing rule.",
    "This file contains this conversation only. No CST rule is included.",
    "",
    // Said plainly, because the whole project refuses to convert these and a
    // reader comparing against a marketplace console deserves to know why the
    // clock may differ.
    "Times are exactly as recorded by the marketplace source, unconverted.",
    "",
    RULE_LINE,
    `MESSAGES (${ordered.length}) - oldest first`,
    RULE_LINE,
    "",
  ];

  if (ordered.length === 0) {
    lines.push("No messages are stored for this conversation.", "");
  } else {
    ordered.forEach((message, index) => lines.push(...messageBlock(message, index + 1)));
  }

  lines.push(RULE_LINE, "End of conversation export.", "");

  return {
    filename: `cst-conversation-${conversation.id}.txt`,
    mimeType: "text/plain;charset=utf-8",
    content: joinLines(lines),
  };
}
