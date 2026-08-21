import { z } from "zod";

/**
 * Marketplace scope.
 *
 * All five marketplaces are in scope and all five are active. They differ in
 * what their source can honestly prove — direction, conversation grouping,
 * customer identity — and that difference is expressed as a capability mode in
 * `marketplace-capabilities.ts`, never as an enabled/disabled switch.
 *
 * Hiding or disabling a marketplace whose mapping is incomplete would state
 * something untrue ("nothing here") about data that demonstrably exists. The
 * interface shows the data and labels what is unknown instead.
 */
export const MARKETPLACES = ["ebay", "amazon", "shopify", "bandq", "temu"] as const;

export type Marketplace = (typeof MARKETPLACES)[number];

export const marketplaceSchema = z.enum(MARKETPLACES);
