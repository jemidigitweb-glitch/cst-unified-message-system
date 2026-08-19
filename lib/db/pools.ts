import "server-only";

import { Pool, type PoolConfig } from "pg";

import { appDbConfig, knowledgeDbConfig, sourceDbConfig } from "@/lib/config/env";

/**
 * node-postgres pools, created lazily on first use.
 *
 * Importing this module does NOT connect. A pool only dials the server when a
 * query is first issued, which is why this scaffold can ship without touching
 * any database.
 *
 * No ORM: the source database has zero foreign keys, so every join has to be an
 * explicitly reviewed SQL relationship rather than something a mapper infers.
 * All queries must be parameterised ($1, $2, ...) — never string-interpolated.
 */

let sourcePool: Pool | undefined;
let appPool: Pool | undefined;
let knowledgePool: Pool | undefined;

/**
 * TLS policy.
 *
 * The servers reject unencrypted connections — `pg_hba.conf` matched no entry
 * for a plaintext client and returned "no encryption". `psql` succeeds because
 * it defaults to `sslmode=prefer` and negotiates TLS; node-postgres defaults to
 * no TLS at all, so without this every pool fails to connect.
 *
 * The default mirrors `sslmode=require`: the transport is encrypted, but the
 * server certificate is not verified — the same trust level psql is operating at
 * today. Set `DB_SSL_MODE=verify` once a CA certificate is available for these
 * hosts; that is a production hardening step, not something to assume works now.
 * `DB_SSL_MODE=disable` is available for a local plaintext server.
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

function base(config: PoolConfig): PoolConfig {
  return {
    ...config,
    ssl: sslConfig(),
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
}

/**
 * READ-ONLY source pool.
 *
 * `default_transaction_read_only=on` is set at the session level so the server
 * itself rejects any write, rather than relying on the caller's discipline. This
 * is deliberate defence in depth: the source database is shared with unrelated
 * production systems.
 */
export function getSourcePool(): Pool {
  sourcePool ??= new Pool(
    base({
      ...sourceDbConfig(),
      options: "-c default_transaction_read_only=on",
      application_name: "cst-source-ro",
    }),
  );
  return sourcePool;
}

/**
 * Application pool. Writable later, and only within the cst_app schema.
 * `search_path` is pinned so a missing qualification cannot silently touch
 * public or any unrelated project's schema.
 */
export function getAppPool(): Pool {
  if (!appPool) {
    const { schema, ...config } = appDbConfig();
    appPool = new Pool(
      base({
        ...config,
        options: `-c search_path=${schema}`,
        application_name: "cst-app",
      }),
    );
  }
  return appPool;
}

/**
 * READ-ONLY knowledge pool. Returns undefined until the knowledge source is
 * configured and its authority is confirmed.
 */
export function getKnowledgePool(): Pool | undefined {
  const config = knowledgeDbConfig();
  if (!config) return undefined;
  knowledgePool ??= new Pool(
    base({
      ...config,
      options: "-c default_transaction_read_only=on",
      application_name: "cst-knowledge-ro",
    }),
  );
  return knowledgePool;
}

/** Closes any pool that was actually opened. For graceful shutdown and tests. */
export async function closeAllPools(): Promise<void> {
  await Promise.all([sourcePool?.end(), appPool?.end(), knowledgePool?.end()]);
  sourcePool = appPool = knowledgePool = undefined;
}
