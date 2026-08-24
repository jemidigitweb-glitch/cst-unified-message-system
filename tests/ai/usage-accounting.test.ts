import { describe, expect, it } from "vitest";

import { estimateCost, recordUsage } from "@/lib/sync/ai-usage-writer";

/**
 * The AI usage record.
 *
 * Two properties matter more than the arithmetic: an unknown model must not be
 * priced, and a failure to record must never fail a draft.
 */

function fake(shouldThrow = false) {
  const calls: { text: string; values?: unknown[] }[] = [];
  return {
    calls,
    client: {
      query: async (config: { text: string; values?: unknown[] }) => {
        calls.push(config);
        if (shouldThrow) throw new Error("relation cst_app.ai_usage_log does not exist");
        return { rows: [{ id: "1" }] };
      },
    },
  };
}

describe("estimating cost", () => {
  it("prices a known model from its token counts", () => {
    const cost = estimateCost("gpt-4.1", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      totalTokens: 1_000_000,
    });
    expect(cost).toBe(2);
  });

  it("prefers the longest matching prefix", () => {
    // gpt-4.1-mini must not be priced as gpt-4.1.
    const mini = estimateCost("gpt-4.1-mini", { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 });
    const full = estimateCost("gpt-4.1", { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 });
    expect(mini).toBe(0.4);
    expect(full).toBe(2);
    expect(mini).toBeLessThan(full!);
  });

  /**
   * The important one. A plausible wrong number is harder to catch than a
   * missing one, so an unpriced model records NULL rather than zero.
   */
  it("returns null for a model it does not know", () => {
    expect(
      estimateCost("gpt-5.6-luna", { inputTokens: 10_000, outputTokens: 500, totalTokens: 10_500 }),
    ).toBeNull();
  });

  it("returns null when the provider reported no usage at all", () => {
    expect(estimateCost("gpt-4.1", undefined)).toBeNull();
    expect(estimateCost("gpt-4.1", { inputTokens: null, outputTokens: null, totalTokens: null })).toBeNull();
  });

  it("keeps sub-cent costs visible rather than rounding them away", () => {
    const cost = estimateCost("gpt-4.1", { inputTokens: 1_000, outputTokens: 0, totalTokens: 1_000 });
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01);
  });
});

describe("recording usage", () => {
  it("writes one row with the counts and the ids", async () => {
    const { client, calls } = fake();
    const result = await recordUsage(client, {
      provider: "openai",
      model: "gpt-4.1",
      conversationId: "239",
      draftRevisionId: "77",
      usage: { inputTokens: 12_000, outputTokens: 400, totalTokens: 12_400 },
      outcome: "ok",
      durationMs: 1_842.6,
    });

    expect(result.recorded).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("INSERT INTO cst_app.ai_usage_log");
    expect(calls[0]!.values).toEqual([
      "openai", "gpt-4.1", "239", "77", 12_000, 400, 12_400, expect.any(Number), "ok",
      // Rounded to whole milliseconds, which is what the integer column holds.
      1_843,
    ]);
  });

  it("records unknown counts as null, never as zero", async () => {
    const { client, calls } = fake();
    await recordUsage(client, {
      provider: "gemini",
      model: "gemini-3.6-flash",
      conversationId: "1",
      draftRevisionId: null,
      usage: undefined,
      outcome: "ok",
    });
    // input, output, total and cost all null — a zero would understate spend
    // in exactly the case where the number matters.
    // An unmeasured duration is null too, for the same reason: a zero would
    // read as "instant", which no generation ever is.
    expect(calls[0]!.values?.slice(4)).toEqual([null, null, null, null, "ok", null]);
  });

  /**
   * A missing accounting row is a nuisance. A draft the reviewer is waiting on
   * failing because its accounting row would not insert is not a trade worth
   * making — most likely cause is migration 0006 not being applied.
   */
  it("never throws when the table is missing", async () => {
    const { client } = fake(true);
    const result = await recordUsage(client, {
      provider: "openai",
      model: "gpt-4.1",
      conversationId: "1",
      draftRevisionId: null,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      outcome: "ok",
    });
    expect(result.recorded).toBe(false);
  });
});
