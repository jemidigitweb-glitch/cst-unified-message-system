import type { SourceStaffRow } from "@/lib/domain/agent-directory";

/**
 * The minimum needed to READ the staff directory out of MariaDB.
 *
 * This is a reader and nothing else. There is no INSERT, UPDATE, DELETE,
 * CREATE, ALTER or DROP in this file, and no code path that could build one:
 * the single statement below is a constant.
 *
 * ------------------------------------------------------------------------
 * READ-ONLY IS ENFORCED BY THE GRANTS, AND VERIFIED AT RUNTIME
 * ------------------------------------------------------------------------
 * PostgreSQL sources get `default_transaction_read_only=on` pinned on the
 * session, so the server refuses a write regardless of what the client does —
 * see `getSourcePool`. MariaDB 10.4 has no equivalent: `transaction_read_only`
 * is not a system variable there, and asking for it is an error rather than a
 * safe no-op.
 *
 * So the guarantee comes from the account instead, and
 * `assertOrderSourceReadOnly` checks it rather than assuming it. The approved
 * credential holds `USAGE ON *.*` plus `SELECT` on 26 named tables and no other
 * privilege anywhere. A credential swapped for a stronger one fails the check
 * at startup instead of being discovered by a write.
 *
 * ------------------------------------------------------------------------
 * NO POOL, ON PURPOSE
 * ------------------------------------------------------------------------
 * A single connection, opened for one bounded import and closed. The
 * message-application account is capped at 50 connections per hour and this
 * account shares the same discipline, so a pool that dials per batch would
 * spend the budget on a 234-row table. One connection, one run.
 */

/** The slice of mysql2 this module needs. Injected so tests need no server. */
export type MySqlQueryable = {
  query: (sql: string, values?: readonly unknown[]) => Promise<[unknown, unknown]>;
};

/** Connection details, already validated by `orderDbConfig()`. */
export type OrderSourceConfig = {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
};

/**
 * Privileges that must NOT appear in this account's grants.
 *
 * `GRANT USAGE` and `GRANT SELECT` are the two expected verbs. Anything in this
 * list means the credential can change the directory it is supposed to be
 * reading.
 */
const WRITE_PRIVILEGES = [
  "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER",
  "TRUNCATE", "REPLACE", "INDEX", "REFERENCES", "ALL PRIVILEGES",
];

/**
 * Refuses to read through a credential that could also write.
 *
 * The mirror of `assertSourceReadOnly` in `lib/sync/guard.ts`, adapted to the
 * only mechanism MariaDB offers. Cheap, and it fails loudly if the credential
 * is ever replaced with a stronger one.
 */
export async function assertOrderSourceReadOnly(connection: MySqlQueryable): Promise<void> {
  const [rows] = await connection.query("SHOW GRANTS FOR CURRENT_USER()");
  const grants = (rows as Array<Record<string, string>>).map(
    (row) => Object.values(row)[0] ?? "",
  );

  if (grants.length === 0) {
    throw new Error("order source: SHOW GRANTS returned nothing — refusing to read");
  }

  for (const grant of grants) {
    // Only the privilege list matters, not the object it is granted on: a
    // table called `order_update` must not read as an UPDATE privilege.
    const privileges = grant.slice(0, grant.toUpperCase().indexOf(" ON ")).toUpperCase();
    for (const privilege of WRITE_PRIVILEGES) {
      if (privileges.includes(privilege)) {
        throw new Error(
          `order source credential holds ${privilege} — refusing to read through a writable account`,
        );
      }
    }
  }
}

/**
 * One page of the staff directory, oldest id first.
 *
 * KEYSET PAGINATION on the primary key, not OFFSET. The table is small today
 * (234 rows) but an OFFSET scan re-reads everything it skips, and a row
 * inserted mid-run shifts every later page — which would silently drop a
 * person. `user > ?` cannot skip or repeat.
 *
 * FOUR COLUMNS. `user_password`, `token`, `verification_code`, `fcm_token`,
 * `user_email`, `user_contact`, `user_gender`, `user_branch`, `user_image`,
 * `attempts` and `last_attempt` are all present in this table and none of them
 * is selected. Data that is never read cannot be stored by accident.
 *
 * `user` is backticked because it is the column name AND a MariaDB keyword.
 *
 * PARAMETERISED. Both values are placeholders; nothing is concatenated into the
 * statement. `query` rather than `execute` deliberately — MariaDB's prepared
 * protocol rejects a placeholder in `LIMIT`, and the alternative would be
 * interpolating the limit, which is the exact habit this avoids.
 */
const SELECT_STAFF = `
  SELECT \`user\`        AS source_user_id,
         user_firstname AS first_name,
         user_lastname  AS last_name,
         user_status    AS status
  FROM \`user\`
  WHERE \`user\` > ?
  ORDER BY \`user\` ASC
  LIMIT ?`;

type StaffQueryRow = {
  source_user_id: number;
  first_name: string | null;
  last_name: string | null;
  status: string | null;
};

export async function fetchStaffPage(
  connection: MySqlQueryable,
  options: { readonly afterUserId: number; readonly limit: number },
): Promise<readonly SourceStaffRow[]> {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error(`limit must be a positive integer, received: ${String(options.limit)}`);
  }
  if (!Number.isInteger(options.afterUserId) || options.afterUserId < 0) {
    throw new Error(`afterUserId must be a non-negative integer, received: ${String(options.afterUserId)}`);
  }

  const [rows] = await connection.query(SELECT_STAFF, [options.afterUserId, options.limit]);

  return (rows as StaffQueryRow[]).map((row) => ({
    sourceUserId: Number(row.source_user_id),
    firstName: row.first_name,
    lastName: row.last_name,
    status: row.status,
  }));
}

/** The statement, exposed so a test can assert what it does and does not select. */
export const SELECT_STAFF_SQL = SELECT_STAFF;
