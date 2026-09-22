import { z } from "zod";

/**
 * Shared CST follow-up reminders: "this customer conversation needs follow-up
 * at this time."
 *
 * ------------------------------------------------------------------------
 * IT REMINDS A PERSON. IT CANNOT CONTACT A CUSTOMER.
 * ------------------------------------------------------------------------
 * There is no recipient, no channel, no marketplace, no body and no template
 * anywhere in this contract, and no status meaning a message left the system —
 * see `FOLLOW_UP_REMINDER_STATUSES`, which is the whole vocabulary. A reminder
 * coming due is a reason for somebody to open the conversation and decide; the
 * acting happens in the systems that can act. `note` is CST's own words to CST.
 *
 * ------------------------------------------------------------------------
 * SHARED, NOT OWNED
 * ------------------------------------------------------------------------
 * A reminder belongs to a CONVERSATION, never to a person. There is no
 * assignee, no author and no completer, because this application has no
 * authentication and no current user — `cst_app.app_users` holds zero rows. A
 * field that could only ever be null is a field readers learn to ignore, so
 * ownership waits for identity. See migration 0014.
 *
 * ------------------------------------------------------------------------
 * THREE STATES STORED, FOUR SHOWN
 * ------------------------------------------------------------------------
 * `upcoming`, `due soon` and `overdue` are the same `scheduled` row read
 * against a clock — they are NOT stored and must not be, because a persisted
 * `overdue` is wrong from the moment it comes due until something remembers to
 * update it. Nothing in this module derives them either: that is a display
 * question for the interface this backend does not build.
 */

/** The persisted vocabulary, exhaustively. Matches `ck_follow_up_reminders_status`. */
export const FOLLOW_UP_REMINDER_STATUSES = ["scheduled", "completed", "cancelled"] as const;
export type FollowUpReminderStatus = (typeof FOLLOW_UP_REMINDER_STATUSES)[number];

/** One reminder, as it crosses the wire. Instants are ISO strings. */
export type FollowUpReminder = {
  readonly id: string;
  readonly conversationId: string;
  readonly promisedDueAt: string;
  readonly note: string | null;
  readonly status: FollowUpReminderStatus;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/**
 * How long a note may be. Generous, because it is a person writing to a
 * colleague about a customer they just spoke to, and a truncated reminder is
 * worse than a long one.
 */
export const MAX_REMINDER_NOTE_LENGTH = 2000;

/**
 * Creating a reminder. The whole input, and deliberately this short.
 *
 * NOT REQUIRED, AND NOT ACCEPTED: any user or staff id, a marketplace, a
 * channel, a recipient, a reply body. `.strict()` is what makes that a
 * guarantee rather than a convention — an unexpected key is a 400, so a caller
 * cannot start smuggling an owner in ahead of the migration that adds one.
 */
export const createFollowUpReminderSchema = z
  .object({
    /**
     * When we said we would come back.
     *
     * Accepted as any string `Date` can parse to a real instant, then
     * normalised to ISO. Validated by parsing rather than by a regex so a
     * caller is not made to guess a format — but an unparseable value is a 400
     * rather than an Invalid Date reaching the column.
     *
     * DELIBERATELY NOT CONSTRAINED TO THE FUTURE. Nothing in this application
     * establishes that convention, and a reminder recorded a moment after the
     * promise lapsed is a real thing a person needs to record. The task that
     * introduced this said not to invent the restriction, and it is not
     * invented here.
     *
     * DELIBERATELY NOT LIMITED TO 24/48/72 HOURS. Those are the common
     * promises, not the only ones, and a fixed set belongs in the interface
     * that offers the buttons rather than in the contract that stores a time.
     */
    promisedDueAt: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), "not a parseable timestamp")
      .transform((value) => new Date(value).toISOString()),

    /**
     * Optional. A whitespace-only note is REJECTED rather than stored, because
     * `ck_follow_up_reminders_note_present` would reject it anyway and a 400
     * naming the field is a better answer than a 500 naming a constraint.
     * Trimmed first, so the check here and the check in the database agree on
     * what "empty" means.
     */
    note: z.string().trim().min(1).max(MAX_REMINDER_NOTE_LENGTH).nullish(),
  })
  .strict();

export type CreateFollowUpReminderInput = z.infer<typeof createFollowUpReminderSchema>;

/**
 * Completing a reminder. The body carries NOTHING.
 *
 * `scheduled -> completed` is the only transition this backend implements, so
 * there is nothing for a caller to choose and nothing to validate. An empty
 * strict object is how that is said in a way a future edit has to argue with:
 * adding `status` here would be adding a second transition.
 */
export const completeFollowUpReminderSchema = z.object({}).strict();

/** Whether a string is one of the persisted statuses. For query-string filters. */
export function isFollowUpReminderStatus(value: unknown): value is FollowUpReminderStatus {
  return (
    typeof value === "string" &&
    (FOLLOW_UP_REMINDER_STATUSES as readonly string[]).includes(value)
  );
}
