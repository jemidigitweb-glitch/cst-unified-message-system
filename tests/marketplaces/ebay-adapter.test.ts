import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EBAY_ORDER_BY,
  EBAY_SOURCE,
  counterpartyOf,
  decodeBody,
  directionFromFolderId,
  isSystemNotice,
} from "@/lib/marketplaces/ebay/adapter";

describe("eBay direction mapping", () => {
  it("maps folder_id 0 to an inbound customer message", () => {
    expect(directionFromFolderId(0)).toBe("inbound");
  });

  it("maps folder_id 1 to a previous CST reply", () => {
    expect(directionFromFolderId(1)).toBe("outbound");
  });

  it("refuses to guess an unmapped folder_id", () => {
    expect(() => directionFromFolderId(2)).toThrow(/Unmapped/);
    expect(() => directionFromFolderId(-1)).toThrow(/Unmapped/);
  });

  it("reads the counterparty from the column matching the direction", () => {
    expect(counterpartyOf({ folderId: 0, senderId: "buyer", receiverId: "seller" })).toBe("buyer");
    expect(counterpartyOf({ folderId: 1, senderId: "seller", receiverId: "buyer" })).toBe("buyer");
  });
});

describe("eBay system notices", () => {
  it("identifies a notice by absent type and absent body", () => {
    expect(isSystemNotice({ messageType: null, extMessageId: null })).toBe(true);
  });

  it("does not treat a real message as a notice", () => {
    expect(isSystemNotice({ messageType: "AskSellerQuestion", extMessageId: "12" })).toBe(false);
    expect(isSystemNotice({ messageType: null, extMessageId: "12" })).toBe(false);
    expect(isSystemNotice({ messageType: "ContactEbayMember", extMessageId: null })).toBe(false);
  });
});

describe("eBay body decoding", () => {
  it("decodes a JSON-encoded string body", () => {
    expect(decodeBody(JSON.stringify("Hi, regarding your order"))).toEqual({
      text: "Hi, regarding your order",
      status: "decoded",
    });
  });

  it("preserves unicode escapes through a JSON parse rather than regex", () => {
    expect(decodeBody('"Sk\\u00e1li"').text).toBe("Skáli");
    expect(decodeBody('"line1\\nline2"').text).toBe("line1\nline2");
  });

  it("treats a JSON null body as empty, not an error", () => {
    expect(decodeBody("null")).toEqual({ text: null, status: "empty" });
    expect(decodeBody(null)).toEqual({ text: null, status: "empty" });
  });

  it("reports malformed input instead of throwing", () => {
    expect(decodeBody("{not json")).toEqual({ text: null, status: "failed" });
    expect(decodeBody('{"a":1}')).toEqual({ text: null, status: "failed" });
  });
});

describe("eBay source identifiers", () => {
  it("realises the neutral ordering intent with eBay's own columns", () => {
    expect(EBAY_ORDER_BY).toBe("ORDER BY receive_date ASC, id ASC");
    expect(EBAY_SOURCE.timestampColumn).toBe("receive_date");
    expect(EBAY_SOURCE.pkColumn).toBe("id");
  });
});

describe("marketplace-specific detail stays in the adapter", () => {
  const DOMAIN_DIR = join(__dirname, "..", "..", "lib", "domain");
  const EBAY_TERMS = [
    "folder_id",
    "ebay_message_headers",
    "ebay_messages",
    "receive_date",
    "ext_message_id",
    "customer_service",
  ];

  function domainFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return domainFiles(full);
      return extname(entry) === ".ts" ? [full] : [];
    });
  }

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
  }

  it("keeps eBay tables, columns and encodings out of lib/domain", () => {
    const offenders: string[] = [];
    for (const file of domainFiles(DOMAIN_DIR)) {
      const source = stripComments(readFileSync(file, "utf8")).toLowerCase();
      for (const term of EBAY_TERMS) {
        if (source.includes(term)) offenders.push(`${file} :: ${term}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("exports no eBay-named symbol from lib/domain", async () => {
    const modules: Record<string, unknown>[] = await Promise.all([
      import("@/lib/domain/message"),
      import("@/lib/domain/threading"),
      import("@/lib/domain/order"),
      import("@/lib/domain/sku"),
      import("@/lib/domain/workflow"),
      import("@/lib/domain/marketplace"),
    ]);
    for (const loaded of modules) {
      for (const name of Object.keys(loaded)) {
        expect(name.toLowerCase()).not.toContain("ebay");
      }
    }
  });
});
