"use client";

import type { ConversationMessageView } from "@/lib/domain/inbox";
import { classifyCaseType } from "@/lib/knowledge/case-type";

/**
 * The flag for a case the CST knowledge base cannot answer.
 *
 * WHAT IT IS SAYING. Retrieval ran, and no applicable rule or approved template
 * came back — so whatever text is on screen was not written from CST policy and
 * must not be treated as though it were. This has to be unmissable, because the
 * failure mode is quiet: a fluent, confident, entirely ungrounded reply looks
 * exactly like a good one.
 *
 * ONE COMPONENT, TWO PLACES. It appears on the draft card and in the review
 * sidebar. Written once so the two cannot drift into saying different things
 * about the same conversation.
 *
 * IT CREATES NOTHING. No rule is written, no rule file is touched, and nothing
 * is sent. The only action offered is a download the reviewer chooses to take.
 */

export const NO_RULE_HEADING = "NO CST RULE / TEMPLATE AVAILABLE";

export const NO_RULE_EXPLANATION =
  "This message type cannot generate a grounded reply because no applicable CST rule or approved template was found in the CST knowledge base.";

export const NO_RULE_REASON = "No applicable CST rule or approved template was found.";

export const NO_RULE_ACTION = "Export conversation for CST rule creation.";

export function NoRuleFlag({
  messages,
  children,
}: {
  messages: readonly ConversationMessageView[];
  /** The export control, supplied by the caller that owns the conversation. */
  children?: React.ReactNode;
}) {
  const caseType = classifyCaseType(messages);

  return (
    <div
      data-testid="no-rule-flag"
      className="rounded-lg border border-amber-600/35 bg-amber-500/[0.08] p-3 dark:border-amber-400/35"
    >
      <p className="text-xs font-semibold tracking-wide text-amber-800 dark:text-amber-200">
        {NO_RULE_HEADING}
      </p>
      <p className="mt-1.5 text-xs opacity-75">{NO_RULE_EXPLANATION}</p>

      <dl className="mt-2.5 flex flex-col gap-1.5 text-xs">
        <div>
          <dt className="opacity-55">Message type</dt>
          <dd className="font-medium">{caseType.label}</dd>
          {/*
           * The evidence for the label, always beside it. The classifier reads
           * the customer's own words against an explicit phrase table, and
           * showing the phrase it matched lets a reviewer judge the label in a
           * glance instead of trusting it.
           */}
          {caseType.matchedPhrase !== null && (
            <dd className="opacity-55">from the customer&rsquo;s wording: &ldquo;{caseType.matchedPhrase}&rdquo;</dd>
          )}
        </div>
        <div>
          <dt className="opacity-55">Reason</dt>
          <dd>{NO_RULE_REASON}</dd>
        </div>
        <div>
          <dt className="opacity-55">Action</dt>
          <dd>{NO_RULE_ACTION}</dd>
        </div>
      </dl>

      {children}
    </div>
  );
}
