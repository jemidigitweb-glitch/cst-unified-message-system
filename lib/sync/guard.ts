import "server-only";

import type { Queryable } from "@/lib/sync/message-sync";

/**
 * Safety checks shared by every entry point that writes to cst_app.
 *
 * Extracted from `scripts/sync-messages.mjs`, where the same two checks were
 * first written, so the CLI and the serverless cron route cannot drift onto
 * different rules for what "safe to write" means.
 */

/** The identity this application is allowed to write as. */
const EXPECTED_DATABASE = "varmen_db";
const EXPECTED_USER = "varmen_user";

/**
 * Refuses to write anywhere that is not the application database.
 *
 * A misconfigured environment pointing the "app" connection at the live
 * marketplace source would otherwise be discovered by writing to it.
 */
export async function assertApplicationDatabase(app: Queryable): Promise<void> {
  const { rows } = await app.query({ text: "SELECT current_database() AS db, current_user AS usr" });
  const { db, usr } = rows[0] as { db: string; usr: string };

  if (db !== EXPECTED_DATABASE) {
    throw new Error(`refusing to write: current_database() is ${db}, expected ${EXPECTED_DATABASE}`);
  }
  if (usr !== EXPECTED_USER) {
    throw new Error(`refusing to write: current_user is ${usr}, expected ${EXPECTED_USER}`);
  }

  const { rows: schema } = await app.query({
    text: "SELECT to_regclass('cst_app.conversations') IS NOT NULL AS ok",
  });
  if (!(schema[0] as { ok: boolean } | undefined)?.ok) {
    throw new Error("cst_app.conversations is missing — apply the migrations first");
  }
}

/** Confirms the source session cannot be written to, before reading from it. */
export async function assertSourceReadOnly(source: Queryable): Promise<void> {
  const { rows } = await source.query({ text: "SHOW default_transaction_read_only" });
  const value = (rows[0] as { default_transaction_read_only?: string } | undefined)
    ?.default_transaction_read_only;
  if (value !== "on") {
    throw new Error("source session is not read-only — refusing to proceed");
  }
}
