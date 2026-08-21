import type { SourceMessage, SourceWatermark } from "@/lib/domain/source-message";

/**
 * Shared, marketplace-NEUTRAL windowing for read-only source fetches.
 *
 * STRICTLY READ-ONLY — this builds SELECT statements and nothing else. Every
 * caller-supplied value is parameterised; only the column and table names come
 * from a marketplace adapter's own frozen descriptor, never from a request.
 *
 * What lives here is the part that is genuinely the same everywhere: the
 * watermark/bootstrap window, the limit clamp, and the shared ordering intent
 * (source timestamp first, source PK as tiebreaker only). What columns to
 * select, and what those columns mean, stays with each adapter.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

export const MAX_FETCH_LIMIT = 5000;
export const DEFAULT_FETCH_LIMIT = 200;

/**
 * Which rows to read.
 *
 * `bootstrap` is the bounded development window: a start timestamp is required,
 * so a first run cannot silently become a full historical import.
 */
export type FetchWindow =
  | { readonly mode: "after"; readonly watermark: SourceWatermark }
  | { readonly mode: "bootstrap"; readonly startAt: string };

export type FetchOptions = {
  readonly window: FetchWindow;
  readonly limit?: number;
};

export type FetchResult = {
  readonly messages: readonly SourceMessage[];
  readonly unusableCount: number;
  readonly rowsExamined: number;
};

/** The source relation and the two columns that realise the ordering intent. */
export type SourceDescriptor = {
  readonly schema: string;
  readonly messageTable: string;
  readonly pkColumn: string;
  readonly timestampColumn: string;
};

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_FETCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer, received: ${String(limit)}`);
  }
  return Math.min(limit, MAX_FETCH_LIMIT);
}

/**
 * Builds a bounded, ordered, parameterised fetch over one source table.
 *
 * `selectList` is the adapter's own column projection, including the casts that
 * keep bigints and naive timestamps intact across the driver.
 */
export function buildFetchQuery(
  source: SourceDescriptor,
  selectList: string,
  options: FetchOptions,
): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  let where: string;

  switch (options.window.mode) {
    case "after": {
      values.push(options.window.watermark.sourceTimestamp, options.window.watermark.sourcePk);
      where = `\n  WHERE (m.${source.timestampColumn}, m.${source.pkColumn}) > ($1::timestamp, $2::bigint)`;
      break;
    }
    case "bootstrap": {
      values.push(options.window.startAt);
      where = `\n  WHERE m.${source.timestampColumn} >= $1::timestamp`;
      break;
    }
    default:
      // Unreachable through the type, but reachable from untyped callers. There
      // is deliberately no unbounded mode: a window that cannot be expressed
      // must fail loudly rather than degrade into a full historical read.
      throw new Error(
        `Unsupported fetch window: ${String((options.window as { mode?: unknown }).mode)}`,
      );
  }

  values.push(clampLimit(options.limit));

  return {
    text:
      `SELECT${selectList}\n  FROM ${source.schema}.${source.messageTable} m${where}` +
      `\n  ORDER BY m.${source.timestampColumn} ASC, m.${source.pkColumn} ASC` +
      `\n  LIMIT $${values.length}`,
    values,
  };
}

/** Normalises rows, counting anything that cannot be represented honestly. */
export function classifyRows<Row>(
  rows: readonly Row[],
  normalize: (row: Row) => SourceMessage | null,
): FetchResult {
  const messages: SourceMessage[] = [];
  let unusableCount = 0;

  for (const row of rows) {
    const normalized = normalize(row);
    if (normalized === null) unusableCount += 1;
    else messages.push(normalized);
  }

  return { messages, unusableCount, rowsExamined: rows.length };
}

/** Runs a built fetch and normalises the result. */
export async function fetchMessages<Row>(
  client: Queryable,
  source: SourceDescriptor,
  selectList: string,
  normalize: (row: Row) => SourceMessage | null,
  options: FetchOptions,
): Promise<FetchResult> {
  const { rows } = await client.query(buildFetchQuery(source, selectList, options));
  return classifyRows(rows as Row[], normalize);
}
