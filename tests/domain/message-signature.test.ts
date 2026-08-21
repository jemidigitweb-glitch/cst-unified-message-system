import { describe, expect, it } from "vitest";

import { senderNameFromBody } from "@/lib/domain/message-signature";
import { unresolvedMessageTitle } from "@/lib/domain/unresolved-messages";
import { capabilityOf } from "@/lib/domain/marketplace-capabilities";

/**
 * Synthetic bodies shaped like the real ones. The names below are invented; no
 * real customer data appears in any test.
 */
function view(bodyText: string | null) {
  return { bodyText, bodyDecodeStatus: "decoded" as const };
}

describe("names a signed message", () => {
  it("reads a name after a blank line", () => {
    expect(senderNameFromBody("Thanks for your message.\n\nKind regards,\n\nZara")).toBe("Zara");
  });

  it("reads a name on the line immediately after the closing", () => {
    expect(senderNameFromBody("Please see attached.\nRegards,\nKarthi")).toBe("Karthi");
  });

  it("accepts the closings this data actually uses, in both languages", () => {
    const cases: [string, string][] = [
      ["Kind regards,", "Zara"],
      ["Best regards,", "Chasin"],
      ["Regards,", "Karthi"],
      ["Sincerely,", "Sanju"],
      ["Yours sincerely,", "Dhruv"],
      ["Many thanks", "Priya"],
      ["Mit freundlichen Grüßen,", "Sanju"],
      ["Viele Grüße,", "Zara"],
    ];
    for (const [closing, name] of cases) {
      expect(senderNameFromBody(`Body text.\n\n${closing}\n\n${name}`)).toBe(name);
    }
  });

  it("tolerates a closing with no trailing comma", () => {
    expect(senderNameFromBody("Body.\n\nMit freundlichen Grüßen\n\nSanju")).toBe("Sanju");
  });

  it("accepts the punctuation real names carry", () => {
    for (const name of ["Anne-Marie", "O'Neill", "J. Smith", "Mary Anne Clarke"]) {
      expect(senderNameFromBody(`Body.\n\nKind regards,\n\n${name}`)).toBe(name);
    }
  });

  it("takes the last sign-off, so a quoted reply does not win", () => {
    const body = "Kind regards,\n\nKarthi\n\nOn Monday you wrote:\n\nRegards,\n\nZara";
    expect(senderNameFromBody(body)).toBe("Zara");
  });
});

describe("refuses anything it is not sure about", () => {
  it("returns null for an unsigned message", () => {
    expect(
      senderNameFromBody("When will a courier be coming? I need to be home."),
    ).toBeNull();
  });

  it("returns null for a closing with no name after it", () => {
    expect(senderNameFromBody("We are unable to dispatch your order.\n\nKind regards,")).toBeNull();
  });

  it("does not mistake a sentence containing a closing word for a sign-off", () => {
    // The line must be the closing and nothing else.
    expect(senderNameFromBody("Thanks again for your cooperation.\nSteve")).toBeNull();
    expect(senderNameFromBody("Please accept our regards for the delay.\nSteve")).toBeNull();
  });

  it("rejects an organisation or role signature", () => {
    for (const signature of [
      "Your B&Q Customer Services team",
      "Temu team",
      "Shopify Growth Specialist",
      "Seller Support",
      "Acme Ltd",
    ]) {
      expect(senderNameFromBody(`Body.\n\nKind regards,\n\n${signature}`)).toBeNull();
    }
  });

  it("rejects a line that is an address, a link or a phone number", () => {
    for (const line of [
      "Unit 3, Marshbrook Close",
      "https://example.invalid/orders",
      "+44 7700 900000",
      "someone@example.invalid",
    ]) {
      expect(senderNameFromBody(`Body.\n\nKind regards,\n\n${line}`)).toBeNull();
    }
  });

  it("returns null for a raw header blob or an empty body", () => {
    expect(senderNameFromBody("X-PQ-Received: mpq-producer\nReceived-SPF: pass")).toBeNull();
    expect(senderNameFromBody(null)).toBeNull();
    expect(senderNameFromBody("")).toBeNull();
  });
});

describe("sidebar title", () => {
  it("uses the signature when there is one", () => {
    expect(
      unresolvedMessageTitle(view("Body.\n\nKind regards,\n\nZara"), capabilityOf("shopify")),
    ).toBe("Zara");
  });

  it("falls back to a neutral marketplace title otherwise", () => {
    expect(unresolvedMessageTitle(view("Are you still accepting orders?"), capabilityOf("shopify"))).toBe(
      "Shopify message",
    );
    expect(unresolvedMessageTitle(view(null), capabilityOf("amazon"))).toBe("Amazon message");
  });

  it("never renders a body placeholder where a title belongs", () => {
    const title = unresolvedMessageTitle(
      { bodyText: null, bodyDecodeStatus: "empty" },
      capabilityOf("amazon"),
    );
    expect(title).toBe("Amazon message");
    expect(title.toLowerCase()).not.toContain("unavailable");
  });

  it("labels the name as nothing, since direction is not established", () => {
    // The signature says who wrote the message, not which side they are on.
    const title = unresolvedMessageTitle(
      view("Body.\n\nKind regards,\n\nZara"),
      capabilityOf("shopify"),
    );
    for (const claim of ["customer", "cst", "agent", "from", "to"]) {
      expect(title.toLowerCase()).not.toContain(claim);
    }
  });
});
