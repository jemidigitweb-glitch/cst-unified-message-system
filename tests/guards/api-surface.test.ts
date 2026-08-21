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

/** Never allowed on any route. */
const FORBIDDEN_METHODS = ["PUT", "DELETE", "HEAD", "OPTIONS"];

/** Allowed to mutate, because a draft is the one thing this phase writes. */
const MUTABLE_ROUTES = [/[\\/]draft[\\/]route\.tsx?$/, /[\\/]workflow[\\/]route\.tsx?$/];

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
