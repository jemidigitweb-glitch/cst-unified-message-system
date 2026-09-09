import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { MARKETPLACES } from "@/lib/domain/marketplace";
import {
  MARKETPLACE_TAB_ORDER,
  capabilityOf,
  isMarketplaceActive,
} from "@/lib/domain/marketplace-capabilities";
import { FEED_NOT_PROVISIONED_TEXT } from "@/lib/domain/unresolved-messages";

/**
 * Standing guard on how marketplaces are presented.
 *
 * Every marketplace tab must be reachable, and a marketplace whose source
 * proves less must not be dressed up as one that proves more. These are read as
 * source text rather than rendered, matching how the rest of this suite guards
 * the interface: no DOM environment is configured, and the properties asserted
 * here are structural rather than visual. Live click-through is covered by the
 * local smoke run.
 */

const ROOT = join(__dirname, "..", "..");
const COMPONENTS = join(ROOT, "components");

function componentFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return componentFiles(full);
    return extname(entry) === ".tsx" ? [full] : [];
  });
}

function read(relative: string): string {
  return readFileSync(join(COMPONENTS, relative), "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
}

const tabs = read("marketplace-tabs.tsx");
/** The two panes that serve a marketplace whose direction is not verified. */
const feed = read("unresolved-message-list.tsx") + read("unresolved-message-view.tsx");
const workspace = read("workspace.tsx");

describe("all five tabs are present and active", () => {
  it("renders every marketplace, in the required order", () => {
    expect(MARKETPLACE_TAB_ORDER).toEqual(["ebay", "amazon", "shopify", "bandq", "temu"]);
    expect([...MARKETPLACE_TAB_ORDER].sort()).toEqual([...MARKETPLACES].sort());
    // The tab strip iterates the full order rather than a filtered subset, so
    // no marketplace can be omitted without changing the shared order itself.
    expect(tabs).toContain("MARKETPLACE_TAB_ORDER.map");
    expect(tabs).not.toMatch(/MARKETPLACE_TAB_ORDER\s*\.\s*filter/);
  });

  it("reports every marketplace as active", () => {
    for (const marketplace of MARKETPLACE_TAB_ORDER) {
      expect(isMarketplaceActive(marketplace)).toBe(true);
    }
  });

  it("disables no tab", () => {
    const code = stripComments(tabs);
    expect(code).not.toMatch(/\bdisabled\b/);
    expect(code).not.toMatch(/aria-disabled/);
    expect(code).not.toMatch(/pointer-events-none/);
    // Every tab gets the same onClick; none is conditionally withheld.
    expect(code).toMatch(/onClick=\{\(\) => onSelect\(marketplace\)\}/);
  });

  it("greys out or annotates no tab as unavailable", () => {
    const code = stripComments(tabs);
    for (const phrase of ["Not enabled", "Coming soon", "coming soon", "Unavailable", "opacity-55"]) {
      expect(code).not.toContain(phrase);
    }
  });

  it("keeps no not-enabled panel anywhere in the interface", () => {
    for (const file of componentFiles(COMPONENTS)) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(code).not.toMatch(/is not enabled yet/i);
      expect(code).not.toMatch(/marketplace-unavailable/);
    }
  });
});

describe("every marketplace gets a list-left, detail-right layout", () => {
  it("renders every list and both detail panes", () => {
    for (const component of [
      "InboxList",
      "ConversationView",
      "UnresolvedMessageList",
      "UnresolvedMessageView",
    ]) {
      expect(workspace).toContain(`<${component}`);
    }
    // One layout now, not two branches: a list sidebar and a context sidebar.
    // Both lists live in the first, so neither can be dropped without also
    // dropping its component above.
    expect(workspace.match(/<aside/g) ?? []).toHaveLength(2);
  });

  /**
   * Both lists are reachable in every marketplace.
   *
   * The layout used to branch on the feed, and because every marketplace is
   * conversation-backed the unresolved branch was dead -- around 4,200 stored
   * messages had no route to the screen. A reintroduced branch would hide them
   * again, so the ternary is what this guards against.
   */
  it("does not gate either list behind a feed branch", () => {
    expect(workspace).not.toMatch(/conversationBackeds*?/);
    const listBlock = workspace.slice(
      workspace.indexOf("<InboxList"),
      workspace.indexOf("</aside>"),
    );
    expect(listBlock).toContain("<UnresolvedMessageList");
  });

  it("keeps one sidebar width for the list column", () => {
    expect(workspace).toContain("320px_minmax(0,1fr)");
  });

  it("selects an ungrouped message without issuing a request", () => {
    // The feed already holds every message and there is no thread to expand,
    // so selection is local. A fetch here would be a new API dependency.
    const handler = workspace.slice(
      workspace.indexOf("const selectMessage"),
      workspace.indexOf("const select ="),
    );
    expect(handler).toContain("setSelectedId(id)");
    expect(handler).not.toContain("fetch(");
  });
});

describe("marketplace isolation", () => {
  it("clears every piece of per-marketplace state when the tab changes", () => {
    const handler = workspace.slice(
      workspace.indexOf("const switchMarketplace"),
      workspace.indexOf("const select"),
    );
    for (const cleared of [
      "setInbox(null)",
      "setInboxError(null)",
      "setSelectedId(null)",
      "setDetail(null)",
      "setDetailError(null)",
      "setFeed(null)",
      "setFeedError(null)",
    ]) {
      expect(handler).toContain(cleared);
    }
  });

  it("scopes every list request to the selected marketplace", () => {
    expect(workspace).toContain("/api/conversations?marketplace=${marketplace}");
    expect(workspace).toContain("/api/marketplace-messages?marketplace=${marketplace}");
    expect(workspace).toContain("/api/conversations/no-rule?marketplace=${marketplace}");
  });

  /**
   * THE DETAIL REQUEST STILL NAMES A MARKETPLACE, and the thread it opens still
   * belongs to the tab that ends up on screen.
   *
   * This used to assert the literal `?marketplace=${marketplace}` — the
   * SELECTED tab, always. That was the whole guarantee while every selection
   * came from a list inside one tab. The notification drawer is global and can
   * hand back a conversation from another marketplace, so `select` now takes
   * the marketplace as an argument, defaulting to the selected one.
   *
   * The guarantee is unchanged and is asserted in three parts rather than one,
   * because it is now upheld by a default plus a rule rather than by a single
   * literal:
   *
   *   1. The request is still parameterised by a marketplace — the server-side
   *      404 on a mismatch is still doing its job, so a stale id cannot surface
   *      one marketplace's thread inside another's tab.
   *   2. The parameter DEFAULTS to the selected marketplace, so every existing
   *      caller — the inbox list, the No Rule list — is byte-identical.
   *   3. The one caller that overrides it switches the tab to the SAME value in
   *      the same handler, so the thread on screen always belongs to the tab on
   *      screen. Asserted here as well as in the notification guard, because
   *      this is the property that would break silently.
   */
  it("opens a conversation only in the marketplace it belongs to", () => {
    expect(workspace).toContain("/api/conversations/${id}?marketplace=${from}");
    expect(workspace).toContain("async (id: string, from: Marketplace = marketplace)");
    expect(workspace).toContain("onSelect={(id) => void select(id)}");

    const overrides = [...workspace.matchAll(/select\(\s*id\s*,\s*(\w+)\s*\)/g)].map(
      ([, argument]) => argument,
    );
    expect(overrides.length).toBeGreaterThan(0);
    for (const argument of overrides) {
      expect(workspace).toContain(
        `if (${argument} !== marketplace) switchMarketplace(${argument});`,
      );
    }
  });
});

describe("unresolved sources are presented neutrally", () => {
  it("labels no message as customer or CST reply", () => {
    const code = stripComments(feed);
    for (const label of ["Customer", "CST reply", "Inbound", "Outbound", "inbound", "outbound"]) {
      expect(code).not.toContain(label);
    }
  });

  it("implies no direction through alignment", () => {
    const code = stripComments(feed);
    for (const alignment of ["justify-end", "justify-start", "ml-auto", "mr-auto", "messageSide"]) {
      expect(code).not.toContain(alignment);
    }
  });

  it("reads no direction field, because the view carries none", () => {
    expect(stripComments(feed)).not.toMatch(/\.direction\b/);
  });

  it("shows no verification caveat, because the layout already makes no claim", () => {
    expect(feed).not.toContain("CapabilityNotices");
    for (const marketplace of ["shopify", "amazon"] as const) {
      const capability = capabilityOf(marketplace) as Record<string, unknown>;
      expect(capability.sourceNotices).toBeUndefined();
    }
  });

  it("exposes no debug vocabulary in the copy it renders", () => {
    // Identifiers such as `UnresolvedMessageFeed` are not in scope — they are
    // never read by a user. What is in scope is the text the feed puts on
    // screen: its own literals plus the copy constants it renders.
    const literals = [
      ...stripComments(feed).matchAll(/["'`]([^"'`\n]{4,})["'`]/g),
    ].map(([, text]) => text);
    const rendered = [...literals, FEED_NOT_PROVISIONED_TEXT].join(" ").toLowerCase();
    for (const jargon of [
      "not yet verified",
      "not yet resolved",
      "direction",
      "grouping",
      "ungrouped",
      "needs context",
      "source reference",
    ]) {
      expect(rendered).not.toContain(jargon);
    }
  });

  it("presents messages as a flat list, not as conversations", () => {
    const code = stripComments(feed);
    expect(code).not.toMatch(/conversation/i);
    expect(code).not.toMatch(/thread/i);
  });
});

describe("directional sources keep their labels", () => {
  it("still renders both sides for a source that records direction", () => {
    const conversation = stripComments(read("conversation-view.tsx"));
    expect(conversation).toContain("messageSide");
    expect(conversation).toContain("Customer");
    expect(conversation).toContain("CST reply");
  });
});

describe("no fabricated identity is displayed", () => {
  it("never prints a stored reference where a customer name belongs", () => {
    // conversationTitle decides from the capability whether the stored value is
    // a real handle. Printing it raw would present an order number as a person.
    for (const file of ["inbox-list.tsx", "conversation-view.tsx"]) {
      const code = stripComments(read(file));
      expect(code).toContain("conversationTitle(");
      expect(code).not.toMatch(/\{\s*(item|conversation)\.counterpartyRef\s*\}/);
    }
  });
});

describe("no send control", () => {
  it("exposes nothing capable of transmitting a reply", () => {
    for (const file of componentFiles(COMPONENTS)) {
      const code = readFileSync(file, "utf8");
      for (const pattern of [/>\s*Send\b/, /\bonSend\b/, /Copy Reply/, /Open Marketplace/]) {
        expect(code).not.toMatch(pattern);
      }
    }
  });
});
