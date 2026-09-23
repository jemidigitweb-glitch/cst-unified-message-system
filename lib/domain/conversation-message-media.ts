import type { EbayMessageLink } from "@/lib/repositories/ebay-message-link-repository";

/**
 * Turning one `message_app.files` row into a CST message-media record.
 *
 * PURE. No network, no database, no clock.
 *
 * ------------------------------------------------------------------------
 * AUTHORSHIP COMES FROM THE MESSAGE, NEVER FROM THE FILE
 * ------------------------------------------------------------------------
 * `files.submitter` holds `BUYER`/`SELLER` — but only on eBay's RETURN images.
 * On all 12,965 message-media rows it is NULL, so a reader that trusted it
 * would conclude nothing, and a reader that filled the gap would be guessing
 * which party sent a photograph.
 *
 * The parent message already knows: `conversation_messages.direction` is NOT
 * NULL and constrained to `inbound`/`outbound`, decided by eBay's `folder_id`
 * against evidence recorded in `lib/marketplaces/ebay/adapter.ts`. So this
 * module never receives `submitter` and 0016 stores no authorship column at
 * all — one fact, one place, no second weaker copy to drift.
 *
 * `authorshipOf` exists so the importer can REPORT the inbound/outbound split
 * without inventing a column to store it in.
 *
 * ------------------------------------------------------------------------
 * A PARENT MESSAGE IS NEVER INVENTED
 * ------------------------------------------------------------------------
 * `conversation_message_id` is NOT NULL with a real foreign key. A media row
 * whose message CST has not ingested cannot be stored, and must not be made
 * storable by creating the message. Only 1,095 of ~9,159 media-bearing
 * messages were present at last measurement (11.9%) — the rest predate CST's
 * eBay window. Those are skipped, counted, and will import unchanged once the
 * history reaches them.
 *
 * ------------------------------------------------------------------------
 * REJECTIONS ARE REPORTED, NOT SILENTLY DROPPED
 * ------------------------------------------------------------------------
 * The three CHECKs on the table — non-empty URL, `https://` prefix,
 * `view_order >= 0` — are enforced here too, ahead of the insert. Not because
 * the database cannot be trusted, but because a constraint violation aborts a
 * whole batch and names one row, whereas a rejection names the row, the
 * reason, and lets the other 12,964 land.
 */

export type SourceMediaRow = {
  readonly sourcePk: string;
  readonly sourceRefId: string | null;
  readonly mediaUrl: string | null;
  readonly viewOrder: number | null;
};

export type MediaRecord = {
  readonly conversationMessageId: number;
  readonly sourceDatabase: "message_app";
  readonly sourceTable: "files";
  readonly sourcePk: string;
  readonly sourceRefId: string;
  readonly mediaUrl: string;
  readonly viewOrder: number;
};

/** Why a row could not be stored. Every one is reported by the importer. */
export type MediaRejection =
  | "no_source_ref"
  | "no_media_url"
  | "insecure_media_url"
  | "invalid_view_order"
  | "message_not_in_cst";

export type MappedMedia =
  | { readonly ok: true; readonly record: MediaRecord; readonly direction: "inbound" | "outbound" }
  | { readonly ok: false; readonly sourcePk: string; readonly reason: MediaRejection };

/** The reference must be a bare id: it is the key the two-hop lookup uses. */
export function usableSourceRefId(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

/**
 * Whether a URL is one the table will accept.
 *
 * Mirrors `ck_conversation_message_media_url_https`. Every observed URL is
 * https today (12,965 of 12,965) across `i.ebayimg.com`,
 * `zstoreservice.vip.ebay.com` and the business's own object storage; a plain
 * http URL would be a source change worth a person looking at, not something
 * to render in a reviewer's browser.
 */
export function usableMediaUrl(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  return trimmed.startsWith("https://") ? trimmed : null;
}

/**
 * Who attached this image, read from the message it arrived on.
 *
 * `inbound` means the customer sent it. That is the whole point of the import:
 * the damage rules require a photograph before anything is offered, and the
 * reviewer currently has to leave CST to see it.
 */
export function authorshipOf(direction: "inbound" | "outbound"): "customer" | "cst" {
  return direction === "inbound" ? "customer" : "cst";
}

/**
 * Maps one media row against whatever the lookup found for its message.
 *
 * `link` is supplied by the caller — this performs no lookup and cannot
 * fabricate a parent. `null` means the message is not in CST yet, which is a
 * skip rather than an error.
 */
export function mapMediaRow(row: SourceMediaRow, link: EbayMessageLink | null): MappedMedia {
  const sourceRefId = usableSourceRefId(row.sourceRefId);
  if (sourceRefId === null) return { ok: false, sourcePk: row.sourcePk, reason: "no_source_ref" };

  const trimmedUrl = row.mediaUrl?.trim() ?? "";
  if (trimmedUrl === "") return { ok: false, sourcePk: row.sourcePk, reason: "no_media_url" };

  const mediaUrl = usableMediaUrl(row.mediaUrl);
  if (mediaUrl === null) {
    return { ok: false, sourcePk: row.sourcePk, reason: "insecure_media_url" };
  }

  if (row.viewOrder === null || !Number.isInteger(row.viewOrder) || row.viewOrder < 0) {
    return { ok: false, sourcePk: row.sourcePk, reason: "invalid_view_order" };
  }

  if (link === null) {
    return { ok: false, sourcePk: row.sourcePk, reason: "message_not_in_cst" };
  }

  return {
    ok: true,
    direction: link.direction,
    record: {
      conversationMessageId: link.conversationMessageId,
      sourceDatabase: "message_app",
      sourceTable: "files",
      sourcePk: row.sourcePk,
      sourceRefId,
      mediaUrl,
      viewOrder: row.viewOrder,
    },
  };
}
