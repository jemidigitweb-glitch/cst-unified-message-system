import "server-only";

/**
 * Reads and writes `cst_app.context_snapshots` / `context_order_candidates` /
 * `context_items` — the order-context tables defined in the very first
 * migration (0001) and never populated by anything until now.
 *
 * ONE SNAPSHOT PER CONVERSATION. `uq_context_snapshots_conversation` enforces
 * it at the database level; every write here upserts on `conversation_id`
 * rather than inserting a new row, so re-resolving a conversation updates its
 * one snapshot instead of accumulating history.
 *
 * NEVER FAILS THE CALLER. Same discipline as `rule-analysis-writer.ts` and
 * `ai-usage-writer.ts`: losing a cached snapshot is a nuisance — the resolver
 * just re-queries the source next time — losing a draft because the cache
 * write failed is not a trade worth making. Every write function catches,
 * logs, and returns rather than throwing.
 */

export type Writable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

export type Resolution = "single_order" | "no_order" | "ambiguous" | "needs_context" | "terminated_order";

export type ContextSnapshotRow = {
  readonly id: string;
  readonly conversation_id: string;
  readonly resolution: Resolution;
  readonly sub_source_id: number | null;
  readonly order_number: string | null;
  readonly order_date: string | null;
  readonly order_status_summary: string | null;
  readonly tracking_number: string | null;
  readonly delivery_courier: string | null;
  readonly delivery_address: string | null;
  readonly listing_item_ref: string | null;
  readonly verification_method: string;
};

export type ContextItemRow = {
  readonly id: string;
  readonly exact_sku: string;
  readonly product_title: string | null;
  readonly image_url: string | null;
};

const GET_SNAPSHOT = `
SELECT id::text, conversation_id::text, resolution, sub_source_id,
       order_number, order_date::text, order_status_summary,
       tracking_number, delivery_courier, delivery_address,
       listing_item_ref, verification_method
FROM cst_app.context_snapshots
WHERE conversation_id = $1::bigint`;

const GET_ITEMS = `
SELECT id::text, exact_sku, product_title, image_url
FROM cst_app.context_items
WHERE context_snapshot_id = $1::bigint`;

/** The stored snapshot for one conversation, or null when it has never been resolved. */
export async function getContextSnapshot(
  client: Writable,
  conversationId: string,
): Promise<ContextSnapshotRow | null> {
  const { rows } = await client.query({ text: GET_SNAPSHOT, values: [conversationId] });
  return (rows as ContextSnapshotRow[])[0] ?? null;
}

/** Every line item captured for a resolved snapshot. Empty for anything but `single_order`. */
export async function getContextItems(
  client: Writable,
  snapshotId: string,
): Promise<ContextItemRow[]> {
  const { rows } = await client.query({ text: GET_ITEMS, values: [snapshotId] });
  return rows as ContextItemRow[];
}

const UPSERT_SINGLE_ORDER_SNAPSHOT = `
INSERT INTO cst_app.context_snapshots (
  conversation_id, resolution, sub_source_id, order_number, order_date,
  order_status_summary, tracking_number, delivery_courier, delivery_address,
  source_order_row_ids, listing_item_ref,
  verification_method, resolved_at, updated_at
)
VALUES ($1::bigint, 'single_order', $2::int, $3, $4::timestamp, $5, $6, $7, $8,
        $9::bigint[], $10, 'deterministic_single', now(), now())
ON CONFLICT (conversation_id) DO UPDATE
SET resolution            = EXCLUDED.resolution,
    sub_source_id         = EXCLUDED.sub_source_id,
    order_number          = EXCLUDED.order_number,
    order_date            = EXCLUDED.order_date,
    order_status_summary  = EXCLUDED.order_status_summary,
    tracking_number       = EXCLUDED.tracking_number,
    delivery_courier      = EXCLUDED.delivery_courier,
    delivery_address      = EXCLUDED.delivery_address,
    source_order_row_ids  = EXCLUDED.source_order_row_ids,
    listing_item_ref      = EXCLUDED.listing_item_ref,
    verification_method   = EXCLUDED.verification_method,
    confirmed_by_user_id  = NULL,
    confirmed_at          = NULL,
    resolved_at           = now(),
    updated_at            = now()
RETURNING id::text`;

const DELETE_ITEMS_FOR_SNAPSHOT = `
DELETE FROM cst_app.context_items WHERE context_snapshot_id = $1::bigint`;

const INSERT_ITEM = `
INSERT INTO cst_app.context_items (
  context_snapshot_id, exact_sku, product_title, quantity, image_url,
  source_order_item_id, source_order_row_id
)
VALUES ($1::bigint, $2, $3, $4, $5, $6::bigint, $7::bigint)`;

export type SingleOrderInput = {
  readonly conversationId: string;
  readonly subSourceId: number;
  readonly orderNumber: string;
  readonly orderDate: string | null;
  readonly orderStatusSummary: string | null;
  readonly trackingNumber: string | null;
  readonly deliveryCourier: string | null;
  readonly deliveryAddress: string | null;
  readonly orderRowId: string;
  readonly listingItemRef: string | null;
  /**
   * Null when the source recorded no SKU for this line. `exact_sku` is
   * NOT NULL in the schema, so there is nothing honest to insert in that
   * case — skipping the item write (rather than storing a placeholder like
   * "unknown") is what stops a fabricated value from later being read back
   * and handed to the model as though it were a verified SKU.
   */
  readonly item: {
    readonly exactSku: string;
    readonly productTitle: string | null;
    readonly imageUrl: string | null;
    readonly sourceOrderItemId: string | null;
  } | null;
};

/**
 * Records a deterministic single-order match: exactly one order matched this
 * item and buyer, so it is written as `single_order` /
 * `deterministic_single` — never `user_confirmed`, because no human looked at
 * this, and the schema's own naming keeps that distinction honest.
 */
export async function saveSingleOrderSnapshot(
  client: Writable,
  input: SingleOrderInput,
): Promise<{ saved: boolean }> {
  try {
    const { rows } = await client.query({
      text: UPSERT_SINGLE_ORDER_SNAPSHOT,
      values: [
        input.conversationId,
        input.subSourceId,
        input.orderNumber,
        input.orderDate,
        input.orderStatusSummary,
        input.trackingNumber,
        input.deliveryCourier,
        input.deliveryAddress,
        [input.orderRowId],
        input.listingItemRef,
      ],
    });
    const snapshotId = (rows[0] as { id: string } | undefined)?.id;
    if (snapshotId === undefined) return { saved: false };

    await client.query({ text: DELETE_ITEMS_FOR_SNAPSHOT, values: [snapshotId] });
    if (input.item !== null) {
      await client.query({
        text: INSERT_ITEM,
        values: [
          snapshotId,
          input.item.exactSku,
          input.item.productTitle,
          null,
          input.item.imageUrl,
          input.item.sourceOrderItemId,
          input.orderRowId,
        ],
      });
    }
    return { saved: true };
  } catch (cause) {
    console.error("[context-snapshot] could not save a single-order snapshot", cause);
    return { saved: false };
  }
}

const UPSERT_AMBIGUOUS_SNAPSHOT = `
INSERT INTO cst_app.context_snapshots (
  conversation_id, resolution, verification_method, resolved_at, updated_at
)
VALUES ($1::bigint, 'ambiguous', 'none', now(), now())
ON CONFLICT (conversation_id) DO UPDATE
SET resolution            = EXCLUDED.resolution,
    sub_source_id         = NULL,
    order_number          = NULL,
    order_date            = NULL,
    order_status_summary  = NULL,
    tracking_number       = NULL,
    delivery_courier      = NULL,
    delivery_address      = NULL,
    source_order_row_ids  = '{}',
    listing_item_ref      = NULL,
    verification_method   = EXCLUDED.verification_method,
    confirmed_by_user_id  = NULL,
    confirmed_at          = NULL,
    resolved_at           = now(),
    updated_at            = now()`;

const DELETE_CANDIDATES_FOR_CONVERSATION = `
DELETE FROM cst_app.context_order_candidates WHERE conversation_id = $1::bigint`;

const INSERT_CANDIDATE = `
INSERT INTO cst_app.context_order_candidates (
  conversation_id, sub_source_id, order_number, order_date,
  order_status_summary, source_order_row_ids, item_count, listing_item_ref
)
VALUES ($1::bigint, $2::int, $3, $4::timestamp, $5, $6::bigint[], $7::int, $8)
ON CONFLICT (conversation_id, sub_source_id, order_number) DO UPDATE
SET order_date            = EXCLUDED.order_date,
    order_status_summary  = EXCLUDED.order_status_summary,
    source_order_row_ids  = EXCLUDED.source_order_row_ids,
    item_count            = EXCLUDED.item_count,
    listing_item_ref      = EXCLUDED.listing_item_ref`;

export type AmbiguousCandidateInput = {
  readonly subSourceId: number;
  readonly orderNumber: string;
  readonly orderDate: string | null;
  readonly orderStatusSummary: string | null;
  readonly orderRowId: string;
  readonly listingItemRef: string | null;
};

/**
 * Records more than one matching order: the snapshot itself stays empty of
 * any order identity (the schema forbids otherwise —
 * `ck_context_snapshots_unresolved_has_no_order`), and every candidate is
 * written to `context_order_candidates` for a human to pick from later.
 * Nothing here guesses which one is right.
 */
export async function saveAmbiguousSnapshot(
  client: Writable,
  conversationId: string,
  candidates: readonly AmbiguousCandidateInput[],
): Promise<{ saved: boolean }> {
  try {
    await client.query({ text: UPSERT_AMBIGUOUS_SNAPSHOT, values: [conversationId] });
    await client.query({ text: DELETE_CANDIDATES_FOR_CONVERSATION, values: [conversationId] });
    for (const candidate of candidates) {
      await client.query({
        text: INSERT_CANDIDATE,
        values: [
          conversationId,
          candidate.subSourceId,
          candidate.orderNumber,
          candidate.orderDate,
          candidate.orderStatusSummary,
          [candidate.orderRowId],
          1,
          candidate.listingItemRef,
        ],
      });
    }
    return { saved: true };
  } catch (cause) {
    console.error("[context-snapshot] could not save an ambiguous snapshot", cause);
    return { saved: false };
  }
}

const UPSERT_NO_ORDER_SNAPSHOT = `
INSERT INTO cst_app.context_snapshots (
  conversation_id, resolution, verification_method, resolved_at, updated_at
)
VALUES ($1::bigint, 'no_order', 'none', now(), now())
ON CONFLICT (conversation_id) DO UPDATE
SET resolution            = EXCLUDED.resolution,
    sub_source_id         = NULL,
    order_number          = NULL,
    order_date            = NULL,
    order_status_summary  = NULL,
    tracking_number       = NULL,
    delivery_courier      = NULL,
    delivery_address      = NULL,
    source_order_row_ids  = '{}',
    listing_item_ref      = NULL,
    verification_method   = EXCLUDED.verification_method,
    confirmed_by_user_id  = NULL,
    confirmed_at          = NULL,
    resolved_at           = now(),
    updated_at            = now()`;

/** Records that nothing matched: no order for this item and buyer. */
export async function saveNoOrderSnapshot(
  client: Writable,
  conversationId: string,
): Promise<{ saved: boolean }> {
  try {
    await client.query({ text: UPSERT_NO_ORDER_SNAPSHOT, values: [conversationId] });
    return { saved: true };
  } catch (cause) {
    console.error("[context-snapshot] could not save a no-order snapshot", cause);
    return { saved: false };
  }
}
