import { describe, expect, it } from "vitest";

import { asExactSku, looksLikeCombo, skuEquals } from "@/lib/domain/sku";

const COMBO = "PSHYOS4BRBM+SPUPBM+LSDO210BM";
const PLAIN = "PCUPVC1015WH";

describe("SKU atomicity", () => {
  it("preserves a combo SKU byte-for-byte", () => {
    const sku = asExactSku(COMBO);
    expect(sku).toBe(COMBO);
    expect(sku.length).toBe(28);
    expect(Buffer.byteLength(sku, "utf8")).toBe(28);
  });

  it("treats a combo SKU as one identifier, never its parts", () => {
    const sku = asExactSku(COMBO);
    expect(skuEquals(sku, asExactSku("PSHYOS4BRBM"))).toBe(false);
    expect(skuEquals(sku, asExactSku("SPUPBM"))).toBe(false);
    expect(skuEquals(sku, asExactSku("LSDO210BM"))).toBe(false);
  });

  it("does not correct a documented SKU to match the database, or vice versa", () => {
    // Documentation elsewhere writes SLDO210BM; the database holds LSDO210BM.
    // The database value wins and the two must never compare equal.
    const fromDocs = asExactSku("PSHYOS4BRBM+SPUPBM+SLDO210BM");
    expect(skuEquals(asExactSku(COMBO), fromDocs)).toBe(false);
  });

  it("is case-sensitive and whitespace-significant", () => {
    expect(skuEquals(asExactSku(PLAIN), asExactSku(PLAIN.toLowerCase()))).toBe(false);
    expect(skuEquals(asExactSku(` ${PLAIN}`), asExactSku(PLAIN))).toBe(false);
  });

  it("flags combos for display without splitting them", () => {
    expect(looksLikeCombo(asExactSku(COMBO))).toBe(true);
    expect(looksLikeCombo(asExactSku(PLAIN))).toBe(false);
  });

  it("exposes no splitting or normalising helper", async () => {
    const skuModule = await import("@/lib/domain/sku");
    for (const name of Object.keys(skuModule)) {
      expect(name).not.toMatch(/split|normali[sz]e|parse|trim|reconstruct/i);
    }
  });

  it("rejects an empty SKU rather than substituting a default", () => {
    expect(() => asExactSku("")).toThrow();
  });
});
