import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CATEGORY_TAG_CLASS } from "@/components/category-tag";
import {
  ALL_PRIORITIES,
  ALL_CATEGORIES,
  type PriorityFilter,
  visibleConversations,
} from "@/components/inbox-list";
import {
  PRIORITY_LABEL,
  PRIORITY_RIBBON_CLASS,
  priorityDescription,
} from "@/components/priority-ribbon";
import type { InboxItem } from "@/lib/domain/inbox";
import { MESSAGE_PRIORITIES } from "@/lib/knowledge/message-priority";

/**
 * Standing guard on the priority ribbon and its filter.
 *
 * Three things matter here and none of them is visible in a diff: the ribbon is
 * a RIGHT-EDGE MARKER rather than a third chip, it says nothing in words, and
 * an unranked conversation gets no ribbon at all rather than a green one.
 *
 * Structural assertions are read from source, matching the rest of this suite —
 * no DOM environment is configured. The filter is asserted by CALLING it,
 * because `visibleConversations` is exported as the pure function it is.
 *
 * Synthetic rows throughout. No real customer data appears in any fixture.
 */

const ROOT = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
/**
 * Comments explain the geometry in the same words the geometry uses — "a
 * rounded end would make it a capsule" — so a structural assertion has to read
 * the code and not the prose about it.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ribbon = stripComments(read("components", "priority-ribbon.tsx"));
const inboxList = stripComments(read("components", "inbox-list.tsx"));
const workspace = stripComments(read("components", "workspace.tsx"));

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "1",
    marketplace: "ebay",
    subSourceId: 7,
    counterpartyRef: "counterparty-a",
    listingItemRef: "listing-1",
    workflowState: "received",
    needsContext: false,
    inboxPlacement: "reply_inbox",
    firstSourceTimestamp: "2026-08-01 10:00:00",
    lastSourceTimestamp: "2026-08-02 10:00:00",
    messageCount: 2,
    inboundCount: 1,
    // Inbound last, so every fixture is "unread" unless a test says otherwise.
    lastDirection: "inbound",
    category: null,
    priority: null,
    ...overrides,
  };
}

const ALL_FILTERS = {
  readFilter: "unread",
  categoryFilter: ALL_CATEGORIES,
  priorityFilter: ALL_PRIORITIES,
} as const;

/* ------------------------------------------------------------------------- *
 * THE COLOURS
 * ------------------------------------------------------------------------- */

describe("the ribbon is a traffic light and nothing else", () => {
  /** 1, 2, 3. */
  it("is red for HIGH, yellow for MEDIUM and green for LOW", () => {
    expect(PRIORITY_RIBBON_CLASS.HIGH).toContain("bg-red-");
    expect(PRIORITY_RIBBON_CLASS.MEDIUM).toContain("bg-yellow-");
    expect(PRIORITY_RIBBON_CLASS.LOW).toContain("bg-green-");
  });

  it("covers every level, with none left out", () => {
    expect(Object.keys(PRIORITY_RIBBON_CLASS).sort()).toEqual([...MESSAGE_PRIORITIES].sort());
    expect(Object.keys(PRIORITY_LABEL).sort()).toEqual([...MESSAGE_PRIORITIES].sort());
  });

  it("gives each level its own hue", () => {
    const classes = Object.values(PRIORITY_RIBBON_CLASS);
    expect(new Set(classes).size).toBe(classes.length);
  });

  /**
   * SOLID, WHERE THE CATEGORY CHIP IS A TINT. The difference is the point: a
   * pastel block beside two pastel capsules would read as a third label. A
   * ribbon sharing a category's exact class would be worse still.
   */
  it("wears no category chip's styling", () => {
    for (const [priority, className] of Object.entries(PRIORITY_RIBBON_CLASS)) {
      expect(Object.values(CATEGORY_TAG_CLASS), priority).not.toContain(className);
      // No tint, no text colour: this is a block of colour, not a chip.
      expect(className, priority).not.toMatch(/\/1[0-9]\b/);
      expect(className, priority).not.toMatch(/\btext-/);
    }
  });

  /** 4. Null is not a level. */
  it("renders nothing at all for an unranked conversation", () => {
    expect(ribbon).toMatch(/if\s*\(priority === null\)\s*return null/);
    // ...and null must never be given a colour anywhere.
    expect(ribbon).not.toMatch(/null\s*:\s*"bg-/);
    expect(PRIORITY_RIBBON_CLASS).not.toHaveProperty("null");
  });
});

/* ------------------------------------------------------------------------- *
 * NO WORDS, BUT AN ACCESSIBLE NAME
 * ------------------------------------------------------------------------- */

describe("the ribbon says everything with colour", () => {
  /** 5. */
  it("renders no visible text", () => {
    // A self-closing span with no children: there is no text node to render.
    expect(ribbon).toMatch(/<span[^>]*\/>/);
    expect(ribbon).not.toMatch(/>\s*\{?\s*(?:priority|PRIORITY_LABEL\[)/);
    expect(ribbon).not.toMatch(/>\s*(?:HIGH|MEDIUM|LOW|High|Medium|Low)\s*</);
  });

  /** 6. */
  it("still announces itself to a screen reader", () => {
    expect(priorityDescription("HIGH")).toBe("High priority");
    expect(priorityDescription("MEDIUM")).toBe("Medium priority");
    expect(priorityDescription("LOW")).toBe("Low priority");
    expect(ribbon).toContain("aria-label={description}");
    expect(ribbon).toContain('role="img"');
    // And to a mouse, which has no other way to learn what a colour means.
    expect(ribbon).toContain("title={description}");
  });

  /** One table, so the dropdown and the ribbon cannot disagree on a name. */
  it("names a level the same way the filter does", () => {
    for (const priority of MESSAGE_PRIORITIES) {
      expect(priorityDescription(priority)).toBe(`${PRIORITY_LABEL[priority]} priority`);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * WHERE IT SITS
 * ------------------------------------------------------------------------- */

describe("the ribbon hangs off the right edge of the row", () => {
  /** 7. */
  it("is pinned right, vertically centred, and horizontal", () => {
    expect(ribbon).toContain("absolute");
    expect(ribbon).toContain("right-0");
    expect(ribbon).toContain("top-1/2");
    expect(ribbon).toContain("-translate-y-1/2");
    // Wider than tall: a horizontal tab, not a vertical bookmark.
    const height = /\bh-(\d+)\b/.exec(ribbon)?.[1];
    const width = /\bw-(\d+)\b/.exec(ribbon)?.[1];
    expect(Number(width)).toBeGreaterThan(Number(height));
  });

  it("is a notched ribbon, not a pill and not a border", () => {
    expect(ribbon).toContain("clip-path");
    expect(ribbon).not.toMatch(/\brounded/);
    expect(ribbon).not.toMatch(/\bborder-[lr]\b|\bborder-l-\d/);
  });

  it("stays small", () => {
    expect(Number(/\bh-(\d+)\b/.exec(ribbon)?.[1])).toBeLessThanOrEqual(4);
    expect(Number(/\bw-(\d+)\b/.exec(ribbon)?.[1])).toBeLessThanOrEqual(8);
  });

  /**
   * ON THE ROW, NOT IN THE CHIP STRIP. The marker belongs to the conversation;
   * putting it in the line of chips would make it a third chip and put it in
   * competition with the status badge for the same few pixels.
   */
  it("attaches to the row button, which makes room for it", () => {
    expect(inboxList).toContain("<PriorityRibbon priority={item.priority} />");
    const row = inboxList.slice(inboxList.indexOf("<button"), inboxList.indexOf("<span className=\"flex items-baseline"));
    expect(row).toContain("relative");
    expect(row).toContain("pr-7");
    // The ribbon is a sibling of the row's content, before the chip strip.
    expect(inboxList.indexOf("<PriorityRibbon")).toBeLessThan(inboxList.indexOf("<CategoryTag"));
    expect(inboxList.indexOf("<PriorityRibbon")).toBeLessThan(inboxList.indexOf("<StatusBadge"));
  });

  it("cannot swallow the click that opens the conversation", () => {
    expect(ribbon).toContain("pointer-events-none");
  });

  /** 19, 20. The two signals that were already on the row are untouched. */
  it("leaves the category chip and the status badge exactly as they were", () => {
    expect(inboxList).toContain("<CategoryTag category={item.category} />");
    expect(inboxList).toContain("<StatusBadge state={item.workflowState} />");
    expect(inboxList).toContain('aria-label="Read state"');
    expect(inboxList).toContain("readStateLabel(state)");
    // The ribbon is not rendered inside the chip strip.
    const strip = inboxList.slice(
      inboxList.indexOf("<span className=\"flex flex-wrap items-center gap-1.5"),
      inboxList.indexOf("</button>"),
    );
    expect(strip).not.toContain("PriorityRibbon");
  });
});

/* ------------------------------------------------------------------------- *
 * THE DROPDOWN
 * ------------------------------------------------------------------------- */

describe("the priority filter is a dropdown beside the category one", () => {
  /** 8. */
  it("offers All, High, Medium and Low", () => {
    expect(workspace).toContain('aria-label="Filter by priority"');
    expect(workspace).toContain("All priorities");
    expect(workspace).toContain("MESSAGE_PRIORITIES.map");
    expect(workspace).toContain("PRIORITY_LABEL[priority]");
    expect(PRIORITY_LABEL).toEqual({ HIGH: "High", MEDIUM: "Medium", LOW: "Low" });
  });

  it("is a select, not buttons, chips or tabs", () => {
    const control = workspace.slice(workspace.indexOf('aria-label="Filter by priority"'));
    expect(control.slice(0, 400)).not.toMatch(/role="tab"|<button/);
    const before = workspace.lastIndexOf("<select", workspace.indexOf('aria-label="Filter by priority"'));
    expect(before).toBeGreaterThan(-1);
  });

  it("sits in the same control group as the marketplace and category controls", () => {
    const group = workspace.slice(
      workspace.indexOf('<div className="flex min-w-0 flex-1 items-end gap-2">'),
      workspace.indexOf('<div className="flex shrink-0 items-center gap-1">'),
    );
    expect(group).toContain("<MarketplaceTabs");
    expect(group).toContain('aria-label="Filter by category"');
    expect(group).toContain('aria-label="Filter by priority"');
  });

  it("appears only on the inbox view, where there is a list to narrow", () => {
    const at = workspace.indexOf('aria-label="Filter by priority"');
    expect(workspace.lastIndexOf('view === "inbox" &&', at)).toBeGreaterThan(-1);
  });

  it("cannot push the header wide on a small screen", () => {
    const control = workspace.slice(workspace.indexOf('aria-label="Filter by priority"'));
    const className = /className="([^"]+)"/.exec(control)?.[1] ?? "";
    expect(className).toContain("shrink-0");
    expect(className).toMatch(/max-w-\[/);
    expect(className).toContain("truncate");
  });
});

/* ------------------------------------------------------------------------- *
 * WHAT THE FILTER SHOWS
 * ------------------------------------------------------------------------- */

describe("filtering by priority", () => {
  const rows = [
    item({ id: "high", priority: "HIGH" }),
    item({ id: "medium", priority: "MEDIUM" }),
    item({ id: "low", priority: "LOW" }),
    item({ id: "unranked", priority: null }),
  ];
  const ids = (filter: PriorityFilter) =>
    visibleConversations(rows, { ...ALL_FILTERS, priorityFilter: filter }).map((row) => row.id);

  /** 9. */
  it("shows every conversation, ranked or not, on All", () => {
    expect(ids(ALL_PRIORITIES)).toEqual(["high", "medium", "low", "unranked"]);
  });

  /** 10, 11, 12. */
  it("shows only the level asked for", () => {
    expect(ids("HIGH")).toEqual(["high"]);
    expect(ids("MEDIUM")).toEqual(["medium"]);
    expect(ids("LOW")).toEqual(["low"]);
  });

  /**
   * 13. AN UNRANKED CONVERSATION IS NOT A QUIET ONE. It is excluded from every
   * level, including Low — "we could not rank this" is not a claim that it can
   * wait, and putting it under Low would be exactly that claim.
   */
  it("excludes an unranked conversation from every level", () => {
    for (const level of MESSAGE_PRIORITIES) {
      expect(ids(level), level).not.toContain("unranked");
    }
  });

  /** 18. */
  it("changes nothing about the order", () => {
    const shuffled = [rows[2]!, rows[0]!, rows[3]!, rows[1]!];
    expect(
      visibleConversations(shuffled, ALL_FILTERS).map((row) => row.id),
    ).toEqual(["low", "high", "unranked", "medium"]);
  });

  it("sorts nowhere in the list", () => {
    expect(inboxList).not.toMatch(/\.sort\(/);
    expect(workspace).not.toMatch(/\.sort\(/);
  });
});

/* ------------------------------------------------------------------------- *
 * COMPOSITION
 * ------------------------------------------------------------------------- */

describe("priority composes with the filters that were already there", () => {
  /** 14. */
  it("narrows by category and priority together", () => {
    const rows = [
      item({ id: "urgent-delivery", category: "Delivery queries", priority: "HIGH" }),
      item({ id: "calm-delivery", category: "Delivery queries", priority: "MEDIUM" }),
      item({ id: "urgent-admin", category: "Admin related issues", priority: "HIGH" }),
    ];
    expect(
      visibleConversations(rows, {
        ...ALL_FILTERS,
        categoryFilter: "Delivery queries",
        priorityFilter: "HIGH",
      }).map((row) => row.id),
    ).toEqual(["urgent-delivery"]);
  });

  /** 15. */
  it("narrows by read state and priority together", () => {
    const rows = [
      item({ id: "unread-high", priority: "HIGH", lastDirection: "inbound" }),
      item({ id: "read-high", priority: "HIGH", lastDirection: "outbound" }),
    ];
    expect(
      visibleConversations(rows, { ...ALL_FILTERS, priorityFilter: "HIGH" }).map((row) => row.id),
    ).toEqual(["unread-high"]);
    expect(
      visibleConversations(rows, {
        ...ALL_FILTERS,
        readFilter: "read",
        priorityFilter: "HIGH",
      }).map((row) => row.id),
    ).toEqual(["read-high"]);
  });

  it("still keeps eBay's own platform notices out, whatever the priority", () => {
    const notice = item({
      id: "notice",
      marketplace: "ebay",
      counterpartyRef: "eBay",
      priority: "HIGH",
    });
    expect(visibleConversations([notice], ALL_FILTERS)).toEqual([]);
    expect(
      visibleConversations([notice], { ...ALL_FILTERS, priorityFilter: "HIGH" }),
    ).toEqual([]);
  });

  it("leaves the existing filters alone when priority is not set", () => {
    const rows = [
      item({ id: "a", category: "Delivery queries", priority: null }),
      item({ id: "b", category: "Damage queries", priority: "HIGH" }),
    ];
    // Exactly what the category filter returned before priority existed.
    expect(
      visibleConversations(rows, { ...ALL_FILTERS, categoryFilter: "Delivery queries" }).map(
        (row) => row.id,
      ),
    ).toEqual(["a"]);
  });
});

/* ------------------------------------------------------------------------- *
 * NO NEW REQUESTS
 * ------------------------------------------------------------------------- */

describe("narrowing the list fetches nothing", () => {
  /** 16, 17. */
  it("keeps both filters out of every fetch dependency list", () => {
    expect(workspace).not.toMatch(/\}, \[[^\]]*priorityFilter[^\]]*\]\)/);
    expect(workspace).not.toMatch(/\}, \[[^\]]*categoryFilter[^\]]*\]\)/);
  });

  it("sends neither filter to the API", () => {
    // The conversations request carries a marketplace and an offset. A priority
    // parameter would make this a server-side filter and a new round trip on
    // every change of the dropdown.
    for (const request of workspace.match(/fetch\(`[^`]+`\)/g) ?? []) {
      expect(request).not.toMatch(/priority|category/i);
    }
  });

  it("issues no request from the list itself", () => {
    expect(inboxList).not.toMatch(/fetch\(/);
  });

  it("reads the priority already on the loaded item", () => {
    expect(inboxList).toContain("item.priority");
  });
});
