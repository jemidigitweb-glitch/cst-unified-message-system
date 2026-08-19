import { z } from "zod";

/**
 * Marketplace scope.
 *
 * Phase 1 ships eBay-first. eBay is the only channel where direction is a stored
 * field (`folder_id`) and where previous CST replies actually exist in the source
 * — Amazon, B&Q and Temu hold inbound messages only, and Shopify holds both
 * directions with no field distinguishing them. Shipping those now would render
 * half a conversation.
 *
 * The other channels are listed so the type exists and enabling one later is a
 * scope decision rather than a refactor. Only `ebay` is enabled.
 */
export const MARKETPLACES = ["ebay", "amazon", "shopify", "bandq", "temu"] as const;

export type Marketplace = (typeof MARKETPLACES)[number];

export const marketplaceSchema = z.enum(MARKETPLACES);

export const ENABLED_MARKETPLACES: readonly Marketplace[] = ["ebay"];

export function isEnabled(marketplace: Marketplace): boolean {
  return ENABLED_MARKETPLACES.includes(marketplace);
}
