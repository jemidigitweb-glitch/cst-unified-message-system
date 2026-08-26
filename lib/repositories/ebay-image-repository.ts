import "server-only";

/**
 * Read-only eBay image lookups, for showing existing eBay-hosted images
 * alongside a conversation's verified context — never inside the chat
 * thread itself. See `lib/context/resolve-image-context.ts` for why.
 *
 * STRICTLY READ-ONLY. Every statement here is a SELECT against the source
 * pool, which the caller pins `default_transaction_read_only=on` for — see
 * `getSourcePool()`. Same discipline as `order-context-repository.ts`.
 *
 * TWO IMAGE SOURCES, NEVER MIXED, NEITHER A CUSTOMER UPLOAD.
 *
 *   Product/listing images: the seller's own listing photos. `item_id` on
 *   an eBay listing is not 1:1 with a row — a multi-variation listing stores
 *   one row per SKU-variant under the same item_id (one listing observed
 *   live with 246 variant rows), each with its own images. Joining on
 *   item_id alone fans out into hundreds of irrelevant per-variant photos.
 *   `is_parent = 1` picks the single representative row every listing has
 *   (confirmed live: 31,052 of 31,108 distinct item_ids), whose own
 *   `main_image_url` and image gallery are the seller's general photos for
 *   the listing — not evidence of anything a specific buyer reported, and
 *   not necessarily the exact variant a specific buyer received.
 *
 *   Return evidence images: `customer_service.ebay_returns` is a status-event
 *   log, not one row per case — a single (order_id, item_id) pair can carry
 *   dozens of rows, most with `img IS NULL`; only the row that actually
 *   carried a photo has one. The table has NO buyer column, so scoping by
 *   item_id alone is unsafe — confirmed live: 200 of 388 sampled conversation
 *   item_ids had *some* return photo in the log, the large majority
 *   belonging to a different buyer entirely. The caller MUST supply the
 *   `order_number` already verified for this conversation (from a
 *   `single_order` context snapshot) so the match is pinned to the one order
 *   already proven to belong to this conversation.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

export type ProductImage = {
  readonly imageUrl: string;
  readonly viewOrder: number | null;
};

type ProductImageRow = {
  image_url: string;
  view_order: number | null;
};

/**
 * `is_parent = 1` is the join condition that keeps this to one listing row
 * regardless of how many SKU-variants it has — see the module doc. Ordered
 * by `view_order` so the gallery renders in the seller's own chosen order.
 */
const FIND_PRODUCT_IMAGES = `
SELECT eli.image_url AS image_url, eli.view_order AS view_order
FROM listings.ebay_listings el
JOIN listings.ebay_listing_images eli ON eli.product_id = el.id
WHERE el.item_id = $1
  AND el.sub_source = $2::int
  AND el.is_parent = 1
ORDER BY eli.view_order NULLS LAST, eli.id`;

function toProductImage(row: ProductImageRow): ProductImage {
  return { imageUrl: row.image_url, viewOrder: row.view_order };
}

/**
 * The parent listing row's own image gallery for one eBay item — never a
 * child variant row's images. Works from `item_id` + `sub_source` alone;
 * no order or buyer needed, since a listing's own photos are not
 * customer-specific.
 */
export async function findProductListingImages(
  client: Queryable,
  options: { readonly itemId: string; readonly subSourceId: number },
): Promise<ProductImage[]> {
  const { rows } = await client.query({
    text: FIND_PRODUCT_IMAGES,
    values: [options.itemId, options.subSourceId],
  });
  return (rows as ProductImageRow[]).map(toProductImage);
}

export type ReturnEvidenceImage = {
  readonly imageUrl: string;
  readonly returnId: string;
  readonly reason: string | null;
  readonly status: string | null;
};

type ReturnEvidenceRow = {
  id: string;
  img: string;
  reason: string | null;
  status: string | null;
};

/**
 * Scoped to `order_id` + `item_id` + `sub_source` — never item_id alone.
 * `order_id` is the already-verified order number for this conversation
 * (the caller's contract: only call this for a `single_order` snapshot),
 * which is what stops a different buyer's return photo for the same
 * listing from appearing here. `img IS NOT NULL` filters the status-event
 * log down to the row(s) that actually carried a photo.
 */
const FIND_RETURN_EVIDENCE_IMAGES = `
SELECT id::text AS id, img, reason, status
FROM customer_service.ebay_returns
WHERE order_id = $1
  AND item_id = $2::bigint
  AND sub_source = $3::int
  AND img IS NOT NULL
  AND img <> ''
ORDER BY id`;

function toReturnEvidenceImage(row: ReturnEvidenceRow): ReturnEvidenceImage {
  return { imageUrl: row.img, returnId: row.id, reason: row.reason, status: row.status };
}

/**
 * Return-case photos for the one order already verified for this
 * conversation. Callers must not invoke this without a verified
 * `orderNumber` from a `single_order` context snapshot — see the module doc
 * for why item_id alone is not a safe scope.
 */
export async function findReturnEvidenceImages(
  client: Queryable,
  options: { readonly orderNumber: string; readonly itemId: string; readonly subSourceId: number },
): Promise<ReturnEvidenceImage[]> {
  const { rows } = await client.query({
    text: FIND_RETURN_EVIDENCE_IMAGES,
    values: [options.orderNumber, options.itemId, options.subSourceId],
  });
  return (rows as ReturnEvidenceRow[]).map(toReturnEvidenceImage);
}
