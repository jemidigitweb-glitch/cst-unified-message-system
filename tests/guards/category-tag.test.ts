import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CATEGORY_TAG_CLASS } from "@/components/category-tag";
import { MESSAGE_CATEGORIES } from "@/lib/knowledge/message-category";

/**
 * Standing guard on the category chip and its filter.
 *
 * Two properties matter and neither is visible in a diff: every category has
 * its OWN colour (so a reviewer scanning a column can tell two kinds of
 * problem apart), and every colour stays PASTEL (so eleven chips never
 * out-shout the one status badge on the row that actually needs noticing).
 *
 * Asserted against source, matching the rest of this suite: no DOM environment
 * is configured, and what matters here is structural.
 */

const ROOT = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const workspace = read("components", "workspace.tsx");
const inboxList = read("components", "inbox-list.tsx");
const tag = read("components", "category-tag.tsx");

describe("every category has its own pastel colour", () => {
  it("covers all eleven, with none left out", () => {
    expect(Object.keys(CATEGORY_TAG_CLASS).sort()).toEqual([...MESSAGE_CATEGORIES].sort());
  });

  it("gives each category a distinct colour", () => {
    const classes = Object.values(CATEGORY_TAG_CLASS);
    expect(new Set(classes).size).toBe(classes.length);
    // ...and distinct hues, not the same hue at different opacities.
    const hues = classes.map((c) => /bg-([a-z]+)-/.exec(c)?.[1]);
    expect(new Set(hues).size).toBe(hues.length);
  });

  /**
   * The pastel recipe: a low-percentage tint behind text a few steps darker.
   *
   * Two tints are allowed, not one. `/15` with `-700` is the chip's own, and
   * `/12` with `-800` is what `StatusBadge` uses — Delivery queries
   * deliberately borrows the latter so it reads as the same family as the
   * "Draft ready" pill. Both are pastel; what this rejects either way is a
   * solid fill (`bg-sky-500` with no opacity), a 600+ background, or
   * white-on-colour.
   */
  it("keeps every colour pastel — a tint, never a solid fill", () => {
    for (const [category, className] of Object.entries(CATEGORY_TAG_CLASS)) {
      expect(className, category).toMatch(/bg-[a-z]+-500\/1[25]\b/);
      expect(className, category).toMatch(/\btext-[a-z]+-[78]00\b/);
      expect(className, category).toMatch(/\bdark:text-[a-z]+-300\b/);
      // No solid or near-solid background, and no white-on-colour.
      expect(className, category).not.toMatch(/bg-[a-z]+-(?:500|600|700|800|900)\b(?!\/)/);
      expect(className, category).not.toContain("text-white");
    }
  });

  /**
   * No category tag may wear a status pill's colour.
   *
   * They sit on the same row. A category tag tinted like the status badge
   * beside it makes one row look as though it carries two of the same signal,
   * which is the opposite of what the colour is for.
   */
  it("shares no colour with any status pill", () => {
    const statusBadge = read("components", "status-badge.tsx");
    const pillClasses = [...statusBadge.matchAll(/className:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(pillClasses.length).toBeGreaterThan(0);

    for (const [category, className] of Object.entries(CATEGORY_TAG_CLASS)) {
      expect(pillClasses, category).not.toContain(className);
    }
  });

  it("rounds the corners", () => {
    expect(tag).toMatch(/className=\{`rounded-(?:md|lg|full)\b/);
  });

  /**
   * One mapping, read everywhere. Eleven inline conditions scattered across
   * components is how a category ends up one colour in the list and another
   * somewhere else.
   */
  it("is the single source of the chip's colour", () => {
    expect(inboxList).toContain("<CategoryTag category={item.category} />");
    // The old inline amber styling must not come back anywhere.
    expect(inboxList).not.toMatch(/bg-amber-500\/15[^`"]*\{item\.category\}/);
    expect(workspace).not.toMatch(/bg-[a-z]+-500\/15[^`"]*category/i);
  });
});

describe("the category filter sits beside the marketplace tabs", () => {
  /**
   * MOVED, deliberately, from the far right of the header.
   *
   * Beside No Rule it read as a view-level control, and it is not one — it
   * narrows the conversations within the SELECTED MARKETPLACE, so it belongs
   * against the control that picks the marketplace.
   */
  it("renders after the marketplace tabs and before the No Rule tab", () => {
    const tabsAt = workspace.indexOf("<MarketplaceTabs");
    const filterAt = workspace.indexOf('aria-label="Filter by category"');
    const noRuleAt = workspace.indexOf('aria-selected={view === "no_rule"}');
    expect(tabsAt).toBeGreaterThan(-1);
    expect(filterAt).toBeGreaterThan(-1);
    expect(noRuleAt).toBeGreaterThan(-1);
    expect(tabsAt).toBeLessThan(filterAt);
    expect(filterAt).toBeLessThan(noRuleAt);
  });

  /**
   * In the SAME flex row as the marketplace control, not merely earlier in the
   * file — that is the whole point of the move, and file order alone would
   * still pass if the two ended up in different containers.
   */
  it("shares one container with the marketplace control", () => {
    const group = workspace.slice(
      workspace.indexOf("<div className=\"flex min-w-0 flex-1 items-end gap-2\">"),
      workspace.indexOf('<div className="flex shrink-0 items-center gap-1">'),
    );
    expect(group).toContain("<MarketplaceTabs");
    expect(group).toContain('aria-label="Filter by category"');
    // The hamburger is the marketplace control below `xl`, so the filter must
    // sit beside that too rather than stranding itself when the tabs fold away.
    expect(group).toContain('aria-label="Open marketplaces and conversations"');
  });

  /** The tabs must still be able to shrink and scroll rather than widen the header. */
  it("leaves the tab strip shrinkable and the filter fixed", () => {
    const group = workspace.slice(
      workspace.indexOf("<div className=\"flex min-w-0 flex-1 items-end gap-2\">"),
      workspace.indexOf('<div className="flex shrink-0 items-center gap-1">'),
    );
    expect(group).toMatch(/hidden min-w-0 xl:block/);
  });

  it("no longer renders the control inside the list header", () => {
    expect(inboxList).not.toContain('aria-label="Filter by category"');
    expect(inboxList).not.toContain("onCategoryFilterChange");
  });

  /**
   * The filter narrows conversations already loaded. If it ever appeared in an
   * inbox fetch's dependencies, changing it would refetch the page.
   */
  it("triggers no request when it changes", () => {
    expect(workspace).not.toMatch(/\}, \[[^\]]*categoryFilter[^\]]*\]\)/);
    expect(inboxList).not.toMatch(/fetch\(/);
  });

  it("leaves the read/unread filter and status badge alone", () => {
    expect(inboxList).toContain("readStateLabel(state)");
    expect(inboxList).toContain('aria-label="Read state"');
    expect(inboxList).toContain("<StatusBadge state={item.workflowState} />");
  });

  /** The control must not force the header wider than a narrow viewport. */
  it("cannot push the header wide on a small screen", () => {
    const select = workspace.slice(workspace.indexOf('aria-label="Filter by category"'));
    const className = /className="([^"]+)"/.exec(select)?.[1] ?? "";
    expect(className).toContain("shrink-0");
    expect(className).toMatch(/max-w-\[/);
    expect(className).toContain("truncate");
  });
});
