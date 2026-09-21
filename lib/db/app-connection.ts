import { Pool, type PoolConfig } from "pg";

import { appDbConfig, sourceDbConfig } from "@/lib/config/env";

/**
 * The two database connections a long-running Node process opens.
 *
 * The safety checks that must pass before either is used to write are NOT
 * re-implemented here: `assertApplicationDatabase` and `assertSourceReadOnly`
 * live in `lib/sync/guard.ts` and the worker calls those, so "is this really the
 * application database, and is the source really read-only?" has exactly one
 * definition in this codebase.
 *
 * WHY THIS FILE EXISTS. `lib/db/pools.ts` is the application's pool module, and
 * it is the right one for the Next server. A standalone worker cannot use it
 * for a reason that is easy to miss: `pg` is CommonJS, and Next bundles it, so
 * its internal `require('pg-native')`-style resolution is settled at build time
 * and never has to happen at runtime. Under plain Node there is no bundler, and
 * a CJS dependency reached from an ESM wrapper is a resolution error rather than
 * a connection failure — which reads as "the worker is broken" when nothing is
 * wrong with it. This module is the same pool, constructed where that cannot
 * happen.
 *
 * WHAT IT IS NOT. It is not a second set of rules. The credentials, the
 * `search_path` pin, the read-only source session and the identity assertions
 * all come from the same places the route uses — `appDbConfig()`,
 * `sourceDbConfig()` and `lib/sync/guard.ts`. If those change, this changes
 * with them. The only thing written out here is the `application_name`, which is
 * a label in `pg_stat_activity` rather than a rule, so an operator can tell the
 * worker's connections apart from the server's.
 *
 * THE SCHEMA IS PINNED FOR A REASON THAT BITES HARDER HERE THAN ANYWHERE ELSE.
 * Every automation statement is written `cst_app.…`, so with the default
 * `search_path` a missing qualification or a stray unqualified name resolves
 * against `public` first and, worse, against the SOURCE database if a
 * connection is ever pointed at the wrong host. Pinning it removes that class of
 * mistake from the worker entirely.
 *
 * `max: 2` rather than the application's 5. A worker waits between ticks and
 * holds at most one connection at a time — one for the idle claim, and the pool
 * it came from. Anything larger would be idle connections held open all day on a
 * database shared with unrelated production systems.
 */

function base(config: PoolConfig, applicationName: string): PoolConfig {
  return {
    ...config,
    ssl: sslConfig(),
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: applicationName,
  };
}

/**
 * TLS policy, mirrored from `lib/db/pools.ts` rather than re-decided.
 *
 * The servers reject unencrypted connections; the default is the same trust
 * level `sslmode=require` gives psql. `DB_SSL_MODE=verify` is the hardening step
 * and `disable` exists for a local plaintext server.
 */
function sslConfig(): PoolConfig["ssl"] {
  switch (process.env.DB_SSL_MODE ?? "require") {
    case "disable":
      return undefined;
    case "verify":
      return { rejectUnauthorized: true };
    default:
      return { rejectUnauthorized: false };
  }
}

/**
 * The application pool, writable, confined to `cst_app` by `search_path`.
 *
 * `schema` is destructured out of the config because it is this process's own
 * setting and not a `pg` connection option: leaving it in the object would put
 * an unknown key in front of node-postgres.
 */
export function createAppPool(): Pool {
  const { schema, ...config } = appDbConfig();
  return new Pool(base({ ...config, options: `-c search_path=${schema}` }, "cst-automation-worker"));
}

/**
 * The source pool. READ-ONLY AT THE SERVER, not by this file's discipline.
 *
 * `default_transaction_read_only=on` is a session setting, so every statement
 * this pool runs — the worker's scans and its rechecks included — is refused a
 * write by the server itself. The source database is shared with unrelated
 * production systems and a bug here must not be able to touch it.
 */
export function createSourcePool(): Pool {
  return new Pool(
    base(
      {
        ...sourceDbConfig(),
        options: "-c default_transaction_read_only=on",
      },
      "cst-automation-worker-source-ro",
    ),
  );
}
