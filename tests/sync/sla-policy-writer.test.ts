import { describe, expect, it } from "vitest";

import {
  MAX_MAIL_ACCOUNTS,
  MAX_RESPONSE_SLA_CONFIGS,
  SELECT_MAIL_ACCOUNTS_SQL,
  SELECT_RESPONSE_SLA_CONFIGS_SQL,
  fetchMailAccounts,
  fetchResponseSlaConfigs,
} from "@/lib/db/message-app-source";
import { RESPONSE_POLICY_TYPE, type CollapsedPolicy } from "@/lib/domain/sla-policy";
import {
  CST_ACCOUNTS_SQL,
  UPSERT_RESPONSE_SLA_POLICY_SQL,
  cstSellerAccounts,
  upsertResponseSlaPolicy,
} from "@/lib/sync/sla-policy-writer";

/**
 * The reader and the writer, without a database.
 *
 * The statements are asserted as TEXT — what they select, what they refuse to
 * select, that values are bound rather than interpolated, and that the conflict
 * target matches the expression index 0019 creates. Those are the properties
 * that make the import safe to run twice and safe to run at all, and every one
 * of them is visible in the SQL.
 */

const policy = (over: Partial<CollapsedPolicy> = {}): CollapsedPolicy => ({
  marketplace: "ebay",
  subSourceId: 1,
  weekScope: "week",
  targetHours: 16,
  sourcePk: "2",
  sourceMailId: null,
  sourceRows: 1,
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

/** A stub MariaDB connection that records statements and returns fixed rows. */
function stubMysql(rows: unknown[]) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  return {
    calls,
    query: async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values: values ?? [] });
      return [rows, undefined] as [unknown, unknown];
    },
  };
}

describe("the sla_configs reader", () => {
  /**
   * 42 of 1,081 rows are policy. The other 1,039 are a per-case escalation log
   * carrying customer message ids. The filter is the most important character
   * in this statement.
   */
  it("filters to the response type, bound rather than inlined", () => {
    expect(SELECT_RESPONSE_SLA_CONFIGS_SQL).toMatch(/WHERE\s+type\s*=\s*\?/);
    expect(SELECT_RESPONSE_SLA_CONFIGS_SQL).not.toMatch(/'response'/);
    expect(SELECT_RESPONSE_SLA_CONFIGS_SQL).not.toMatch(/'urgent'/);
  });

  it("passes the response type as the bound value", async () => {
    const conn = stubMysql([]);
    await fetchResponseSlaConfigs(conn);
    expect(conn.calls[0].values[0]).toBe(RESPONSE_POLICY_TYPE);
  });

  /**
   * `key_value` is a customer's marketplace message id; `reason` quotes phrases
   * from customer conversations. Both are NULL on all 42 response rows and
   * populated on the 1,039 urgent ones. A column that is never selected cannot
   * be stored by accident.
   */
  it("selects no customer-derived column", () => {
    expect(SELECT_RESPONSE_SLA_CONFIGS_SQL).not.toMatch(/\bkey_value\b/);
    expect(SELECT_RESPONSE_SLA_CONFIGS_SQL).not.toMatch(/\breason\b/);
  });

  it("selects exactly the eight columns the mapper needs", () => {
    for (const column of [
      "id",
      "type",
      "channel",
      "week_scope",
      "situation",
      "hours",
      "sub_source",
      "mail_id",
    ]) {
      expect(SELECT_RESPONSE_SLA_CONFIGS_SQL).toContain(column);
    }
  });

  it("is a SELECT and contains no write verb", () => {
    expect(SELECT_RESPONSE_SLA_CONFIGS_SQL.trimStart()).toMatch(/^SELECT/i);
    for (const verb of ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "TRUNCATE"]) {
      expect(SELECT_RESPONSE_SLA_CONFIGS_SQL.toUpperCase()).not.toContain(verb);
    }
  });

  it("maps a source row into the mapper's shape", async () => {
    const conn = stubMysql([
      {
        source_pk: 4,
        config_type: "response",
        channel: "shopify",
        week_scope: "week",
        situation: "default",
        hours: "16",
        sub_source: null,
        mail_id: 3,
      },
    ]);
    const rows = await fetchResponseSlaConfigs(conn);

    expect(rows).toEqual([
      {
        sourcePk: "4",
        type: "response",
        channel: "shopify",
        weekScope: "week",
        situation: "default",
        hours: 16,
        subSource: null,
        mailId: 3,
      },
    ]);
  });

  /** Text, because the column that stores it is text and Number() would be lossy. */
  it("carries the source id as text", async () => {
    const conn = stubMysql([{ source_pk: 42, config_type: "response", channel: "ebay", week_scope: "week", situation: "default", hours: 16, sub_source: 1, mail_id: null }]);
    const rows = await fetchResponseSlaConfigs(conn);
    expect(rows[0].sourcePk).toBe("42");
    expect(typeof rows[0].sourcePk).toBe("string");
  });

  /**
   * The LIMIT is a RUNAWAY GUARD, not pagination — 42 rows do not need paging
   * against an account capped at 100 queries an hour. Hitting it means the read
   * may be truncated, and a truncated policy looks exactly like a successful
   * import with seller accounts missing.
   */
  it("refuses a result at or past the guard rather than importing a partial policy", async () => {
    const many = Array.from({ length: MAX_RESPONSE_SLA_CONFIGS }, (_, i) => ({
      source_pk: i + 1,
      config_type: "response",
      channel: "ebay",
      week_scope: "week",
      situation: "default",
      hours: 16,
      sub_source: 1,
      mail_id: null,
    }));
    await expect(fetchResponseSlaConfigs(stubMysql(many))).rejects.toThrow(/truncated/i);
  });

  it("counts one query against the budget", async () => {
    const budget = { spent: 0 };
    await fetchResponseSlaConfigs(stubMysql([]), { budget });
    expect(budget.spent).toBe(1);
  });
});

describe("the mails reader", () => {
  /**
   * `mails` also holds env_pw, smtp_host, smtp_port, smtp_encryption and a
   * mailbox address. None is selected: this application has no transport and
   * must not acquire the configuration for one by accident.
   */
  it("selects no credential, address or transport column", () => {
    for (const column of ["env_pw", "email", "smtp_host", "smtp_port", "smtp_encryption", "password"]) {
      expect(SELECT_MAIL_ACCOUNTS_SQL).not.toContain(column);
    }
  });

  it("selects only the id and the account", () => {
    expect(SELECT_MAIL_ACCOUNTS_SQL).toMatch(/SELECT\s+id\s+AS mail_id,\s*sub_source\s+AS sub_source/);
  });

  /**
   * Amazon's mailbox has a NULL sub_source, and that NULL is load-bearing: it
   * is what tells `resolveAccount` the target is channel-wide rather than that
   * the mailbox is missing. Filtering NULLs would turn a verified reading into
   * a dangling reference.
   */
  it("does not filter out mailboxes with no account", () => {
    expect(SELECT_MAIL_ACCOUNTS_SQL).not.toMatch(/sub_source\s+IS\s+NOT\s+NULL/i);
    expect(SELECT_MAIL_ACCOUNTS_SQL).not.toMatch(/WHERE/i);
  });

  it("carries a NULL account through as null", async () => {
    const rows = await fetchMailAccounts(stubMysql([{ mail_id: 1, sub_source: null }]));
    expect(rows).toEqual([{ mailId: 1, subSource: null }]);
  });

  it("refuses a result at or past the guard", async () => {
    const many = Array.from({ length: MAX_MAIL_ACCOUNTS }, (_, i) => ({
      mail_id: i + 1,
      sub_source: null,
    }));
    await expect(fetchMailAccounts(stubMysql(many))).rejects.toThrow(/truncated/i);
  });

  it("counts one query against the budget", async () => {
    const budget = { spent: 0 };
    await fetchMailAccounts(stubMysql([]), { budget });
    expect(budget.spent).toBe(1);
  });
});

describe("the upsert statement", () => {
  /**
   * THE `coalesce` IS NOT DECORATION. PostgreSQL treats NULLs as distinct in a
   * unique index, so Amazon's channel-wide row would be insertable twice and
   * every run would append another pair. This must match
   * `uq_response_sla_policy_scope` in 0019 exactly.
   */
  it("conflicts on the expression index 0019 creates, coalesce included", () => {
    expect(UPSERT_RESPONSE_SLA_POLICY_SQL).toMatch(
      /ON CONFLICT \(marketplace, coalesce\(sub_source_id, -1\), week_scope\) DO UPDATE/,
    );
  });

  /**
   * `created_at` records when CST first saw this scope. A refresh must not
   * rewrite it, so it must not appear in the update list.
   */
  it("refreshes imported_at but never created_at", () => {
    const doUpdate = UPSERT_RESPONSE_SLA_POLICY_SQL.slice(
      UPSERT_RESPONSE_SLA_POLICY_SQL.indexOf("DO UPDATE"),
    );
    expect(doUpdate).toMatch(/imported_at\s*=\s*now\(\)/);
    expect(doUpdate).not.toMatch(/created_at/);
  });

  /**
   * Provenance must follow the value. If the source's winning row changes, a
   * stale source_pk would point at a row that no longer sets the target it
   * claims to explain.
   */
  it("updates the provenance alongside the target", () => {
    const doUpdate = UPSERT_RESPONSE_SLA_POLICY_SQL.slice(
      UPSERT_RESPONSE_SLA_POLICY_SQL.indexOf("DO UPDATE"),
    );
    for (const column of ["target_hours", "source_pk", "source_mail_id", "source_rows"]) {
      expect(doUpdate).toContain(column);
    }
  });

  it("binds every value and interpolates none", () => {
    expect(UPSERT_RESPONSE_SLA_POLICY_SQL).toMatch(/\$1[\s\S]*\$7/);
    expect(UPSERT_RESPONSE_SLA_POLICY_SQL).not.toMatch(/\$\{/);
  });

  it("writes only response_sla_policy", () => {
    expect(UPSERT_RESPONSE_SLA_POLICY_SQL).toContain("INSERT INTO cst_app.response_sla_policy");
    expect(UPSERT_RESPONSE_SLA_POLICY_SQL).not.toMatch(/conversation/i);
    expect(UPSERT_RESPONSE_SLA_POLICY_SQL).not.toMatch(/\bDELETE\b/i);
  });

  it("holds no customer-derived column", () => {
    expect(UPSERT_RESPONSE_SLA_POLICY_SQL).not.toMatch(/\bkey_value\b/);
    expect(UPSERT_RESPONSE_SLA_POLICY_SQL).not.toMatch(/\breason\b/);
    expect(UPSERT_RESPONSE_SLA_POLICY_SQL).not.toMatch(/\bbody_text\b/);
  });
});

describe("upserting", () => {
  it("passes the entry's values in order", async () => {
    const tx = stubTx([true]);
    await upsertResponseSlaPolicy(tx, [
      policy({ marketplace: "shopify", subSourceId: 104, weekScope: "weekend", targetHours: 24, sourcePk: "38", sourceMailId: 3, sourceRows: 3 }),
    ]);

    expect(tx.calls[0].values).toEqual(["shopify", 104, "weekend", 24, "38", 3, 3]);
  });

  /** NULL travels as null — it means "the whole channel", not "unknown". */
  it("sends a channel-wide policy with a null account", async () => {
    const tx = stubTx([true]);
    await upsertResponseSlaPolicy(tx, [
      policy({ marketplace: "amazon", subSourceId: null, sourcePk: "1", sourceMailId: 1 }),
    ]);
    expect(tx.calls[0].values[1]).toBeNull();
  });

  it("counts inserts and updates apart", async () => {
    const tx = stubTx([true, false, true]);
    const outcome = await upsertResponseSlaPolicy(tx, [
      policy({ sourcePk: "2" }),
      policy({ sourcePk: "9", subSourceId: 2 }),
      policy({ sourcePk: "10", subSourceId: 3 }),
    ]);
    expect(outcome).toEqual({ inserted: 2, updated: 1 });
  });

  it("writes nothing for an empty batch", async () => {
    const tx = stubTx([]);
    const outcome = await upsertResponseSlaPolicy(tx, []);
    expect(tx.calls).toHaveLength(0);
    expect(outcome).toEqual({ inserted: 0, updated: 0 });
  });

  it("issues exactly one statement per policy row", async () => {
    const tx = stubTx([true, true]);
    await upsertResponseSlaPolicy(tx, [policy({ sourcePk: "2" }), policy({ sourcePk: "23", weekScope: "weekend" })]);
    expect(tx.calls).toHaveLength(2);
  });
});

describe("the coverage read", () => {
  /**
   * The only statement in the writer that touches `conversations`, and it must
   * stay a read. It exists so the importer can say which accounts it did NOT
   * cover.
   */
  it("reads conversations and never writes them", () => {
    expect(CST_ACCOUNTS_SQL.trimStart()).toMatch(/^SELECT/i);
    expect(CST_ACCOUNTS_SQL).toContain("FROM cst_app.conversations");
    for (const verb of ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE"]) {
      expect(CST_ACCOUNTS_SQL.toUpperCase()).not.toContain(verb);
    }
  });

  /** No message body, no counterparty, no customer-identifying column. */
  it("reads no message content", () => {
    expect(CST_ACCOUNTS_SQL).not.toMatch(/body_text|counterparty|subject/i);
  });

  it("groups by marketplace and account together", () => {
    expect(CST_ACCOUNTS_SQL).toMatch(/GROUP BY marketplace, sub_source_id/);
  });

  it("returns accounts with their conversation counts", async () => {
    const tx = stubTx([]);
    const app = {
      query: async () => ({
        rows: [
          { marketplace: "ebay", sub_source_id: 1, conversations: 120 },
          { marketplace: "bandq", sub_source_id: 104, conversations: 4247 },
        ],
      }),
    };
    void tx;
    const accounts = await cstSellerAccounts(app);
    expect(accounts).toEqual([
      { marketplace: "ebay", subSourceId: 1, conversations: 120 },
      { marketplace: "bandq", subSourceId: 104, conversations: 4247 },
    ]);
  });
});
