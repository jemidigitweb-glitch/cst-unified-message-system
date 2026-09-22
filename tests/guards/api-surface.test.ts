import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Standing guard on the HTTP surface.
 *
 * Phase 1 reads, and writes a small, named set of things: a draft reply
 * awaiting human review, the automation's own configuration, and a CST agent's
 * internal notes. POST and PATCH are permitted on those routes and nowhere
 * else. PUT, HEAD and OPTIONS are permitted nowhere at all.
 *
 * DELETE IS PERMITTED ON EXACTLY ONE ROUTE, and the exemption is worth stating
 * rather than burying. It used to be permitted on none, because draft history
 * is append-only and nothing else was mutable. An internal note is the first
 * thing in this application a person writes in their own words, and the first
 * therefore that a person can get wrong — a note on the wrong case, or one
 * that should never have been recorded. Leaving removal to a hand-written SQL
 * statement makes correcting a mistake harder than making it, which is the
 * wrong way round.
 *
 * It is one route, `notes/[noteId]`, and it deletes one row from one table
 * that nothing else reads. "the internal note route deletes only its own
 * notes" below pins that, and the writer behind it matches on the conversation
 * as well as the note id, so the route cannot reach another case's note.
 *
 * What has not changed, and must not: no route may transmit a reply to a
 * customer. That is checked by name, by content, and by the absence of any
 * workflow state after `reviewed`.
 */

const ROOT = join(__dirname, "..", "..");
const API_DIR = join(ROOT, "app", "api");

/** Never allowed on any route. */
const FORBIDDEN_METHODS = ["PUT", "HEAD", "OPTIONS"];

/**
 * DELETE is allowed here and nowhere else. An EXACT path, not a prefix: a new
 * route under `notes/` does not inherit this, and has to be added on purpose.
 */
const DELETE_EXEMPT = join(
  API_DIR,
  "conversations",
  "[conversationId]",
  "notes",
  "[noteId]",
  "route.ts",
);

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
 * The internal-notes route is the third exemption, and the narrowest kind:
 * it writes ONE table, `cst_app.internal_notes`, which nothing else in this
 * application reads. A note is a CST agent's own record of where a case
 * stands; it is never a message, never a draft, and never anything a customer
 * receives. "the internal notes route writes only internal notes" below pins
 * that, so widening this list did not widen what the route can do.
 */
const MUTABLE_ROUTES = [
  /[\\/]draft[\\/]route\.tsx?$/,
  /[\\/]workflow[\\/]route\.tsx?$/,
  /[\\/]automations[\\/]settings[\\/]route\.tsx?$/,
  /[\\/]automations[\\/][^\\/]+[\\/]cancel[\\/]route\.tsx?$/,
  /[\\/]conversations[\\/][^\\/]+[\\/]notes[\\/]route\.tsx?$/,
  /[\\/]conversations[\\/][^\\/]+[\\/]notes[\\/][^\\/]+[\\/]route\.tsx?$/,
];

const NOTES_ROUTE = join(API_DIR, "conversations", "[conversationId]", "notes", "route.ts");
const NOTE_ROUTE = DELETE_EXEMPT;

const SETTINGS_ROUTE = join(API_DIR, "automations", "settings", "route.ts");
const CANCEL_ROUTE = join(API_DIR, "automations", "[itemId]", "cancel", "route.ts");

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

  it("exports no PUT, HEAD or OPTIONS anywhere", () => {
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

  /** The DELETE exemption, pinned to the one route that holds it. */
  it("exports DELETE on the internal note route and nowhere else", () => {
    const pattern = /export\s+(async\s+)?function\s+DELETE\b|export\s+const\s+DELETE\b/;
    const exporting = routeFiles.filter((file) => pattern.test(readFileSync(file, "utf8")));
    expect(exporting).toEqual([DELETE_EXEMPT]);
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
   * The internal-notes exemption, pinned.
   *
   * This route may record a CST staff note. It may not reach a draft, a
   * revision, a review, a workflow state or an automation, and — the one that
   * matters most — it may not touch the READ-ONLY SOURCE DATABASE. Internal
   * notes are application data; `getSourcePool` appearing here would mean this
   * feature had started reaching for the live marketplace database, which it
   * has no reason to do and no permission to write to.
   *
   * Create and view only in this phase: no PATCH, and no DELETE. Those are
   * already forbidden application-wide above, so this pins the positive half —
   * that the route exports exactly the two handlers it is meant to.
   */
  it("keeps the internal notes route to recording a note", () => {
    expect(existsSync(NOTES_ROUTE)).toBe(true);
    const source = readFileSync(NOTES_ROUTE, "utf8");

    expect(source).toMatch(/addInternalNote/);
    expect(source).toMatch(/findInternalNotes/);
    expect(source).toMatch(/getAppPool/);
    expect(source).not.toMatch(/getSourcePool/);
    expect(source).not.toMatch(/getKnowledgePool/);

    expect(source).toMatch(/export\s+async\s+function\s+GET\b/);
    expect(source).toMatch(/export\s+async\s+function\s+POST\b/);
    expect(source).not.toMatch(/export\s+async\s+function\s+PATCH\b/);

    for (const forbidden of [
      "saveRevision",
      "advanceWorkflowState",
      "updateAutomationSettings",
      "insertScheduledItem",
      "buildDraftInput",
      "conversationExport",
    ]) {
      expect(source, `internal notes route must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  /**
   * The edit-and-delete route, pinned.
   *
   * It may change one note's text and remove one note. It may not reach a
   * draft, a workflow state or an automation, and it may not touch the
   * read-only source database. Most importantly it must keep taking BOTH ids:
   * the writer functions it calls are the conversation-scoped ones, so a note
   * id on its own can never reach another conversation's note.
   */
  it("keeps the internal note route to editing and removing its own notes", () => {
    expect(existsSync(NOTE_ROUTE)).toBe(true);
    const source = readFileSync(NOTE_ROUTE, "utf8");

    expect(source).toMatch(/updateInternalNote/);
    expect(source).toMatch(/deleteInternalNote/);
    expect(source).toMatch(/parseConversationId/);
    expect(source).toMatch(/parseInternalNoteId/);
    expect(source).toMatch(/getAppPool/);
    expect(source).not.toMatch(/getSourcePool/);
    expect(source).not.toMatch(/getKnowledgePool/);

    expect(source).toMatch(/export\s+async\s+function\s+PATCH\b/);
    expect(source).toMatch(/export\s+async\s+function\s+DELETE\b/);

    for (const forbidden of [
      "saveRevision",
      "advanceWorkflowState",
      "updateAutomationSettings",
      "buildDraftInput",
      "conversationExport",
      "addInternalNote",
    ]) {
      expect(source, `internal note route must not call ${forbidden}`).not.toContain(forbidden);
    }
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
