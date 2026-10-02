import type { MySqlQueryable } from "@/lib/db/order-source";
import type { CaseSourceTable } from "@/lib/domain/marketplace-case";
import type { SourceCaseEvent } from "@/lib/domain/marketplace-case-extract";

/**
 * The minimum needed to READ the nine marketplace case stores out of MariaDB.
 *
 * A reader and nothing else. Every statement below is a constant; there is no
 * INSERT, UPDATE, DELETE, CREATE, ALTER or DROP in this file and no code path
 * that could build one.
 *
 * ---------------------------------------------------------------------------
 * A SIBLING OF `message-app-source.ts`, NOT AN ADDITION TO IT
 * ---------------------------------------------------------------------------
 * That file is already 650 lines, carries documented invariants about the
 * activity log, the media table, the SLA policy and the mailbox map, and is
 * depended on by three shipped importers. Six more readers inside it would put
 * this feature's bugs in their blast radius for no benefit. The connection, the
 * read-only assertion and the query-budget type are shared; the statements are
 * not.
 *
 * ---------------------------------------------------------------------------
 * THE QUERY BUDGET IS THE BINDING CONSTRAINT, NOT THE ROW COUNT
 * ---------------------------------------------------------------------------
 * This account carries `MAX_QUERIES_PER_HOUR 100` alongside
 * `MAX_CONNECTIONS_PER_HOUR 50`. One hundred — not per connection, per hour,
 * across every consumer including the message sync.
 *
 * So the usual instinct is backwards: PAGING WOULD BE THE EXPENSIVE MISTAKE.
 * Each store is read WHOLE in one statement, and `LIMIT ?` is a RUNAWAY GUARD
 * rather than pagination — if a store grows past it the reader THROWS instead of
 * silently importing a truncated case set, which is the failure that would
 * otherwise look like a successful import with cases missing.
 *
 * ---------------------------------------------------------------------------
 * TWO HEADER-ROW FILTERS DO THE REAL WORK
 * ---------------------------------------------------------------------------
 * Two of the stores are event logs where only one row per case carries the
 * case-level facts, and filtering to it in SQL is what keeps a whole-table read
 * affordable:
 *
 *   ebay_returns   `status IS NOT NULL` -> ~4,427 rows of ~42,900. The other
 *                  38,504 carry NULL in status, state, type and reason together.
 *   cancellation   `level = 0`          -> 1,263 rows of 4,623. The source names
 *                  the discriminator itself: `level` is commented 0-main/1-sub.
 *
 * Neither column is indexed, so both are full scans — but a full scan returning
 * 4,427 rows beats transferring 40,719. Together they cut the transfer from
 * ~45,300 rows to ~5,700 across two statements.
 *
 * ---------------------------------------------------------------------------
 * THE OMISSIONS ARE THE POINT
 * ---------------------------------------------------------------------------
 * Between them these stores hold `comments` (up to 2,000 chars of case
 * correspondence), `buyer_req`, `buyer_note`, `esc_reason`, `evi_seller_note`,
 * `return_address` (a customer's postal location, in a longtext),
 * `refund_payload` (a raw marketplace blob), `img` (return photographs),
 * `customer_email`, `customer_name`, `shipping_city`, `shipping_country`,
 * `tracking_no`, `tracking_url` and `carrier`. NONE is selected.
 *
 * Data that is never read cannot be stored by accident — the rule
 * `fetchStaffPage` applies to the credential columns and 0021 applied to this
 * very family of tables.
 *
 * ONE OMISSION IS A CAPABILITY LOSS AND IS RECORDED AS SUCH. `tracking_no` is
 * non-empty on 5,595 eBay return rows and on ZERO of the 4,427 header rows —
 * return tracking lives only on event rows. Extracting it would mean
 * transferring ~40,000 rows per run instead of ~4,400, so the indicator reports
 * return tracking as unavailable rather than paying that.
 *
 * ---------------------------------------------------------------------------
 * COLLATIONS ARE MIXED WITHIN THIS DATABASE
 * ---------------------------------------------------------------------------
 * Discovery lost a query to `ER_CANT_AGGREGATE_NCOLLATIONS`: a UNION of raw
 * string columns across these tables is illegal because their column collations
 * differ. Each reader here touches ONE table and unions nothing, so the problem
 * does not arise — but a future reader that joins or unions them must wrap every
 * string in `CONVERT(... USING utf8mb4)`.
 */

/** A count a caller can compare against `MAX_QUERIES_PER_HOUR`. */
export type QueryBudget = { spent: number };

/**
 * The account's own stated hourly allowances, parsed from its grants.
 *
 * WHY THIS IS READ AT ALL. A run must not discover a budget problem part-way
 * through a nine-store read, and the allowance is not a constant this repository
 * should assert — it is a property of a credential somebody else administers. So
 * it is read and compared against the planned spend before the first data query.
 *
 * WHAT IT CANNOT DO, STATED BECAUSE IT MATTERS. MariaDB exposes the LIMITS
 * through `SHOW GRANTS` and exposes CURRENT HOURLY CONSUMPTION to no statement
 * this account can run — `information_schema.USER_STATISTICS` needs `userstat`
 * enabled and privileges this credential deliberately lacks. So a pre-flight
 * check can prove "the plan fits inside the stated allowance" and cannot prove
 * "the allowance has not already been spent by another consumer".
 *
 * The remaining protection is the one that does not need to know: MariaDB answers
 * an exhausted allowance with error 1226, and the importer stops on it without
 * retrying. A retry loop is what turns one exhausted hour into several.
 */
export type AccountLimits = {
  readonly maxQueriesPerHour: number | null;
  readonly maxConnectionsPerHour: number | null;
  readonly maxUserConnections: number | null;
};

/** Pure, so the parse is testable without a server. */
export function parseAccountLimits(grantLines: readonly string[]): AccountLimits {
  const joined = grantLines.join("\n").toUpperCase();
  const read = (name: string): number | null => {
    const match = new RegExp(`${name}\\s+(\\d+)`).exec(joined);
    return match === null ? null : Number(match[1]);
  };
  return {
    maxQueriesPerHour: read("MAX_QUERIES_PER_HOUR"),
    maxConnectionsPerHour: read("MAX_CONNECTIONS_PER_HOUR"),
    maxUserConnections: read("MAX_USER_CONNECTIONS"),
  };
}

/**
 * Reads the account's stated allowances. ONE query, counted like every other.
 *
 * Deliberately a second `SHOW GRANTS` rather than a change to
 * `assertOrderSourceReadOnly`: that function is shared with three shipped
 * importers and its single job is to refuse a writable credential. One extra
 * query out of a hundred is the cheaper price.
 */
export async function fetchAccountLimits(
  connection: MySqlQueryable,
  options: { readonly budget?: QueryBudget } = {},
): Promise<AccountLimits> {
  const [rows] = await connection.query("SHOW GRANTS FOR CURRENT_USER()");
  if (options.budget) options.budget.spent += 1;
  const lines = (rows as Array<Record<string, string>>).map(
    (row) => Object.values(row)[0] ?? "",
  );
  return parseAccountLimits(lines);
}

/**
 * Runaway guards. Each is roomy enough that ordinary growth is invisible and
 * tight enough to catch a store that has changed character. Row counts measured
 * 2026-10-02 are in the comments; the two filtered stores are sized for their
 * FILTERED population, which is the only one the statement returns.
 */
export const MAX_CASE_SOURCE_ROWS: Readonly<Record<CaseSourceTable, number>> = {
  ebay_returns: 40_000, // ~4,427 header rows
  amazon_returns: 60_000, // ~15,920
  cancellation: 20_000, // 1,263 level-0 rows
  amz_cancellations: 20_000, // 9
  shopify_returns: 20_000, // 2,019
  shopify_cancellations: 20_000, // 153
  inquiries: 40_000, // 8,054
  cases: 20_000, // 1,038
  payment_disputes: 20_000, // 37
};

/**
 * ONE STATEMENT PER STORE, EACH A COMPILE-TIME CONSTANT.
 *
 * The table name is NEVER interpolated. A table name cannot be a bound
 * parameter, so a passed value may only ever LOOK UP a prepared statement —
 * the rule `documentation/ai-coding-context.md` states and
 * `fetchCaseHistoryEvents` already follows.
 *
 * Every statement selects into the SAME column aliases, so one projector
 * normalises all nine. A column the store does not have is selected as NULL
 * explicitly rather than omitted, which is what makes the projector total and
 * keeps "this store has no buyer" visible in the statement itself.
 */
const SELECT_EBAY_RETURNS = `
  SELECT return_id             AS case_id,
         res_his_order         AS event_seq,
         id                    AS row_id,
         sub_source            AS sub_source,
         order_id              AS order_ref,
         item_id               AS item_ref,
         transaction_id        AS txn_ref,
         NULL                  AS counterparty_ref,
         NULL                  AS case_type_raw,
         status                AS status,
         current_state         AS state,
         type                  AS resolution,
         reason                AS reason,
         reason_type           AS reason_family,
         NULL                  AS fulfilment,
         NULL                  AS disposition,
         NULL                  AS is_case,
         NULL                  AS esc_date,
         buyer_esc             AS buyer_esc,
         seller_esc            AS seller_esc,
         NULL                  AS az_claim,
         seller_res_due_status AS seller_action_owed,
         seller_res_due_date   AS seller_action_due_at,
         return_qty            AS quantity,
         seller_refund_amount  AS refund_amount,
         seller_currency       AS refund_currency,
         request_date          AS opened_at,
         NULL                  AS closed_at,
         updated_at            AS source_updated_at
  FROM ebay_returns
  WHERE status IS NOT NULL
  ORDER BY return_id ASC, res_his_order ASC, id ASC
  LIMIT ?`;

/**
 * `fulfilment` is selected because it decides whether `status` is a case status
 * at all. `detailed_disposition` is the Amazon-fulfilled outcome's detail and is
 * read only to fill `disposition` for those rows.
 */
const SELECT_AMAZON_RETURNS = `
  SELECT amz_rma_id            AS case_id,
         NULL                  AS event_seq,
         id                    AS row_id,
         sub_source            AS sub_source,
         order_id              AS order_ref,
         item_id               AS item_ref,
         NULL                  AS txn_ref,
         NULL                  AS counterparty_ref,
         NULL                  AS case_type_raw,
         status                AS status,
         NULL                  AS state,
         resolution            AS resolution,
         reason                AS reason,
         NULL                  AS reason_family,
         fulfilment            AS fulfilment,
         detailed_disposition  AS disposition,
         NULL                  AS is_case,
         NULL                  AS esc_date,
         NULL                  AS buyer_esc,
         NULL                  AS seller_esc,
         a_z_claim             AS az_claim,
         NULL                  AS seller_action_owed,
         NULL                  AS seller_action_due_at,
         qty                   AS quantity,
         refunded_amount       AS refund_amount,
         currency              AS refund_currency,
         request_date          AS opened_at,
         return_delivery_date  AS closed_at,
         NULL                  AS source_updated_at
  FROM amazon_returns
  ORDER BY amz_rma_id ASC, id ASC
  LIMIT ?`;

/** `level = 0` is the header row. The source's own comment names it 0-main. */
const SELECT_CANCELLATION = `
  SELECT cancel_id                AS case_id,
         NULL                     AS event_seq,
         id                       AS row_id,
         sub_source               AS sub_source,
         order_id                 AS order_ref,
         item_id                  AS item_ref,
         transaction_id           AS txn_ref,
         NULL                     AS counterparty_ref,
         NULL                     AS case_type_raw,
         status                   AS status,
         current_state            AS state,
         close_reason             AS resolution,
         reason                   AS reason,
         requestor_type           AS reason_family,
         NULL                     AS fulfilment,
         NULL                     AS disposition,
         NULL                     AS is_case,
         NULL                     AS esc_date,
         NULL                     AS buyer_esc,
         NULL                     AS seller_esc,
         NULL                     AS az_claim,
         NULL                     AS seller_action_owed,
         seller_response_due_date AS seller_action_due_at,
         cancel_qty               AS quantity,
         request_refund_amount    AS refund_amount,
         currency                 AS refund_currency,
         request_date             AS opened_at,
         close_date               AS closed_at,
         updated_at               AS source_updated_at
  FROM cancellation
  WHERE level = ?
  ORDER BY cancel_id ASC, id ASC
  LIMIT ?`;

/** The level value that marks a cancellation header. Bound, never inlined. */
export const CANCELLATION_HEADER_LEVEL = 0;

const SELECT_AMZ_CANCELLATIONS = `
  SELECT id               AS case_id,
         NULL             AS event_seq,
         id               AS row_id,
         sub_source       AS sub_source,
         order_id         AS order_ref,
         NULL             AS item_ref,
         NULL             AS txn_ref,
         NULL             AS counterparty_ref,
         NULL             AS case_type_raw,
         order_status     AS status,
         NULL             AS state,
         NULL             AS resolution,
         cancel_reason    AS reason,
         NULL             AS reason_family,
         NULL             AS fulfilment,
         NULL             AS disposition,
         NULL             AS is_case,
         NULL             AS esc_date,
         NULL             AS buyer_esc,
         NULL             AS seller_esc,
         NULL             AS az_claim,
         NULL             AS seller_action_owed,
         NULL             AS seller_action_due_at,
         NULL             AS quantity,
         NULL             AS refund_amount,
         NULL             AS refund_currency,
         order_date       AS opened_at,
         last_update_date AS closed_at,
         NULL             AS source_updated_at
  FROM amz_cancellations
  ORDER BY id ASC
  LIMIT ?`;

/**
 * Seven columns at source, and the case type that falls out of them is REFUND.
 * There is no status, no reason and no lifecycle to read, so this statement
 * selects NULL for all three rather than inventing a stand-in.
 */
const SELECT_SHOPIFY_RETURNS = `
  SELECT id              AS case_id,
         NULL            AS event_seq,
         id              AS row_id,
         sub_source      AS sub_source,
         order_id        AS order_ref,
         NULL            AS item_ref,
         NULL            AS txn_ref,
         NULL            AS counterparty_ref,
         NULL            AS case_type_raw,
         NULL            AS status,
         NULL            AS state,
         NULL            AS resolution,
         NULL            AS reason,
         NULL            AS reason_family,
         NULL            AS fulfilment,
         NULL            AS disposition,
         NULL            AS is_case,
         NULL            AS esc_date,
         NULL            AS buyer_esc,
         NULL            AS seller_esc,
         NULL            AS az_claim,
         NULL            AS seller_action_owed,
         NULL            AS seller_action_due_at,
         NULL            AS quantity,
         refund_amount   AS refund_amount,
         refund_currency AS refund_currency,
         date            AS opened_at,
         NULL            AS closed_at,
         created_at      AS source_updated_at
  FROM shopify_returns
  ORDER BY id ASC
  LIMIT ?`;

/**
 * `customer_email`, `customer_name`, `shipping_city` and `shipping_country`
 * exist on this store and are NOT selected. They are the only directly
 * identifying customer fields in any of the nine, and there is no column in 0022
 * that could hold one.
 */
const SELECT_SHOPIFY_CANCELLATIONS = `
  SELECT id                 AS case_id,
         NULL               AS event_seq,
         id                 AS row_id,
         sub_source         AS sub_source,
         order_id           AS order_ref,
         item_id            AS item_ref,
         NULL               AS txn_ref,
         NULL               AS counterparty_ref,
         NULL               AS case_type_raw,
         financial_status   AS status,
         fulfillment_status AS state,
         NULL               AS resolution,
         cancel_reason      AS reason,
         NULL               AS reason_family,
         NULL               AS fulfilment,
         NULL               AS disposition,
         NULL               AS is_case,
         NULL               AS esc_date,
         NULL               AS buyer_esc,
         NULL               AS seller_esc,
         NULL               AS az_claim,
         NULL               AS seller_action_owed,
         NULL               AS seller_action_due_at,
         qty                AS quantity,
         refund_subtotal    AS refund_amount,
         currency           AS refund_currency,
         cancelled_at       AS opened_at,
         closed_at          AS closed_at,
         created_at         AS source_updated_at
  FROM shopify_cancellations
  ORDER BY id ASC
  LIMIT ?`;

/**
 * `is_case` and `esc_date` are the escalation signal — the only one of the nine
 * stores that records a per-case one in this form. `esc_reason` is its free-text
 * sibling and is deliberately absent.
 *
 * `item_id` and `transaction_id` ARE selected, and 0021 deliberately did not
 * select them. That is the change this feature rests on: the pair is the
 * marketplace's own order-line identifier, present on 100% of rows, and it
 * resolves 1,182 of 1,189 cases to exactly one order with none ambiguous — where
 * item plus BUYER, which 0021 considered, is ambiguous on 7%.
 */
const SELECT_INQUIRIES = `
  SELECT inquiry_id     AS case_id,
         res_his_order  AS event_seq,
         id             AS row_id,
         sub_source     AS sub_source,
         NULL           AS order_ref,
         item_id        AS item_ref,
         transaction_id AS txn_ref,
         buyer          AS counterparty_ref,
         type           AS case_type_raw,
         status         AS status,
         state          AS state,
         res_type       AS resolution,
         NULL           AS reason,
         intiator       AS reason_family,
         NULL           AS fulfilment,
         NULL           AS disposition,
         is_case        AS is_case,
         esc_date       AS esc_date,
         NULL           AS buyer_esc,
         NULL           AS seller_esc,
         NULL           AS az_claim,
         NULL           AS seller_action_owed,
         due_date       AS seller_action_due_at,
         inquiry_qty    AS quantity,
         claim_amount   AS refund_amount,
         claim_cur      AS refund_currency,
         req_date       AS opened_at,
         NULL           AS closed_at,
         NULL           AS source_updated_at
  FROM inquiries
  ORDER BY inquiry_id ASC, res_his_order ASC, id ASC
  LIMIT ?`;

/**
 * The pre-inquiry formal-case store, which stopped being written 2025-05-31.
 * No escalation columns are read: `esc_reason` is free text AND NULL on all
 * 1,038 rows, so there is nothing to carry even if it were wanted.
 */
const SELECT_CASES = `
  SELECT case_id        AS case_id,
         res_his_order  AS event_seq,
         id             AS row_id,
         sub_source     AS sub_source,
         NULL           AS order_ref,
         item_id        AS item_ref,
         transaction_id AS txn_ref,
         buyer          AS counterparty_ref,
         case_type      AS case_type_raw,
         status         AS status,
         state          AS state,
         res_type       AS resolution,
         NULL           AS reason,
         intiator       AS reason_family,
         NULL           AS fulfilment,
         NULL           AS disposition,
         NULL           AS is_case,
         NULL           AS esc_date,
         NULL           AS buyer_esc,
         NULL           AS seller_esc,
         NULL           AS az_claim,
         NULL           AS seller_action_owed,
         due_date       AS seller_action_due_at,
         case_qty       AS quantity,
         claim_amount   AS refund_amount,
         claim_cur      AS refund_currency,
         req_date       AS opened_at,
         NULL           AS closed_at,
         NULL           AS source_updated_at
  FROM \`cases\`
  ORDER BY case_id ASC, res_his_order ASC, id ASC
  LIMIT ?`;

/**
 * `revision` is the event sequence here — there is no res_his_order — and it is
 * nullable, which is why the collapse sorts a null sequence oldest and breaks
 * ties on the row id.
 *
 * `buyer_note`, `return_address` and `evi_seller_note` are all free text, and
 * `return_address` is a customer's postal location in a longtext. None is read.
 */
const SELECT_PAYMENT_DISPUTES = `
  SELECT case_id        AS case_id,
         revision       AS event_seq,
         id             AS row_id,
         sub_source     AS sub_source,
         order_id       AS order_ref,
         item_id        AS item_ref,
         line_item_id   AS txn_ref,
         buyer          AS counterparty_ref,
         NULL           AS case_type_raw,
         status         AS status,
         seller_res     AS state,
         reason_closure AS resolution,
         reason         AS reason,
         pro_status     AS reason_family,
         NULL           AS fulfilment,
         NULL           AS disposition,
         NULL           AS is_case,
         NULL           AS esc_date,
         NULL           AS buyer_esc,
         NULL           AS seller_esc,
         NULL           AS az_claim,
         seller_res     AS seller_action_owed,
         NULL           AS seller_action_due_at,
         NULL           AS quantity,
         amount         AS refund_amount,
         currency       AS refund_currency,
         req_date       AS opened_at,
         close_date     AS closed_at,
         NULL           AS source_updated_at
  FROM payment_disputes
  ORDER BY case_id ASC, revision ASC, id ASC
  LIMIT ?`;

/** The statement map. A store name LOOKS UP a constant; it never builds one. */
const CASE_STATEMENTS: Readonly<Record<CaseSourceTable, string>> = {
  ebay_returns: SELECT_EBAY_RETURNS,
  amazon_returns: SELECT_AMAZON_RETURNS,
  cancellation: SELECT_CANCELLATION,
  amz_cancellations: SELECT_AMZ_CANCELLATIONS,
  shopify_returns: SELECT_SHOPIFY_RETURNS,
  shopify_cancellations: SELECT_SHOPIFY_CANCELLATIONS,
  inquiries: SELECT_INQUIRIES,
  cases: SELECT_CASES,
  payment_disputes: SELECT_PAYMENT_DISPUTES,
};

/** Exposed so a test can assert what each statement does and does not select. */
export const CASE_SOURCE_STATEMENTS = CASE_STATEMENTS;

/** One source row as the driver hands it back, before normalisation. */
type CaseQueryRow = {
  case_id: string | number | null;
  event_seq: number | null;
  row_id: string | number;
  sub_source: number | null;
  order_ref: string | null;
  item_ref: string | number | null;
  txn_ref: string | number | null;
  counterparty_ref: string | null;
  case_type_raw: string | null;
  status: string | null;
  state: string | null;
  resolution: string | null;
  reason: string | null;
  reason_family: string | null;
  fulfilment: string | null;
  disposition: string | null;
  is_case: number | null;
  esc_date: string | null;
  buyer_esc: number | null;
  seller_esc: number | null;
  az_claim: number | null;
  seller_action_owed: string | null;
  seller_action_due_at: string | null;
  quantity: number | string | null;
  refund_amount: number | string | null;
  refund_currency: string | null;
  opened_at: string | null;
  closed_at: string | null;
  source_updated_at: string | null;
};

/** Text, not Number: these are 20-digit source identifiers and a rounded one is
 *  a case nobody can find again. */
function asText(value: string | number | null): string | null {
  if (value === null) return null;
  const out = String(value).trim();
  return out === "" ? null : out;
}

function asNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
}

/**
 * ONE PROJECTOR FOR ALL NINE STORES, which is only possible because every
 * statement selects the same aliases. A per-store projector would be nine places
 * for the same rounding or timezone mistake to hide.
 */
export function toSourceCaseEvent(
  sourceTable: CaseSourceTable,
  row: CaseQueryRow,
): SourceCaseEvent {
  return {
    sourceTable,
    caseId: asText(row.case_id),
    eventSeq: row.event_seq === null ? null : Number(row.event_seq),
    rowId: String(row.row_id),
    subSource: row.sub_source === null ? null : Number(row.sub_source),
    orderRef: asText(row.order_ref),
    itemRef: asText(row.item_ref),
    txnRef: asText(row.txn_ref),
    counterpartyRef: asText(row.counterparty_ref),
    caseTypeRaw: asText(row.case_type_raw),
    status: asText(row.status),
    state: asText(row.state),
    resolution: asText(row.resolution),
    reason: asText(row.reason),
    reasonFamily: asText(row.reason_family),
    fulfilment: asText(row.fulfilment),
    disposition: asText(row.disposition),
    isCase: asNumber(row.is_case),
    escDate: asText(row.esc_date),
    buyerEsc: asNumber(row.buyer_esc),
    sellerEsc: asNumber(row.seller_esc),
    azClaim: asNumber(row.az_claim),
    sellerActionOwed: asText(row.seller_action_owed),
    sellerActionDueAt: asText(row.seller_action_due_at),
    quantity: asNumber(row.quantity),
    // Money kept as TEXT end to end: the destination column is numeric(12,2) and
    // a float round trip is how a refund amount loses a penny.
    refundAmount: asText(row.refund_amount),
    refundCurrency: asText(row.refund_currency),
    openedAt: asText(row.opened_at),
    closedAt: asText(row.closed_at),
    sourceUpdatedAt: asText(row.source_updated_at),
  };
}

/**
 * Every case row of one store, in ONE query.
 *
 * Throws at the runaway guard rather than returning a truncated store, because a
 * short read here imports a partial case set that reports as complete — the
 * exact failure the publication design exists to prevent, arriving by a
 * different door.
 *
 * `table` selects a compile-time-constant statement from the map; the name is
 * never interpolated.
 */
export async function fetchCaseSourceRows(
  connection: MySqlQueryable,
  table: CaseSourceTable,
  options: { readonly budget?: QueryBudget } = {},
): Promise<readonly SourceCaseEvent[]> {
  const text = CASE_STATEMENTS[table];
  const limit = MAX_CASE_SOURCE_ROWS[table];
  const values: unknown[] =
    table === "cancellation" ? [CANCELLATION_HEADER_LEVEL, limit] : [limit];

  const [rows] = await connection.query(text, values);
  if (options.budget) options.budget.spent += 1;

  const result = rows as CaseQueryRow[];
  if (result.length >= limit) {
    throw new Error(
      `${table} returned ${result.length} rows, at or past the ${limit} guard — ` +
        "refusing to import a possibly truncated case set",
    );
  }
  return result.map((row) => toSourceCaseEvent(table, row));
}
