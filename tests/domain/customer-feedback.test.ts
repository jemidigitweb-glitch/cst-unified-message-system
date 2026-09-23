import { describe, expect, it } from "vitest";

import {
  FEEDBACK_SUPPORTED_MARKETPLACES,
  countsFrom,
  emptyCounts,
  feedbackSupport,
  negativeSharePercent,
  shareDenominatorLabel,
} from "@/lib/domain/customer-feedback";
import { EBAY_FEEDBACK_SQL, ebayFeedbackCounts } from "@/lib/repositories/performance-repository";
import { kpiByKey } from "@/lib/domain/performance-metrics";

/**
 * Customer feedback, and the one rate that can honestly be derived from it.
 *
 * Every figure in these fixtures was measured against the source:
 * 319,605 positive, 1,964 neutral and 1,127 negative on eBay; 218 Amazon rows
 * carrying ratings 1, 2 and 3 and nothing else.
 */

describe("marketplace support", () => {
  it("supports eBay, where all three sentiments are recorded", () => {
    expect([...FEEDBACK_SUPPORTED_MARKETPLACES]).toEqual(["ebay"]);
    expect(feedbackSupport("ebay").supported).toBe(true);
  });

  it("treats no marketplace filter as the supported set", () => {
    expect(feedbackSupport(null).supported).toBe(true);
  });

  /**
   * THE FINDING THIS TEST EXISTS FOR. Amazon's table holds ratings 1, 2 and 3
   * only — 117, 52 and 49 rows, not a single 4 or 5. The usual
   * "4-5 positive" reading would report zero positive feedback and a negative
   * share near 100%, which is an artefact of a table that only stores
   * complaints, not a finding about the business.
   */
  it("refuses Amazon, and says why", () => {
    const support = feedbackSupport("amazon");
    expect(support.supported).toBe(false);
    expect(support.supported === false && support.reason).toMatch(/only ratings 1–3/);
  });

  it.each(["shopify", "bandq", "temu"])("refuses %s, which records none", (marketplace) => {
    const support = feedbackSupport(marketplace);
    expect(support.supported).toBe(false);
    expect(support.supported === false && support.reason).toMatch(/No customer feedback/i);
  });
});

describe("counts", () => {
  it("totals the three sentiments", () => {
    expect(countsFrom({ positive: 19225, neutral: 58, negative: 30 })).toEqual({
      positive: 19225,
      neutral: 58,
      negative: 30,
      total: 19313,
    });
  });

  it("starts empty", () => {
    expect(emptyCounts()).toEqual({ positive: 0, neutral: 0, negative: 0, total: 0 });
  });

  it("refuses to carry a negative count into a total", () => {
    expect(countsFrom({ positive: -5, neutral: 1, negative: 2 }).total).toBe(3);
  });
});

describe("negative feedback share", () => {
  /** 30 of 19,313 measured over Jun–Sep 2026. */
  it("divides negatives by all feedback received", () => {
    expect(negativeSharePercent(countsFrom({ positive: 19225, neutral: 58, negative: 30 }))).toBe(
      0.2,
    );
  });

  it("keeps one decimal, because negatives are rare", () => {
    // 6 of 4,275 measured over September: 0.14%, which whole-percent rounding
    // would render as 0% — indistinguishable from none at all.
    expect(negativeSharePercent(countsFrom({ positive: 4262, neutral: 7, negative: 6 }))).toBe(0.1);
  });

  /**
   * A silent period has NO share. Zero would read as "nobody complained",
   * which is a finding; the truth is that nobody said anything.
   */
  it("is null when nothing was received, never zero", () => {
    expect(negativeSharePercent(emptyCounts())).toBeNull();
  });

  it("is 100 when everything received was negative", () => {
    expect(negativeSharePercent(countsFrom({ positive: 0, neutral: 0, negative: 4 }))).toBe(100);
  });

  it("is 0 when feedback arrived and none of it was negative", () => {
    // Distinct from the null case above: here buyers did speak.
    expect(negativeSharePercent(countsFrom({ positive: 10, neutral: 1, negative: 0 }))).toBe(0);
  });

  /** The denominator is stated so the share can be checked, not trusted. */
  it("labels its denominator as feedback received", () => {
    expect(shareDenominatorLabel(countsFrom({ positive: 19225, neutral: 58, negative: 30 }))).toBe(
      "30 of 19,313 feedback received",
    );
  });
});

describe("the feedback query", () => {
  it("counts only feedback left for the seller", () => {
    expect(EBAY_FEEDBACK_SQL).toMatch(/role = 'Seller'/);
  });

  /**
   * `type` is the sentiment. `rating_star` is eBay's seller-badge colour —
   * Red, Turquoise, Purple — and grouping by it yields a plausible-looking
   * breakdown that means nothing.
   */
  it("reads sentiment from type, never from rating_star", () => {
    expect(EBAY_FEEDBACK_SQL).toMatch(/type = 'Positive'/);
    expect(EBAY_FEEDBACK_SQL).not.toMatch(/rating_star/);
  });

  /**
   * `date` is a timestamp, so an inclusive upper bound would drop everything
   * after midnight on the closing day — a whole day missing from every period
   * ending today.
   */
  it("uses a half-open upper bound so the final day is included", () => {
    expect(EBAY_FEEDBACK_SQL).toMatch(/date < \(\$2::date \+ 1\)/);
    expect(EBAY_FEEDBACK_SQL).not.toMatch(/BETWEEN/i);
  });

  it("binds both bounds", () => {
    expect(EBAY_FEEDBACK_SQL).toMatch(/\$1::date/);
    expect(EBAY_FEEDBACK_SQL).not.toMatch(/\$\{/);
  });

  it("is a SELECT and nothing else", () => {
    for (const verb of ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER"]) {
      expect(EBAY_FEEDBACK_SQL.toUpperCase()).not.toContain(verb);
    }
  });

  it("passes the range through as bound values", async () => {
    const calls: Array<{ values: unknown[] }> = [];
    const client = {
      query: async (config: { text: string; values?: unknown[] }) => {
        calls.push({ values: config.values ?? [] });
        return { rows: [{ positive: 1, neutral: 2, negative: 3 }] };
      },
    };
    const counts = await ebayFeedbackCounts(client, { from: "2026-06-01", to: "2026-09-23" });
    expect(calls[0].values).toEqual(["2026-06-01", "2026-09-23"]);
    expect(counts).toEqual({ positive: 1, neutral: 2, negative: 3 });
  });

  it("reads an empty result as zeroes rather than failing", async () => {
    const client = { query: async () => ({ rows: [] }) };
    expect(await ebayFeedbackCounts(client, { from: "2026-01-01", to: "2026-01-02" })).toEqual({
      positive: 0,
      neutral: 0,
      negative: 0,
    });
  });
});

describe("feedback is never attributed to an agent", () => {
  /** No feedback record carries an agent; the module offers no way to ask. */
  it("exposes no function taking an agent", async () => {
    const feedbackModule = await import("@/lib/domain/customer-feedback");
    expect(Object.keys(feedbackModule).join(" ")).not.toMatch(/agent|user/i);
  });

  it("scopes the KPI to the marketplace", () => {
    expect(kpiByKey("customer_feedback").scope).toBe("marketplace");
  });

  it("does not join the feedback query to any agent table", () => {
    expect(EBAY_FEEDBACK_SQL).not.toMatch(/agent_activity|agent_directory|source_user_id/);
  });
});

describe("it stays distinct from buyer dissatisfaction", () => {
  /**
   * They divide by different things: feedback received versus orders placed.
   * Dissatisfaction must remain unavailable while it has neither an orders
   * denominator nor a definition, so the share cannot quietly stand in for it.
   */
  it("leaves buyer dissatisfaction unavailable", () => {
    expect(kpiByKey("buyer_dissatisfaction_rate").availability.state).toBe("unavailable");
  });

  it("describes the feedback KPI in terms of feedback received", () => {
    expect(kpiByKey("customer_feedback").calculation).toMatch(/share of all feedback received/i);
  });

  it("makes customer feedback available", () => {
    expect(kpiByKey("customer_feedback").availability.state).toBe("available");
  });
});
