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

/**
 * ---------------------------------------------------------------------------
 * POOL SIZING, AND THE MEASUREMENT IT COMES FROM
 * ---------------------------------------------------------------------------
 * `varmen_user` has `rolconnlimit = 25`. That is a cap on the ROLE, not the
 * server — the cluster's `max_connections` is 200 — so every process using
 * these credentials is drawing on one shared budget of 25, and when it runs out
 * the error is `53300 too many connections for role "varmen_user"`, which is
 * what took the performance dashboard down on 2026-09-24.
 *
 * ---------------------------------------------------------------------------
 * THE IDLE REAPER DOES NOT RUN ON VERCEL, AND THAT IS THE ROOT CAUSE
 * ---------------------------------------------------------------------------
 * Measured in `pg_stat_activity` on 2026-09-24: seven connections, every one
 * `state = idle`, `idle_for` between 9 and 10 MINUTES, against an
 * `idleTimeoutMillis` of 30 seconds. The reaper had not fired once.
 *
 * It cannot. Vercel functions run on Lambda, and the execution environment is
 * FROZEN once the response is sent — timers do not fire while frozen, so a pool
 * can never reap its own idle clients between invocations. They are held until
 * the instance is recycled or the server drops them.
 *
 * That reading also carried three distinct `client_addr` values, all in AWS
 * ranges: three concurrent Vercel instances, each with its own module-level
 * pools. The old `max: 5` on both pools therefore had a ceiling of TEN
 * connections per instance, none of them ever given back — three warm instances
 * could exhaust a 25-connection budget on their own.
 *
 * (`client_addr` is how you tell instances apart if this recurs. Group
 * `pg_stat_activity` by it; the addresses are not recorded here because
 * `tests/guards/no-customer-data.test.ts` forbids committing an IP, and it is
 * right to — they are infrastructure detail with a short shelf life.)
 *
 * ---------------------------------------------------------------------------
 * SO THE SIZE IS THE CONTROL, AND IT IS SIZED TO REAL CONCURRENCY
 * ---------------------------------------------------------------------------
 * A pool of 5 was never reachable by one request. The widest fan-out in the
 * application is three parallel statements on the APP pool
 * (`/api/performance/summary` runs `messagesHandledByAgent`, `activityCoverage`
 * and `agentOptions` in one `Promise.all`), and every SOURCE read is a single
 * batched statement. Sizing to that costs nothing in latency and cuts the
 * per-instance ceiling from ten to five.
 *
 * THIS IS MITIGATION, NOT A FIX. Instance count on Vercel is unbounded, so no
 * `max` can be proven safe — five instances still reach 25. The durable answers
 * are a connection pooler (PgBouncer in transaction mode) in front of Postgres,
 * or raising `rolconnlimit`, and both are decisions for whoever owns the
 * cluster rather than something this file can settle.
 */
const APP_POOL_MAX = 3;
const SOURCE_POOL_MAX = 2;

function base(config: PoolConfig & { max: number }): PoolConfig {
  return {
    ...config,
    ssl: sslConfig(),
    /*
     * Lower than the old 30s. It buys nothing on Vercel, where the timer is
     * frozen, but it is the difference between holding and releasing for every
     * context where the event loop DOES keep running — `npm run dev`, the sync
     * scripts and the automation worker, which are long-lived processes drawing
     * on the same 25.
     */
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    /*
     * Let a pool with nothing checked out stop holding the event loop open, so
     * a script that has finished its work exits — and releases its connections
     * — instead of lingering for the idle timeout.
     */
    allowExitOnIdle: true,
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
      max: SOURCE_POOL_MAX,
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
        max: APP_POOL_MAX,
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
      // One batched read per request, like the source pool.
      max: SOURCE_POOL_MAX,
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
