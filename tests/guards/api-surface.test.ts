import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Standing guard on the HTTP surface.
 *
 * Phase 1 reads, and writes exactly one thing: a draft reply awaiting human
 * review. So POST and PATCH are permitted on the draft and workflow routes and
 * nowhere else, and DELETE/PUT are permitted nowhere at all — draft history is
 * append-only, and nothing else in this phase is mutable.
 *
 * What has not changed, and must not: no route may transmit a reply to a
 * customer. That is checked by name, by content, and by the absence of any
 * workflow state after `reviewed`.
 */

const ROOT = join(__dirname, "..", "..");
const API_DIR = join(ROOT, "app", "api");
const REPO_DIR = join(ROOT, "lib", "repositories");

/** Never allowed on any route. */
const FORBIDDEN_METHODS = ["PUT", "DELETE", "HEAD", "OPTIONS"];

/**
 * Allowed to mutate.
 *
 * Drafts and their workflow, plus ONE narrow exemption: the post-dispatch
 * automation's own configuration. That is the first mutable thing in this
 * application that is not a draft, and it earns the exemption because switching
 * the automation on is a decision with consequences an operator must be able to
 * reverse from the screen — leaving it to a hand-written SQL statement makes
 * "off" harder than "on", which is the wrong way round for a safety control.
 *
 * It writes `cst_app.automation_settings` and nothing else. "the automation
 * settings route writes only configuration" below pins that, so widening this
 * list did not widen what the route can do.
 *
 * THE TWO FOLLOW-UP ENTRIES ARE THE SECOND EXEMPTION, and narrower still. A
 * follow-up reminder is internal CST state — "this conversation needs coming
 * back to at this time" — with no recipient, channel, template or body, so
 * neither route can reach a customer however it is called. One creates a row on
 * a conversation; the other moves one row from `scheduled` to `completed`.
 * "the follow-up routes touch reminders and nothing else" below pins that,
 * exactly as the settings and cancel entries are pinned.
 */
const MUTABLE_ROUTES = [
  /[\\/]draft[\\/]route\.tsx?$/,
  /[\\/]workflow[\\/]route\.tsx?$/,
  /[\\/]automations[\\/]settings[\\/]route\.tsx?$/,
  /[\\/]automations[\\/][^\\/]+[\\/]cancel[\\/]route\.tsx?$/,
  /[\\/]automations[\\/][^\\/]+[\\/]restore[\\/]route\.tsx?$/,
  /[\\/]conversations[\\/][^\\/]+[\\/]follow-up[\\/]route\.tsx?$/,
  /[\\/]follow-up-reminders[\\/][^\\/]+[\\/]route\.tsx?$/,
];

const FOLLOW_UP_CREATE_ROUTE = join(
  API_DIR,
  "conversations",
  "[conversationId]",
  "follow-up",
  "route.ts",
);
const FOLLOW_UP_COMPLETE_ROUTE = join(
  API_DIR,
  "follow-up-reminders",
  "[reminderId]",
  "route.ts",
);

const SETTINGS_ROUTE = join(API_DIR, "automations", "settings", "route.ts");
const CANCEL_ROUTE = join(API_DIR, "automations", "[itemId]", "cancel", "route.ts");
const RESTORE_ROUTE = join(API_DIR, "automations", "[itemId]", "restore", "route.ts");

/**
 * The operator-triggered run route, and it must stay absent.
 *
 * It existed so somebody could start a pass from the screen while no scheduler
 * was registered. The automation is driven by `/api/cron/automation` alone now —
 * authenticated, bounded, and the path a real transport would eventually run
 * on. An unauthenticated route that starts real work is not something to re-add
 * by accident.
 */
const REMOVED_RUN_ROUTE = join(API_DIR, "automations", "run", "route.ts");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return extname(entry) === ".ts" || extname(entry) === ".tsx" ? [full] : [];
  });
}

const routeFiles = walk(API_DIR);

describe("API surface", () => {
  it("exposes at least one route", () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  it("exports no PUT, DELETE, HEAD or OPTIONS anywhere", () => {
    const offenders: string[] = [];
    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8");
      for (const method of FORBIDDEN_METHODS) {
        const pattern = new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b|export\\s+const\\s+${method}\\b`);
        if (pattern.test(source)) offenders.push(`${file.replace(ROOT + sep, "")} :: ${method}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("mutates only on the draft and workflow routes", () => {
    const offenders: string[] = [];
    for (const file of routeFiles) {
      const relative = file.replace(ROOT + sep, "");
      const mutable = MUTABLE_ROUTES.some((pattern) => pattern.test(file));
      if (mutable) continue;
      const source = readFileSync(file, "utf8");
      for (const method of ["POST", "PATCH"]) {
        const pattern = new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`);
        if (pattern.test(source)) offenders.push(`${relative} :: ${method}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps every read route readable", () => {
    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8");
      const mutable = MUTABLE_ROUTES.some((pattern) => pattern.test(file));
      // The workflow route is a transition only; everything else exposes a read.
      if (!mutable || /[\\/]draft[\\/]/.test(file)) {
        expect(source).toMatch(/export\s+async\s+function\s+GET\b/);
      }
    }
  });

  /**
   * The exemption above, pinned.
   *
   * The settings route may mutate configuration. It may not reach a work item,
   * a revision, a review or a workflow state, and it may not acquire a
   * transport — so the writer it imports is named here rather than left to
   * whatever a future edit happens to reach for.
   */
  it("keeps the automation settings route to configuration only", () => {
    expect(existsSync(SETTINGS_ROUTE)).toBe(true);
    const source = readFileSync(SETTINGS_ROUTE, "utf8");

    expect(source).toMatch(/updateAutomationSettings/);
    for (const forbidden of [
      "saveAutomationRevision",
      "markDraftItemReviewed",
      "markDraftItemSkipped",
      "markDraftItemFailed",
      "insertScheduledDraftItem",
      "claimDueDraftItems",
      "draftForItem",
      "advanceWorkflowState",
      "saveRevision",
    ]) {
      expect(source, `settings route must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  /** See `REMOVED_RUN_ROUTE`: the automation is cron-driven only. */
  it("exposes no operator-triggered run route", () => {
    expect(existsSync(REMOVED_RUN_ROUTE)).toBe(false);
  });

  /**
   * The cancel route, pinned.
   *
   * Stopping a scheduled record is the ONLY thing an operator may do to one.
   * This route must not acquire a way to process, resend or otherwise finish a
   * record, and it must never write a status itself beyond the cancellation.
   */
  it("keeps the automation cancel route to cancelling", () => {
    expect(existsSync(CANCEL_ROUTE)).toBe(true);
    const source = readFileSync(CANCEL_ROUTE, "utf8");

    expect(source).toMatch(/cancelScheduledItem/);
    for (const forbidden of [
      "markItemProcessed",
      "runPostDispatchAutomation",
      "processDueItems",
      "updateAutomationSettings",
      "insertScheduledItem",
    ]) {
      expect(source, `cancel route must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  /**
   * The restore route, pinned.
   *
   * IT EARNS A PLACE ON THIS LIST BECAUSE CANCEL HAS ONE. Cancelling is a single
   * click that cannot be taken back; an undo is what makes that acceptable, and
   * leaving it to a hand-written SQL statement would make "undo" harder than
   * "cancel" -- the wrong way round for a control guarding a mistake. The
   * exemption is narrow in the same way the cancel one is: this route may move a
   * record's STATUS and nothing else. It must never acquire the ability to
   * process, schedule, reschedule or configure anything.
   */
  it("keeps the automation restore route to restoring", () => {
    expect(existsSync(RESTORE_ROUTE)).toBe(true);
    const source = readFileSync(RESTORE_ROUTE, "utf8");

    expect(source).toMatch(/restoreCancelledItem/);
    for (const forbidden of [
      "markItemProcessed",
      "runPostDispatchAutomation",
      "processDueItems",
      "selectDueItems",
      "insertScheduledItem",
      "updateAutomationSettings",
      "renderTemplate",
      "dispatchEventForShipment",
      "findDispatchedShipments",
    ]) {
      expect(source, `restore route must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  /**
   * AND ITS WRITER TOUCHES ONE COLUMN. The same promise the settings route makes
   * about its own writer, made here: `restoreItem` sets `status` and `updated_at`
   * and names no schedule, no provenance and no cancellation column -- so "do not
   * recalculate `scheduled_at`" is a property of the statement rather than a
   * promise in a comment.
   */
  it("keeps the restore writer to the status alone", () => {
    const repository = readFileSync(
      join(REPO_DIR, "automation-repository.ts"),
      "utf8",
    );
    const restore = /export async function restoreItem[\s\S]*?\n\}/.exec(repository)?.[0];
    expect(restore).toBeDefined();
    expect(restore).toMatch(/SET status = 'scheduled'/);
    expect(restore).not.toMatch(/scheduled_at\s*=/);
    expect(restore).not.toMatch(/dispatched_at\s*=/);
    // An UPDATE of the existing row, never a second INSERT of it.
    expect(restore).toMatch(/UPDATE cst_app\.automation_items/);
    expect(restore).not.toMatch(/INSERT/);
  });

  /**
   * The follow-up routes, pinned — the price of their place on MUTABLE_ROUTES.
   *
   * They may create a reminder and complete one. They must never acquire a way
   * to reach a customer, touch a draft, move a workflow state, or write any
   * table but their own — which is what keeps "a reminder is internal CST
   * state" a property of the code rather than a claim in a comment.
   */
  it("keeps the follow-up routes to reminders and nothing else", () => {
    expect(existsSync(FOLLOW_UP_CREATE_ROUTE)).toBe(true);
    expect(existsSync(FOLLOW_UP_COMPLETE_ROUTE)).toBe(true);

    const create = readFileSync(FOLLOW_UP_CREATE_ROUTE, "utf8");
    const complete = readFileSync(FOLLOW_UP_COMPLETE_ROUTE, "utf8");

    expect(create).toMatch(/createReminder/);
    expect(complete).toMatch(/completeReminder/);

    for (const source of [create, complete]) {
      for (const forbidden of [
        "saveRevision",
        "saveAutomationRevision",
        "advanceWorkflowState",
        "insertScheduledItem",
        "markItemProcessed",
        "runPostDispatchAutomation",
        "processDueItems",
        "updateAutomationSettings",
        "renderTemplate",
        "getSourcePool",
        "getKnowledgePool",
      ]) {
        expect(source, `follow-up route must not call ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  /**
   * AND THEIR WRITER TOUCHES ONE TABLE. The same promise the restore writer
   * makes, made here: every statement in the reminder repository that writes
   * names `cst_app.follow_up_reminders`, and completion is an UPDATE guarded on
   * the status rather than a second INSERT — so "completing twice cannot
   * duplicate a reminder or move its timestamp" is a property of the statement.
   */
  it("keeps the reminder writer to its own table", () => {
    const raw = readFileSync(join(REPO_DIR, "follow-up-reminder-repository.ts"), "utf8");
    /*
     * Comments stripped before the name check, because the header names the
     * tables this module must NOT touch — prose saying "not that one" is the
     * opposite of the thing being guarded against, and would otherwise fail it.
     */
    const repository = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

    for (const other of [
      "cst_app.internal_notes",
      "cst_app.automation_items",
      "cst_app.automation_settings",
      "cst_app.draft_replies",
      "cst_app.draft_revisions",
      "cst_app.app_users",
      "cst_app.audit_log",
      "order_management",
      "customer_service",
    ]) {
      expect(repository, `reminder repository must not name ${other}`).not.toContain(other);
    }

    // The only writing statements, and both name the one table.
    const writes = repository.match(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+\S+/g) ?? [];
    expect(writes).toEqual([
      "INSERT INTO cst_app.follow_up_reminders",
      "UPDATE cst_app.follow_up_reminders",
    ]);

    const complete = /const COMPLETE_REMINDER = `[\s\S]*?`;/.exec(repository)?.[0];
    expect(complete).toBeDefined();
    expect(complete).toMatch(/SET status = 'completed'/);
    expect(complete).toMatch(/WHERE id = \$1::bigint AND status = 'scheduled'/);
    expect(complete).not.toMatch(/INSERT/);
  });

  it("declares no send or transmission route", () => {
    for (const file of routeFiles) {
      expect(file.toLowerCase()).not.toMatch(/\bsend\b|outbound|dispatch|transmit|reply-to/);
    }
  });

  it("returns no raw database error to the client", () => {
    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8");
      // The caught error may name schemas, columns or hosts; it must be logged,
      // not serialised into the response body.
      expect(source).not.toMatch(/NextResponse\.json\(\s*\{[^}]*\berror\s*:\s*(error|err)\b/);
      expect(source).not.toMatch(/\berror\.message\b/);
    }
  });

  it("embeds no SQL in a route handler", () => {
    // Routes delegate to a repository or a writer; SQL lives there, where it is
    // reviewed and tested. Transaction control (BEGIN/COMMIT/ROLLBACK) is not
    // SQL against a table and is expected on the mutating routes.
    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8").toUpperCase();
      for (const statement of [
        "INSERT INTO",
        "UPDATE CST_APP",
        "DELETE FROM",
        "SELECT ",
        "TRUNCATE",
        "DROP TABLE",
        "ALTER TABLE",
      ]) {
        expect(source, `${file} contains ${statement}`).not.toContain(statement);
      }
    }
  });
});

describe("browser-facing code", () => {
  const clientFiles = [...walk(join(ROOT, "components")), ...walk(join(ROOT, "app"))].filter(
    (file) => !file.includes(`${sep}api${sep}`),
  );

  it("never imports the database layer into a component", () => {
    for (const file of clientFiles) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/@\/lib\/db\//);
      expect(source).not.toMatch(/@\/lib\/config\//);
      expect(source).not.toMatch(/from\s+["']pg["']/);
    }
  });

  it("renders no raw markup from message content", () => {
    for (const file of clientFiles) {
      expect(readFileSync(file, "utf8")).not.toContain("dangerouslySetInnerHTML");
    }
  });

  it("exposes no send control", () => {
    for (const file of clientFiles) {
      const source = readFileSync(file, "utf8");
      for (const pattern of [/>\s*Send\b/, /\bonSend\b/, /\bsendReply\b/, /Copy Reply/, /Open Marketplace/]) {
        expect(source).not.toMatch(pattern);
      }
    }
  });

  it("shows no internal source table or column name in the interface", () => {
    for (const file of clientFiles) {
      const source = readFileSync(file, "utf8");
      for (const internal of [
        "ebay_message_headers",
        "ebay_messages",
        "customer_service",
        "folder_id",
        "receive_date",
        "ext_message_id",
        "conversation_messages",
        "cst_app",
      ]) {
        expect(source).not.toContain(internal);
      }
    }
  });
});
