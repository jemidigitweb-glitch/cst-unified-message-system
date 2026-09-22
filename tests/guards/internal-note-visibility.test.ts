import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { conversationDetailSchema } from "@/lib/domain/inbox";
import { INTERNAL_NOTE_VISIBILITY } from "@/lib/domain/internal-note";

/**
 * Standing guard: an internal note must never reach a customer.
 *
 * This application has no customer-facing client today, so the risk is not
 * that a customer calls an endpoint — they cannot. The risk is that internal
 * text escapes through one of the three paths that DO end up in front of a
 * customer, or in front of somebody outside CST:
 *
 *   1. the AI draft input, which becomes the wording of a reply
 *   2. the post-dispatch automation's rendered body
 *   3. the conversation export, a file that leaves the application
 *
 * plus the shared `ConversationDetail` payload, which feeds 1 and 3 at once.
 *
 * The check is structural rather than semantic: the internal-note modules are
 * simply not reachable from any of those files. A module that cannot be
 * imported cannot leak, whatever a future edit intends.
 */

const ROOT = join(__dirname, "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return [".ts", ".tsx"].includes(extname(entry)) ? [full] : [];
  });
}

function relative(file: string): string {
  return file.replace(ROOT + sep, "").replace(/\\/g, "/");
}

/** Every module this feature owns. Importing one of these is the leak. */
const INTERNAL_NOTE_MODULES = [
  "@/lib/domain/internal-note",
  "@/lib/repositories/internal-note-repository",
  "@/lib/sync/internal-note-writer",
];

/**
 * The files that must not reach them, and why each one is on the list.
 *
 *   lib/ai/            everything here becomes model input, and model input
 *                      becomes the customer's reply
 *   lib/export/        produces a file that leaves this application
 *   lib/domain/automation/ renders a body addressed to a customer
 *   lib/repositories/customer-note-repository.ts
 *                      the BUYER notes feed; an internal note appearing in it
 *                      would be filed under a heading that says "customer"
 */
const FORBIDDEN_IMPORTERS = [
  join(ROOT, "lib", "ai"),
  join(ROOT, "lib", "export"),
  join(ROOT, "lib", "domain", "automation"),
];

const CUSTOMER_NOTE_FILES = [
  join(ROOT, "lib", "domain", "customer-note.ts"),
  join(ROOT, "lib", "repositories", "customer-note-repository.ts"),
  join(ROOT, "app", "api", "customer-notes", "route.ts"),
  join(ROOT, "app", "api", "customer-notes", "[noteId]", "route.ts"),
];

describe("internal notes cannot reach a customer", () => {
  it("is not imported by the AI draft layer, the export, or the automation", () => {
    const offenders: string[] = [];
    for (const dir of FORBIDDEN_IMPORTERS) {
      for (const file of walk(dir)) {
        const source = readFileSync(file, "utf8");
        for (const specifier of INTERNAL_NOTE_MODULES) {
          if (source.includes(specifier)) offenders.push(`${relative(file)} :: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The table itself, not just the modules.
   *
   * A file could reach the notes without importing this feature — by writing
   * its own query. Naming the table anywhere outside this feature is the
   * thing that would let that happen unnoticed.
   */
  it("is not queried from outside its own repository and writer", () => {
    const owners = new Set([
      // The domain module names the table in its own documentation. It holds
      // no SQL — the two files below are the only ones that query it.
      "lib/domain/internal-note.ts",
      "lib/repositories/internal-note-repository.ts",
      "lib/sync/internal-note-writer.ts",
      "migrations/0012_internal_notes.up.sql",
      "migrations/0012_internal_notes.down.sql",
    ]);

    const offenders: string[] = [];
    for (const dir of [join(ROOT, "lib"), join(ROOT, "app"), join(ROOT, "components")]) {
      for (const file of walk(dir)) {
        if (owners.has(relative(file))) continue;
        if (readFileSync(file, "utf8").includes("internal_notes")) offenders.push(relative(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The shared payload, pinned by its schema rather than by reading the code.
   *
   * `ConversationDetail` is what the thread view, the draft input and the
   * export all read. A notes field appearing on it would put internal text
   * into all three at once, which is exactly why this feature has its own
   * endpoint and its own payload.
   */
  it("is absent from the ConversationDetail payload", () => {
    const keys = Object.keys(conversationDetailSchema.shape);
    expect(keys).toEqual(["conversation", "messages"]);
    for (const key of keys) {
      expect(key.toLowerCase()).not.toContain("note");
    }
  });

  it("is absent from the conversation export", () => {
    const source = readFileSync(join(ROOT, "lib", "export", "conversation-export.ts"), "utf8");
    expect(source).not.toContain("internal-note");
    expect(source).not.toContain("internalNote");
    expect(source).not.toContain("InternalNote");
  });

  /**
   * The draft input, checked by what it is BUILT FROM rather than by a name.
   *
   * `buildDraftInput` composes the model's user content out of `DraftRequest`.
   * If that type never carries a note, no note can be composed into a reply,
   * whatever a later edit to the assembly file does.
   */
  it("is absent from the draft request the model is built from", () => {
    const provider = readFileSync(join(ROOT, "lib", "ai", "provider.ts"), "utf8");
    const assembly = readFileSync(join(ROOT, "lib", "ai", "draft-assembly.ts"), "utf8");
    for (const source of [provider, assembly]) {
      expect(source).not.toMatch(/\binternalNote\w*\b/i);
      expect(source).not.toContain("internal_notes");
    }
  });

  it("does not leak into the customer-note feature, which is a different thing", () => {
    for (const file of CUSTOMER_NOTE_FILES) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("internal_notes");
      expect(source).not.toContain("internal-note");
      expect(source).not.toMatch(/\bfindInternalNotes\b|\baddInternalNote\b/);
    }
  });
});

describe("the internal notes feature keeps to the application database", () => {
  const feedRoute = join(ROOT, "app", "api", "conversations", "[conversationId]", "notes", "route.ts");
  const noteRoute = join(
    ROOT,
    "app",
    "api",
    "conversations",
    "[conversationId]",
    "notes",
    "[noteId]",
    "route.ts",
  );

  const owned = [
    join(ROOT, "lib", "repositories", "internal-note-repository.ts"),
    join(ROOT, "lib", "sync", "internal-note-writer.ts"),
    feedRoute,
    noteRoute,
  ];

  /**
   * THE READ-ONLY SOURCE DATABASE IS NOT PART OF THIS FEATURE.
   *
   * Internal notes are application data: they are created here, stored here,
   * and read back here. `getSourcePool` appearing anywhere in this feature
   * would mean it had started reaching for the live marketplace database,
   * which it must not write to and has no reason to read.
   */
  it("names the application pool and no other", () => {
    for (const route of [feedRoute, noteRoute]) {
      expect(readFileSync(route, "utf8")).toContain("getAppPool");
    }
    for (const file of owned) {
      const source = readFileSync(file, "utf8");
      expect(source, `${relative(file)} must not reach the source pool`).not.toContain(
        "getSourcePool",
      );
      expect(source).not.toContain("getKnowledgePool");
    }
  });

  /**
   * Every statement the feature runs, named, and every one of them against
   * the same single table. A write reaching any other table would mean this
   * feature had grown a second responsibility.
   */
  it("writes only cst_app.internal_notes", () => {
    const writer = readFileSync(owned[1]!, "utf8");
    expect(writer.match(/INSERT INTO\s+[\w.]+/g) ?? []).toEqual([
      "INSERT INTO cst_app.internal_notes",
    ]);
    expect(writer.match(/UPDATE\s+[\w.]+/g) ?? []).toEqual(["UPDATE cst_app.internal_notes"]);
    expect(writer.match(/DELETE FROM\s+[\w.]+/g) ?? []).toEqual([
      "DELETE FROM cst_app.internal_notes",
    ]);
  });

  /**
   * THE CROSS-CONVERSATION PROTECTION, pinned where it actually lives.
   *
   * The edit and the delete each bind BOTH ids, so a note id from another
   * case matches no row. This is the whole access control: there is no
   * separate ownership check a route could forget, because the WHERE clause
   * is it. A statement losing `conversation_id` would make a note id alone
   * sufficient to reach any note in the table.
   */
  it("scopes every edit and delete to the conversation as well as the note", () => {
    const writer = readFileSync(owned[1]!, "utf8");
    const scoped = /WHERE id = \$1::bigint\s+AND conversation_id = \$2::bigint/g;
    expect(writer.match(scoped) ?? []).toHaveLength(2);
  });

  /** An edit changes the text. It cannot change who owns the note, or its visibility. */
  it("lets an edit set only the text and updated_at", () => {
    const writer = readFileSync(owned[1]!, "utf8");
    const start = writer.indexOf("UPDATE cst_app.internal_notes");
    const setClause = writer.slice(start, writer.indexOf("WHERE", start));
    for (const column of ["conversation_id", "visibility", "note_category", "created_at"]) {
      expect(setClause, `an edit must not set ${column}`).not.toContain(column);
    }
  });

  /**
   * Neither route may set a visibility, whatever a caller sends.
   *
   * COMMENTS ARE STRIPPED FIRST, the same way `draft-workflow.test.ts` strips
   * them before looking for a transmission capability. Both routes explain in
   * prose that visibility cannot be changed through them, and a guard that
   * failed on the denial as readily as on the capability would teach the next
   * person to delete the explanation rather than keep the guarantee.
   */
  it("accepts no visibility from any request", () => {
    for (const route of [feedRoute, noteRoute]) {
      const code = readFileSync(route, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/.*$/gm, " ");
      expect(code, `${relative(route)} must not name a visibility in code`).not.toContain(
        "visibility",
      );
    }
    const domain = readFileSync(join(ROOT, "lib", "domain", "internal-note.ts"), "utf8");
    // The domain may discuss it; what it must not do is read one from a body.
    expect(domain).not.toMatch(/visibility:\s*z\./);
  });
});

/**
 * The interface, after the redesign.
 *
 * These are the two things the panel deliberately stopped saying and the one
 * control it stopped showing. They are pinned because each was removed for a
 * reason — a panel that explains itself, and a question asked before every
 * note that its reader did not need answered.
 */
describe("the notes panel asks for nothing but the note", () => {
  const panel = readFileSync(join(ROOT, "components", "internal-notes-panel.tsx"), "utf8");

  it("has no category control, and no pin control either", () => {
    // The note's existence is what pins it. A Pin button would imply an
    // unpinned state the data model has no way to represent.
    expect(panel).not.toMatch(/>\s*Pin\b/);
    expect(panel).not.toMatch(/\bonPin\b|\btogglePin\b|\bunpin\b/i);
    expect(panel).not.toContain("<select");
    expect(panel).not.toContain("internalNoteCategoryOptions");
    expect(panel).not.toContain("INTERNAL_NOTE_CATEGORY_LABEL");
    expect(panel).not.toMatch(/>\s*Category\s*</);
  });

  it("carries no caption explaining what an internal note is", () => {
    expect(panel).not.toContain("INTERNAL_NOTES_STAFF_ONLY_NOTICE");
    expect(panel).not.toMatch(/Never shown to the customer/);
  });

  /**
   * A SECTION, NOT A CONTROL.
   *
   * The notes were behind a pill an agent had to click, which made the notes
   * on a case invisible until asked for. The heading is a heading now: no
   * `aria-expanded` anywhere in the panel, and no toggle state to be closed.
   */
  it("shows the notes as a section rather than behind a toggle", () => {
    expect(panel).not.toContain("aria-expanded");
    expect(panel).not.toContain("internal-notes-toggle");
    expect(panel).toMatch(/<h2\b/);
    expect(panel).toContain("INTERNAL_NOTES_TITLE");
  });

  /** No empty-state sentence: the heading with nothing under it is the message. */
  it("shows no empty-state sentence", () => {
    expect(panel).not.toContain("INTERNAL_NOTES_EMPTY");
    expect(panel).not.toMatch(/No notes yet/);
    expect(panel).not.toMatch(/No internal notes/);
  });

  /**
   * The tint that says "CST wrote this, the customer did not".
   *
   * On the section and on the card, because the point is the boundary being
   * visible before a note is read — a card-only tint would leave the heading
   * and the add box looking like any other sidebar section.
   */
  it("tints the section and the note card", () => {
    const section = panel.slice(panel.indexOf('data-testid="internal-notes"'));
    expect(section).toMatch(/border-amber-500\/30/);
    expect(section).toMatch(/bg-amber-500\//);

    const card = readFileSync(join(ROOT, "components", "internal-note-card.tsx"), "utf8");
    const cardMarkup = card.slice(card.indexOf('data-testid="internal-note"'));
    expect(cardMarkup.slice(0, 400)).toMatch(/border-amber-500\/30/);
    expect(cardMarkup.slice(0, 400)).toMatch(/bg-amber-500\//);
  });

  /**
   * Every request this feature makes from the browser, and they are all to
   * the internal-notes endpoints.
   *
   * The fetches live in the hook, which is the single place the two
   * renderings share. A URL appearing anywhere else in the feature would mean
   * a second, unsynchronised source of notes.
   */
  it("reaches the internal notes endpoints and no other", () => {
    // Comments stripped first: the hook documents the endpoint it reaches in
    // prose, and a guard that read the documentation as a call would teach
    // the next person to delete the comment rather than keep the rule.
    const hook = readFileSync(join(ROOT, "components", "use-internal-notes.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/.*$/gm, " ");
    const urls = hook.match(/\/api\/[^`"']*/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(/^\/api\/conversations\/\$\{conversationId\}\/notes/);
    }

    // The presentational pieces make no requests of their own.
    for (const file of ["internal-notes-panel.tsx", "internal-note-card.tsx", "pinned-internal-note.tsx"]) {
      expect(readFileSync(join(ROOT, "components", file), "utf8")).not.toMatch(/fetch\(/);
    }
  });
});

/**
 * The pinned area.
 *
 * "Pinned" here is a rendering of `cst_app.internal_notes`, not a feature of
 * its own. There is no pin flag, no pin table, no pin endpoint and no Pin
 * button — a note is pinned because it exists. These checks are what stop
 * that turning into a generic message-pinning system, which is a different
 * feature with a different blast radius: pinning a customer message or a CST
 * reply would put conversation content into a surface built for private
 * staff notes.
 */
describe("only internal notes can be pinned", () => {
  const pinned = readFileSync(join(ROOT, "components", "pinned-internal-note.tsx"), "utf8");

  /**
   * THE PINNED NOTE IS OUTSIDE THE MESSAGE SCROLLER, AND THIS IS WHAT PINS IT.
   *
   * It was inside once. That read correctly on open and then scrolled away the
   * moment an agent moved down the thread — exactly when a note saying
   * "courier follow-up already requested" earns its place. The fix is
   * structural, not cosmetic, so the check is structural too: the mount must
   * appear BEFORE the element that owns `overflow-y-auto`, in a flex column
   * where that element is the only thing that scrolls.
   *
   * Sticky positioning is deliberately not accepted as an alternative. A
   * sticky card is still a child of the scroller, still part of the message
   * list, and still competing for its height.
   */
  it("is mounted outside the message scroller, not inside it", () => {
    const view = readFileSync(join(ROOT, "components", "conversation-view.tsx"), "utf8");

    const mount = view.indexOf("<PinnedInternalNotes");
    const scroller = view.indexOf("ref={scroller}");
    expect(mount).toBeGreaterThan(-1);
    expect(scroller).toBeGreaterThan(-1);
    expect(mount, "the pinned note must be mounted before the scroller").toBeLessThan(scroller);

    // The scroller still owns the scrolling, and still only vertically.
    expect(view.slice(scroller, scroller + 200)).toContain("overflow-y-auto");
    expect(view.slice(scroller, scroller + 200)).toContain("flex-1");

    // The pinned row holds its height instead of being squeezed by the thread.
    expect(pinned).toContain("shrink-0");
    // Not sticky: that would leave it inside the message list.
    expect(pinned).not.toMatch(/\bsticky\b/);
    expect(view.slice(mount, scroller)).not.toMatch(/\bsticky\b/);
  });

  /** No empty strip above the thread when a conversation has no notes. */
  it("renders nothing at all when there are no notes", () => {
    expect(pinned).toMatch(/return null;/);
    // The frame lives inside the component, so the early return takes the
    // border and the padding with it rather than leaving a bare rule above
    // the thread on every conversation that has no notes.
    expect(pinned).toMatch(/border-b/);
    const frame = pinned.indexOf("border-b");
    const earlyReturn = pinned.indexOf("return null;");
    expect(earlyReturn, "the empty case must return before the frame").toBeLessThan(frame);
  });

  /** Which note is pinned is a domain rule, not an index into an array here. */
  it("asks the domain which note is pinned", () => {
    expect(pinned).toContain("pinnedInternalNote");
    expect(pinned).not.toMatch(/notes\[0\]/);
  });

  it("renders internal notes and no other kind of record", () => {
    expect(pinned).toContain("InternalNote");
    expect(pinned).toContain("InternalNoteCard");

    // A conversation message, a customer note or a source message reaching
    // this component would mean the pinned area had stopped being about
    // internal notes.
    for (const foreign of [
      "ConversationMessageView",
      "ConversationDetail",
      "CustomerNote",
      "SourceMessage",
      "messages",
      "bodyText",
      "direction",
    ]) {
      expect(pinned, `the pinned area must not know about ${foreign}`).not.toContain(foreign);
    }
  });

  it("offers no pin or unpin action anywhere in the feature", () => {
    for (const file of [
      "pinned-internal-note.tsx",
      "internal-note-card.tsx",
      "internal-notes-panel.tsx",
      "use-internal-notes.ts",
    ]) {
      const source = readFileSync(join(ROOT, "components", file), "utf8");
      expect(source, `${file} must not offer a pin action`).not.toMatch(
        /\bpinNote\b|\btogglePin\b|\bunpin\b|\bisPinned\b|\bpinned_at\b/i,
      );
    }
  });

  /** No generic pin endpoint, by name or by path. */
  it("declares no message-pinning API", () => {
    const routes = walk(join(ROOT, "app", "api"));
    for (const file of routes) {
      expect(relative(file)).not.toMatch(/\bpin(ned)?\b/i);
    }
    const forbidden = [
      join(ROOT, "app", "api", "pinned-messages"),
      join(ROOT, "app", "api", "messages"),
    ];
    for (const path of forbidden) {
      expect(existsSync(path), `${relative(path)} must not exist`).toBe(false);
    }
  });

  /** No pin storage: the note row is the only record there is. */
  it("adds no pin table or pin column to the schema", () => {
    const migrations = readdirSync(join(ROOT, "migrations")).filter((name) =>
      name.endsWith(".sql"),
    );
    for (const name of migrations) {
      const sql = readFileSync(join(ROOT, "migrations", name), "utf8")
        .replace(/--[^\n]*/g, " ")
        .toLowerCase();
      expect(sql, `${name} must not create pin storage`).not.toMatch(
        /pinned_messages|message_pins|\bpinned\b|\bis_pinned\b/,
      );
    }
  });

  /**
   * The pin is derived from the same list, so it cannot duplicate a row.
   *
   * The pinned card takes its note from the array the hook holds. Only one
   * request creates a note — `POST` in the hook's `add` — and the pinned
   * rendering issues none of its own, which is what makes "displayed twice,
   * stored once" true rather than merely intended.
   */
  it("stores one row however many places a note is shown", () => {
    const hook = readFileSync(join(ROOT, "components", "use-internal-notes.ts"), "utf8");
    expect(hook.match(/method:\s*"POST"/g) ?? []).toHaveLength(1);
    expect(pinned).not.toMatch(/fetch\(|method:\s*"/);
  });
});

describe("the visibility guarantee is stored, not assumed", () => {
  const migration = readFileSync(
    join(__dirname, "..", "..", "migrations", "0012_internal_notes.up.sql"),
    "utf8",
  );

  /**
   * A one-value CHECK, and the application agreeing with it.
   *
   * This is the device that makes "not customer visible" a fact the database
   * holds rather than a convention the code follows: a customer-visible note
   * requires altering this constraint on purpose.
   */
  it("constrains the column to exactly one value", () => {
    expect(migration).toMatch(/ck_internal_notes_visibility[\s\S]{0,120}CHECK \(visibility IN \('internal'\)\)/);
    expect(INTERNAL_NOTE_VISIBILITY).toBe("internal");
  });

  it("refuses a blank note at the database as well as in the application", () => {
    expect(migration).toMatch(
      /ck_internal_notes_text_present[\s\S]{0,120}CHECK \(length\(btrim\(note_text\)\) > 0\)/,
    );
  });

  it("creates nothing outside cst_app, and no foreign key into the source database", () => {
    const code = migration.replace(/--[^\n]*/g, " ");
    const created = code.match(/CREATE (?:TABLE|INDEX)[^\n]*\n?[^\n]*/g) ?? [];
    expect(created.length).toBeGreaterThan(0);
    for (const statement of created) {
      expect(statement).toContain("cst_app.");
    }
    for (const sourceSchema of ["order_management", "customers", "customer_service", "listings"]) {
      expect(code).not.toMatch(new RegExp(`REFERENCES\\s+${sourceSchema}\\.`, "i"));
    }
  });
});
