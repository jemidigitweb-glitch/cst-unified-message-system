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

/**
 * Gemini access for draft generation.
 *
 * Server-side only, like every other credential here — the key must never be
 * prefixed with NEXT_PUBLIC_ and never reach the browser. Returns undefined
 * when unconfigured, so callers report that plainly instead of generating an
 * ungrounded draft.
 *
 * The CST rules sheet is configured separately (see `lib/knowledge/`): holding
 * an API key does not imply having the rule corpus, and the two degrade
 * differently.
 */
export type GeminiConfig = {
  readonly apiKey: string;
  readonly model: string;
};

/**
 * Default model.
 *
 * `gemini-2.5-flash` is closed to new API keys — the endpoint answers a
 * `models.get` for it but refuses `generateContent`, so a key can look valid
 * and still fail on the first real draft. Override with GEMINI_MODEL.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

/** The variable that is actually read, named once so errors can quote it. */
export const GEMINI_API_KEY_VAR = "GEMINI_API_KEY";

/**
 * A key that is present but unusable is a configuration mistake, not a value.
 *
 * Whitespace and the template's own placeholder both survive a naive
 * `if (!key)` check and would be sent to Google as a credential, producing a
 * 4xx that reads like an outage. They are rejected here instead, where the
 * cause is obvious.
 */
const apiKeySchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/^<.*>$/.test(value), {
    message: "still set to the .env.example placeholder",
  });

/**
 * NOT CACHED. Read from `process.env` on every call, deliberately.
 *
 * There is no memo here and one must not be added back. Two earlier versions
 * cached. The first cached forever, so a new API key in `.env` was ignored and
 * the stale key’s 429 read as a Google quota problem — the one cause it could
 * not have been. The second keyed the cache on the value, which fixed that but
 * still kept a credential sitting in module scope.
 *
 * What a cache buys here is one small zod parse per draft, on a request that
 * ships ~137,000 tokens over the network. It is not measurable. What it costs
 * is the ability to know which key is in flight, and that turned out to be
 * expensive twice.
 *
 * The object returned is built fresh each call and callers must not hold it —
 * see `getDraftModelClient`, which re-reads at request time.
 */
export function geminiConfig(): GeminiConfig | undefined {
  const raw = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY;
  if (raw === undefined || raw.trim() === "") return undefined;

  const parsed = apiKeySchema.safeParse(raw);
  if (!parsed.success) {
    // The message quotes the variable name, never the value.
    throw new Error(
      `${GEMINI_API_KEY_VAR} is set but not usable: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
    );
  }

  return {
    apiKey: parsed.data,
    model: process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
  };
}

export type OpenAiConfig = {
  readonly apiKey: string;
  readonly model: string;
  /**
   * The vector store holding the approved CST knowledge files.
   *
   * OPTIONAL, and the distinction matters. Without it the provider still runs,
   * but with no `file_search` tool — so the model has NO CST knowledge and can
   * state no policy. That is a real, reportable state, not a failure to hide:
   * `knowledgeSearchEnabled` on the outcome says which of the two happened.
   */
  readonly vectorStoreId: string | undefined;
};

/** Default model. Needs a large context and strict structured output. */
export const DEFAULT_OPENAI_MODEL = "gpt-4.1";

export const OPENAI_API_KEY_VAR = "OPENAI_API_KEY";
export const OPENAI_VECTOR_STORE_VAR = "OPENAI_VECTOR_STORE_ID";

/**
 * OpenAI configuration. NOT CACHED, for the same reason as `geminiConfig`.
 *
 * A rotated key must take effect on the next request, not the next restart. A
 * memo here cost two debugging sessions on the Gemini side, where a stale key's
 * 429 read as a provider quota problem.
 */
export function openAiConfig(): OpenAiConfig | undefined {
  const raw = process.env.OPENAI_API_KEY;
  if (raw === undefined || raw.trim() === "") return undefined;

  const parsed = apiKeySchema.safeParse(raw);
  if (!parsed.success) {
    // The message quotes the variable name, never the value.
    throw new Error(
      `${OPENAI_API_KEY_VAR} is set but not usable: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
    );
  }

  const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID?.trim();

  return {
    apiKey: parsed.data,
    model: process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
    vectorStoreId: vectorStoreId === "" ? undefined : vectorStoreId,
  };
}

/**
 * Test seam: clears memoised DATABASE config so a test can vary process.env.
 *
 * There is deliberately no Gemini or OpenAI entry: neither is ever cached.
 */
export function resetConfigCacheForTests(): void {
  sourceCache = undefined;
  appCache = undefined;
  knowledgeCache = undefined;
}
