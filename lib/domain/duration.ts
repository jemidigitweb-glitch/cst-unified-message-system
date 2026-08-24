/**
 * A measured duration, as a person reads it.
 *
 * Milliseconds are how the number is stored and are useless on a screen: a
 * reviewer wondering why a draft felt slow wants "1m 42s", not "102314".
 *
 * NOT ROUNDED UPWARD TO SOMETHING FRIENDLY. Under a second reports the
 * milliseconds rather than "0s", because a 40 ms row means the value came from
 * somewhere unexpected and rounding it to zero would hide that. Null in, "not
 * recorded" out — never a zero standing in for an absent measurement.
 *
 * PURE, and shared: the same function formats the sidebar and any report, so a
 * duration cannot read one way in one place and another way somewhere else.
 */
export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return "not recorded";
  }
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;

  const totalSeconds = Math.round(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) return `${seconds}s`;
  // Zero-padded seconds, so "1m 08s" lines up with "1m 42s" in a column.
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
