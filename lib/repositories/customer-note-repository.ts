import "server-only";

import {
  CUSTOMER_NOTE_TYPE,
  type CustomerNote,
  type CustomerNoteFeed,
  type NoteResolution,
  isDisplayableCustomerNote,
} from "@/lib/domain/customer-note";
import { channelForSourceId } from "@/lib/domain/automation/automation-types";
import type { Marketplace } from "@/lib/domain/marketplace";

/**
 * Customer notes, read from the live source database.
 *
 * STRICTLY READ-ONLY. SELECT and nothing else. The pool this runs on pins
 * `default_transaction_read_only=on`, so the server itself refuses a write.
 *
 * THE MAPPING, VERIFIED LIVE on 2026-09-21:
 *
 *   order_management.note n              the note. PK `id`.
 *     n.note_type                        'buyer' (8,144) | 'team' (113)
 *     -> order_management.orders o       o.id = n.order_id
 *          all 8,257 notes matched an order; none has a null order_id
 *     -> order_management.sub_source ss  ss.id = o.sub_source_id
 *          ss.source_id names the platform, ss.name the storefront
 *
 * The note carries NO customer identity of its own — no buyer id, no email, no
 * handle. Its only link to a person is through the order, which is why the
 * conversation lookup below goes through the order row id and nothing else.
 *
 * `created_by` IS NOT THE AUTHORSHIP TEST and is deliberately unused. It is
 * null on 5,316 rows and holds a staff user id on many `buyer` rows — the
 * colleague who transcribed the note, not the person who wrote it. `note_type`
 * is the stored answer to "whose note is this"; `created_by` would be a guess.
 */

/** Source reads only. The source pool enforces `default_transaction_read_only=on`. */
export type SourceQueryable = {
  query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows: unknown[] }>;
};

/** Application reads. Used only to resolve a note's conversation. */
export type AppQueryable = {
  query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows: unknown[] }>;
};

type NoteRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  address_name: string | null;
  order_row_id: string;
  order_number: string | null;
  note_type: string | null;
  note_text: string | null;
  created_at: string | null;
  storefront: string | null;
  source_id: number | null;
};

const NOTE_COLUMNS = `
  DISTINCT ON (n.id)
  n.id::text            AS id,
  ci.first_name         AS first_name,
  ci.last_name          AS last_name,
  sa.address_name       AS address_name,
  n.order_id::text      AS order_row_id,
  o.order_id            AS order_number,
  n.note_type           AS note_type,
  n.note_text           AS note_text,
  n.created_at::text    AS created_at,
  ss.name               AS storefront,
  ss.source_id          AS source_id`;

const NOTE_FROM = `
FROM order_management.note n
JOIN order_management.orders o ON o.id = n.order_id
JOIN order_management.sub_source ss ON ss.id = o.sub_source_id
LEFT JOIN customers.customer_info ci ON ci.order_id = o.id
LEFT JOIN customers.shipping_address sa ON sa.order_id = o.id`;

/**
 * How far back the panel looks.
 *
 * ONE MONTH, ACROSS EVERY MARKETPLACE. A note is about an order that is
 * still in flight; one from six months ago is history, not work. The window
 * is what makes the counts on the tabs mean something comparable — "eBay 33"
 * is 33 notes this month, not 33 out of however many happened to fit in a
 * fixed page.
 *
 * Measured on 2026-09-21: 108 buyer notes in the window, across 18
 * storefronts and five platforms. Comfortably one request.
 */
const WINDOW = "1 month";

/**
 * BUYER NOTES ONLY, AND NEVER A BLANK ONE.
 *
 * Both rules are in the WHERE clause so an internal note is never transferred
 * at all, and both are checked again in code by `isDisplayableCustomerNote` —
 * a filter that exists in one place is a filter somebody edits without
 * noticing what it was for.
 *
 * `LIMIT $1 + 1` fetches one more than asked so the caller can say whether the
 * list is complete without a second count query.
 */
const FIND_NOTES = `
SELECT * FROM (
  SELECT ${NOTE_COLUMNS}
  ${NOTE_FROM}
  WHERE n.note_type = '${CUSTOMER_NOTE_TYPE}'
    AND n.note_text IS NOT NULL
    AND btrim(n.note_text) <> ''
    AND n.created_at > now() - interval '${WINDOW}'
  -- DISTINCT ON needs its own leading key; the newest-first order the reader
  -- actually sees is applied outside, where it is free to differ.
  ORDER BY n.id, ci.id, sa.id
) notes
ORDER BY created_at DESC NULLS LAST, id DESC
LIMIT $1::int`;

const FIND_ONE_NOTE = `
SELECT ${NOTE_COLUMNS}
${NOTE_FROM}
WHERE n.id = $1::bigint
ORDER BY n.id, ci.id, sa.id`;

/**
 * The customer's name, from the two columns that record it.
 *
 * `customer_info.first_name`/`last_name` first, then
 * `shipping_address.address_name` — the same person, recorded twice, and the
 * exact fallback `order-display-repository.ts` already uses. Never a
 * marketplace username: a handle is not a name.
 *
 * The note itself carries no identity at all, so this is the ORDER's
 * customer. That is the only person a note on that order can be about.
 */
function customerName(row: NoteRow): string | null {
  const parts = [row.first_name, row.last_name]
    .map((part) => part?.trim())
    .filter((part): part is string => part !== undefined && part !== "");
  if (parts.length > 0) return parts.join(" ");
  return blankToNull(row.address_name);
}

function blankToNull(value: string | null): string | null {
  return value === null || value.trim() === "" ? null : value;
}

function toNote(row: NoteRow): CustomerNote {
  return {
    id: row.id,
    orderRowId: row.order_row_id,
    orderNumber: blankToNull(row.order_number),
    customerName: customerName(row),
    // Non-null by the filter and the guard below; trimmed for display.
    noteText: (row.note_text ?? "").trim(),
    createdAt: blankToNull(row.created_at),
    storefront: blankToNull(row.storefront),
    // Null rather than guessed: the source lists seventeen platforms and this
    // application has five. A note from Etsy is still a note; it simply has no
    // channel chip to show.
    channel: row.source_id === null ? null : (channelForSourceId(Number(row.source_id)) ?? null),
  };
}

export async function findCustomerNotes(
  source: SourceQueryable,
  options: { readonly limit: number },
): Promise<CustomerNoteFeed> {
  const limit = Math.max(1, Math.min(options.limit, 1_000));
  const { rows } = await source.query({ text: FIND_NOTES, values: [limit + 1] });
  const typed = rows as NoteRow[];

  const displayable = typed.filter((row) =>
    isDisplayableCustomerNote({ noteType: row.note_type, noteText: row.note_text }),
  );
  const hasMore = displayable.length > limit;

  return {
    notes: displayable.slice(0, limit).map(toNote),
    scanned: Math.min(displayable.length, limit),
    hasMore,
  };
}

/** One note, by id, or undefined. Used by the resolver before it looks further. */
export async function customerNoteById(
  source: SourceQueryable,
  noteId: string,
): Promise<CustomerNote | undefined> {
  const { rows } = await source.query({ text: FIND_ONE_NOTE, values: [noteId] });
  const row = (rows as NoteRow[])[0];
  if (row === undefined) return undefined;
  // A note that is not a displayable buyer note is treated as absent rather
  // than returned: the resolver must not open a conversation from a team note
  // that the panel would never have shown in the first place.
  if (!isDisplayableCustomerNote({ noteType: row.note_type, noteText: row.note_text })) {
    return undefined;
  }
  return toNote(row);
}

/**
 * Which conversation an order has been VERIFIED to belong to.
 *
 * THE LINK ALREADY EXISTS AND IS NOT INVENTED HERE. `cst_app.context_snapshots`
 * is where this application records the order it resolved for a conversation,
 * and the only rows trusted are the deterministic single-order ones — the same
 * rows the context panel and the draft grounding already rely on. Ambiguous and
 * no-order snapshots carry no order number and no row ids at all, so they
 * cannot reach this query even by accident.
 *
 * MORE THAN ONE MATCH IS A REFUSAL, NOT A CHOICE. One order in the current data
 * is linked to two conversations. Opening either would be asserting which
 * customer thread a note belongs to, which nothing here establishes.
 */
const RESOLVE_CONVERSATION = `
SELECT DISTINCT c.id::text AS conversation_id, c.marketplace
FROM cst_app.context_snapshots s
JOIN cst_app.conversations c ON c.id = s.conversation_id
WHERE s.resolution = 'single_order'
  AND s.verification_method = 'deterministic_single'
  AND s.source_order_row_ids @> ARRAY[$1::bigint]`;

export async function resolveNoteConversation(
  app: AppQueryable,
  orderRowId: string,
): Promise<NoteResolution> {
  const { rows } = await app.query({ text: RESOLVE_CONVERSATION, values: [orderRowId] });
  const matches = rows as { conversation_id: string; marketplace: Marketplace }[];

  if (matches.length === 0) return { resolved: false, reason: "unlinked" };
  if (matches.length > 1) return { resolved: false, reason: "ambiguous" };

  const match = matches[0]!;
  return { resolved: true, conversationId: match.conversation_id, marketplace: match.marketplace };
}
