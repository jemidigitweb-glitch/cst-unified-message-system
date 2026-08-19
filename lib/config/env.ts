import "server-only";

import { z } from "zod";

/**
 * Server-only environment access.
 *
 * Importing this module from a client component is a build error (`server-only`),
 * which is what keeps database credentials out of the browser bundle. Nothing here
 * is prefixed with NEXT_PUBLIC_, and nothing here should ever be.
 *
 * Parsing is lazy and memoised: reading config does NOT open a connection.
 */

const nonEmpty = z.string().min(1);

const dbSchema = z.object({
  host: nonEmpty,
  port: z.coerce.number().int().positive().default(5432),
  database: nonEmpty,
  user: nonEmpty,
  password: z.string(),
});

export type DbConfig = z.infer<typeof dbSchema>;

function readDb(prefix: string): DbConfig {
  return dbSchema.parse({
    host: process.env[`${prefix}_HOST`],
    port: process.env[`${prefix}_PORT`],
    database: process.env[`${prefix}_NAME`],
    user: process.env[`${prefix}_USER`],
    password: process.env[`${prefix}_PASSWORD`] ?? "",
  });
}

let sourceCache: DbConfig | undefined;
let appCache: (DbConfig & { schema: string }) | undefined;
let knowledgeCache: DbConfig | undefined;

/**
 * Live marketplace source (messages, orders, listings).
 * Read-only for this project — see `lib/db/pools.ts`.
 */
export function sourceDbConfig(): DbConfig {
  sourceCache ??= readDb("SOURCE_DB");
  return sourceCache;
}

/**
 * CST application database. Writes are confined to `APP_DB_SCHEMA` (cst_app),
 * which does not exist yet and is not created by this scaffold.
 */
export function appDbConfig(): DbConfig & { schema: string } {
  appCache ??= {
    ...readDb("APP_DB"),
    schema: z.string().min(1).default("cst_app").parse(process.env.APP_DB_SCHEMA),
  };
  return appCache;
}

/**
 * CST rule snapshot. Read-only, and optional until the knowledge-authority
 * review completes — callers must handle `undefined`.
 */
export function knowledgeDbConfig(): DbConfig | undefined {
  if (!process.env.KNOWLEDGE_DB_HOST) return undefined;
  knowledgeCache ??= readDb("KNOWLEDGE_DB");
  return knowledgeCache;
}

/** Test seam: clears memoised config so a test can vary process.env. */
export function resetConfigCacheForTests(): void {
  sourceCache = undefined;
  appCache = undefined;
  knowledgeCache = undefined;
}
