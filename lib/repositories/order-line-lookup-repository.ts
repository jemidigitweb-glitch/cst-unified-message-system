import "server-only";

/**
 * Read-only order lookups behind the case import's order matching.
 *
 * STRICTLY READ-ONLY AGAINST THE MARKETPLACE SOURCE. Two SELECTs and nothing
 * else; the pool the caller supplies pins `default_transaction_read_only=on` at
 * the session level, so the server refuses a write from this path even if one
 * were written. Same contract as `order-context-repository.ts`.
 *
 * A NEW FILE RATHER THAN AN ADDITION TO `order-context-repository.ts`, which
 * three shipped features and two guards read. Adding statements there would put
 * the order panel in this feature's blast radius for no benefit.
 *
 * ---------------------------------------------------------------------------
 * TWO LOOKUPS, TWO DIFFERENT CLAIMS
 * ---------------------------------------------------------------------------
 *   VERIFY      a source-recorded order number against a real order row on the
 *               same storefront. Measured match rates: eBay returns 3,934 of
 *               3,934, eBay cancellations 1,263 of 1,263, Amazon returns 12,093
 *               of 14,398 (84.0%). The 16% that find no order row are NOT an
 *               error — the source did record a reference, and
 *               `source_order_id_unverified` says exactly that.
 *
 *   DERIVE      an order from the marketplace ITEM and TRANSACTION identifiers,
 *               for the two inquiry logs, which carry no order id at all (0 of
 *               8,054 and 0 of 1,038). Measured: `order_item_info` holds both
 *               parts on 364,467 eBay order lines forming 364,465 distinct
 *               pairs, and the join resolves 1,182 of 1,189 cases to exactly one
 *               order, 7 to none and NONE to several.
 *
 * ---------------------------------------------------------------------------
 * THE DERIVED LOOKUP RETURNS EVERY MATCH, NEVER THE FIRST
 * ---------------------------------------------------------------------------
 * 2 of the 364,467 measured pairs collide, so "exactly one" is a property to
 * CHECK rather than assume. The statement therefore returns the distinct order
 * numbers a key matched and the caller refuses on more than one — see
 * `resolveOrderFor`. A `LIMIT 1` here would quietly pick one of two real orders,
 * which is the guess this codebase rejects.
 *
 * ---------------------------------------------------------------------------
 * BATCHED, BECAUSE A PER-CASE QUERY WOULD BE 21,000 ROUND TRIPS
 * ---------------------------------------------------------------------------
 * Both statements take arrays and `unnest` them into a join key, so one
 * statement answers for a whole store. Every value is still bound; nothing is
 * interpolated.
 */

import { channelForSourceId } from "@/lib/domain/automation/automation-types";
import type { Marketplace } from "@/lib/domain/marketplace";
import type { Queryable } from "@/lib/sync/message-sync";

/**
 * ===========================================================================
 * THE VERIFIED STOREFRONT ALLOWLIST, FOR EVERY MARKETPLACE AT ONCE
 * ===========================================================================
 * The nine case stores carry a `sub_source` and NO platform column. 0022 makes
 * `marketplace` NOT NULL, so there is no honest NULL to fall back on, and writing
 * a platform because "these look like eBay tables" is the guess this codebase
 * rejects.
 *
 * `findEbaySubSourceIds` resolves one platform and is the right shape for the
 * historical case-history import, which is eBay-only. This import is not: five of
 * its nine stores are Amazon or Shopify, and with an eBay-only allowlist every one
 * of their cases is rejected as `unverified_storefront` — which is SAFE, and was
 * the blocker reported at the end of the previous bundle.
 *
 * ---------------------------------------------------------------------------
 * THE PLATFORM IDS ARE READ, NOT ASSUMED, AND THEN MAPPED BY EXISTING CODE
 * ---------------------------------------------------------------------------
 * The join is `sub_source.source_id -> source.id`, and the mapping from a
 * platform id to a CST marketplace is `channelForSourceId`, which the
 * post-dispatch automation already uses and which this repository does not
 * duplicate. Verified read-only 2026-10-02 against the source's OWN
 * `source.source_name` column rather than against the map:
 *
 *   1 AMAZON   11 storefronts        4 ETSY, 5 ONBUY, 7 AVASAM, 8 MANOMANO,
 *   2 EBAY     22 storefronts        12 BOL, 14 FAIRE, 15 WOO, 17 TEMU: 0 each
 *   3 SHOPIFY  14 storefronts        6 WAYFAIR 5, 11 REPLACEMENT 69,
 *                                    16 B&Q 1, 9/10/13 internal: 0
 *
 * ---------------------------------------------------------------------------
 * A PLATFORM THIS APPLICATION HAS NO CHANNEL FOR IS DROPPED, NOT GUESSED
 * ---------------------------------------------------------------------------
 * The source lists seventeen platforms and this application has five. A
 * storefront under Wayfair, or under the internal REPLACEMENT platform (69
 * storefronts), resolves to no channel and is therefore ABSENT from the result —
 * so a case recorded against it is rejected as `unverified_storefront` rather
 * than labelled on the strength of which table it came from. That is the same
 * refusal `toDispatchEvent` makes, for the same reason, and it is what keeps the
 * rejection rule intact while widening the allowlist.
 */

/**
 * Every storefront and the platform it belongs to, in ONE query.
 *
 * Read whole rather than probed per storefront: the alternative is one query per
 * distinct sub_source, and the marketplace identity of an account does not vary by
 * caller. Roughly 120 small rows across all seventeen platforms.
 *
 * `source_id` is selected as well as the storefront so a caller can report which
 * platforms were dropped, rather than only that some were.
 */
const FIND_STOREFRONTS = `
SELECT ss.id::int AS sub_source_id, ss.source_id::int AS source_id
FROM order_management.sub_source ss
WHERE ss.source_id IS NOT NULL
ORDER BY ss.source_id, ss.id`;

export const FIND_STOREFRONTS_SQL = FIND_STOREFRONTS;

export type StorefrontAllowlist = {
  /** Verified storefronts per marketplace. A marketplace with none is absent. */
  readonly byMarketplace: ReadonlyMap<Marketplace, ReadonlySet<number>>;
  /**
   * Platform ids this application has no channel for, with their storefront
   * counts. Reported so a run can say what it dropped instead of only how many
   * cases it rejected.
   */
  readonly unmappedPlatforms: ReadonlyMap<number, number>;
};

/**
 * Builds the allowlist. PURE once the rows are in hand — the mapping decision is
 * `channelForSourceId`'s, and this function only groups.
 */
export function storefrontAllowlistFrom(
  rows: readonly { readonly sub_source_id: number; readonly source_id: number }[],
): StorefrontAllowlist {
  const byMarketplace = new Map<Marketplace, Set<number>>();
  const unmappedPlatforms = new Map<number, number>();

  for (const row of rows) {
    const sourceId = Number(row.source_id);
    const marketplace = channelForSourceId(sourceId);
    if (marketplace === undefined) {
      unmappedPlatforms.set(sourceId, (unmappedPlatforms.get(sourceId) ?? 0) + 1);
      continue;
    }
    const set = byMarketplace.get(marketplace);
    if (set === undefined) byMarketplace.set(marketplace, new Set([Number(row.sub_source_id)]));
    else set.add(Number(row.sub_source_id));
  }

  return { byMarketplace, unmappedPlatforms };
}

export async function findVerifiedStorefronts(client: Queryable): Promise<StorefrontAllowlist> {
  const { rows } = await client.query({ text: FIND_STOREFRONTS });
  return storefrontAllowlistFrom(
    rows as Array<{ sub_source_id: number; source_id: number }>,
  );
}

/** One (order number, storefront) pair to confirm exists. */
export type OrderRefKey = {
  readonly orderRef: string;
  readonly subSourceId: number;
};

const VERIFY_ORDER_REFS = `
SELECT DISTINCT k.order_ref AS order_ref, k.sub_source_id AS sub_source_id
FROM unnest($1::text[], $2::int[]) AS k(order_ref, sub_source_id)
WHERE EXISTS (
  SELECT 1 FROM order_management.orders o
   WHERE o.order_id = k.order_ref
     AND o.sub_source_id = k.sub_source_id
)`;

export const VERIFY_ORDER_REFS_SQL = VERIFY_ORDER_REFS;

/**
 * Which of the supplied references name a real order on their own storefront.
 *
 * Returns a set of `orderRef|subSourceId` keys. A reference absent from the set
 * exists at source but resolves to no order row, which the caller records as
 * `source_order_id_unverified` rather than discarding.
 */
export async function verifyOrderRefs(
  client: Queryable,
  keys: readonly OrderRefKey[],
): Promise<ReadonlySet<string>> {
  if (keys.length === 0) return new Set();
  const { rows } = await client.query({
    text: VERIFY_ORDER_REFS,
    values: [keys.map((k) => k.orderRef), keys.map((k) => k.subSourceId)],
  });
  return new Set(
    (rows as Array<{ order_ref: string; sub_source_id: number }>).map(
      (row) => `${row.order_ref}|${Number(row.sub_source_id)}`,
    ),
  );
}

/** One marketplace order line to resolve an order from. */
export type OrderLineKey = {
  readonly itemRef: string;
  readonly txnRef: string;
  readonly subSourceId: number;
};

/**
 * The storefront is part of the predicate, not a corroboration added afterwards.
 *
 * Every one of the 1,182 measured matches landed on the same storefront the case
 * itself records, so including it costs nothing and removes the one way a
 * marketplace-wide item/transaction pair could reach across accounts.
 */
const FIND_ORDERS_BY_LINE = `
SELECT k.item_ref AS item_ref, k.txn_ref AS txn_ref, k.sub_source_id AS sub_source_id,
       o.order_id AS order_ref
FROM unnest($1::text[], $2::text[], $3::int[]) AS k(item_ref, txn_ref, sub_source_id)
JOIN order_management.order_item_info oii
  ON oii.item_id = k.item_ref
 AND oii.item_transaction_id = k.txn_ref
JOIN order_management.orders o
  ON o.id = oii.order_id
 AND o.sub_source_id = k.sub_source_id
GROUP BY 1, 2, 3, 4`;

export const FIND_ORDERS_BY_LINE_SQL = FIND_ORDERS_BY_LINE;

/**
 * The DISTINCT order numbers each line key matched, keyed
 * `itemRef|txnRef|subSourceId`.
 *
 * A key with several entries is ambiguous and the caller stores the case as
 * unmatched. A key with none is simply absent.
 */
export async function findOrdersByLineKey(
  client: Queryable,
  keys: readonly OrderLineKey[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  if (keys.length === 0) return new Map();
  const { rows } = await client.query({
    text: FIND_ORDERS_BY_LINE,
    values: [
      keys.map((k) => k.itemRef),
      keys.map((k) => k.txnRef),
      keys.map((k) => k.subSourceId),
    ],
  });
  const out = new Map<string, string[]>();
  for (const row of rows as Array<{
    item_ref: string;
    txn_ref: string;
    sub_source_id: number;
    order_ref: string;
  }>) {
    const key = `${row.item_ref}|${row.txn_ref}|${Number(row.sub_source_id)}`;
    const list = out.get(key);
    if (list === undefined) out.set(key, [row.order_ref]);
    else if (!list.includes(row.order_ref)) list.push(row.order_ref);
  }
  return out;
}

/** The key shapes, exported so the orchestrator and the tests agree on them. */
export function orderRefKeyOf(orderRef: string, subSourceId: number): string {
  return `${orderRef}|${subSourceId}`;
}

export function orderLineKeyOf(itemRef: string, txnRef: string, subSourceId: number): string {
  return `${itemRef}|${txnRef}|${subSourceId}`;
}
