import { describe, expect, it } from "vitest";

import {
  UNRESOLVED_REFERENCE_PREFIX,
  isUnresolvedReference,
  unresolvedReferenceFor,
} from "@/lib/domain/conversation-reference";
import { conversationTitle } from "@/lib/domain/inbox";
import { capabilityOf } from "@/lib/domain/marketplace-capabilities";

describe("ungrouped sentinel", () => {
  it("derives from the immutable source PK, so a re-run is stable", () => {
    expect(unresolvedReferenceFor("42")).toBe(`${UNRESOLVED_REFERENCE_PREFIX}42`);
    expect(unresolvedReferenceFor("42")).toBe(unresolvedReferenceFor("42"));
  });

  it("is recognisable, so it never reaches the interface as a value", () => {
    expect(isUnresolvedReference(unresolvedReferenceFor("42"))).toBe(true);
    expect(isUnresolvedReference("0000000001-A")).toBe(false);
    expect(isUnresolvedReference("")).toBe(false);
  });
});

describe("conversation title", () => {
  it("shows eBay's stored value directly, because it is a real handle", () => {
    expect(
      conversationTitle({ counterpartyRef: "buyer-handle" }, capabilityOf("ebay")),
    ).toBe("buyer-handle");
  });

  it("titles a referenced conversation as the marketplace plus its order", () => {
    expect(
      conversationTitle({ counterpartyRef: "1068193152-A" }, capabilityOf("bandq")),
    ).toBe("B&Q Order 1068193152-A");
  });

  it("titles a conversation with no reference as a plain enquiry", () => {
    expect(
      conversationTitle({ counterpartyRef: unresolvedReferenceFor("7") }, capabilityOf("bandq")),
    ).toBe("B&Q enquiry");
    expect(
      conversationTitle({ counterpartyRef: unresolvedReferenceFor("7") }, capabilityOf("temu")),
    ).toBe("Temu enquiry");
  });

  it("uses no debug vocabulary in any title", () => {
    // eBay is excluded: its reference is a real customer handle rendered
    // verbatim, so the title is whatever the customer's handle happens to be.
    const titles = (["bandq", "temu"] as const).flatMap((marketplace) => [
      conversationTitle({ counterpartyRef: "1068193152-A" }, capabilityOf(marketplace)),
      conversationTitle(
        { counterpartyRef: unresolvedReferenceFor("7") },
        capabilityOf(marketplace),
      ),
    ]);
    for (const title of titles) {
      for (const jargon of ["ungrouped", "source reference", "unresolved", "needs context"]) {
        expect(title.toLowerCase()).not.toContain(jargon);
      }
    }
  });

  it("never leaks the internal sentinel into user-facing text", () => {
    for (const marketplace of ["ebay", "bandq", "temu"] as const) {
      const title = conversationTitle(
        { counterpartyRef: unresolvedReferenceFor("7") },
        capabilityOf(marketplace),
      );
      if (marketplace !== "ebay") expect(title).not.toContain(UNRESOLVED_REFERENCE_PREFIX);
    }
  });

  it("falls back to the marketplace plus the bare reference when no noun is declared", () => {
    expect(
      conversationTitle({ counterpartyRef: "ref-1" }, capabilityOf("temu")),
    ).toBe("Temu ref-1");
  });
});
