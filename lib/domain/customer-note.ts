import { MARKETPLACES, type Marketplace } from "@/lib/domain/marketplace";

/**
 * Customer notes — what a BUYER attached to their order at the source.
 *
 * ONLY `note_type = 'buyer'`. The source's `order_management.note` holds two
 * kinds and says which: 8,144 `buyer` rows and 113 `team` rows on 2026-09-21.
 * Team notes are colleagues writing to each other about an order, and showing
 * one under a heading that says "customer" would put a colleague's words in a
 * customer's mouth. The discriminator is a stored column, not an inference, so
 * the filter is exact rather than a guess about authorship.
 *
 * A BLANK NOTE IS NOT A NOTE. One buyer row has empty text; it carries nothing
 * to read and would render as a row with a date and a gap.
 */

/** The note types the source records. Only the first is ever displayed. */
export const CUSTOMER_NOTE_TYPE = "buyer";
export const INTERNAL_NOTE_TYPE = "team";

export type CustomerNote = {
  readonly id: string;
  /** `order_management.orders.id` — the row, not the printed reference. */
  readonly orderRowId: string;
  /** The marketplace's own order reference, which is what a person reads. */
  readonly orderNumber: string | null;
  /**
   * The ORDER's customer, from `customers.customer_info` with
   * `shipping_address.address_name` as the fallback — the same two columns the
   * order sidebar already reads.
   *
   * The note itself carries no identity of any kind, so this is whose order it
   * is, not a claim about who typed the note. Null where the source recorded
   * neither, which is shown as absent rather than filled in.
   */
  readonly customerName: string | null;
  readonly noteText: string;
  /** NAIVE, copied verbatim from the source. Formatted for display only. */
  readonly createdAt: string | null;
  /** The storefront the order was placed on, for context on the row. */
  readonly storefront: string | null;
  /** Null where the source platform has no channel in this application. */
  readonly channel: Marketplace | null;
};

export type CustomerNoteFeed = {
  readonly notes: readonly CustomerNote[];
  /** How many notes were examined, so a bounded list can say it is bounded. */
  readonly scanned: number;
  readonly hasMore: boolean;
};

/**
 * Why a note could not be opened.
 *
 * A CLOSED SET, because each one is shown to a reviewer as a sentence and
 * "something went wrong" is not a sentence anybody can act on. `ambiguous` is
 * the one that matters: an order can be linked to more than one conversation,
 * and picking one would be guessing which customer thread a note belongs to.
 */
export const NOTE_RESOLUTION_FAILURES = ["not_found", "unlinked", "ambiguous"] as const;

export type NoteResolutionFailure = (typeof NOTE_RESOLUTION_FAILURES)[number];

export type NoteResolution =
  | { readonly resolved: true; readonly conversationId: string; readonly marketplace: Marketplace }
  | { readonly resolved: false; readonly reason: NoteResolutionFailure };

/** What a reviewer is told when a note will not open. Never a code. */
export const NOTE_RESOLUTION_MESSAGE: Readonly<Record<NoteResolutionFailure, string>> = {
  not_found: "This note is no longer in the order system.",
  unlinked:
    "No conversation has been matched to this order yet, so there is nothing to open.",
  ambiguous:
    "This order is matched to more than one conversation, so which one this note belongs to is not established.",
};

/**
 * Whether a source row may be shown as a customer note.
 *
 * PURE, and the single place the two rules live, so the SQL filter and any
 * caller that re-checks cannot drift apart.
 */
export function isDisplayableCustomerNote(row: {
  readonly noteType: string | null;
  readonly noteText: string | null;
}): boolean {
  if (row.noteType !== CUSTOMER_NOTE_TYPE) return false;
  return row.noteText !== null && row.noteText.trim() !== "";
}

/**
 * Which marketplace's notes are on screen.
 *
 * `all` is the default. `other` exists because notes are NOT confined to the
 * five marketplaces this application has channels for — the source runs
 * seventeen platforms, and a note from Etsy or Wayfair is still a customer
 * note. Filing those under a marketplace they do not belong to would be a lie;
 * dropping them would hide real notes. They get their own tab and say so.
 */
export type CustomerNoteChannelFilter = Marketplace | "other";

/**
 * The tab the panel opens on.
 *
 * THERE IS NO "ALL" TAB, deliberately. A mixed list asks the reader to check
 * each row's marketplace before they can act on it, which is the work the tabs
 * exist to remove. One marketplace is always selected, and eBay is the one this
 * workspace opens on everywhere else — the notes panel agreeing with the rest
 * of the screen is worth more than starting on a total nobody asked for.
 */
export const DEFAULT_CUSTOMER_NOTE_CHANNEL: CustomerNoteChannelFilter = "ebay";

/**
 * The tabs to show, in a stable order, for the notes actually loaded.
 *
 * EVERY MARKETPLACE GETS A TAB AND A COUNT, including a zero. "Amazon 0" is
 * worth reading: it answers "is there anything for me over there?" without
 * clicking, and a tab that appears and disappears as notes arrive is one a
 * reviewer cannot learn the position of.
 *
 * `other` is the exception and appears only when something is in it — the
 * source runs seventeen platforms and this application has channels for five,
 * so an Etsy note is real and has nowhere else to go. An empty "Other" tab
 * would be a permanent question about platforms the reader cannot name.
 *
 * THE COUNTS ARE OF WHAT IS LOADED, not of all history. The panel fetches a
 * bounded page and says so beneath the list when there is more.
 *
 * PURE — the drawer holds no state and does no counting of its own.
 */
export function customerNoteChannelTabs(
  notes: readonly CustomerNote[],
  selected: CustomerNoteChannelFilter,
): readonly { readonly value: CustomerNoteChannelFilter; readonly count: number }[] {
  const counts = new Map<CustomerNoteChannelFilter, number>();
  for (const note of notes) {
    const key: CustomerNoteChannelFilter = note.channel ?? "other";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const showOther = counts.has("other") || selected === "other";

  return [
    ...MARKETPLACES.map((value) => ({ value, count: counts.get(value) ?? 0 })),
    ...(showOther ? [{ value: "other" as const, count: counts.get("other") ?? 0 }] : []),
  ];
}

/** The notes belonging to one tab. Pure, and the only place the rule lives. */
export function customerNotesForChannel(
  notes: readonly CustomerNote[],
  filter: CustomerNoteChannelFilter,
): readonly CustomerNote[] {
  if (filter === "other") return notes.filter((note) => note.channel === null);
  return notes.filter((note) => note.channel === filter);
}

/** What the non-marketplace tab is called. It names itself, not a platform. */
export const CUSTOMER_NOTE_TAB_LABEL: Readonly<Record<"other", string>> = {
  other: "Other",
};

/** The panel's own title, so the drawer and its tests cannot disagree. */
export const CUSTOMER_NOTES_TITLE = "Customer notes";

/** Shown when the source has none to report. */
export const CUSTOMER_NOTES_EMPTY = "No customer notes.";
