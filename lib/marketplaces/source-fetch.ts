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

/**
 * The largest set of primary keys one read-by-pk may ask for.
 *
 * Separate from MAX_FETCH_LIMIT because it bounds a different thing: not how
 * much of the source to walk, but how many already-known rows to look up at
 * once. Keeping it modest keeps the parameter array small and the plan an index
 * scan rather than a sort.
 */
export const MAX_PK_BATCH = 500;

/** Source primary keys are bigints everywhere; anything else is a caller bug. */
export function assertSourcePks(sourcePks: readonly string[]): void {
  if (sourcePks.length === 0) {
    throw new Error("at least one source pk is required");
  }
  if (sourcePks.length > MAX_PK_BATCH) {
    throw new Error(`too many source pks in one read: ${sourcePks.length} > ${MAX_PK_BATCH}`);
  }
  for (const pk of sourcePks) {
    if (!/^\d+$/.test(pk)) {
      throw new Error(`source pk is not a bigint: ${pk}`);
    }
  }
}

/**
 * Builds a read of specific, already-known source rows.
 *
 * THIS IS NOT A WINDOW AND MUST NOT BECOME ONE. `buildFetchQuery` above answers
 * "what is new?" and owns the watermark; this answers "what does row N say
 * now?", which is a different question with no cursor, no resume point and no
 * relationship to `sync_state`. Repair reads rows the sync has already passed,
 * so giving it a window would be giving it a way to rewind one.
 *
 * The keys are parameterised as a single bigint array — one round trip for the
 * whole batch, and no identifier in the statement comes from a caller.
 */
export function buildPkFetchQuery(
  source: SourceDescriptor,
  selectList: string,
  sourcePks: readonly string[],
): { text: string; values: unknown[] } {
  assertSourcePks(sourcePks);
  return {
    text:
      `SELECT${selectList}\n  FROM ${source.schema}.${source.messageTable} m` +
      `\n  WHERE m.${source.pkColumn} = ANY($1::bigint[])` +
      `\n  ORDER BY m.${source.timestampColumn} ASC, m.${source.pkColumn} ASC`,
    values: [[...sourcePks]],
  };
}

/** Reads specific source rows by primary key and normalises them. */
export async function fetchMessagesByPk<Row>(
  client: Queryable,
  source: SourceDescriptor,
  selectList: string,
  normalize: (row: Row) => SourceMessage | null,
  sourcePks: readonly string[],
): Promise<FetchResult> {
  const { rows } = await client.query(buildPkFetchQuery(source, selectList, sourcePks));
  return classifyRows(rows as Row[], normalize);
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
