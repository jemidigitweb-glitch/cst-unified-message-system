import "server-only";

import { GEMINI_API_KEY_VAR, geminiConfig } from "@/lib/config/env";

import type { DraftModelClient } from "./draft-generator";

/**
 * Gemini client for draft generation.
 *
 * SERVER-ONLY. `server-only` makes importing this from a client component a
 * build error, which keeps the API key out of the browser bundle. The key is
 * read from the environment and never returned, logged or serialised.
 *
 * Hand-rolled over `fetch` rather than pulling in the SDK: this calls one
 * endpoint with one request shape, and a dependency that can reach the network
 * should earn its place. It also keeps the surface small enough to see that
 * nothing here can contact a customer — the only host it talks to is Google's
 * API, and the only thing it returns is text.
 */

const GENERATE_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const REQUEST_TIMEOUT_MS = 60_000;

export class GeminiUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiUnavailable";
  }
}

/**
 * Raised when Gemini has not been configured at all.
 *
 * Distinct from `GeminiUnavailable`, which means "configured, but the call
 * failed" — an operator fixes those two in completely different places, so the
 * error says which one it is and names the variable to set.
 */
export class GeminiNotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiNotConfigured";
  }
}

/**
 * Whether Gemini is configured, and with which model.
 *
 * Deliberately carries no key and no way to derive one: this is the shape that
 * is safe for a route handler to report or a log line to record. Callers that
 * need to actually make a call use `requireDraftModelClient` instead.
 */
export type GeminiStatus =
  | { readonly configured: true; readonly model: string }
  | { readonly configured: false; readonly reason: string };

const NOT_CONFIGURED_REASON =
  `Gemini is not configured: set ${GEMINI_API_KEY_VAR} in the server environment ` +
  `(see .env.example). It is server-side only and must never be prefixed with NEXT_PUBLIC_.`;

/**
 * Verifies configuration without opening a connection or spending a token.
 *
 * A startup check or health route can call this; a misconfigured key surfaces
 * here rather than as a confusing provider error on the first real draft.
 */
export function geminiStatus(): GeminiStatus {
  let config: ReturnType<typeof geminiConfig>;
  try {
    config = geminiConfig();
  } catch (cause) {
    // Thrown when the variable is present but unusable (blank, placeholder).
    // The message names the variable, never the value.
    return { configured: false, reason: (cause as Error).message };
  }
  return config
    ? { configured: true, model: config.model }
    : { configured: false, reason: NOT_CONFIGURED_REASON };
}

type GeminiPayload = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
};

/** Pulls the model text out of a response, failing loudly if there is none. */
function textOf(payload: GeminiPayload): string {
  if (payload.promptFeedback?.blockReason) {
    throw new GeminiUnavailable("The draft service declined to answer this conversation.");
  }
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((part) => part.text ?? "").join("").trim();
  if (text === "") throw new GeminiUnavailable("The draft service returned no content.");
  return text;
}

/**
 * Turns a provider HTTP status into something a reviewer can act on.
 *
 * "The draft service rejected the request" is true of a quota exhaustion, a bad
 * API key and a malformed payload alike, and tells whoever reads it none of the
 * three. These are genuinely different situations — one is wait, one is fix
 * your key, one is a bug — so they get different sentences.
 *
 * The provider's own text is never returned: it can quote the request, and the
 * request contains customer messages. Only the retry delay is lifted out of it,
 * because that is the one part a reviewer can use and it names no one.
 */
export function describeFailure(status: number, providerMessage?: string): string {
  if (status === 429) {
    const seconds = /retry in (\d+)/i.exec(providerMessage ?? "")?.[1];
    return seconds
      ? `The draft service has reached its usage limit. Try again in about ${seconds} seconds.`
      : "The draft service has reached its usage limit. Try again shortly.";
  }
  if (status === 401 || status === 403) {
    return "The draft service refused the API key. Check GEMINI_API_KEY on the server.";
  }
  if (status === 404) {
    return "The configured model is not available. Check GEMINI_MODEL on the server.";
  }
  if (status >= 500) {
    return "The draft service is temporarily unavailable. Try again shortly.";
  }
  return "The draft service rejected the request.";
}

/**
 * Translates a JSON Schema into the subset Gemini's `responseSchema` accepts.
 *
 * Gemini takes an OpenAPI-3-flavoured schema, not JSON Schema, and rejects the
 * whole request when handed the difference. Two of them bite here:
 *
 *   additionalProperties   not a field it knows; "Cannot find field".
 *   type: ["string","null"]  it wants one type plus `nullable: true`.
 *
 * The translation lives here rather than in `lib/domain/draft.ts` on purpose.
 * The draft shape is a domain fact; which dialect a particular provider wants
 * is not, and baking Gemini's quirks into the domain would make swapping or
 * adding a provider a change to the domain model.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== "object") return schema;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "additionalProperties") continue;

    if (key === "type" && Array.isArray(value)) {
      const types = value.filter((entry) => entry !== "null");
      if (value.includes("null")) out.nullable = true;
      out.type = types[0] ?? "string";
      continue;
    }

    out[key] = toGeminiSchema(value);
  }
  return out;
}

/**
 * The configured client, or undefined when no API key is set.
 *
 * Structured output is requested through `responseMimeType` +
 * `responseSchema`, so the model is constrained to the draft shape rather than
 * being asked politely for JSON and trusted to comply.
 */
export function getDraftModelClient(): DraftModelClient | undefined {
  const status = geminiStatus();
  if (!status.configured) return undefined;
  const config = geminiConfig();
  if (!config) return undefined;

  return {
    model: config.model,
    generate: async ({ instructions, input, responseSchema }) => {
      // Re-read at REQUEST time, not at client-construction time. Capturing
      // `config` in this closure would put a credential inside a long-lived
      // object, which is the same staleness bug the config memo used to cause,
      // just moved one layer out — a client built before a key change would go
      // on sending the old key for as long as anything held a reference to it.
      const live = geminiConfig();
      if (!live) throw new GeminiNotConfigured(NOT_CONFIGURED_REASON);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(
          `${GENERATE_ENDPOINT}/${encodeURIComponent(live.model)}:generateContent`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": live.apiKey,
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: instructions }] },
              contents: [{ role: "user", parts: [{ text: input }] }],
              generationConfig: {
                responseMimeType: "application/json",
                responseSchema: toGeminiSchema(responseSchema),
                // Low temperature: this is policy-bound drafting, not writing.
                temperature: 0.2,
              },
            }),
            signal: controller.signal,
          },
        );

        const payload = (await response.json()) as GeminiPayload;
        if (!response.ok) {
          // The provider's message may quote the request, which contains
          // customer text. Logged server-side, never returned to the browser.
          console.error(
            `[draft] gemini returned ${response.status}`,
            payload.error?.message,
          );
          throw new GeminiUnavailable(describeFailure(response.status, payload.error?.message));
        }
        return { text: textOf(payload) };
      } catch (cause) {
        if (cause instanceof GeminiUnavailable) throw cause;
        // A key removed between constructing the client and using it is a
        // configuration problem, not an outage. Relabelling it "unavailable"
        // would send whoever reads it looking at Google.
        if (cause instanceof GeminiNotConfigured) throw cause;
        console.error("[draft] gemini call failed", cause);
        throw new GeminiUnavailable("The draft service is unavailable.");
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/**
 * The client, or a clear configuration error.
 *
 * For callers that cannot do anything useful unconfigured and would otherwise
 * have to invent their own message. `getDraftModelClient` stays for the route
 * handler, which turns the undefined into a 503 of its own wording.
 */
export function requireDraftModelClient(): DraftModelClient {
  const client = getDraftModelClient();
  if (client === undefined) {
    const status = geminiStatus();
    throw new GeminiNotConfigured(
      status.configured ? NOT_CONFIGURED_REASON : status.reason,
    );
  }
  return client;
}
