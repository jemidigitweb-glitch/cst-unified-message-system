import "server-only";

import type { VerifiedFact } from "@/lib/domain/draft";
import {
  type Queryable as SourceQueryable,
  findSotProductBySku,
  findSotProductForListing,
} from "@/lib/repositories/sot-product-repository";

/**
 * Verified PRODUCT facts from the SOT catalogue, for a conversation that has no
 * resolved order — a pre-sale enquiry.
 *
 * WHAT PROBLEM THIS SOLVES. A customer asking "what's the diameter?" or "will an
 * E27 bulb fit?" before buying produces no order, so `resolveEbayOrderContext`
 * returns nothing and the prompt says, correctly, that no product has been
 * verified. `extractCustomerProductData` already surfaces the QUESTION under
 * "Customer product data" and is explicit that it holds unverified claims and
 * consults no catalogue. This is the other half: the catalogue's own answer,
 * from the source database, under the VERIFIED heading.
 *
 * IT NEVER GUESSES, and that is measured rather than asserted. Over eBay's last
 * 180 days, 3,170 inbound pre-sale (`AskSellerQuestion`) messages produced only
 * 8 that sit on a single-SKU listing. Everything else is a multi-variation
 * listing where the customer's words cannot identify one variant: a conservative
 * matcher over `selected_variations` resolved 18 of 264 uniquely and refused the
 * other 246, and only 2 of those 18 had a SOT row at all. So this resolver does
 * not attempt variant matching. It answers only where the listing itself has one
 * SKU, and returns nothing everywhere else.
 *
 * SCOPED TO EBAY. Amazon carries an ASIN rather than an item_id and would need
 * its own join through `listings.amazon_listings`; Shopify, Temu and B&Q carry no
 * listing reference at all (`listingItemRef` is null by construction). All of
 * them return no facts, unchanged from today.
 *
 * NOT CACHED, and deliberately not: unlike `resolveEbayOrderContext` this writes
 * no snapshot and reads none. There is nothing to resolve ONCE here — a listing's
 * catalogue attributes are not a per-conversation finding, and storing them would
 * put a copy of a Google Sheet mirror behind a second, staler mirror.
 *
 * READ-ONLY. One SELECT for the parent SKU, one for the attributes. Nothing here
 * writes anywhere.
 */

export type ConversationForSotProductContext = {
  readonly marketplace: string;
  readonly subSourceId: number | null;
  readonly listingItemRef: string | null;
};

const EMPTY: VerifiedFact[] = [];

/**
 * WHICH ATTRIBUTES MAY BE STATED — decided by family, not by enumeration.
 *
 * WHY THIS IS A DENYLIST. The first version named the seventeen attributes a
 * reply could use. It was safe and it did not work: SOT holds `table_lamp = Y`
 * for every lampshade, and because nobody had added that key to the list, a
 * customer asking "can this be used on a table lamp?" was answered with a
 * request for their voltage and wattage — the model had no fact that answered
 * the question and the CST compatibility rule then required it to ask. Every new
 * sheet column would have repeated that, one code change at a time.
 *
 * SO THE FILTER DESCRIBES WHAT MUST NOT BE SAID, and a new column carrying a
 * physical property flows to a draft with no code change at all. That is the
 * point of this design, and it is also its risk: this fails OPEN where the
 * allowlist failed CLOSED. Two things hold the line.
 *
 *   1. THE FAMILIES BELOW are named after how this sheet is actually organised —
 *      channel prefixes, money suffixes, metric abbreviations — not after
 *      individual columns. Every one was checked against all 413 live keys.
 *   2. `statableValue` REJECTS BY SHAPE as well as by name: a URL, a currency
 *      figure, an over-long block of text and the sheet's own `[VERIFY]` marker
 *      are refused whatever the column is called. A new commercial column
 *      usually announces itself in its value even when its name is novel.
 *
 * NOTHING IS RENAMED, DESCRIBED, MERGED OR INTERPRETED. `table_lamp` is sent as
 * `table_lamp: Y`, exactly as the sheet stores it. Turning that into "suitable
 * for table lamps" would be this layer deciding what a column means, and a
 * column whose meaning we have guessed is not a verified fact. The model does
 * the phrasing; this decides only what it is allowed to see.
 */
export const BLOCKED_SOT_ATTRIBUTE_PATTERNS: readonly string[] = [
  /*
   * NAMES THE PROMPT BUILDER WOULD MISFILE. This one is not about what the
   * column means — it is about where its value would land.
   *
   * `contextBlocks()` in `lib/ai/draft-assembly.ts` sorts facts into the ORDER
   * and PRODUCT halves of the prompt by testing the fact NAME against
   * /order|refund|tracking|delivery/i. A sheet column called `delivery_window`
   * or `tracking_ref` would therefore be printed to the model under "VERIFIED
   * CONTEXT — ORDER" — presented as something the backend established about
   * this customer's order, which it is not. With a fixed allowlist that could
   * not happen; with an open one it can, so it is blocked here.
   *
   * Deliberately UNBOUNDED, matching that regex exactly rather than more
   * strictly: `reorder_code` would be misfiled by the prompt builder too.
   */
  "(order|refund|tracking|delivery)",

  // MONEY. Any price, cost, bid, fee, revenue or margin, however prefixed.
  "(^|_)(gbp|usd|eur|price|cost|bid|fee|fees|rev|revenue|margin|rrp|roas|acos)(_|$)",

  // STOCK AND AVAILABILITY. A sheet mirror must never state what the warehouse
  // holds — live stock is `inventory.physical_product_stock`, and this snapshot
  // is days old.
  "(^|_)(stock|availability|available|inventory|backorder|lead_time)(_|$)",

  // PERFORMANCE AND VOICE-OF-CUSTOMER metrics. Internal analytics, never a
  // customer answer. Bare `rating`/`reviews` are deliberately NOT listed: they
  // would also block `switch_rating_a` and `current_rating_a`, which are
  // electrical specifications. The channel prefixes below catch the real ones.
  "(^|_)(ctr|cvr|bsr|buy_box|buybox|impressions|clicks|sessions|conversion|voc)(_|$)",

  // MARKETING, SEO AND PPC copy and terms.
  "(^|_)(seo|ppc|kw|keyword|keywords|search_terms|broad_match|phrase_match|exact_match|hashtags|social|promo|bullet|headline|caption|email_subject|long_tail)(_|$)",

  // SALES CHANNELS. Prefixes for the per-storefront columns (`eb_`, `amz_`,
  // `shp_`, `wf_`, `b_q_`) and the platform-specific fields. Every one is either
  // a listing identifier, a channel flag or channel marketing copy.
  "^(eb|amz|shp|wf|b_q)_",
  "^(ebay|amazon|shopify|wayfair|google|meta|b_q)($|_)",
  "(^|_)(asin|item_id|handle|listing|listings|title)(_|$)",

  // MEDIA AND SHEET MACHINERY. Image links, the 51 unnamed `listings_col_n`
  // columns, and anything carrying a row's provenance rather than the product's.
  "(^|_)(img|image|images)(_|$)",
  "(^|_)col_[0-9]+$",
  "(^|_)(sheet|synced|created|updated|source_tab|status)(_|$)",
  "(_|^)id$",

  // POLICY AND COMMITMENT. Warranty, returns, objections and related-product
  // suggestions are the team's decisions, not the product's properties — policy
  // comes from the CST rule base, and a recommendation is not a specification.
  "(^|_)(warranty|return|returns|refund|objection|obj|restricted_claims|positive_theme|rel)(_|$)",

  // COMPLIANCE AND CUSTOMS IDENTIFIERS. `rohs_compliant`, `halogen_free` and
  // `energy_class` are product properties and stay; the certificate and
  // registration numbers behind them are internal references.
  "(^|_)(cert|weee|hs_code)(_|$)",

  // FREIGHT AND FULFILMENT. Carrier formats, FBA tiers, postage costs and
  // chargeable-weight accounting. Package DIMENSIONS are physical and stay.
  "(^|_)(fba|postage|royal_mail|volumetric|chargeable|outer_weight|units_per_outer|label_req|label_required|fragile)(_|$)",
];

/** Compiled once. Case-insensitive, because a sheet header's case is not policy. */
const BLOCKED_SOT_ATTRIBUTES: readonly RegExp[] = BLOCKED_SOT_ATTRIBUTE_PATTERNS.map(
  (source) => new RegExp(source, "i"),
);

/** Whether this attribute name may reach a draft. Exported so a test can sweep the live schema. */
export function sotAttributeIsStatable(key: string): boolean {
  return !BLOCKED_SOT_ATTRIBUTES.some((pattern) => pattern.test(key));
}

/**
 * The sheet's own "not confirmed yet" marker.
 *
 * MATCHED AS A SUBSTRING, NOT AS THE WHOLE VALUE, and that is not fussiness:
 * 85,216 of 192,705 SOT cells contain it, of which 84,783 are the bare sentinel
 * and 433 have it embedded in otherwise-real text — `Room_Suitability` reads
 * "Kitchen, Dining, Hallway [VERIFY]". An equality check would pass those 433
 * through as facts, which is exactly the case the marker exists to prevent.
 */
const VERIFY_SENTINEL = /\[VERIFY\]/i;

/**
 * Words that would disarm the prohibited-claim check downstream.
 *
 * `ungroundedClaims` in `lib/domain/draft.ts` concatenates every fact NAME AND
 * VALUE into one string and then allows a prohibited claim — a refund decision,
 * a replacement decision, a tracking number, a delivery promise, a policy
 * exception — if that string contains the claim's first word. A product
 * attribute whose value happened to read "…covered by our returns policy" would
 * therefore quietly license the model to write "we have processed your refund"
 * without review.
 *
 * NO SOT VALUE MATCHES THIS TODAY — checked live across all 192,705 cells, zero
 * hits — so this drops nothing now. It is here because SOT is a Google Sheet
 * mirror: a future edit to a whitelisted column would otherwise weaken a safety
 * check in a file nobody was editing, with no signal that it had happened.
 */
const CLAIM_WORDS = /\b(?:refund|replacement|tracking|deliver|policy)/i;

/**
 * A link. Blocks image and listing URLs whatever the column is called.
 *
 * The name families above catch `img_link`, `img_main` and the rest, but a sheet
 * is edited by people and the next URL column will not necessarily be called
 * `img_` anything. A URL is never an answer to a product question.
 */
const LOOKS_LIKE_A_LINK = /\b(?:https?:\/\/|www\.)/i;

/** A currency figure. Blocks a price however its column is named. */
const LOOKS_LIKE_MONEY = /[£$€]\s*\d|\b\d+(?:[.,]\d{2})\s*(?:gbp|usd|eur)\b/i;

/**
 * Longest value this will state.
 *
 * The longest legitimate specification observed live is a ceiling rose's
 * `parts_list` at just over 200 characters. Anything materially longer is
 * marketing copy, a description, or a pasted block that nobody curated for a
 * customer reply — and it would crowd the prompt.
 */
const MAX_VALUE_LENGTH = 300;

/**
 * A stored SOT value this may state, or null.
 *
 * TWO INDEPENDENT FILTERS, and this is the second. The name families decide
 * which COLUMNS are product properties; this decides whether the VALUE is one.
 * They are deliberately not the same test: the denylist depends on somebody
 * having named a column recognisably, and this does not.
 *
 * Everything surviving is passed through EXACTLY as stored — no rounding, no
 * unit conversion, no title-casing, no expansion of "Y" into "Yes", no
 * rewording of a key into a sentence. A reviewer must be able to find every
 * value in the sheet by looking, which stops being true the moment this starts
 * tidying them up, and a value we have reworded is no longer the sheet's claim
 * but ours.
 */
export function statableValue(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_VALUE_LENGTH) return null;
  if (VERIFY_SENTINEL.test(trimmed)) return null;
  if (CLAIM_WORDS.test(trimmed)) return null;
  if (LOOKS_LIKE_A_LINK.test(trimmed)) return null;
  if (LOOKS_LIKE_MONEY.test(trimmed)) return null;
  return trimmed;
}

/**
 * The SOT product facts for one conversation, or an empty list.
 *
 * FACT NAMES ARE THE SOT KEYS VERBATIM — `diameter_mm`, `bulb_base_compat` —
 * and that is load-bearing in two ways. They fall into the PRODUCT/SKU half of
 * the prompt, because `contextBlocks()` in `lib/ai/draft-assembly.ts` buckets by
 * matching `/order|refund|tracking|delivery/i` against the fact name and none of
 * these match; and they are not in `RETURN_FACT_NAMES`, so none is mistaken for
 * a return fact. Neither that file nor the prompt needs to change.
 *
 * `sku` is included so a reviewer reading the draft's grounding can see WHICH
 * product these attributes describe. It is the same fact name
 * `resolveEbayOrderContext` uses for the same thing, and the two can never both
 * be present — see the caller, which only asks for SOT facts when no order
 * resolved.
 *
 * An empty list is returned for every unsafe case, and they are not
 * distinguished because the answer is the same for all of them: a non-eBay
 * conversation, a missing item reference or sub-account, no parent listing row,
 * more than one parent SKU, no SOT row for that exact SKU, or a SOT row whose
 * every whitelisted value was empty or unverified.
 */
export async function resolveSotProductContext(
  sourceClient: SourceQueryable,
  conversation: ConversationForSotProductContext,
): Promise<VerifiedFact[]> {
  if (conversation.marketplace !== "ebay") return EMPTY;
  if (conversation.subSourceId === null) return EMPTY;
  if (conversation.listingItemRef === null || conversation.listingItemRef.trim() === "") {
    return EMPTY;
  }

  const product = await findSotProductForListing(sourceClient, {
    itemId: conversation.listingItemRef,
    subSourceId: conversation.subSourceId,
    blockedKeyPatterns: BLOCKED_SOT_ATTRIBUTE_PATTERNS,
  });
  if (product === null) return EMPTY;

  const facts: VerifiedFact[] = [];
  for (const attribute of product.attributes) {
    // The database already applied the same patterns; re-applying them here is
    // deliberate. This function is the authority on what may be stated, and it
    // must give the same answer whether or not the query filtered first.
    if (!sotAttributeIsStatable(attribute.key)) continue;
    const value = statableValue(attribute.value);
    if (value !== null) facts.push({ name: attribute.key, value });
  }

  // A record whose every whitelisted cell was `[VERIFY]` or empty is not a
  // product we know anything about. Naming the SKU alone would be a heading with
  // nothing under it.
  if (facts.length === 0) return EMPTY;

  return [{ name: "sku", value: product.sku }, ...facts];
}

/**
 * The SOT attributes for the SKU a customer ACTUALLY BOUGHT.
 *
 * WHY THIS IS A SEPARATE ENTRY POINT, AND WHY IT MAY RUN BESIDE ORDER FACTS.
 * The listing-based lookup above answers from the parent row, which on a
 * multi-variation listing is one specific variant and not necessarily the
 * customer's — so for a conversation that HAS resolved an order it would put a
 * second, possibly wrong product description beside the right one. That is the
 * contradiction the draft route used to avoid by refusing to run SOT at all once
 * an order existed, at the cost of every post-sale reply losing the catalogue.
 *
 * Resolving by the ORDER'S OWN SKU removes the contradiction instead of avoiding
 * it: there is exactly one product, the order named it, and these are its
 * attributes. A "wrong description" or "missing parts" reply can now state the
 * dimensions and the parts list of the item in the customer's hands.
 *
 * NO `sku` FACT IS RETURNED. The order already stated it and remains the
 * authority on it; repeating it here could only ever disagree with itself.
 */
export async function resolveSotProductContextForSku(
  sourceClient: SourceQueryable,
  sku: string,
): Promise<VerifiedFact[]> {
  if (sku.trim() === "") return EMPTY;

  const product = await findSotProductBySku(sourceClient, {
    sku,
    blockedKeyPatterns: BLOCKED_SOT_ATTRIBUTE_PATTERNS,
  });
  if (product === null) return EMPTY;

  const facts: VerifiedFact[] = [];
  for (const attribute of product.attributes) {
    // Re-applied here for the same reason as above: this module is the authority
    // on what may be stated, whether or not the query filtered first.
    if (!sotAttributeIsStatable(attribute.key)) continue;
    const value = statableValue(attribute.value);
    if (value !== null) facts.push({ name: attribute.key, value });
  }

  return facts;
}
