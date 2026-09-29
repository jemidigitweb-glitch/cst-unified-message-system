import "server-only";

/**
 * A customer's name, resolved from the READ-ONLY source by thread reference.
 *
 * ---------------------------------------------------------------------------
 * ITS OWN MODULE, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * The CST root cause repository is guarded against naming the source at all —
 * it writes, and a module that both writes CST tables and reads the live
 * marketplace is one edit away from writing what it read. So the name lookup
 * lives here, takes the source client explicitly, and issues SELECT only.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS STORED
 * ---------------------------------------------------------------------------
 * A name copied into `cst_app` would be a second copy that goes stale the
 * moment the source corrects a spelling, and this application has no business
 * owning customer identity. It is read at export time and written into a file
 * the operator already has the right to see.
 *
 * ---------------------------------------------------------------------------
 * THE JOIN IS THE ONE THE SEARCH ALREADY USES
 * ---------------------------------------------------------------------------
 * `conversation-search-repository.ts` resolves a name the same way, through
 * `customers.customer_info` joined to `order_management.orders`. Reusing the
 * shape means a name shown by search and a name printed in the export come
 * from the same place and cannot disagree.
 *
 * A thread reference is an ORDER NUMBER on Shopify, Amazon, B&Q and Temu, and a
 * BUYER USERNAME on eBay. Both columns are matched, which is why one statement
 * serves every marketplace.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

/**
 * Names for a batch of thread references.
 *
 * ONE STATEMENT FOR THE WHOLE BATCH. The per-conversation alternative is a
 * round trip each on a source pool of ONE connection — for a report of any
 * size that is not a lookup but an outage.
 *
 * `DISTINCT ON` keeps the newest order per reference, because a buyer with
 * several orders has one name but many rows, and the newest is the one whose
 * spelling somebody most recently confirmed.
 */
const NAMES_FOR_REFS = `
SELECT DISTINCT ON (ref)
       ref,
       btrim(coalesce(ci.first_name, '') || ' ' || coalesce(ci.last_name, '')) AS full_name
  FROM customers.customer_info ci
  JOIN order_management.orders o ON o.id = ci.order_id
  CROSS JOIN LATERAL (VALUES (o.order_id), (ci.ebay_buyer_id)) AS candidate(ref)
 WHERE ref = ANY($1::text[])
   AND btrim(coalesce(ci.first_name, '') || ' ' || coalesce(ci.last_name, '')) <> ''
 ORDER BY ref, o.order_date DESC`;

/** Exposed so a test can assert what it selects, and that it selects only. */
export const NAMES_FOR_REFS_SQL = NAMES_FOR_REFS;

type NameRow = { ref: string; full_name: string };

/**
 * Thread reference to customer name, for every reference the source can match.
 *
 * NEVER THROWS ON A MISSING NAME. A reference the source cannot match is simply
 * absent from the map, and the caller prints nothing — which is honest. The one
 * thing this must never do is fall back to the reference itself: a marketplace
 * handle printed under "Customer" reads as a person's name to whoever opens the
 * report.
 */
export async function loadCustomerNamesByRef(
  source: Queryable,
  refs: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();

  // De-duplicated and blank-free: a batch of a thousand conversations on one
  // storefront is usually far fewer distinct references.
  const wanted = [...new Set(refs.filter((ref) => ref !== ""))];
  if (wanted.length === 0) return names;

  const { rows } = await source.query({ text: NAMES_FOR_REFS, values: [wanted] });
  for (const row of rows as NameRow[]) {
    if (row.full_name !== "") names.set(row.ref, row.full_name);
  }
  return names;
}
