import { describe, expect, it } from "vitest";

import { ORDER_MANAGEMENT, type DirectoryEntry } from "@/lib/domain/agent-directory";
import {
  UPSERT_AGENT_DIRECTORY_SQL,
  upsertAgentDirectory,
} from "@/lib/sync/agent-directory-writer";
import { SELECT_STAFF_SQL, assertOrderSourceReadOnly } from "@/lib/db/order-source";

/**
 * The writer and the reader, without a database.
 *
 * The statements are asserted as text — that a value is bound rather than
 * interpolated, that the conflict target is the unique index 0018 created, and
 * that `created_at` is not rewritten — because those are the properties that
 * make the import safe to run twice, and they are all visible in the SQL.
 */

const entry = (over: Partial<DirectoryEntry> = {}): DirectoryEntry => ({
  sourceSystem: ORDER_MANAGEMENT,
  sourceUserId: 43,
  displayName: "mathusha digitweb",
  active: true,
  sourceStatus: "Active",
  ...over,
});

/** A stub that records calls and answers as PostgreSQL would. */
function stubTx(insertedFlags: boolean[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let i = 0;
  return {
    calls,
    query: async (config: { text: string; values?: unknown[] }) => {
      calls.push({ text: config.text, values: config.values ?? [] });
      return { rows: [{ inserted: insertedFlags[i++] ?? true }] };
    },
  };
}

describe("the upsert statement", () => {
  it("conflicts on the unique index 0018 created", () => {
    expect(UPSERT_AGENT_DIRECTORY_SQL).toMatch(
      /ON CONFLICT \(source_system, source_user_id\) DO UPDATE/,
    );
  });

  /**
   * `created_at` records when CST first saw this person. A refresh must not
   * rewrite it, so it must not appear in the update list.
   */
  it("refreshes synced_at but never created_at", () => {
    const doUpdate = UPSERT_AGENT_DIRECTORY_SQL.slice(
      UPSERT_AGENT_DIRECTORY_SQL.indexOf("DO UPDATE"),
    );
    expect(doUpdate).toMatch(/synced_at\s*=\s*now\(\)/);
    expect(doUpdate).not.toMatch(/created_at/);
  });

  it("binds every value and interpolates none", () => {
    expect(UPSERT_AGENT_DIRECTORY_SQL).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, now\(\)\)/);
    expect(UPSERT_AGENT_DIRECTORY_SQL).not.toMatch(/\$\{/);
  });

  it("writes only agent_directory — never app_users", () => {
    expect(UPSERT_AGENT_DIRECTORY_SQL).toContain("cst_app.agent_directory");
    expect(UPSERT_AGENT_DIRECTORY_SQL).not.toMatch(/app_users/i);
  });

  /** Departed staff are updated, never removed: agent_activity refers to them. */
  it("contains no DELETE", () => {
    expect(UPSERT_AGENT_DIRECTORY_SQL).not.toMatch(/\bDELETE\b/i);
    expect(UPSERT_AGENT_DIRECTORY_SQL).not.toMatch(/\bTRUNCATE\b/i);
  });
});

describe("upsertAgentDirectory", () => {
  it("passes the five mapped fields as bound parameters, in order", async () => {
    const tx = stubTx([true]);
    await upsertAgentDirectory(tx, [entry()]);
    expect(tx.calls).toHaveLength(1);
    expect(tx.calls[0].values).toEqual([
      "order_management", 43, "mathusha digitweb", true, "Active",
    ]);
  });

  it("reports inserts and updates separately", async () => {
    const tx = stubTx([true, false, false]);
    const outcome = await upsertAgentDirectory(tx, [
      entry({ sourceUserId: 1 }),
      entry({ sourceUserId: 2 }),
      entry({ sourceUserId: 3 }),
    ]);
    expect(outcome).toEqual({ inserted: 1, updated: 2 });
  });

  /** A second run must update, never duplicate — the repeatability guarantee. */
  it("reports a re-run as all updates and no inserts", async () => {
    const entries = [entry({ sourceUserId: 20 }), entry({ sourceUserId: 43 })];
    const second = stubTx([false, false]);
    expect(await upsertAgentDirectory(second, entries)).toEqual({ inserted: 0, updated: 2 });
  });

  it("carries a null source_status through as null", async () => {
    const tx = stubTx([true]);
    await upsertAgentDirectory(tx, [entry({ sourceStatus: null, active: false })]);
    expect(tx.calls[0].values[4]).toBeNull();
    expect(tx.calls[0].values[3]).toBe(false);
  });

  it("does nothing when given nothing", async () => {
    const tx = stubTx([]);
    expect(await upsertAgentDirectory(tx, [])).toEqual({ inserted: 0, updated: 0 });
    expect(tx.calls).toHaveLength(0);
  });
});

describe("the source SELECT", () => {
  /**
   * `user` holds user_password, token, verification_code, fcm_token,
   * user_email, user_contact, user_gender, user_branch, user_image, attempts
   * and last_attempt. Data that is never read cannot be stored by accident.
   */
  it.each([
    "user_password", "token", "verification_code", "fcm_token",
    "user_email", "user_contact", "user_gender", "user_branch",
    "user_image", "attempts", "last_attempt",
  ])("never selects %s", (column) => {
    expect(SELECT_STAFF_SQL).not.toContain(column);
  });

  it("selects exactly the four approved columns", () => {
    for (const column of ["user_firstname", "user_lastname", "user_status"]) {
      expect(SELECT_STAFF_SQL).toContain(column);
    }
    expect(SELECT_STAFF_SQL.match(/\bAS\s+\w+/g)).toHaveLength(4);
  });

  it("is a SELECT and nothing else", () => {
    for (const verb of ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "REPLACE"]) {
      expect(SELECT_STAFF_SQL.toUpperCase()).not.toContain(verb);
    }
  });

  /** Keyset pagination: an OFFSET scan would drop a person if a row arrived mid-run. */
  it("paginates on the primary key with bound parameters", () => {
    expect(SELECT_STAFF_SQL).toMatch(/WHERE `user` > \?/);
    expect(SELECT_STAFF_SQL).toMatch(/ORDER BY `user` ASC/);
    expect(SELECT_STAFF_SQL).toMatch(/LIMIT \?/);
  });
});

describe("assertOrderSourceReadOnly", () => {
  const grants = (lines: string[]) => ({
    query: async () => [lines.map((l) => ({ "Grants for x@y": l })), null] as [unknown, unknown],
  });

  it("accepts a USAGE + SELECT credential", async () => {
    await expect(
      assertOrderSourceReadOnly(
        grants([
          "GRANT USAGE ON *.* TO `message-app-dev`@`%` IDENTIFIED BY PASSWORD '*ABC'",
          "GRANT SELECT ON `order_management`.`user` TO `message-app-dev`@`%`",
        ]),
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    "GRANT SELECT, INSERT ON `order_management`.`user` TO `x`@`%`",
    "GRANT ALL PRIVILEGES ON *.* TO `x`@`%`",
    "GRANT UPDATE ON `order_management`.`user` TO `x`@`%`",
    "GRANT DELETE ON `order_management`.`user` TO `x`@`%`",
    "GRANT DROP ON `order_management`.* TO `x`@`%`",
  ])("refuses a credential holding write privileges: %s", async (line) => {
    await expect(assertOrderSourceReadOnly(grants([line]))).rejects.toThrow(/refusing to read/);
  });

  /**
   * The privilege list is read, not the object. A table named `order_update`
   * must not be mistaken for an UPDATE grant.
   */
  it("reads the privilege list, not the table name", async () => {
    await expect(
      assertOrderSourceReadOnly(grants(["GRANT SELECT ON `order_management`.`order_update` TO `x`@`%`"])),
    ).resolves.toBeUndefined();
  });

  it("refuses when SHOW GRANTS returns nothing", async () => {
    await expect(assertOrderSourceReadOnly(grants([]))).rejects.toThrow(/returned nothing/);
  });
});
