import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TIER_MODEL_VARS } from "@/lib/ai/model-selection";
import { getOpenAiProvider } from "@/lib/ai/openai-client";
import type { DraftRequest } from "@/lib/ai/provider";
import type { ConversationMessageView } from "@/lib/domain/inbox";

/**
 * Routing a draft to a model by how hard the conversation is.
 *
 * THE CLAIM THIS FILE EXISTS TO PROVE. Changing the model must change the model
 * and NOTHING ELSE. A cheaper model is only defensible if it is answering the
 * identical question from the identical evidence — same CST retrieval, same
 * verified facts, same instructions, same structured output, same review rules.
 * If routing quietly shipped a thinner request to the cheap tier, every
 * comparison of the two would be measuring the request rather than the model,
 * and a regression would look like "the small model is worse" forever.
 *
 * So the central tests here capture the actual HTTP bodies the provider builds
 * for the same conversation under different tier configuration and assert they
 * are byte-identical once `model` is removed. Not "similar" — equal.
 *
 * No network: `fetch` is stubbed and the body it is handed is the assertion.
 * No model names: tiers are configured to opaque ids, because which model
 * serves a tier is deployment configuration, not a fact about this code.
 */

const ENV_KEYS = [...Object.values(TIER_MODEL_VARS), "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_VECTOR_STORE_ID"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // A syntactically valid key that reaches nothing: `fetch` is stubbed below.
  process.env.OPENAI_API_KEY = `sk-${"t".repeat(32)}`;
  process.env.OPENAI_VECTOR_STORE_ID = "vs_test_store";
  process.env.OPENAI_MODEL = "fallback-model";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});

function message(overrides: Partial<ConversationMessageView> = {}): ConversationMessageView {
  return {
    id: "1",
    direction: "inbound",
    sourceTimestamp: "2026-08-01 09:00:00",
    bodyText: "Has my parcel shipped?",
    bodyDecodeStatus: "decoded",
    attachments: [],
    ...overrides,
  };
}

/** A well-formed Responses API answer, so the provider reaches the end of `generate`. */
const REPLY = JSON.stringify({
  draft_reply: "Thanks for getting in touch. Your order left us on Friday and is on its way.",
  sources_used: [{ kind: "cst_document", ref: "DEL-1", label: null }],
  missing_information: [],
  requires_review: false,
});

function okResponse(): unknown {
  return {
    ok: true,
    json: async () => ({
      output: [{ type: "message", content: [{ type: "output_text", text: REPLY }] }],
      usage: { input_tokens: 1_000, output_tokens: 50, total_tokens: 1_050 },
    }),
  };
}

/** Stubs `fetch` and hands back every request body the provider sent. */
function captureBodies(): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return okResponse();
  });
  return { bodies };
}

/** A one-line delivery question: nothing substantive, so the lightest tier. */
const SIMPLE: DraftRequest = {
  messages: [message()],
  marketplace: "ebay",
  listingItemRef: "123456789012",
  facts: [
    { name: "order_number", value: "12-34567-89012" },
    { name: "order_status", value: "Dispatched" },
  ],
};

/** The same conversation, escalated by wording alone. */
const COMPLEX: DraftRequest = {
  ...SIMPLE,
  messages: [message({ bodyText: "The bulb caught fire and burnt the fitting." })],
};

describe("the request is identical whichever model is chosen", () => {
  /**
   * The load-bearing test. Same conversation, two different models, and the
   * only permitted difference between the two HTTP bodies is `model`.
   */
  it("sends the same facts, sources, instructions and schema to every tier", async () => {
    const { bodies } = captureBodies();

    process.env[TIER_MODEL_VARS.simple] = "light-model";
    await getOpenAiProvider()!.generate(SIMPLE);

    delete process.env[TIER_MODEL_VARS.simple];
    process.env[TIER_MODEL_VARS.complex] = "strong-model";
    await getOpenAiProvider()!.generate(SIMPLE);

    expect(bodies).toHaveLength(2);
    const [light, strong] = bodies;

    // The models really did differ, or the comparison below proves nothing.
    expect(light!.model).toBe("light-model");
    expect(strong!.model).toBe("strong-model");

    const withoutModel = (body: Record<string, unknown>): Record<string, unknown> => {
      const rest = { ...body };
      delete rest.model;
      return rest;
    };
    expect(withoutModel(light!)).toEqual(withoutModel(strong!));
  });

  /**
   * Spelled out field by field as well as compared wholesale. The deep-equal
   * above would catch any of these, but a failure there says only "not equal";
   * these say which guarantee broke.
   */
  it("gives the cheap tier the same CST retrieval as the strongest", async () => {
    const { bodies } = captureBodies();

    process.env[TIER_MODEL_VARS.simple] = "light-model";
    await getOpenAiProvider()!.generate(SIMPLE);
    const light = bodies[0]!;

    process.env[TIER_MODEL_VARS.simple] = "strong-model";
    await getOpenAiProvider()!.generate(SIMPLE);
    const strong = bodies[1]!;

    expect(light.tools).toEqual(strong.tools);
    expect(light.tools).toEqual([
      { type: "file_search", vector_store_ids: ["vs_test_store"], max_num_results: 20 },
    ]);
    expect(light.instructions).toEqual(strong.instructions);
    expect(light.text).toEqual(strong.text);
    expect(light.max_output_tokens).toEqual(strong.max_output_tokens);
  });

  it("puts the verified facts in front of every tier alike", async () => {
    const { bodies } = captureBodies();

    process.env[TIER_MODEL_VARS.simple] = "light-model";
    await getOpenAiProvider()!.generate(SIMPLE);
    process.env[TIER_MODEL_VARS.simple] = "strong-model";
    await getOpenAiProvider()!.generate(SIMPLE);

    expect(bodies[0]!.input).toEqual(bodies[1]!.input);
    // Not merely equal to each other — actually carrying the facts.
    expect(String(bodies[0]!.input)).toContain("12-34567-89012");
    expect(String(bodies[0]!.input)).toContain("Dispatched");
  });

  /**
   * A complex conversation and a simple one differ in their INPUT, obviously.
   * What must not differ is everything around it.
   */
  it("keeps instructions, retrieval and schema constant across complexity too", async () => {
    const { bodies } = captureBodies();
    process.env[TIER_MODEL_VARS.simple] = "light-model";
    process.env[TIER_MODEL_VARS.complex] = "strong-model";

    await getOpenAiProvider()!.generate(SIMPLE);
    await getOpenAiProvider()!.generate(COMPLEX);

    expect(bodies[0]!.model).toBe("light-model");
    expect(bodies[1]!.model).toBe("strong-model");
    expect(bodies[0]!.tools).toEqual(bodies[1]!.tools);
    expect(bodies[0]!.instructions).toEqual(bodies[1]!.instructions);
    expect(bodies[0]!.text).toEqual(bodies[1]!.text);
  });
});

describe("which model the tier resolves to", () => {
  it("routes a light conversation to the light model", async () => {
    const { bodies } = captureBodies();
    process.env[TIER_MODEL_VARS.simple] = "light-model";
    process.env[TIER_MODEL_VARS.standard] = "mid-model";
    process.env[TIER_MODEL_VARS.complex] = "strong-model";

    await getOpenAiProvider()!.generate(SIMPLE);
    expect(bodies[0]!.model).toBe("light-model");
  });

  it("routes a mid-weight conversation to the mid model", async () => {
    const { bodies } = captureBodies();
    process.env[TIER_MODEL_VARS.simple] = "light-model";
    process.env[TIER_MODEL_VARS.standard] = "mid-model";
    process.env[TIER_MODEL_VARS.complex] = "strong-model";

    await getOpenAiProvider()!.generate({
      ...SIMPLE,
      messages: [
        message({ id: "1", bodyText: "Where is my order?" }),
        message({ id: "2", direction: "outbound", bodyText: "Let me check." }),
        message({ id: "3", bodyText: "Tracking has not moved and I now want a refund." }),
      ],
    });
    expect(bodies[0]!.model).toBe("mid-model");
  });

  it("routes a high-risk conversation to the strongest model", async () => {
    const { bodies } = captureBodies();
    process.env[TIER_MODEL_VARS.simple] = "light-model";
    process.env[TIER_MODEL_VARS.standard] = "mid-model";
    process.env[TIER_MODEL_VARS.complex] = "strong-model";

    await getOpenAiProvider()!.generate(COMPLEX);
    expect(bodies[0]!.model).toBe("strong-model");
  });

  it("falls back to OPENAI_MODEL when no tier is configured, as before tiering", async () => {
    const { bodies } = captureBodies();
    await getOpenAiProvider()!.generate(SIMPLE);
    expect(bodies[0]!.model).toBe("fallback-model");
  });
});

