/**
 * Customer feedback sentiment, and the one rate that can honestly be derived
 * from it.
 *
 * PURE. No network, no database, no clock.
 *
 * ------------------------------------------------------------------------
 * eBay IS SUPPORTED. AMAZON IS NOT, AND THE REASON IS MEASURED
 * ------------------------------------------------------------------------
 * eBay records all three sentiments against the seller — 319,605 positive,
 * 1,964 neutral, 1,127 negative, every row `role = 'Seller'` — so a breakdown
 * and a share are both real.
 *
 * Amazon's feedback table holds 218 rows whose ratings are 1, 2 and 3 ONLY:
 * 117, 52 and 49. There is not a single 4 or 5 in it. Applying the usual
 * "4-5 positive, 3 neutral, 1-2 negative" reading would report Amazon as having
 * zero positive feedback and a negative share near 100%, which is not a finding
 * — it is an artefact of a table that only stores complaints.
 *
 * So Amazon is declared unsupported rather than rendered. A dashboard that
 * shows a wrong number confidently is worse than one that shows none, and this
 * particular wrong number would say the business is failing on Amazon.
 *
 * ------------------------------------------------------------------------
 * NEGATIVE FEEDBACK SHARE IS NOT THE DISSATISFACTION RATE
 * ------------------------------------------------------------------------
 * They divide by different things and answer different questions:
 *
 *   negative feedback share   negative / all feedback received
 *                             "of the buyers who spoke, how many were unhappy"
 *
 *   buyer dissatisfaction     dissatisfaction events / orders placed
 *                             "of the buyers we served, how many were unhappy"
 *
 * The first is computable today because both of its terms are feedback rows.
 * The second needs an orders denominator CST does not hold and a definition of
 * what counts as dissatisfaction that nobody has given, so it stays
 * unavailable. Presenting the first under the second's name would quietly
 * answer a question nobody asked, with a much smaller denominator — most buyers
 * never leave feedback at all, so the share is far larger than the rate.
 *
 * ------------------------------------------------------------------------
 * NEVER PER AGENT
 * ------------------------------------------------------------------------
 * No feedback record carries an agent, and the only bridge to a conversation is
 * the listing, which maps one listing to many buyers. There is no function in
 * this module that takes an agent.
 */

export type FeedbackCounts = {
  readonly positive: number;
  readonly neutral: number;
  readonly negative: number;
  readonly total: number;
};

/** Marketplaces whose feedback can be reported as a full sentiment breakdown. */
export const FEEDBACK_SUPPORTED_MARKETPLACES = ["ebay"] as const;

export type FeedbackSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string };

export function feedbackSupport(marketplace: string | null): FeedbackSupport {
  if (marketplace === null) return { supported: true };
  if ((FEEDBACK_SUPPORTED_MARKETPLACES as readonly string[]).includes(marketplace)) {
    return { supported: true };
  }
  if (marketplace === "amazon") {
    return {
      supported: false,
      reason:
        "Amazon feedback records only ratings 1–3 — no positive rating is stored — so a sentiment breakdown would misreport.",
    };
  }
  return { supported: false, reason: "No customer feedback is recorded for this marketplace." };
}

export function emptyCounts(): FeedbackCounts {
  return { positive: 0, neutral: 0, negative: 0, total: 0 };
}

export function countsFrom(input: {
  positive: number;
  neutral: number;
  negative: number;
}): FeedbackCounts {
  const positive = Math.max(0, Math.trunc(input.positive));
  const neutral = Math.max(0, Math.trunc(input.neutral));
  const negative = Math.max(0, Math.trunc(input.negative));
  return { positive, neutral, negative, total: positive + neutral + negative };
}

/**
 * Negative as a share of all feedback received, as a percentage.
 *
 * NULL WHEN NOTHING WAS RECEIVED, never 0. A period with no feedback has no
 * share — 0% would read as "nobody complained", which is a finding, when the
 * truth is that nobody said anything at all.
 *
 * One decimal place: negatives are rare enough (1,127 against 319,605 on eBay,
 * about 0.35%) that rounding to whole percent would render almost every period
 * as 0%.
 */
export function negativeSharePercent(counts: FeedbackCounts): number | null {
  if (counts.total <= 0) return null;
  return Math.round((counts.negative / counts.total) * 1000) / 10;
}

/** The denominator, stated so a reader can check the share rather than trust it. */
export function shareDenominatorLabel(counts: FeedbackCounts): string {
  return `${counts.negative.toLocaleString()} of ${counts.total.toLocaleString()} feedback received`;
}
