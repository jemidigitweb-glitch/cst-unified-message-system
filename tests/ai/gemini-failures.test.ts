import { describe, expect, it } from "vitest";

import { describeFailure, toGeminiSchema } from "@/lib/ai/gemini-client";
import { DRAFT_RESULT_JSON_SCHEMA } from "@/lib/domain/draft";

/**
 * The two provider-shaped things that broke Generate Reply, pinned so they
 * cannot break again quietly.
 */

describe("the response schema Gemini is actually sent", () => {
  const converted = toGeminiSchema(DRAFT_RESULT_JSON_SCHEMA) as Record<string, unknown>;

  it("carries no additionalProperties at any depth", () => {
    // Gemini answers 400 "Cannot find field" for this, which used to surface as
    // the generic "Unable to generate a draft".
    expect(JSON.stringify(converted)).not.toContain("additionalProperties");
  });

  it("expresses a nullable field as one type plus nullable", () => {
    const sources = (converted.properties as Record<string, Record<string, unknown>>).sources_used;
    const items = sources.items as Record<string, Record<string, Record<string, unknown>>>;
    const label = items.properties.label;
    expect(label.type).toBe("string");
    expect(label.nullable).toBe(true);
  });

  it("has no union type left anywhere", () => {
    const types: unknown[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "type") types.push(value);
        else walk(value);
      }
    };
    walk(converted);
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) expect(typeof type).toBe("string");
  });

  it("keeps the parts of the schema that constrain the model", () => {
    expect(converted.required).toEqual(DRAFT_RESULT_JSON_SCHEMA.required);
    const properties = converted.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual(Object.keys(DRAFT_RESULT_JSON_SCHEMA.properties));
    expect(properties.draft_reply!.description).toBeTypeOf("string");
  });
});

describe("what a failure tells the person looking at it", () => {
  it("names a quota problem as one, with the wait", () => {
    const message = describeFailure(
      429,
      "You exceeded your current quota... Please retry in 30.03s.",
    );
    expect(message).toMatch(/usage limit/i);
    expect(message).toContain("30");
  });

  it("still says something useful when the wait is not given", () => {
    expect(describeFailure(429)).toMatch(/usage limit/i);
  });

  it("distinguishes a bad key from a bad model from an outage", () => {
    expect(describeFailure(403)).toMatch(/GEMINI_API_KEY/);
    expect(describeFailure(404)).toMatch(/GEMINI_MODEL/);
    expect(describeFailure(503)).toMatch(/temporarily unavailable/i);
    expect(describeFailure(400)).toMatch(/rejected the request/i);
  });

  it("never repeats the provider's own text back to the browser", () => {
    // The provider echoes the request, and the request holds customer messages.
    const leaky = "Invalid value at contents[0]: 'my order 12-34567-89012 is late'";
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      expect(describeFailure(status, leaky)).not.toContain("12-34567-89012");
      expect(describeFailure(status, leaky)).not.toContain("my order");
    }
  });
});
