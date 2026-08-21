import { describe, expect, it } from "vitest";

import { MARKETPLACES } from "@/lib/domain/marketplace";
import {
  CONVERSATION_MARKETPLACES,
  MARKETPLACE_CAPABILITIES,
  MARKETPLACE_TAB_ORDER,
  UNRESOLVED_FEED_MARKETPLACES,
  capabilityOf,
  isMarketplaceActive,
  parseMarketplace,
  parseMarketplaceForFeed,
} from "@/lib/domain/marketplace-capabilities";

describe("tab order", () => {
  it("is exactly eBay, Amazon, Shopify, B&Q, Temu", () => {
    expect(MARKETPLACE_TAB_ORDER).toEqual(["ebay", "amazon", "shopify", "bandq", "temu"]);
  });

  it("labels every tab with a business name, not a source name", () => {
    expect(MARKETPLACE_TAB_ORDER.map((m) => capabilityOf(m).label)).toEqual([
      "eBay",
      "Amazon",
      "Shopify",
      "B&Q",
      "Temu",
    ]);
  });

  it("declares a capability for every marketplace, and no extras", () => {
    expect([...MARKETPLACE_TAB_ORDER].sort()).toEqual([...MARKETPLACES].sort());
    for (const marketplace of MARKETPLACE_TAB_ORDER) {
      expect(MARKETPLACE_CAPABILITIES[marketplace]).toBeDefined();
      expect(MARKETPLACE_CAPABILITIES[marketplace].marketplace).toBe(marketplace);
    }
  });
});

describe("every marketplace is active", () => {
  it("activates all five, with no disabled state to fall into", () => {
    for (const marketplace of MARKETPLACE_TAB_ORDER) {
      expect(isMarketplaceActive(marketplace)).toBe(true);
    }
  });

  it("exposes no disabled/not-enabled vocabulary at all", () => {
    const serialised = JSON.stringify(MARKETPLACE_CAPABILITIES).toLowerCase();
    for (const term of ["not_enabled", "disabled", "disabledreason", "coming soon"]) {
      expect(serialised).not.toContain(term);
    }
  });

  it("serves every marketplace from exactly one feed", () => {
    expect([...CONVERSATION_MARKETPLACES, ...UNRESOLVED_FEED_MARKETPLACES].sort()).toEqual(
      [...MARKETPLACE_TAB_ORDER].sort(),
    );
    for (const marketplace of CONVERSATION_MARKETPLACES) {
      expect(UNRESOLVED_FEED_MARKETPLACES).not.toContain(marketplace);
    }
  });
});

describe("capability modes", () => {
  it("assigns each marketplace the mode its source evidence supports", () => {
    expect(capabilityOf("ebay").mode).toBe("full");
    expect(capabilityOf("amazon").mode).toBe("full");
    expect(capabilityOf("shopify").mode).toBe("full");
    expect(capabilityOf("bandq").mode).toBe("degraded");
    expect(capabilityOf("temu").mode).toBe("degraded");
  });

  it("keeps eBay two-sided and warning-free", () => {
    const ebay = capabilityOf("ebay");
    expect(ebay.feed).toBe("conversations");
    expect(ebay.directionVerified).toBe(true);
    expect(ebay.hasOutboundHistory).toBe(true);
    expect(ebay.counterpartyIdentityVerified).toBe(true);
    expect(ebay.conversationReferenceKind).toBe("customer_handle");
  });

  it("declares Amazon two-sided, and never inbound-only", () => {
    // An earlier reading concluded inbound-only because no company domain
    // appears in the sender field. Amazon relays both directions through its
    // own domains, so that proved nothing — and 4,293 CST replies are present.
    // Direction now comes from the two sender fields; see the adapter.
    const amazon = capabilityOf("amazon");
    expect(amazon.feed).toBe("conversations");
    expect(amazon.directionVerified).toBe(true);
    expect(amazon.hasOutboundHistory).toBe(true);
    expect(amazon.mode).not.toBe("inbound_only");
    // The relay address is still not a customer identity.
    expect(amazon.counterpartyIdentityVerified).toBe(false);
    expect(amazon.referenceNoun).toBe("Order");
  });

  it("declares B&Q and Temu inbound-verified but unresolved for grouping/context", () => {
    for (const marketplace of ["bandq", "temu"] as const) {
      const capability = capabilityOf(marketplace);
      expect(capability.feed).toBe("conversations");
      expect(capability.directionVerified).toBe(true);
      expect(capability.hasOutboundHistory).toBe(false);
      expect(capability.groupingVerified).toBe(false);
      expect(capability.counterpartyIdentityVerified).toBe(false);
    }
  });

  it("proves nothing beyond the message itself for an unresolved source", () => {
    const shopify = capabilityOf("shopify");
    // Direction is now decided by the two addresses against the company-domain
    // list, so every STORED Shopify message has one. The messages whose
    // addresses do not decide it never become conversations at all.
    expect(shopify.mode).toBe("full");
    expect(shopify.feed).toBe("conversations");
    expect(shopify.directionVerified).toBe(true);
    expect(shopify.hasOutboundHistory).toBe(true);
    // Still unproven: this source carries suppliers, couriers and platform
    // mail beside customers, so an address is not a customer identity.
    expect(shopify.counterpartyIdentityVerified).toBe(false);
    expect(shopify.groupingVerified).toBe(false);
  });

  it("leaves no marketplace claiming an unverified direction", () => {
    for (const marketplace of MARKETPLACE_TAB_ORDER) {
      expect(capabilityOf(marketplace).directionVerified).toBe(true);
    }
  });
});

describe("notice copy", () => {
  it("carries no per-marketplace notice copy at all", () => {
    // The capability now exposes only flags and names. What the interface may
    // claim is enforced by the layout those flags select, not by a caption
    // beside it, so there is no notice field for one to reappear in.
    for (const marketplace of MARKETPLACE_TAB_ORDER) {
      const capability = capabilityOf(marketplace) as Record<string, unknown>;
      for (const field of ["sourceNotices", "unresolvedContextNotice", "disabledReason"]) {
        expect(capability[field]).toBeUndefined();
      }
    }
  });

  it("exposes no verification or debug vocabulary anywhere in the copy", () => {
    const allCopy = MARKETPLACE_TAB_ORDER.flatMap((m) => [
      capabilityOf(m).label,
      capabilityOf(m).referenceNoun ?? "",
    ])
      .join(" ")
      .toLowerCase();
    for (const jargon of [
      "not yet verified",
      "not yet resolved",
      "unverified",
      "unresolved",
      "direction",
      "grouping",
      "source reference",
      "ungrouped",
      "needs context",
      "current source",
      "mapping",
    ]) {
      expect(allCopy).not.toContain(jargon);
    }
  });

  it("names no source table, column or database in user-facing copy", () => {
    // Only what a CST agent reads. Internal discriminators such as the feed
    // name are not shown and are not in scope here.
    const allCopy = MARKETPLACE_TAB_ORDER.flatMap((m) => [
      capabilityOf(m).label,
      capabilityOf(m).referenceNoun ?? "",
    ])
      .join(" ")
      .toLowerCase();
    for (const internal of [
      "ledsone",
      "customer_service",
      "cst_app",
      "_messages",
      "folder_id",
      "sub_source",
      "order_id",
      "asin",
    ]) {
      expect(allCopy).not.toContain(internal);
    }
  });
});

describe("conversation reference presentation", () => {
  it("marks eBay's reference as a real customer handle and no other's", () => {
    for (const marketplace of MARKETPLACE_TAB_ORDER) {
      const capability = capabilityOf(marketplace);
      const isHandle = capability.conversationReferenceKind === "customer_handle";
      expect(isHandle).toBe(marketplace === "ebay");
      expect(capability.counterpartyIdentityVerified).toBe(isHandle);
    }
  });

  it("names the reference the way an agent would, or not at all", () => {
    // B&Q puts this order number on the message itself, so an agent will
    // recognise it. Temu supplies no reference to title with, and eBay's is a
    // real customer handle — neither declares a noun.
    expect(capabilityOf("bandq").referenceNoun).toBe("Order");
    expect(capabilityOf("temu").referenceNoun).toBeUndefined();
    expect(capabilityOf("ebay").referenceNoun).toBeUndefined();
  });
});

describe("feed allowlists", () => {
  it("routes conversation-backed marketplaces to the conversation feed only", () => {
    expect(CONVERSATION_MARKETPLACES).toEqual(["ebay", "amazon", "shopify", "bandq", "temu"]);
    for (const marketplace of CONVERSATION_MARKETPLACES) {
      expect(parseMarketplaceForFeed(marketplace, "conversations")).toBe(marketplace);
      expect(parseMarketplaceForFeed(marketplace, "unresolved_messages")).toBeNull();
    }
  });

  it("routes no marketplace to the unresolved feed, now that all five decide direction", () => {
    // The unresolved store still holds Shopify's ambiguous remainder, but no
    // marketplace TAB is served from it, so the feed has an empty allowlist and
    // its route rejects every request.
    expect(UNRESOLVED_FEED_MARKETPLACES).toEqual([]);
    for (const marketplace of MARKETPLACE_TAB_ORDER) {
      expect(parseMarketplaceForFeed(marketplace, "unresolved_messages")).toBeNull();
    }
  });

  it("rejects anything outside the allowlist", () => {
    const hostile = [
      "",
      "EBAY",
      "ebay ",
      "conversations",
      "cst_app.conversations",
      "'; DROP TABLE x--",
      "*",
      null,
    ];
    for (const bad of hostile) {
      expect(parseMarketplace(bad)).toBeNull();
      expect(parseMarketplaceForFeed(bad, "conversations")).toBeNull();
      expect(parseMarketplaceForFeed(bad, "unresolved_messages")).toBeNull();
    }
  });

  it("accepts every tab name through the tab-level parser", () => {
    for (const marketplace of MARKETPLACE_TAB_ORDER) {
      expect(parseMarketplace(marketplace)).toBe(marketplace);
    }
  });
});

describe("no send capability", () => {
  it("declares nothing that could transmit a reply", () => {
    const serialised = JSON.stringify(MARKETPLACE_CAPABILITIES).toLowerCase();
    for (const term of ["cansend", "sendenabled", "outboundapi", "credentials", "queue", "retry"]) {
      expect(serialised).not.toContain(term);
    }
  });
});
