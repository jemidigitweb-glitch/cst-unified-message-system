import { describe, expect, it } from "vitest";

import { formatDuration } from "@/lib/domain/duration";

/**
 * How a measured generation time reads on screen.
 *
 * The value in the column is milliseconds because that is what was measured;
 * the sidebar is for a person deciding whether a draft felt slow, and 102314 is
 * not an answer to that.
 */
describe("formatting a measured duration", () => {
  it("reads seconds under a minute", () => {
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(59_400)).toBe("59s");
  });

  it("reads minutes and seconds above one", () => {
    expect(formatDuration(102_000)).toBe("1m 42s");
    expect(formatDuration(188_000)).toBe("3m 08s");
  });

  /** Zero-padded, so a column of durations lines up. */
  it("pads the seconds", () => {
    expect(formatDuration(68_000)).toBe("1m 08s");
    expect(formatDuration(60_000)).toBe("1m 00s");
  });

  /**
   * Under a second reports milliseconds rather than "0s". A 40 ms generation
   * did not happen, so the number should look wrong rather than look instant.
   */
  it("keeps a sub-second value visible", () => {
    expect(formatDuration(40)).toBe("40ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("says 'not recorded' rather than inventing a zero", () => {
    expect(formatDuration(null)).toBe("not recorded");
  });

  /** A negative or non-finite duration is a bug upstream, not a fast run. */
  it("refuses an impossible value", () => {
    expect(formatDuration(-1)).toBe("not recorded");
    expect(formatDuration(Number.NaN)).toBe("not recorded");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("not recorded");
  });
});
