import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FOLLOW_UP_DUE_SOON_MINUTES,
  FOLLOW_UP_PRESET_HOURS,
  FOLLOW_UP_STATE_LABEL,
  FOLLOW_UP_TABS,
  dueAtFromLocalInput,
  dueAtFromPreset,
  followUpDisplayState,
  followUpRelativeTime,
  formatFollowUpDueAt,
  sortByDueSoonest,
} from "@/lib/domain/follow-up-view";
import { BEFORE_SHIPMENT_RECENCY_HOURS } from "@/lib/domain/before-shipment-urgency";
import { RESPONSE_SLA_MINUTES } from "@/lib/domain/response-sla";

/**
 * The shared follow-up interface.
 *
 * TWO KINDS OF TEST, because vitest runs with `environment: "node"` and there
 * is no DOM to mount a component into — the same constraint every other
 * component guard in this project works under:
 *
 *   the DERIVATION is pure and is tested directly, which is why it lives in
 *   `lib/domain/follow-up-view.ts` rather than inside a component;
 *   the WIRING is asserted against the component source, exactly as
 *   `notification-bell.test.ts` and `before-shipment-urgency.test.ts` do.
 *
 * Synthetic data throughout. No real customer, conversation or order appears.
 */

const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

const BUTTON = read("components", "follow-up-button.tsx");
const LIST = read("components", "follow-up-list.tsx");
const PANEL_BUTTON = read("components", "follow-up-panel-button.tsx");
const DRAWER = read("components", "notification-drawer.tsx");
const WORKSPACE = read("components", "workspace.tsx");
const CONVERSATION = read("components", "conversation-view.tsx");
const VIEW_MODEL = read("lib", "domain", "follow-up-view.ts");
const ALL_UI = [BUTTON, LIST, PANEL_BUTTON];

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const NOW = new Date("2026-09-22T12:00:00Z");
const HOUR = 3_600_000;

/* ------------------------------------------------------------------------- *
 * THE ENTRY POINT
 * ------------------------------------------------------------------------- */

describe("Set follow-up", () => {
  it("lives on the conversation view, not the app header", () => {
    expect(CONVERSATION).toContain("<FollowUpButton");
    expect(CONVERSATION).toContain('conversationId={conversation.id}');
  });

  /**
   * Hidden where there is no conversation row for a reminder to belong to —
   * the unresolved-message view wires no callback, so the control is absent.
   */
  it("appears only where the caller wired the conversation up", () => {
    expect(CONVERSATION).toContain("onFollowUpCreated !== undefined &&");
    expect(WORKSPACE).toContain("onFollowUpCreated={");
  });

  it("acts on the selected conversation's own id", () => {
    expect(BUTTON).toContain("`/api/conversations/${conversationId}/follow-up`");
  });
});

/* ------------------------------------------------------------------------- *
 * THE PRESETS PRODUCE ABSOLUTE INSTANTS
 * ------------------------------------------------------------------------- */

describe("the quick choices", () => {
  it("offers 24, 48 and 72 hours", () => {
    expect([...FOLLOW_UP_PRESET_HOURS]).toEqual([24, 48, 72]);
  });

  it("turns 24 hours into the right absolute due time", () => {
    expect(dueAtFromPreset(NOW, 24)).toBe("2026-09-23T12:00:00.000Z");
  });

  it("turns 48 hours into the right absolute due time", () => {
    expect(dueAtFromPreset(NOW, 48)).toBe("2026-09-24T12:00:00.000Z");
  });

  it("turns 72 hours into the right absolute due time", () => {
    expect(dueAtFromPreset(NOW, 72)).toBe("2026-09-25T12:00:00.000Z");
  });

  /** A duration would be reinterpreted later; an instant cannot drift. */
  it("sends an instant rather than a duration", () => {
    expect(stripComments(BUTTON)).toContain("dueAtFromPreset(now(), choice.hours)");
    expect(stripComments(BUTTON)).not.toMatch(/body:\s*JSON\.stringify\(\{[^}]*hours/);
  });
});

describe("a custom due date and time", () => {
  /**
   * Read as SL TIME — the zone every deadline in this application is displayed
   * in. 14:30 in Asia/Colombo (UTC+5:30) is 09:00 UTC.
   */
  it("reads the typed wall clock in the SL display zone", () => {
    expect(dueAtFromLocalInput("2026-09-25T14:30")).toBe("2026-09-25T09:00:00.000Z");
  });

  it("round-trips back to the same wall clock on screen", () => {
    const instant = dueAtFromLocalInput("2026-09-25T14:30")!;
    expect(formatFollowUpDueAt(instant)).toContain("14:30");
    expect(formatFollowUpDueAt(instant)).toContain("SL time");
  });

  it("refuses anything unparseable rather than sending an invalid date", () => {
    for (const bad of ["", "soon", "25/09/2026", "2026-09-25"]) {
      expect(dueAtFromLocalInput(bad), bad).toBeNull();
    }
  });

  it("is submitted through the same field as a preset", () => {
    expect(stripComments(BUTTON)).toContain("dueAtFromLocalInput(customAt)");
    expect(stripComments(BUTTON)).toContain("promisedDueAt");
  });
});

/* ------------------------------------------------------------------------- *
 * THE NOTE
 * ------------------------------------------------------------------------- */

describe("the internal note", () => {
  it("is optional and omitted entirely when blank", () => {
    const source = stripComments(BUTTON);
    expect(source).toContain("const trimmed = note.trim()");
    expect(source).toContain('trimmed === "" ? { promisedDueAt } : { promisedDueAt, note: trimmed }');
  });

  it("says on screen that it never reaches the customer", () => {
    expect(BUTTON).toContain("Internal only — never part of a customer reply.");
  });
});

/* ------------------------------------------------------------------------- *
 * CREATING
 * ------------------------------------------------------------------------- */

describe("creating a follow-up", () => {
  it("uses the existing POST endpoint", () => {
    expect(BUTTON).toContain('method: "POST"');
    expect(BUTTON).toContain("`/api/conversations/${conversationId}/follow-up`");
  });

  it("refreshes the shared reminder data afterwards", () => {
    expect(stripComments(BUTTON)).toContain("onCreated?.()");
    expect(stripComments(WORKSPACE)).toContain("void refreshFollowUps();");
  });

  it("shows a controlled success state naming the stored time", () => {
    expect(BUTTON).toContain("savedDueAt");
    expect(BUTTON).toContain("Nothing was sent to the customer.");
  });

  /** It must not disturb the thread behind it. */
  it("does not generate a draft or advance the workflow", () => {
    const source = stripComments(BUTTON);
    for (const forbidden of [/onDraftGenerated/, /\/draft\b/, /\/workflow\b/, /advanceWorkflow/]) {
      expect(source).not.toMatch(forbidden);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * THE DRAWER
 * ------------------------------------------------------------------------- */

describe("the follow-up drawer", () => {
  it("is the third mode of the existing panel, not a separate dashboard", () => {
    expect(DRAWER).toContain('export type NotificationPanelMode = "notifications" | "notes" | "follow_up"');
    expect(DRAWER).toContain("<FollowUpList");
    expect(WORKSPACE).toContain('setNotificationPanelMode("follow_up")');
  });

  it("offers Scheduled and Completed", () => {
    expect(FOLLOW_UP_TABS.map((tab) => tab.key)).toEqual(["scheduled", "completed"]);
  });

  /**
   * The endpoint falls back to `scheduled` for an unknown status. The UI must
   * never rely on that, so only the API's own values are ever requested.
   */
  it("requests only known status values", () => {
    expect(WORKSPACE).toContain("`/api/follow-up-reminders?status=${tab}`");
    const tabKeys = FOLLOW_UP_TABS.map((tab) => tab.key);
    expect(tabKeys.every((key) => ["scheduled", "completed", "cancelled"].includes(key))).toBe(true);
  });

  it("renders scheduled reminders soonest first", () => {
    const reminder = (id: string, promisedDueAt: string) =>
      ({ id, promisedDueAt }) as never;
    const sorted = sortByDueSoonest([
      reminder("1", "2026-09-25T12:00:00Z"),
      reminder("2", "2026-09-23T12:00:00Z"),
      reminder("3", "2026-09-24T12:00:00Z"),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["2", "3", "1"]);
  });

  it("renders the completed list from the same component", () => {
    expect(LIST).toContain("No follow-ups have been completed yet.");
    expect(LIST).toContain('tab === "scheduled" ? sortByDueSoonest(reminders) : reminders');
  });
});

/* ------------------------------------------------------------------------- *
 * DERIVED DISPLAY STATE
 * ------------------------------------------------------------------------- */

describe("upcoming / overdue are read from the clock", () => {
  const scheduled = (promisedDueAt: string) =>
    ({ status: "scheduled", promisedDueAt, now: NOW }) as const;

  it("reads a future promise as upcoming", () => {
    expect(followUpDisplayState(scheduled("2026-09-24T12:00:00Z"))).toBe("upcoming");
  });

  it("reads a lapsed promise as overdue, with no stored change", () => {
    expect(followUpDisplayState(scheduled("2026-09-22T11:59:00Z"))).toBe("overdue");
    // The status is still `scheduled`: nothing was written when it lapsed.
    expect(scheduled("2026-09-22T11:59:00Z").status).toBe("scheduled");
  });

  it("treats the promised moment itself as not yet late", () => {
    expect(followUpDisplayState(scheduled("2026-09-22T12:00:00Z"))).toBe("upcoming");
  });

  /** A settled reminder is a fact, never re-read against the clock. */
  it("never calls a completed reminder overdue", () => {
    expect(
      followUpDisplayState({
        status: "completed",
        promisedDueAt: "2020-01-01T00:00:00Z",
        now: NOW,
      }),
    ).toBe("completed");
  });

  it("describes the remaining or elapsed time in the SLA module's own units", () => {
    expect(followUpRelativeTime(scheduled(new Date(NOW.getTime() + 2 * HOUR).toISOString()))).toBe(
      "Due in 2h 0m",
    );
    expect(followUpRelativeTime(scheduled(new Date(NOW.getTime() - HOUR).toISOString()))).toBe(
      "Overdue by 1h 0m",
    );
  });

  it("names all four concepts the panel must show", () => {
    for (const label of ["Upcoming", "Due soon", "Overdue", "Completed"]) {
      expect(Object.values(FOLLOW_UP_STATE_LABEL)).toContain(label);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * THE DUE-SOON THRESHOLD
 * ------------------------------------------------------------------------- */

describe("due soon", () => {
  /**
   * BLOCKER, PINNED. No approved approaching-deadline threshold exists in this
   * repository, so none was invented — the same treatment `RESPONSE_SLA_MINUTES`
   * was given while its own duration was unapproved.
   */
  it("has no invented threshold", () => {
    expect(FOLLOW_UP_DUE_SOON_MINUTES).toBeNull();
  });

  /** The two figures that DO exist, and why neither is this one. */
  it("did not borrow a figure that means something else", () => {
    // A reply target, not a warning distance. Borrowing it would make every
    // reminder "due soon" from the moment it was created.
    expect(RESPONSE_SLA_MINUTES).toBe(24 * 60);
    // A window that keeps a conversation in the urgent block. Also not a warning.
    expect(BEFORE_SHIPMENT_RECENCY_HOURS).toBe(48);
    expect(FOLLOW_UP_DUE_SOON_MINUTES).not.toBe(RESPONSE_SLA_MINUTES);
    expect(FOLLOW_UP_DUE_SOON_MINUTES).not.toBe(BEFORE_SHIPMENT_RECENCY_HOURS * 60);
  });

  /** Unreachable while the constant is null — and nothing else is blocked by it. */
  it("never fires, and does not stop upcoming or overdue working", () => {
    for (const hours of [0.1, 0.5, 1, 2, 12, 23]) {
      expect(
        followUpDisplayState({
          status: "scheduled",
          promisedDueAt: new Date(NOW.getTime() + hours * HOUR).toISOString(),
          now: NOW,
        }),
      ).toBe("upcoming");
    }
  });

  /**
   * One place to set it, so the decision lands in a single edit.
   *
   * The components must not compare a due time against a number of their own —
   * every one of them asks `followUpDisplayState`, which is the only reader of
   * the constant.
   */
  it("is centralised behind one named constant", () => {
    expect(VIEW_MODEL).toContain("export const FOLLOW_UP_DUE_SOON_MINUTES: number | null = null");
    // Exactly one reader, in the module that declares it.
    const readers = (VIEW_MODEL.match(/FOLLOW_UP_DUE_SOON_MINUTES/g) ?? []).length;
    expect(readers).toBe(3); // the doc reference, the declaration, the one comparison
    for (const source of ALL_UI) {
      expect(source).not.toContain("FOLLOW_UP_DUE_SOON_MINUTES");
      // No component does deadline arithmetic of its own.
      expect(stripComments(source)).not.toMatch(/Date\.parse|getTime\(\)\s*[-+]/);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * OPENING AND COMPLETING
 * ------------------------------------------------------------------------- */

describe("open conversation", () => {
  it("uses the existing selection path and switches tab like a notification does", () => {
    const source = stripComments(WORKSPACE);
    expect(source).toContain("if (from !== marketplace) switchMarketplace(from);");
    expect(source).toContain("await select(conversationId, from);");
  });

  /** The marketplace is resolved by the server, never guessed from the tab. */
  it("asks the existing detail route which marketplace the conversation is in", () => {
    expect(stripComments(WORKSPACE)).toContain("`/api/conversations/${conversationId}`");
  });

  it("does not complete the reminder, draft, or send", () => {
    const opener = /const openFollowUpConversation[\s\S]*?\n  \);/.exec(WORKSPACE)?.[0] ?? "";
    expect(opener).not.toContain("completeFollowUp");
    expect(opener).not.toContain("PATCH");
    expect(opener).not.toContain("draft");
  });
});

describe("mark completed", () => {
  it("calls the PATCH endpoint", () => {
    const source = stripComments(WORKSPACE);
    expect(source).toContain("`/api/follow-up-reminders/${reminderId}`");
    expect(source).toContain('method: "PATCH"');
  });

  it("refreshes the list after a success", () => {
    const completer = /const completeFollowUp[\s\S]*?\n  \);/.exec(WORKSPACE)?.[0] ?? "";
    expect(completer).toContain("await refreshFollowUps();");
  });

  it("handles 409 not_completable without a crash", () => {
    const completer = /const completeFollowUp[\s\S]*?\n  \);/.exec(WORKSPACE)?.[0] ?? "";
    expect(completer).toContain("response.status === 409");
    expect(completer).toContain("Already completed by someone else.");
    // Refreshed rather than left showing a row that no longer exists.
    expect(completer).toMatch(/409[\s\S]*?refreshFollowUps/);
  });

  /** The action exists only on a reminder that is still owed. */
  it("is offered only on a scheduled reminder", () => {
    expect(LIST).toContain('reminder.status === "scheduled" && (');
    expect(LIST).toContain("Mark completed");
  });

  /** Completion is a person's statement, never a side effect. */
  it("is reachable only from the button", () => {
    const source = stripComments(WORKSPACE);
    // ONE call site: the handler the drawer is given. The definition itself is
    // `const completeFollowUp = useCallback(`, which this pattern does not
    // match — so a second hit would be a second caller, which is the thing
    // being guarded against.
    const calls = source.match(/completeFollowUp\(/g) ?? [];
    expect(calls.length).toBe(1);
  });
});

/* ------------------------------------------------------------------------- *
 * WHAT THIS INTERFACE IS NOT
 * ------------------------------------------------------------------------- */

describe("the follow-up UI adds nothing that could reach a customer", () => {
  it("imports or calls no send, marketplace or transport function", () => {
    for (const source of ALL_UI.map(stripComments)) {
      for (const forbidden of [
        /\bsendReply\b/i,
        /\bsendMessage\b/i,
        /outbound/i,
        /transmit/i,
        /marketplace-?api/i,
        />\s*Send\b/,
        /Copy Reply/,
        /Open Marketplace/,
      ]) {
        expect(source).not.toMatch(forbidden);
      }
    }
  });

  it("raises no browser notification, sound or external alert", () => {
    // Comments stripped: the prose in these files names the transports they
    // deliberately do NOT use, which is the opposite of the thing guarded.
    for (const source of ALL_UI.map(stripComments)) {
      for (const forbidden of [
        "new Notification",
        "Notification.requestPermission",
        "new Audio",
        "navigator.vibrate",
        "serviceWorker",
        "toast",
        ".play()",
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it("offers no cancel, reopen or delete control", () => {
    for (const source of ALL_UI) {
      for (const forbidden of [/\bDELETE\b/, /Cancel reminder/i, /Reopen/i, /Delete/i]) {
        expect(source).not.toMatch(forbidden);
      }
    }
  });

  it("asks for no staff identity and offers no assignment", () => {
    for (const source of ALL_UI.map(stripComments)) {
      for (const forbidden of [
        /assignedUserId/,
        /createdByUserId/,
        /completedByUserId/,
        /\bassignee\b/i,
        /\bteam ?leader\b/i,
        /currentUser/,
        /\bMine\b/,
      ]) {
        expect(source).not.toMatch(forbidden);
      }
    }
  });

  /** No new schedule anywhere — the standing workspace guard still holds. */
  it("introduces no timer or background worker", () => {
    for (const source of [...ALL_UI, WORKSPACE, DRAWER]) {
      expect(source).not.toContain("setInterval");
    }
  });

  it("never renders a reminder note as markup", () => {
    for (const source of ALL_UI) {
      expect(source).not.toContain("dangerouslySetInnerHTML");
    }
  });
});
