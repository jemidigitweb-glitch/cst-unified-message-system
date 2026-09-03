import "server-only";

/**
 * Read-only eBay listing lookup: an item reference to the listing's own URL.
 *
 * STRICTLY READ-ONLY, a single SELECT against the source pool, which the caller
 * pins `default_transaction_read_only=on` for — see `getSourcePool()`. Same
 * discipline as `ebay-image-repository.ts`, and the same table.
 *
 * NOTHING IS BUILT HERE. The URL is the one `listings.ebay_listings.listing_url`
 * already holds. No string is assembled from a domain and an item id, no site
 * is inferred, no slug is composed — a URL this code invented would be a guess
 * dressed as a record, and the failure would be a reviewer opening someone
 * else's listing.
 *
 * ONE ROW PER LISTING, VIA `is_parent = 1`. `item_id` is not 1:1 with a row: a
 * multi-variation listing stores one row per SKU-variant under the same
 * item_id, and the example in the brief (267367123779) has 52 of them. The
 * parent row is the listing itself. Measured live, the restriction costs no
 * coverage at all — 25,486 distinct item_ids carry a URL with or without it —
 * and it removes almost every disagreement: 48 item_ids hold two different URLs
 * across their variant rows (the same listing re-titled, so the same product
 * under two slugs), and reading parent rows only brings that down to 3.
 *
 * SCOPED BY `sub_source` as well as `item_id`, matching the image lookup. An
 * eBay item id is globally unique, so this is not what makes the answer
 * correct; it makes the answer belong to the same seller account the rest of
 * the conversation's context was read from.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

type ListingUrlRow = {
  listing_url: string;
};

/**
 * `DISTINCT` because a listing can hold more than one parent row and they
 * normally agree; the caller treats disagreement as "no link" rather than
 * picking one. Blank and NULL are excluded in SQL so an empty string can never
 * be mistaken for a recorded value — 55,491 of the 308,096 rows have no URL.
 */
const FIND_LISTING_URL = `
SELECT DISTINCT el.listing_url AS listing_url
FROM listings.ebay_listings el
WHERE el.item_id = $1
  AND el.sub_source = $2::int
  AND el.is_parent = 1
  AND el.listing_url IS NOT NULL
  AND btrim(el.listing_url) <> ''`;

/**
 * The one listing URL recorded for this item, or null.
 *
 * NULL WHEN THERE IS ANY DOUBT, and the two doubtful cases are deliberately
 * given the same answer. No row means the source recorded no URL for this
 * listing. Several rows mean it recorded more than one and nothing here can say
 * which is current — picking the commonest, the longest or the first would be
 * this module deciding a question it has no evidence for. Both come back null,
 * and the panel shows the reference without a link.
 *
 * Measured against every eBay conversation CST holds: of 890 distinct
 * (item reference, sub-account) pairs, 867 resolve to exactly one URL, 23 have
 * none recorded, and none is ambiguous.
 */
export async function findListingUrl(
  client: Queryable,
  options: { readonly itemId: string; readonly subSourceId: number },
): Promise<string | null> {
  const { rows } = await client.query({
    text: FIND_LISTING_URL,
    values: [options.itemId, options.subSourceId],
  });
  if (rows.length !== 1) return null;
  return (rows[0] as ListingUrlRow).listing_url;
}

/** One variation axis a listing offers, with every option under it. */
export type ListingVariation = {
  readonly name: string;
  readonly values: readonly string[];
};

/** What the listing itself says, as opposed to what a catalogue says about it. */
export type ListingDetails = {
  readonly title: string;
  readonly variations: readonly ListingVariation[];
};

type ListingDetailsRow = {
  title: string | null;
  selected_variations: unknown;
};

/**
 * `title` and `selected_variations`, and DELIBERATELY NOT `product_description`.
 *
 * The description is the seller's own eBay HTML, and the numbers are what
 * settled it: across the 869 parent rows behind live conversations it is
 * populated on all of them, averages 53,736 characters, reaches 486,634, and
 * every single one contains markup — `<style>` blocks, `<meta>` tags, whole
 * pages. It is marketing copy rather than a specification, so a model reading it
 * would state claims nobody verified, in a block headed VERIFIED. It would also
 * dwarf the CST rules in the same prompt. Title and variations are short,
 * structured and factual; the description is none of those things.
 *
 * `is_parent = 1` for the same reason as everywhere else in this file: the
 * variation axes belong to the listing, not to one of its variants.
 */
const FIND_LISTING_DETAILS = `
SELECT el.title AS title, el.selected_variations AS selected_variations
FROM listings.ebay_listings el
WHERE el.item_id = $1
  AND el.sub_source = $2::int
  AND el.is_parent = 1
  AND el.title IS NOT NULL
  AND btrim(el.title) <> ''`;

/**
 * Reads eBay's `[{"Name": "Colour", "Value": ["Copper", ...]}]` shape.
 *
 * TOTALLY DEFENSIVE, because this is the one jsonb column on the path and its
 * shape is the source's to change. Anything that is not that shape contributes
 * nothing rather than throwing — a malformed variation must not cost a draft its
 * order facts. Measured live: 867 of 869 parent rows hold an array, 2 hold null.
 */
function toVariations(raw: unknown): ListingVariation[] {
  if (!Array.isArray(raw)) return [];
  const variations: ListingVariation[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as { Name?: unknown }).Name;
    const value = (entry as { Value?: unknown }).Value;
    if (typeof name !== "string" || name.trim() === "") continue;
    if (!Array.isArray(value)) continue;
    const values = value.filter(
      (option): option is string => typeof option === "string" && option.trim() !== "",
    );
    if (values.length === 0) continue;
    variations.push({ name: name.trim(), values });
  }
  return variations;
}

/**
 * What one eBay listing says about itself, or null.
 *
 * Null when the item has no parent row on this storefront, or several — the
 * same "never picks one" rule the URL lookup above applies, for the same reason.
 */
export async function findListingDetails(
  client: Queryable,
  options: { readonly itemId: string; readonly subSourceId: number },
): Promise<ListingDetails | null> {
  const { rows } = await client.query({
    text: FIND_LISTING_DETAILS,
    values: [options.itemId, options.subSourceId],
  });
  if (rows.length !== 1) return null;

  const row = rows[0] as ListingDetailsRow;
  if (row.title === null || row.title.trim() === "") return null;

  return { title: row.title.trim(), variations: toVariations(row.selected_variations) };
}
