import { describe, expect, it } from "vitest";

import { assertApplicationDatabase, assertSourceReadOnly } from "@/lib/sync/guard";

function fake(rowsByCall: unknown[][]) {
  let index = 0;
  return {
    query: async () => ({ rows: rowsByCall[index++] ?? [] }),
  };
}

describe("assertApplicationDatabase", () => {
  it("passes for the expected database, user and schema", async () => {
    const client = fake([
      [{ db: "varmen_db", usr: "varmen_user" }],
      [{ ok: true }],
    ]);
    await expect(assertApplicationDatabase(client)).resolves.toBeUndefined();
  });

  it("refuses a connection to the wrong database", async () => {
    const client = fake([[{ db: "some_other_db", usr: "varmen_user" }]]);
    await expect(assertApplicationDatabase(client)).rejects.toThrow(/current_database/);
  });

  it("refuses a connection under the wrong user", async () => {
    const client = fake([[{ db: "varmen_db", usr: "someone_else" }]]);
    await expect(assertApplicationDatabase(client)).rejects.toThrow(/current_user/);
  });

  it("refuses when the schema has not been migrated yet", async () => {
    const client = fake([
      [{ db: "varmen_db", usr: "varmen_user" }],
      [{ ok: false }],
    ]);
    await expect(assertApplicationDatabase(client)).rejects.toThrow(/migrations/);
  });
});

describe("assertSourceReadOnly", () => {
  it("passes when the session is read-only", async () => {
    const client = fake([[{ default_transaction_read_only: "on" }]]);
    await expect(assertSourceReadOnly(client)).resolves.toBeUndefined();
  });

  it("refuses a session that could write", async () => {
    const client = fake([[{ default_transaction_read_only: "off" }]]);
    await expect(assertSourceReadOnly(client)).rejects.toThrow(/read-only/);
  });
});
