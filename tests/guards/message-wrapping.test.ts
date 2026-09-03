import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Standing guard on message text staying inside its bubble.
 *
 * THE BUG THIS PINS. Every message body renders with `whitespace-pre-wrap`,
 * which preserves the customer's own line breaks and wraps only at a SPACE. A
 * message carrying one long unbroken token has no space to wrap at — a tracking
 * URL, a combo SKU like `PSHYOS4BRBM+SPUPBM+LSDO210BM`, a consignment number, a
 * German compound — and the bubble is a flex item, so its min-content width was
 * that token's full width. `max-w-[78%]` cannot shrink a box below its
 * min-content, so the text ran outside the bubble and the panel scrolled
 * sideways.
 *
 * WHY THE EXACT RULE MATTERS, and why this is asserted rather than left to
 * review. The three candidates are not interchangeable:
 *
 *   overflow-wrap: break-word  (`break-words`) wraps the token but is NOT
 *                              counted in min-content, so the flex item stays
 *                              too wide and the bubble still overflows.
 *   word-break: break-all      (`break-all`) breaks EVERY word at the margin,
 *                              including ordinary prose. Worse than the bug.
 *   overflow-wrap: anywhere    (`wrap-anywhere`) breaks a word only when it
 *                              cannot fit a line by itself, AND counts toward
 *                              min-content. The only one that does both.
 *
 * Asserted against component SOURCE, matching the rest of this suite: no DOM
 * environment is configured, and what matters here is which class is applied.
 */

const ROOT = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

/** Every surface that renders a stored message or a drafted reply verbatim. */
const BODIES = [
  ["conversation-view.tsx", "the customer and CST reply bubbles"],
  ["draft-panel.tsx", "the drafted reply"],
  ["unresolved-message-view.tsx", "the unresolved-direction feed"],
] as const;

describe("every rendered message body wraps unbreakable text", () => {
  it.each(BODIES)("%s — %s", (file) => {
    const source = stripComments(read("components", file));
    // Each of these files renders exactly one verbatim body paragraph.
    const paragraphs = source.match(/className=\{?[`"][^`"]*whitespace-pre-wrap[^`"]*/g) ?? [];
    expect(paragraphs.length, "expected a verbatim body paragraph").toBeGreaterThan(0);
    for (const paragraph of paragraphs) {
      expect(paragraph, "must wrap unbreakable tokens").toContain("wrap-anywhere");
    }
  });

  /**
   * The customer's own line breaks are what `whitespace-pre-wrap` is for, and a
   * fix that dropped it would silently reflow every multi-line message into one
   * paragraph.
   */
  it.each(BODIES)("%s keeps the sender's own line breaks", (file) => {
    expect(stripComments(read("components", file))).toContain("whitespace-pre-wrap");
  });

  /**
   * Normal sentences must still wrap normally. `break-all` on a message body
   * would satisfy the overflow requirement and fail the readability one.
   */
  it.each(BODIES)("%s does not break ordinary prose mid-word", (file) => {
    const source = stripComments(read("components", file));
    const paragraphs = source.match(/className=\{?[`"][^`"]*whitespace-pre-wrap[^`"]*/g) ?? [];
    for (const paragraph of paragraphs) {
      expect(paragraph, "break-all would break every word").not.toContain("break-all");
    }
  });
});

describe("the bubble stays inside the panel", () => {
  const view = stripComments(read("components", "conversation-view.tsx"));

  it("keeps the width cap that the wrapping rule makes effective", () => {
    // Without a cap the bubble grows to the panel; without the wrapping rule the
    // cap cannot be honoured. Both are required, so both are pinned.
    expect(view).toContain("max-w-[78%]");
  });

  /**
   * The thread scroller is deliberately vertical-only. A horizontal scrollbar
   * here would mean content escaped a bubble, so the absence of `overflow-x`
   * is the assertion — adding one would hide the very bug this guards.
   */
  it("scrolls vertically only, so overflow cannot be hidden by a scrollbar", () => {
    expect(view).toContain("overflow-y-auto");
    expect(view).not.toContain("overflow-x-auto");
    expect(view).not.toContain("overflow-x-scroll");
  });
});
