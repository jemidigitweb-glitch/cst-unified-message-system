import "server-only";

import { OPENAI_API_KEY_VAR, OPENAI_VECTOR_STORE_VAR, openAiConfig } from "@/lib/config/env";
import { DRAFT_RESULT_JSON_SCHEMA } from "@/lib/domain/draft";

import { buildDraftInput, validateDraft } from "./draft-assembly";
import { cstInstructions, restrictedInstructions } from "./instructions";
import {
  type DraftOutcome,
  type DraftProvider,
  type DraftRequest,
  DraftServiceNotConfigured,
  DraftServiceUnavailable,
  describeFailure,
} from "./provider";

/**
 * OpenAI draft provider: Responses API + File Search over a vector store.
 *
 * SERVER-ONLY. `server-only` makes importing this from a client component a
 * build error, which keeps the API key out of the browser bundle.
 *
 * THE POINT OF THIS PROVIDER. The CST knowledge no longer travels with the
 * request. It lives in an OpenAI vector store, and `file_search` pulls the
 * relevant part per conversation — roughly the ChatGPT Project the team already
 * uses. The Gemini path sends ~127,000 tokens of rules on every single draft,
 * which capped throughput at about one draft a minute and made the corpus the
 * dominant cost of every request.
 *
 * WHAT IS TRADED. Retrieval chooses a subset before the model reasons, so a
 * relevant rule can be missed in a way that sending everything cannot. That is
 * a real regression in worst-case coverage and it is why `knowledgeAvailable`
 * and the citation trail are reported rather than assumed — a draft that cites
 * nothing is visible, not silent.
 *
 * NO SDK. One endpoint, one request shape. A dependency that can reach the
 * network should earn its place, and keeping the surface small makes it
 * checkable that nothing here can contact a customer: the only host it talks to
 * is OpenAI, and the only thing it returns is text.
 */

const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

/** File Search can take several turns; the corpus is large and the model reads. */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * How many chunks File Search may return.
 *
 * Higher than a default of 5 on purpose. A CST case is routinely several rule
 * areas at once — damage AND evidence AND refund AND escalation — and the
 * instruction explicitly tells the model to combine them. Retrieving too few
 * would make that instruction impossible to follow, and the failure would look
 * like a reasoning problem rather than a retrieval budget.
 */
const MAX_SEARCH_RESULTS = 20;

/**
 * Hard ceiling on what one draft may generate.
 *
 * A customer reply is a few hundred words. This is far above that on purpose —
 * it is a runaway guard, not a length target, and clipping a legitimate reply
 * to save tokens would be a worse failure than the one it prevents. Reasoning
 * models also spend part of this budget on thinking before any visible text, so
 * a tight bound would truncate the reply rather than the reasoning.
 *
 * When it IS hit the response comes back incomplete, and `textOf` reports that
 * specifically rather than as an empty answer.
 */
const MAX_OUTPUT_TOKENS = 4_000;

type ResponsesPayload = {
  output?: {
    type?: string;
    content?: {
      type?: string;
      text?: string;
      annotations?: { type?: string; filename?: string; file_id?: string }[];
    }[];
    // file_search_call items carry queries when `include` asks for them.
    queries?: string[];
  }[];
  incomplete_details?: { reason?: string };
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error?: { message?: string };
};

/** The assistant's final text, failing loudly rather than returning "". */
function textOf(payload: ResponsesPayload): string {
  const parts: string[] = [];
  for (const item of payload.output ?? []) {
    if (item.type !== "message") continue;
    for (const chunk of item.content ?? []) {
      if (chunk.type === "output_text" && typeof chunk.text === "string") parts.push(chunk.text);
    }
  }
  const text = parts.join("").trim();
  if (text === "") {
    const reason = payload.incomplete_details?.reason;
    throw new DraftServiceUnavailable(
      reason === "max_output_tokens"
        ? "The draft service ran out of room before finishing the reply."
        : "The draft service returned no content.",
    );
  }
  return text;
}

/** Which knowledge documents File Search actually cited, for the record. */
function citedFiles(payload: ResponsesPayload): string[] {
  const files = new Set<string>();
  for (const item of payload.output ?? []) {
    for (const chunk of item.content ?? []) {
      for (const annotation of chunk.annotations ?? []) {
        if (annotation.type === "file_citation" && annotation.filename) {
          files.add(annotation.filename);
        }
      }
    }
  }
  return [...files];
}

/**
 * The provider, or undefined when OPENAI_API_KEY is not set.
 *
 * Config is re-read inside `generate` rather than captured here: holding a
 * credential in a long-lived closure is the staleness bug that cost two
 * debugging sessions on the Gemini side, where a rotated key kept being ignored
 * and the resulting 429 read as a provider quota problem.
 */
export function getOpenAiProvider(): DraftProvider | undefined {
  const configured = openAiConfig();
  if (configured === undefined) return undefined;

  return {
    name: "openai",
    model: configured.model,

    async generate(request: DraftRequest): Promise<DraftOutcome> {
      const config = openAiConfig();
      if (config === undefined) {
        throw new DraftServiceNotConfigured(
          `OpenAI is not configured: set ${OPENAI_API_KEY_VAR} in the server environment.`,
        );
      }
      if (request.messages.length === 0) {
        throw new DraftServiceUnavailable("This conversation has no messages to reply to.");
      }

      // No vector store means no CST knowledge. The draft still happens, in
      // restricted mode, and says so — rather than the model writing policy
      // out of general knowledge of retail, which is the failure the whole
      // grounding design exists to prevent.
      const searchable = config.vectorStoreId !== undefined;
      const knowledgeReason = searchable
        ? undefined
        : `No CST knowledge base is attached: set ${OPENAI_VECTOR_STORE_VAR} in the server environment. This draft states no policy — check it before using.`;

      const body = {
        model: config.model,
        instructions: searchable
          ? cstInstructions(request.marketplace)
          : restrictedInstructions(request.marketplace),
        input: buildDraftInput(request),
        ...(searchable
          ? {
              tools: [
                {
                  type: "file_search",
                  vector_store_ids: [config.vectorStoreId],
                  max_num_results: MAX_SEARCH_RESULTS,
                },
              ],
            }
          : {}),
        text: {
          format: {
            type: "json_schema",
            name: "cst_draft_reply",
            // Passed through untouched. `DRAFT_RESULT_JSON_SCHEMA` already sets
            // `additionalProperties: false` and marks every field required,
            // which is exactly what strict mode requires — the Gemini path
            // needs a translation layer to REMOVE those.
            schema: DRAFT_RESULT_JSON_SCHEMA,
            strict: true,
          },
        },
        // Policy-bound drafting, not writing. Dropped automatically on models
        // that refuse it — see `send` below.
        temperature: 0.2,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      /** One attempt. Returns the payload, or the status to decide on. */
      const send = async (
        requestBody: Record<string, unknown>,
      ): Promise<{ ok: true; payload: ResponsesPayload } | { ok: false; status: number; message?: string }> => {
        const response = await fetch(RESPONSES_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        const parsed = (await response.json()) as ResponsesPayload;
        return response.ok
          ? { ok: true, payload: parsed }
          : { ok: false, status: response.status, message: parsed.error?.message };
      };

      let payload: ResponsesPayload;
      try {
        let attempt = await send(body);

        /**
         * Reasoning models reject sampling parameters outright:
         *   400 Unsupported parameter: 'temperature' is not supported with this model.
         *
         * Retried once WITHOUT it rather than dropping temperature for
         * everyone. On models that accept it, 0.2 is a deliberate choice for
         * policy-bound drafting; on models that do not, sampling is fixed and
         * asking for it changes nothing anyway. One narrow retry keeps both
         * families working with no per-model configuration to maintain — and
         * it is logged, so the behaviour is discoverable rather than magic.
         */
        if (!attempt.ok && attempt.status === 400 && /temperature/i.test(attempt.message ?? "")) {
          console.info(
            `[draft] ${config.model} rejects 'temperature'; retrying without it`,
          );
          const withoutTemperature: Record<string, unknown> = { ...body };
          delete withoutTemperature.temperature;
          attempt = await send(withoutTemperature);
        }

        if (!attempt.ok) {
          // The vendor's message may quote the request, and the request
          // contains customer text. Logged server-side, never returned.
          console.error(`[draft] openai returned ${attempt.status}`, attempt.message);
          throw new DraftServiceUnavailable(describeFailure(attempt.status, attempt.message));
        }
        payload = attempt.payload;
      } catch (cause) {
        if (cause instanceof DraftServiceUnavailable) throw cause;
        if (cause instanceof DraftServiceNotConfigured) throw cause;
        console.error("[draft] openai call failed", cause);
        throw new DraftServiceUnavailable("The draft service is unavailable.");
      } finally {
        clearTimeout(timeout);
      }

      // `knownRefs` is undefined: with retrieval we cannot enumerate what was
      // available, and dropping every citation we cannot pre-verify would turn
      // a grounded draft into an apparently ungrounded one. Citations are
      // resolved against the local corpus later, by the evidence endpoint.
      const validated = validateDraft(textOf(payload), request, undefined);

      const documents = citedFiles(payload);
      const missing = searchable
        ? validated.missingInformation
        : [...new Set([...validated.missingInformation, knowledgeReason!])];

      if (documents.length > 0) {
        console.info(`[draft] openai file_search cited: ${documents.join(", ")}`);
      }

      return {
        result: validated.result,
        // A draft written without the knowledge base always needs a human: it
        // was written without policy.
        requiresReview: !searchable || validated.requiresReview,
        missingInformation: missing,
        model: config.model,
        provider: "openai",
        knowledgeAvailable: searchable,
        knowledgeReason,
        usage: {
          inputTokens: payload.usage?.input_tokens ?? null,
          outputTokens: payload.usage?.output_tokens ?? null,
          totalTokens: payload.usage?.total_tokens ?? null,
        },
      };
    },
  };
}
