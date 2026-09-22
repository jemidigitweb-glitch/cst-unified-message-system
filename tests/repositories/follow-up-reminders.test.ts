import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FOLLOW_UP_REMINDER_STATUSES,
  completeFollowUpReminderSchema,
  createFollowUpReminderSchema,
  isFollowUpReminderStatus,
} from "@/lib/domain/follow-up-reminder";
import {
  DEFAULT_REMINDER_LIMIT,
  MAX_REMINDER_LIMIT,
  completeReminder,
  createReminder,
  getConversationReminders,
  isFollowUpStoreMissing,
  isUnknownConversation,
  listReminders,
} from "@/lib/repositories/follow-up-reminder-repository";

/**
 * Shared follow-up reminders: the repository and its contract.
 *
 * NO DATABASE IS TOUCHED. The project's established repository-test strategy is
 * a fake `Queryable` that records the statement and its bound values and hands
 * back canned rows — see `tests/repositories/conversation-repository.test.ts`,
 * which this follows. That is the isolated write strategy: there is no test
 * database in this project and no production row is created to prove a query
 * shape. The schema itself, and the constraints these statements rely on, were
 * proved against the real database in a rolled-back transaction when migration
 * 0014 was written.
 *
 * Synthetic data throughout. No real customer, conversation or order appears.
 */

const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

type Call = { text: string; values?: unknown[] };

/** Records every statement and returns canned rows, in order. */
function fake(responses: unknown[][] = []) {
  const calls: Call[] = [];
  let index = 0;
  const db = {
    query: async (config: { text: string; values?: unknown[] }) => {
      calls.push(config);
      return { rows: responses[index++] ?? [] };
    },
  };
  return { calls, db };
}

/** A stored row, exactly as the columns come back. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "7",
    conversation_id: "45862",
    promised_due_at: new Date("2026-09-24T09:00:00Z"),
    note: "Customer chasing the replacement shade",
    status: "scheduled",
    completed_at: null,
    created_at: new Date("2026-09-22T09:00:00Z"),
    updated_at: new Date("2026-09-22T09:00:00Z"),
    ...overrides,
  };
}

/* ------------------------------------------------------------------------- *
 * CREATING A REMINDER
 * ------------------------------------------------------------------------- */

describe("creating a reminder", () => {
  it("writes one row and returns what the database stored", async () => {
    const { calls, db } = fake([[row()]]);
    const reminder = await createReminder(db, {
      conversationId: "45862",
      promisedDueAt: "2026-09-24T09:00:00.000Z",
      note: "Customer chasing the replacement shade",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("INSERT INTO cst_app.follow_up_reminders");
    expect(reminder.id).toBe("7");
    expect(reminder.status).toBe("scheduled");
  });

  /** The reminder belongs to the conversation the caller named. */
  it("links the reminder to the requested conversation", async () => {
    const { calls, db } = fake([[row({ conversation_id: "45862" })]]);
    const reminder = await createReminder(db, {
      conversationId: "45862",
      promisedDueAt: "2026-09-24T09:00:00.000Z",
    });

    expect(calls[0]!.values![0]).toBe("45862");
    expect(calls[0]!.text).toContain("$1::bigint");
    expect(reminder.conversationId).toBe("45862");
  });

  it("preserves the promised time exactly", async () => {
    const { calls, db } = fake([[row({ promised_due_at: new Date("2026-09-24T09:00:00Z") })]]);
    const reminder = await createReminder(db, {
      conversationId: "45862",
      promisedDueAt: "2026-09-24T09:00:00.000Z",
    });

    expect(calls[0]!.values![1]).toBe("2026-09-24T09:00:00.000Z");
    expect(reminder.promisedDueAt).toBe("2026-09-24T09:00:00.000Z");
  });

  it("stores an absent note as NULL rather than an empty string", async () => {
    const { calls, db } = fake([[row({ note: null })]]);
    const reminder = await createReminder(db, {
      conversationId: "45862",
      promisedDueAt: "2026-09-24T09:00:00.000Z",
    });

    expect(calls[0]!.values![2]).toBeNull();
    expect(reminder.note).toBeNull();
  });

  it("carries a note through when one is given", async () => {
    const { calls, db } = fake([[row({ note: "Ring them about the dome cone" })]]);
    const reminder = await createReminder(db, {
      conversationId: "45862",
      promisedDueAt: "2026-09-24T09:00:00.000Z",
      note: "Ring them about the dome cone",
    });

    expect(calls[0]!.values![2]).toBe("Ring them about the dome cone");
    expect(reminder.note).toBe("Ring them about the dome cone");
  });

  it("parameterises every value it writes", async () => {
    const { calls, db } = fake([[row()]]);
    await createReminder(db, {
      conversationId: "45862",
      promisedDueAt: "2026-09-24T09:00:00.000Z",
      note: "note",
    });
    // No value is interpolated into the statement text.
    expect(calls[0]!.text).not.toContain("45862");
    expect(calls[0]!.text).not.toContain("2026-09-24");
    expect(calls[0]!.values).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------------- *
 * VALIDATION — the contract, before any statement runs
 * ------------------------------------------------------------------------- */

describe("the create contract", () => {
  it("accepts a timestamp and an optional note", () => {
    const parsed = createFollowUpReminderSchema.safeParse({
      promisedDueAt: "2026-09-24T09:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.promisedDueAt).toBe("2026-09-24T09:00:00.000Z");
  });

  /** Matches `ck_follow_up_reminders_note_present`: an empty note is no note. */
  it("rejects a whitespace-only note", () => {
    for (const note of ["   ", "\t", "\n  \n"]) {
      const parsed = createFollowUpReminderSchema.safeParse({
        promisedDueAt: "2026-09-24T09:00:00.000Z",
        note,
      });
      expect(parsed.success, `note ${JSON.stringify(note)}`).toBe(false);
      expect(parsed.success === false && parsed.error.issues[0]!.path[0]).toBe("note");
    }
  });

  it("rejects an unparseable timestamp", () => {
    for (const promisedDueAt of ["", "soon", "2026-13-45", "not a date"]) {
      const parsed = createFollowUpReminderSchema.safeParse({ promisedDueAt });
      expect(parsed.success, promisedDueAt).toBe(false);
    }
  });

  /**
   * NO IDENTITY MAY BE ATTACHED. `.strict()` is what makes this structural: a
   * caller cannot start sending an owner to a table that has nowhere to put
   * one, so the field cannot appear before the migration that adds it.
   */
  it("refuses any staff, owner or send field", () => {
    for (const extra of [
      { assignedUserId: "3" },
      { createdByUserId: "3" },
      { userId: "3" },
      { status: "completed" },
      { channel: "ebay" },
      { recipient: "someone@example.com" },
      { body: "Hello" },
    ]) {
      const parsed = createFollowUpReminderSchema.safeParse({
        promisedDueAt: "2026-09-24T09:00:00.000Z",
        ...extra,
      });
      expect(parsed.success, JSON.stringify(extra)).toBe(false);
    }
  });

  /**
   * DELIBERATELY ABSENT RESTRICTIONS, pinned so nobody adds them by reflex:
   * there is no "must be in the future" rule and no 24/48/72-only rule.
   */
  it("accepts a past due time and any duration", () => {
    for (const promisedDueAt of ["2020-01-01T00:00:00.000Z", "2031-06-30T17:45:00.000Z"]) {
      expect(createFollowUpReminderSchema.safeParse({ promisedDueAt }).success).toBe(true);
    }
  });

  /** Completion carries nothing: there is one transition, so nothing to choose. */
  it("refuses a completion body that tries to decide anything", () => {
    expect(completeFollowUpReminderSchema.safeParse({}).success).toBe(true);
    for (const body of [{ status: "cancelled" }, { completedAt: "2026-09-22T00:00:00Z" }]) {
      expect(completeFollowUpReminderSchema.safeParse(body).success).toBe(false);
    }
  });

  it("knows the three persisted statuses and no others", () => {
    expect([...FOLLOW_UP_REMINDER_STATUSES]).toEqual(["scheduled", "completed", "cancelled"]);
    for (const bad of ["sent", "queued", "delivered", "notified", "overdue", "due_soon"]) {
      expect(isFollowUpReminderStatus(bad), bad).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * READING
 * ------------------------------------------------------------------------- */

describe("the shared list", () => {
  it("orders scheduled reminders earliest due first", async () => {
    const { calls, db } = fake([[row({ id: "1" }), row({ id: "2" })]]);
    const page = await listReminders(db, { status: "scheduled" });

    expect(calls[0]!.text).toContain("ORDER BY promised_due_at ASC, id ASC");
    expect(calls[0]!.values![0]).toBe("scheduled");
    expect(page.items.map((r) => r.id)).toEqual(["1", "2"]);
  });

  /** History reads most recently settled first, not by a promise nobody owes. */
  it("orders completed reminders by when they were settled", async () => {
    const { calls, db } = fake([[]]);
    await listReminders(db, { status: "completed" });
    expect(calls[0]!.text).toContain("ORDER BY COALESCE(completed_at, updated_at) DESC, id DESC");
    expect(calls[0]!.values![0]).toBe("completed");
  });

  it("asks for one row more than the page, and never returns it", async () => {
    const many = Array.from({ length: DEFAULT_REMINDER_LIMIT + 1 }, (_, i) =>
      row({ id: String(i) }),
    );
    const { calls, db } = fake([many]);
    const page = await listReminders(db, { status: "scheduled" });

    expect(calls[0]!.values![1]).toBe(DEFAULT_REMINDER_LIMIT + 1);
    expect(page.items).toHaveLength(DEFAULT_REMINDER_LIMIT);
    expect(page.hasMore).toBe(true);
  });

  it("reports no further page when the last one is short", async () => {
    const { calls, db } = fake([[row()]]);
    const page = await listReminders(db, { status: "scheduled", limit: 10, offset: 20 });

    expect(page.hasMore).toBe(false);
    expect(calls[0]!.values![1]).toBe(11);
    expect(calls[0]!.values![2]).toBe(20);
  });

  it("clamps an absurd page size", async () => {
    const { calls, db } = fake([[]]);
    await listReminders(db, { status: "scheduled", limit: 100_000 });
    expect(calls[0]!.values![1]).toBe(MAX_REMINDER_LIMIT + 1);
  });
});

describe("one conversation's reminders", () => {
  it("returns only that conversation's rows, newest promise first", async () => {
    const { calls, db } = fake([[row({ id: "9" }), row({ id: "4" })]]);
    const reminders = await getConversationReminders(db, "45862");

    expect(calls[0]!.text).toContain("WHERE conversation_id = $1::bigint");
    expect(calls[0]!.values).toEqual(["45862"]);
    expect(calls[0]!.text).toContain("ORDER BY promised_due_at DESC, id DESC");
    expect(reminders.map((r) => r.id)).toEqual(["9", "4"]);
  });

  /** A thread shows what was promised AND what was done. */
  it("does not filter by status", async () => {
    const { calls, db } = fake([[]]);
    await getConversationReminders(db, "45862");
    expect(calls[0]!.text).not.toContain("status =");
  });
});

/* ------------------------------------------------------------------------- *
 * COMPLETING
 * ------------------------------------------------------------------------- */

describe("completing a reminder", () => {
  it("moves scheduled to completed and stamps both times from the database clock", async () => {
    const completedAt = new Date("2026-09-23T10:15:00Z");
    const { calls, db } = fake([
      [row({ status: "completed", completed_at: completedAt, updated_at: completedAt })],
    ]);
    const reminder = await completeReminder(db, "7");

    expect(calls[0]!.text).toContain("SET status = 'completed'");
    expect(calls[0]!.text).toContain("completed_at = now()");
    expect(calls[0]!.text).toContain("updated_at = now()");
    expect(reminder?.status).toBe("completed");
    expect(reminder?.completedAt).toBe("2026-09-23T10:15:00.000Z");
    expect(reminder?.updatedAt).toBe("2026-09-23T10:15:00.000Z");
  });

  /**
   * THE GUARD IS WHAT MAKES A SECOND COMPLETION IMPOSSIBLE. A reminder that is
   * already completed matches no row, so `completed_at` cannot be moved.
   */
  it("guards the transition on the current status", async () => {
    const { calls, db } = fake([[]]);
    await completeReminder(db, "7");
    expect(calls[0]!.text).toContain("WHERE id = $1::bigint AND status = 'scheduled'");
    expect(calls[0]!.values).toEqual(["7"]);
  });

  /**
   * Completing an already-completed reminder returns null, which the route
   * turns into a 409 — the CONTROLLED CONFLICT this project already uses for a
   * non-transition, see `/api/automations/[itemId]/cancel`. Chosen over silent
   * idempotency so a stale tab is told its view is out of date.
   */
  it("reports a non-transition rather than inventing a success", async () => {
    const { db } = fake([[]]);
    expect(await completeReminder(db, "7")).toBeNull();
  });

  it("updates the existing row and never inserts a second", async () => {
    const { calls, db } = fake([[row({ status: "completed", completed_at: new Date() })]]);
    await completeReminder(db, "7");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("UPDATE cst_app.follow_up_reminders");
    expect(calls[0]!.text).not.toContain("INSERT");
  });
});

/* ------------------------------------------------------------------------- *
 * FAILURE CLASSIFICATION
 * ------------------------------------------------------------------------- */

describe("failures are classified from the database's own answer", () => {
  it("recognises an unknown conversation", () => {
    expect(isUnknownConversation({ code: "23503" })).toBe(true);
    expect(isUnknownConversation({ code: "23514" })).toBe(false);
    expect(isUnknownConversation(new Error("boom"))).toBe(false);
    expect(isUnknownConversation(null)).toBe(false);
  });

  it("recognises a missing store", () => {
    expect(isFollowUpStoreMissing({ code: "42P01" })).toBe(true);
    expect(isFollowUpStoreMissing({ code: "23503" })).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * WHAT THIS FEATURE IS NOT
 * ------------------------------------------------------------------------- */

describe("no identity, no deletion, no sending", () => {
  const REPO = read("lib", "repositories", "follow-up-reminder-repository.ts");
  const DOMAIN = read("lib", "domain", "follow-up-reminder.ts");
  const CREATE_ROUTE = read("app", "api", "conversations", "[conversationId]", "follow-up", "route.ts");
  const COMPLETE_ROUTE = read("app", "api", "follow-up-reminders", "[reminderId]", "route.ts");
  const LIST_ROUTE = read("app", "api", "follow-up-reminders", "route.ts");
  const ALL = [REPO, DOMAIN, CREATE_ROUTE, COMPLETE_ROUTE, LIST_ROUTE];

  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("requires no user or staff identity anywhere", () => {
    for (const source of ALL.map(stripComments)) {
      for (const identity of [
        /assigned_user_id|assignedUserId/,
        /created_by_user_id|createdByUserId/,
        /completed_by_user_id|completedByUserId/,
        /\bapp_users\b/,
        /currentUser|getSession|\bauth\(/,
      ]) {
        expect(source).not.toMatch(identity);
      }
    }
  });

  it("imports or calls no sending, transport or marketplace service", () => {
    for (const source of ALL.map(stripComments)) {
      for (const forbidden of [
        /\bsendMessage\b/i,
        /\bsendReply\b/i,
        /send_attempt/i,
        /outbound/i,
        /transmit/i,
        /\bfetch\s*\(/,
        /getSourcePool/,
        /automation-runner/,
        /openai/i,
      ]) {
        expect(source).not.toMatch(forbidden);
      }
    }
  });

  /** A reminder is completed or cancelled, never erased. */
  it("exposes no DELETE route and no delete statement", () => {
    for (const source of ALL) {
      expect(source).not.toMatch(/export\s+(async\s+)?function\s+DELETE\b/);
      expect(source.toUpperCase()).not.toContain("DELETE FROM");
    }
    expect(
      existsSync(join(ROOT, "app", "api", "follow-up-reminders", "[reminderId]", "route.ts")),
    ).toBe(true);
  });

  /** Reopening is not implemented: completion is one-way in this phase. */
  it("implements no reopen and no reschedule", () => {
    for (const source of ALL.map(stripComments)) {
      expect(source).not.toMatch(/reopenReminder|rescheduleReminder|uncompleteReminder/);
    }
    expect(stripComments(REPO)).not.toMatch(/SET status = 'scheduled'/);
  });

  /** The derived display states are computed nowhere in the backend. */
  it("computes no upcoming, due-soon or overdue state", () => {
    for (const source of ALL.map(stripComments)) {
      expect(source).not.toMatch(/\boverdue\b|\bdueSoon\b|\bdue_soon\b|\bupcoming\b/i);
    }
  });
});
