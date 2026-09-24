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

/**
 * ---------------------------------------------------------------------------
 * THE POOLS LIVE ON `globalThis`, AND THAT IS NOT A STYLE CHOICE
 * ---------------------------------------------------------------------------
 * These were three module-level `let`s, which is correct in production and
 * LEAKS BADLY IN DEVELOPMENT.
 *
 * `next dev` hot-reloads a changed module and everything that imports it. Each
 * re-evaluation gives this file a FRESH set of bindings, so `appPool` comes
 * back `undefined`, the next caller constructs a NEW `Pool` — and the previous
 * one is orphaned with its connections still open. Nothing holds a reference to
 * it any more, so nothing can ever call `.end()` on it. The sockets stay up
 * until the process dies.
 *
 * MEASURED 2026-09-24: a dev server that had been running for under two hours,
 * across an editing session that touched this file and its dependents
 * repeatedly, was holding 17 `cst-app` connections against a pool `max` of 3.
 * Six pools' worth of orphans from one server, on a role capped at 25 — which
 * is why the inbox kept failing with `53300` however small the pool got. Pool
 * SIZE cannot fix a leak in pool COUNT.
 *
 * `globalThis` survives module re-evaluation, so a reload now finds the pool
 * that already exists and reuses it. This is the same pattern the Prisma and
 * Drizzle docs prescribe for Next.js, and for exactly this reason.
 *
 * IT CHANGES NOTHING IN PRODUCTION, where a module is evaluated once per
 * process and these behave precisely as the `let`s did.
 */
type PoolCache = {
  source?: Pool;
  app?: Pool;
  knowledge?: Pool;
};

/*
 * A symbol rather than a string key, so this cannot collide with anything else
 * that decides to keep state on the global object.
 */
const POOL_CACHE = Symbol.for("cst.db.pools");

const globalWithPools = globalThis as typeof globalThis & {
  [POOL_CACHE]?: PoolCache;
};

const pools: PoolCache = (globalWithPools[POOL_CACHE] ??= {});

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
/**
 * TWO, AND THE SECOND ONE IS LOAD-BEARING — DO NOT MAKE THIS 1.
 *
 * `app/api/conversations/[conversationId]/draft/route.ts` checks out a client,
 * runs its transaction, COMMITs, and then calls `recordUsage(pool, ...)` on
 * this same pool BEFORE `connection.release()` runs in its `finally`. For that
 * moment two clients are wanted at once.
 *
 * At `max: 1` there is no second slot, so `recordUsage` waits out
 * `connectionTimeoutMillis` and throws. It swallows its own errors by design,
 * so nothing would surface: every AI draft generation would simply take ten
 * seconds longer and AI usage accounting would stop recording, silently.
 *
 * The other four transaction sites — the workflow route, the second draft
 * transaction, `cron/sync` and `automation-runner` — all COMMIT and release
 * without touching the pool in between, so this route is the only constraint.
 * Releasing before the accounting write would free it, and that is a fair
 * change to make on its own merits; it is not one to make as a side effect of
 * connection tuning.
 */
const APP_POOL_MAX = 2;

/**
 * ONE IS SAFE HERE, and the difference from the app pool is the whole reason.
 *
 * Nothing ever checks a client OUT of the source pool — `.connect()` is never
 * called on it anywhere in the application, so no code path can be holding one
 * while asking for another. Every use is a single `pool.query()`, and the few
 * places that issue several at once simply queue instead of deadlocking.
 */
const SOURCE_POOL_MAX = 1;

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
  pools.source ??= new Pool(
    base({
      ...sourceDbConfig(),
      max: SOURCE_POOL_MAX,
      options: "-c default_transaction_read_only=on",
      application_name: "cst-source-ro",
    }),
  );
  return pools.source;
}

/**
 * Application pool. Writable later, and only within the cst_app schema.
 * `search_path` is pinned so a missing qualification cannot silently touch
 * public or any unrelated project's schema.
 */
export function getAppPool(): Pool {
  if (!pools.app) {
    const { schema, ...config } = appDbConfig();
    pools.app = new Pool(
      base({
        ...config,
        max: APP_POOL_MAX,
        options: `-c search_path=${schema}`,
        application_name: "cst-app",
      }),
    );
  }
  return pools.app;
}

/**
 * READ-ONLY knowledge pool. Returns undefined until the knowledge source is
 * configured and its authority is confirmed.
 */
export function getKnowledgePool(): Pool | undefined {
  const config = knowledgeDbConfig();
  if (!config) return undefined;
  pools.knowledge ??= new Pool(
    base({
      ...config,
      // One batched read per request, like the source pool.
      max: SOURCE_POOL_MAX,
      options: "-c default_transaction_read_only=on",
      application_name: "cst-knowledge-ro",
    }),
  );
  return pools.knowledge;
}

/** Closes any pool that was actually opened. For graceful shutdown and tests. */
export async function closeAllPools(): Promise<void> {
  await Promise.all([pools.source?.end(), pools.app?.end(), pools.knowledge?.end()]);
  pools.source = pools.app = pools.knowledge = undefined;
}
