/**
 * SKU atomicity.
 *
 * A SKU is ONE opaque identifier. The database value is authoritative and always
 * wins over any example written in documentation.
 *
 * Never split on `+`, trim, normalise, case-fold, reconstruct, or interpret
 * separators. `PSHYOS4BRBM+SPUPBM+LSDO210BM` is a single SKU with its own product
 * master row; its components are already decomposed upstream in
 * `order_management.order_combo`, so the application never needs to parse one.
 *
 * There is deliberately no `parseSku`, `splitSku`, or `normalizeSku` in this
 * codebase. This module exists to make that absence explicit and testable.
 */

/** An exact source SKU value. Branded so a normalised string cannot be passed by mistake. */
export type ExactSku = string & { readonly __brand: "ExactSku" };

/**
 * Wraps a raw database value as an ExactSku, verifying it was not altered in
 * transit. Throws rather than silently repairing — a mutated SKU is a bug, not
 * something to correct.
 */
export function asExactSku(raw: string): ExactSku {
  if (raw.length === 0) throw new Error("SKU is empty");
  if (raw !== raw.normalize("NFC")) {
    throw new Error("SKU is not in its original byte form (unicode-normalised)");
  }
  return raw as ExactSku;
}

/** Exact, case-sensitive equality. The only comparison a SKU supports. */
export function skuEquals(a: ExactSku, b: ExactSku): boolean {
  return a === b;
}

/**
 * Reports whether a SKU is a combo, for display purposes only.
 * This must NEVER be used to split the value — combo components come from
 * `order_management.order_combo`, keyed by `order_item_info_id`.
 */
export function looksLikeCombo(sku: ExactSku): boolean {
  return sku.includes("+");
}
