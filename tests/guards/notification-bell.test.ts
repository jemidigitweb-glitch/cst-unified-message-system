import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ORDER_CHANGE_CATEGORY,
  ORDER_CHANGE_NOTIFICATION_TITLE,
} from "@/lib/domain/inbox";
import { PRIORITY_RIBBON_CLASS } from "@/components/priority-ribbon";

/**
 * Standing guard on the notification bell and drawer.
 *
 * THREE PROPERTIES, and none of them is visible in a diff.
 *
 *   1. It OBSERVES. No fetch of its own, no write, no classifier, no stored
 *      read/unread state, and none of the escalation a "notification" invites —
 *      no browser Notification, no sound, no polling, no external alert.
 *   2. It REUSES the existing conversation path. A notification click must end
 *      in the same `select(id)` the inbox list calls, so there is one
 *      conversation-detail path and not two that drift.
 *   3. It stays a DRAWER, not a layout column. The workspace's two `<aside>`
 *      elements are the list and the details panel; a notification panel that
 *      became a third would narrow the conversation permanently for something
 *      on screen for two seconds.
 *
 * Asserted against component SOURCE, matching the rest of this suite: no DOM
 * environment is configured and the properties that matter are structural.
 * Live click-through is covered by the local smoke run.
 */

const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const workspaceSource = read("components", "workspace.tsx");
const workspace = stripComments(workspaceSource);
const bell = stripComments(read("components", "notification-bell.tsx"));
const drawer = stripComments(read("components", "notification-drawer.tsx"));
const route = read("app", "api", "conversations", "awaiting-response", "route.ts");

describe("the Order Change tab is gone", () => {
  it("removed the workspace view entirely", () => {
    expect(workspace).not.toContain("order_change");
    expect(workspace).not.toContain("OrderChangeList");
    // The view union is back to the three it had before.
    expect(workspace).toContain('useState<"inbox" | "status" | "no_rule">("inbox")');
  });

  it("removed the component that backed it", () => {
    expect(existsSync(join(ROOT, "components", "order-change-list.tsx"))).toBe(false);
  });

  it("left the other two tabs untouched", () => {
    expect(workspace).toContain('aria-selected={view === "no_rule"}');
    expect(workspace).toContain('aria-selected={view === "status"}');
  });
});

describe("the bell", () => {
  it("sits at the top right of the header, above the view tabs", () => {
    const header = workspace.slice(workspace.indexOf("<header"), workspace.indexOf("</header>"));
    expect(header).toContain("<NotificationBell");
    // The title row, not the tab row: the bell opens something OVER the screen
    // and the tabs change what IS the screen.
    expect(header.indexOf("<NotificationBell")).toBeLessThan(
      header.indexOf('aria-selected={view === "no_rule"}'),
    );
    expect(header).toContain('className="flex items-start justify-between gap-3 px-5"');
  });

  it("renders whether or not anything is waiting", () => {
    // The button itself is unconditional; only the badge is conditional. A
    // control that appears and disappears is one a reviewer cannot rely on.
    expect(bell).toMatch(/return\s*\(\s*<button/);
    expect(bell).toContain("{waiting > 0 && (");
  });

  it("draws no badge for an empty or unknown queue", () => {
    // Null means the request has not landed or failed, and neither is a claim
    // that nothing is waiting.
    expect(bell).toContain("const waiting = count ?? 0;");
    expect(workspace).toContain(
      "count={orderChange === null ? null : orderChange.conversations.length}",
    );
  });

  it("puts the count in the accessible name, not only in the badge", () => {
    expect(bell).toContain("aria-label={label}");
    expect(bell).toContain("aria-expanded={open}");
    expect(bell).toContain("conversation${waiting === 1 ? \"\" : \"s\"}");
  });

  it("counts the drawer's own rows, never a second source", () => {
    expect(bell).not.toMatch(/fetch\(|useEffect|useState/);
    expect(workspace.match(/<NotificationBell/g)).toHaveLength(1);
  });

  /**
   * THE COUNT IS GLOBAL, and this is the property the whole change exists for.
   *
   * The feed is fetched with no marketplace argument, on its own effect keyed to
   * draft generation rather than to the selected tab. If either of those
   * regressed the bell would silently go back to counting one marketplace, and
   * a reviewer on eBay would never learn that an Amazon customer is waiting.
   */
  it("counts every marketplace, not the selected tab", () => {
    expect(workspace).toContain('fetch("/api/conversations/awaiting-response")');
    expect(workspace).not.toContain("awaiting-response?marketplace=");
    const effect = workspace.slice(
      workspace.indexOf('fetch("/api/conversations/awaiting-response")'),
    );
    expect(effect.slice(0, effect.indexOf("}, ["))).not.toContain("marketplace");
    expect(effect).toContain("}, [draftGeneration]);");
  });

  it("refreshes when a draft is written, and by no other schedule", () => {
    // A conversation leaves the list the moment a draft exists for it, so a
    // badge still showing it afterwards is a badge that is wrong. That is the
    // only refresh — no interval, no polling, no subscription.
    expect(workspace).toContain("}, [draftGeneration]);");
    expect(workspace).not.toContain("setInterval");
  });
});

describe("the drawer opens, closes and shows the required fields", () => {
  it("is toggled by the bell and closed by the backdrop and the button", () => {
    expect(workspace).toContain("setNotificationsOpen((isOpen) => !isOpen)");
    expect(workspace).toContain("onClose={() => setNotificationsOpen(false)}");
    // Backdrop and an explicit Close, the same two ways the list drawer and the
    // details panel are already dismissed.
    expect(drawer).toContain("onClick={onClose}");
    expect(drawer).toMatch(/>\s*Close\s*</);
  });

  it("renders nothing at all while closed", () => {
    expect(drawer).toContain("if (!open) return null;");
  });

  it("survives a marketplace change, because it is not per-marketplace state", () => {
    const handler = workspace.slice(
      workspace.indexOf("const switchMarketplace"),
      workspace.indexOf("const select"),
    );
    // Blanking a GLOBAL feed on a tab switch would empty the bell and then
    // refill it with the same answer — a count that flickers to nothing every
    // time a reviewer changes tab is a count they stop trusting.
    expect(handler).not.toContain("setOrderChange(null)");
    expect(handler).not.toContain("setNotificationsOpen(false)");
    // ...while every genuinely per-marketplace piece is still cleared.
    for (const cleared of ["setInbox(null)", "setFeed(null)", "setNoRule(null)"]) {
      expect(handler).toContain(cleared);
    }
  });

  it("shows the requested notification title", () => {
    expect(drawer).toContain("{ORDER_CHANGE_NOTIFICATION_TITLE}");
    expect(ORDER_CHANGE_NOTIFICATION_TITLE).toBe("Order Change Before Shipping Queries");
  });

  it("shows the customer identifier through the shared safe-display rule", () => {
    expect(drawer).toContain("conversationTitle(item, capability)");
    expect(drawer).not.toMatch(/\{\s*item\.counterpartyRef\s*\}/);
  });

  it("shows the marketplace, the preview and the timestamp", () => {
    expect(drawer).toContain("{capability.label}");
    expect(drawer).toContain("{item.latestCustomerMessagePreview}");
    expect(drawer).toContain("formatSourceTimestamp(item.latestCustomerMessageAt)");
  });

  it("reads each row's capability from that row's own marketplace", () => {
    // Per row, not per drawer. Two rows side by side can come from sources with
    // different guarantees about identity, and `conversationTitle` decides from
    // the capability whether a stored reference may be shown as a person.
    expect(drawer).toContain("const capability = capabilityOf(item.marketplace);");
    // No marketplace prop at all: there is nothing to scope it by, so it cannot
    // quietly become tab-scoped again.
    expect(drawer).not.toMatch(/capability:\s*MarketplaceCapability/);
    expect(drawer).not.toMatch(/marketplace:\s*Marketplace;/);
  });

  it("says the list is not scoped to the tab behind it", () => {
    expect(drawer).toContain("All marketplaces");
    expect(drawer).toContain("on any marketplace");
  });

  it("shows the priority from the shared scale, and omits it when unranked", () => {
    expect(drawer).toContain("PRIORITY_RIBBON_CLASS[item.priority]");
    expect(drawer).toContain("priorityDescription(item.priority)");
    expect(drawer).toContain("{item.priority !== null && (");
    // The colours come from the one exported table, never from inline classes
    // that could disagree with the inbox ribbon.
    for (const className of Object.values(PRIORITY_RIBBON_CLASS)) {
      expect(drawer).not.toContain(`"${className}`);
    }
  });

  it("distinguishes an empty queue from a failed load and from a pending one", () => {
    expect(drawer).toContain("error !== null");
    expect(drawer).toContain("feed === null");
    expect(drawer).toContain("items.length === 0");
  });

  it("says plainly when it did not look at everything", () => {
    expect(drawer).toContain("feed?.hasMore");
    expect(drawer).toContain("{feed.scanned}");
  });
});

describe("clicking a notification opens the existing conversation", () => {
  it("closes the drawer and hands the id to the existing selector", () => {
    const mount = workspace.slice(
      workspace.indexOf("<NotificationDrawer"),
      workspace.indexOf("/>", workspace.indexOf("<NotificationDrawer")),
    );
    expect(mount).toContain("setNotificationsOpen(false)");
    // Back to the inbox first: a conversation opened from here must not sit
    // beside the No Rule list it is not part of, or behind the usage panel.
    expect(mount).toContain('setView("inbox")');
    expect(mount).toContain("void select(id, from)");
  });

  /**
   * THE CROSS-MARKETPLACE CASE, which is the whole point of a global feed.
   *
   * `/api/conversations/:id` 404s a conversation that does not belong to the
   * marketplace named in the request — a deliberate guard against a stale URL
   * surfacing one tab's thread inside another. So opening an Amazon
   * notification from the eBay tab has to do two things, and both are asserted
   * here because either one alone is broken: switch the tab, and tell `select`
   * which marketplace to ask for rather than letting it read the old value out
   * of a closure that has not re-rendered yet.
   */
  it("switches to the notification's own marketplace before opening it", () => {
    const mount = workspace.slice(
      workspace.indexOf("<NotificationDrawer"),
      workspace.indexOf("/>", workspace.indexOf("<NotificationDrawer")),
    );
    expect(mount).toContain("if (from !== marketplace) switchMarketplace(from)");
    expect(mount).toContain("void select(id, from)");
  });

  it("lets the selector be told a marketplace instead of assuming the current tab", () => {
    expect(workspace).toContain("async (id: string, from: Marketplace = marketplace)");
    expect(workspace).toContain("`/api/conversations/${id}?marketplace=${from}`");
  });

  it("leaves the left-column lists selecting within their own tab", () => {
    // They pass one argument, so they get the default — their rows ARE the
    // current tab's rows, and nothing about the global feed changes that.
    expect(workspace).toContain("onSelect={(id) => void select(id)}");
  });

  it("keeps one conversation-detail path", () => {
    for (const pane of ["ConversationView", "ContextPanel", "DraftPanel", "DraftEvidencePanel"]) {
      expect(drawer).not.toContain(`<${pane}`);
    }
    // The panels are still mounted exactly once each, by the workspace.
    expect(workspace.match(/<ConversationView/g)).toHaveLength(1);
    expect(workspace.match(/<ContextPanel/g)).toHaveLength(1);
    expect(workspace.match(/<DraftEvidencePanel/g)).toHaveLength(1);
  });

  it("passes the drawer no way to alter what selecting means", () => {
    // It is handed `onSelect` and calls it. The workspace owns the behaviour.
    expect(drawer).toContain("onClick={() => onSelect(item.id, item.marketplace)}");
    expect(drawer).not.toContain("setDetail");
    expect(drawer).not.toContain("setView");
  });
});

describe("the drawer observes and nothing more", () => {
  it("fetches nothing and holds no state", () => {
    expect(drawer).not.toMatch(/fetch\(/);
    expect(drawer).not.toMatch(/useEffect|useState|useReducer/);
  });

  it("classifies nothing of its own", () => {
    for (const forbidden of [
      "classifyConversationCategory",
      "classifyMessageCategory",
      "classifyCaseType",
    ]) {
      expect(drawer).not.toContain(forbidden);
    }
    // The category literal never appears as display copy or as a comparison:
    // the drawer is titled by its own constant and filters nothing.
    expect(drawer).not.toContain(ORDER_CHANGE_CATEGORY);
  });

  it("mutates nothing", () => {
    for (const source of [bell, drawer]) {
      expect(source).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/);
      expect(source).not.toMatch(/\/workflow\b/);
      expect(source).not.toMatch(/\/draft\b/);
    }
  });

  it("records no read, dismissed or acknowledged state", () => {
    for (const source of [bell, drawer, workspace]) {
      for (const forbidden of ["dismiss", "markRead", "acknowledge", "seenAt", "unreadCount"]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it("raises no browser notification, sound or external alert", () => {
    for (const source of [bell, drawer, workspace]) {
      for (const forbidden of [
        "new Notification",
        "Notification.requestPermission",
        "new Audio",
        "navigator.vibrate",
        "serviceWorker",
        "webkitNotifications",
        ".play()",
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it("polls nothing", () => {
    // The feed is fetched once per marketplace, with the inbox. A timer here
    // would put the classifier on a schedule nobody asked for.
    for (const source of [bell, drawer]) {
      expect(source).not.toContain("setInterval");
      expect(source).not.toContain("setTimeout");
    }
    expect(workspace).not.toContain("setInterval");
  });

  it("builds no global notification machinery", () => {
    for (const framework of [
      "createContext",
      "NotificationProvider",
      "useNotifications",
      "toast",
    ]) {
      expect(workspace).not.toContain(framework);
      expect(drawer).not.toContain(framework);
    }
  });

  it("names no source table, column or connection detail", () => {
    for (const file of ["notification-bell.tsx", "notification-drawer.tsx"]) {
      const source = read("components", file);
      for (const internal of ["cst_app", "draft_replies", "customer_service", "source_pk"]) {
        expect(source, file).not.toContain(internal);
      }
    }
  });
});

describe("the drawer is an overlay, not a fourth column", () => {
  it("adds no sidebar to the workspace", () => {
    // Still exactly two: the list column and the details column.
    expect(workspaceSource.match(/<aside/g) ?? []).toHaveLength(2);
  });

  it("does not sit inside a grid column", () => {
    // Mounted between the header and the layout, so it belongs to no view and
    // resizes nothing.
    expect(workspace.indexOf("<NotificationDrawer")).toBeGreaterThan(
      workspace.indexOf("</header>"),
    );
    expect(workspace.indexOf("<NotificationDrawer")).toBeLessThan(workspace.indexOf("<main"));
  });

  it("covers the screen rather than reflowing it", () => {
    expect(drawer).toContain("fixed inset-y-0 right-0");
    expect(drawer).toContain('role="dialog"');
    expect(drawer).toContain("fixed inset-0 z-40");
  });

  it("changes none of the existing layout tracks", () => {
    expect(workspaceSource).toContain("320px_minmax(0,1fr)");
    expect(workspaceSource).toContain(
      "sm:grid-cols-[minmax(0,1fr)_280px] xl:grid-cols-[320px_minmax(0,1fr)_300px]",
    );
  });
});

describe("the marketplace tabs and their lists are untouched", () => {
  /**
   * The global feed must not leak into the per-marketplace lists. The inbox,
   * the No Rule list and the unresolved feed are the working lists a reviewer
   * reads INSIDE one tab, and they stay scoped to it — only the notification
   * feed was made global.
   */
  it("still scopes every list request to the selected marketplace", () => {
    for (const request of [
      "/api/conversations?marketplace=${marketplace}",
      "/api/marketplace-messages?marketplace=${marketplace}",
      "/api/conversations/no-rule?marketplace=${marketplace}",
    ]) {
      expect(workspace).toContain(request);
    }
  });

  it("leaves the tab strip and its handler alone", () => {
    expect(workspace).toContain(
      "<MarketplaceTabs selected={marketplace} onSelect={selectMarketplace}",
    );
    expect(workspace).toContain("if (next !== marketplace) switchMarketplace(next);");
  });

  it("keeps the per-marketplace feeds refetching on a tab change", () => {
    // The three tab-scoped feeds still hang off [marketplace]; only the global
    // one was moved off it.
    expect(workspace).toContain("}, [marketplace]);");
  });
});

describe("the route reads globally and only reads", () => {
  it("exports GET and nothing else", () => {
    expect(route).toMatch(/export\s+async\s+function\s+GET\b/);
    for (const method of ["POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
      expect(route).not.toMatch(
        new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b|export\\s+const\\s+${method}\\b`),
      );
    }
  });

  /**
   * NO MARKETPLACE PARAMETER AT ALL. It used to take one, and that was the
   * defect: an Amazon customer waiting on an order change is waiting whether or
   * not the reviewer is on the eBay tab. The allowlist is built server-side
   * from a fixed array of literals, so there is nothing for a caller to supply
   * and nothing to validate.
   */
  it("takes no marketplace argument", () => {
    expect(route).toContain("CONVERSATION_MARKETPLACES");
    expect(route).not.toContain("parseMarketplaceForFeed");
    expect(route).not.toMatch(/searchParams/);
    expect(route).toMatch(/export async function GET\(\)/);
  });

  it("returns what was actually read alongside the matches", () => {
    for (const field of ["conversations:", "scanned:", "hasMore:", "marketplaces:"]) {
      expect(route).toContain(field);
    }
  });

  it("embeds no SQL and returns no raw database error", () => {
    const upper = route.toUpperCase();
    for (const statement of ["SELECT ", "INSERT INTO", "UPDATE CST_APP", "DELETE FROM"]) {
      expect(upper).not.toContain(statement);
    }
    expect(route).not.toMatch(/\berror\.message\b/);
  });

  it("fixes the case area to the declared constant", () => {
    expect(route).toContain("ORDER_CHANGE_CATEGORY");
    expect(route).not.toContain('"Order change');
  });

  it("logs no customer content", () => {
    const logged = [...route.matchAll(/console\.\w+\(([^)]*)\)/g)].map(([, args]) =>
      args!.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, " "),
    );
    expect(logged.length).toBeGreaterThan(0);
    for (const args of logged) {
      for (const leaked of ["body", "preview", "message", "counterparty", "page", "items"]) {
        expect(args, args).not.toContain(leaked);
      }
    }
  });
});
