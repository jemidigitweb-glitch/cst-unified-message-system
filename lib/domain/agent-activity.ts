/**
 * Turning one row of the message application's activity log into a CST agent
 * activity record.
 *
 * PURE. No network, no database, no clock. The decisions here are about
 * MEANING — did this action resolve to a conversation, and can the person who
 * did it be named — and both are the kind of thing that must be arguable in
 * review rather than buried in a query.
 *
 * ------------------------------------------------------------------------
 * THREE MATCH OUTCOMES, AND THE DIFFERENCE MATTERS
 * ------------------------------------------------------------------------
 * `no_reference`   the log row identified no message at all. 4,757 of 17,815
 *                  eBay rows are like this — `move_to_resolved`,
 *                  `mark_as_no_need_reply` and the settings actions reference
 *                  nothing. They are real work and must be counted.
 * `unmatched`      it carried a reference that did not resolve to a CST
 *                  conversation. Expected in bulk: the log starts 2026-03-06
 *                  and CST's eBay history starts 2026-06-19, so everything
 *                  before that window has nowhere to land.
 * `matched`        it resolved.
 *
 * Collapsing the first two into one "unmatched" would make a missing
 * conversation indistinguishable from an action that never had one, and the
 * first is a gap worth chasing while the second is normal. Dropping either
 * would understate an agent's work.
 *
 * NOTHING IS EVER INVENTED. A conversation id appears only when the two-hop
 * lookup returned one.
 *
 * ------------------------------------------------------------------------
 * `externalMessageId` IS THE SOURCE'S REFERENCE, NOT CST's
 * ------------------------------------------------------------------------
 * A real trap. The log payload carries eBay's `ext_message_id` (13 digits);
 * `cst_app.conversation_messages.external_message_id` holds `message_id`
 * (12 digits). They are different numbers for the same message, and the
 * resolution runs ext_message_id -> header -> message_id -> conversation.
 *
 * This field stores what the LOG carried — the reference the match was
 * attempted on — because an `unmatched` row has nothing else to show, and
 * because reconciliation needs the key the attempt used. Migration 0017 names
 * it "the identifier the join was made on" for exactly this reason.
 *
 * ------------------------------------------------------------------------
 * WHAT IS NOT HERE
 * ------------------------------------------------------------------------
 * No message body. The log's `data` payload contains the full text of the
 * reply that was sent, the customer's email address and the subject line; the
 * reader lifts out one identifier and the payload never leaves MySQL. Nothing
 * in this file can store one because nothing in this file receives one.
 */

/** The only marketplace this importer handles. `source = 2` in the log. */
export const EBAY_SOURCE_ID = 2;

/**
 * Logins that are not a person.
 *
 * `86` is a shared account literally named `admin`. Work recorded under it
 * happened, but it cannot be credited to anybody, and a dashboard that prints
 * "admin" next to a productivity figure is attributing one person's numbers to
 * whoever was holding the shared password.
 *
 * The id is still STORED — an operator needs to see the work — and this set is
 * what the reader consults to refuse to name it. Writer keeps, reader refuses;
 * migration 0017 states the same split.
 */
export const SHARED_ACCOUNT_SOURCE_USER_IDS: ReadonlySet<number> = new Set([86]);

/** One activity-log row, exactly the fields the reader selects. */
export type SourceActivityRow = {
  readonly sourcePk: string;
  readonly sourceUserId: number | null;
  readonly action: string;
  readonly actionDate: string;
  readonly sourceId: number | null;
  readonly subSourceId: number | null;
  /** eBay's ext_message_id from the payload, or null when absent. */
  readonly extMessageId: string | null;
};

export type MatchStatus = "matched" | "unmatched" | "no_reference";

/** Why an action cannot be credited to a named person. */
export type ActorAttribution = "attributed" | "shared_account" | "unknown_actor" | "no_actor";

export type ActivityRecord = {
  readonly sourceDatabase: "message_app";
  readonly sourceTable: "message_app_logs";
  readonly sourcePk: string;
  readonly sourceUserId: number | null;
  readonly action: string;
  readonly actionDate: string;
  readonly marketplace: "ebay" | null;
  readonly subSourceId: number | null;
  readonly conversationId: number | null;
  readonly externalMessageId: string | null;
  readonly matchStatus: MatchStatus;
};

export type MappedActivity = {
  readonly record: ActivityRecord;
  readonly attribution: ActorAttribution;
};

/**
 * Whether the payload's reference is a usable id.
 *
 * `JSON_EXTRACT` on a JSON null yields the four characters `null`, not SQL
 * NULL, so a naive presence check treats "this row explicitly has no message"
 * as a reference and produces an `unmatched` row that could never match.
 * Only digits count.
 */
export function usableExtMessageId(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

/**
 * Can this action be credited to a named person?
 *
 * `knownSourceUserIds` is the set present in `cst_app.agent_directory`. An id
 * absent from it is an `unknown_actor` — the work is real and stored, but there
 * is no name for it and none may be invented.
 */
export function actorAttribution(
  sourceUserId: number | null,
  knownSourceUserIds: ReadonlySet<number>,
): ActorAttribution {
  if (sourceUserId === null) return "no_actor";
  if (SHARED_ACCOUNT_SOURCE_USER_IDS.has(sourceUserId)) return "shared_account";
  return knownSourceUserIds.has(sourceUserId) ? "attributed" : "unknown_actor";
}

/** `source = 2` is eBay. Any other value is not mapped rather than guessed. */
export function marketplaceOf(sourceId: number | null): "ebay" | null {
  return sourceId === EBAY_SOURCE_ID ? "ebay" : null;
}

/**
 * Maps one log row, given whatever the conversation lookup found for it.
 *
 * `conversationId` is supplied by the caller — this function performs no
 * lookup and cannot fabricate one. Passing a conversation id for a row with no
 * reference is a caller bug, and is rejected rather than stored: it would
 * produce a row claiming a match nothing attempted.
 */
export function mapActivityRow(
  row: SourceActivityRow,
  conversationId: number | null,
  knownSourceUserIds: ReadonlySet<number>,
): MappedActivity {
  const externalMessageId = usableExtMessageId(row.extMessageId);

  if (externalMessageId === null && conversationId !== null) {
    throw new Error(
      `row ${row.sourcePk} has no reference but was given conversation ${conversationId}`,
    );
  }

  const matchStatus: MatchStatus =
    externalMessageId === null ? "no_reference" : conversationId === null ? "unmatched" : "matched";

  return {
    attribution: actorAttribution(row.sourceUserId, knownSourceUserIds),
    record: {
      sourceDatabase: "message_app",
      sourceTable: "message_app_logs",
      sourcePk: row.sourcePk,
      sourceUserId: row.sourceUserId,
      action: row.action,
      actionDate: row.actionDate,
      marketplace: marketplaceOf(row.sourceId),
      subSourceId: row.subSourceId,
      conversationId,
      externalMessageId,
      matchStatus,
    },
  };
}
