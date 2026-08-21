import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DRAFT_PROVIDER_VAR, draftProviderStatus, getDraftProvider } from "@/lib/ai/draft-service";

/**
 * Which provider answers, and why.
 *
 * The point of the provider layer is that the route never names a vendor, so
 * these tests pin the SELECTION rather than any vendor's behaviour. No network
 * call is made and no key is contacted — the fake keys below are synthetic
 * strings, and selection is decided entirely from the environment.
 */

const FAKE_OPENAI = "test-openai-key-not-a-real-credential";
const FAKE_GEMINI = "test-gemini-key-not-a-real-credential";

const VARS = [
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_VECTOR_STORE_ID",
  "GEMINI_API_KEY",
  "GOOGLE_AI_API_KEY",
  "GEMINI_MODEL",
  DRAFT_PROVIDER_VAR,
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
  for (const name of VARS) delete process.env[name];
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("choosing a provider", () => {
  it("reports nothing configured when no key is set", () => {
    expect(getDraftProvider()).toBeUndefined();
    const status = draftProviderStatus();
    expect(status.configured).toBe(false);
    if (status.configured) throw new Error("unreachable");
    // The message must name what to set, not merely say it is missing.
    expect(status.reason).toMatch(/OPENAI_API_KEY/);
    expect(status.reason).toMatch(/GEMINI_API_KEY/);
    expect(status.reason).toMatch(/NEXT_PUBLIC_/);
  });

  it("prefers OpenAI when both are configured", () => {
    process.env.OPENAI_API_KEY = FAKE_OPENAI;
    process.env.GEMINI_API_KEY = FAKE_GEMINI;
    expect(getDraftProvider()?.name).toBe("openai");
  });

  it("falls back to Gemini when only Gemini is configured", () => {
    process.env.GEMINI_API_KEY = FAKE_GEMINI;
    expect(getDraftProvider()?.name).toBe("gemini");
  });

  /**
   * An explicit override beats inference. Someone comparing the two providers,
   * or rolling a migration back, must not have to unset a credential to change
   * which one runs.
   */
  it("honours an explicit DRAFT_PROVIDER over the preference order", () => {
    process.env.OPENAI_API_KEY = FAKE_OPENAI;
    process.env.GEMINI_API_KEY = FAKE_GEMINI;
    process.env[DRAFT_PROVIDER_VAR] = "gemini";
    expect(getDraftProvider()?.name).toBe("gemini");
  });

  /**
   * A forced provider that is not configured returns nothing rather than
   * quietly running the other one. Silently answering with a model the operator
   * did not choose is how a comparison produces numbers for the wrong thing.
   */
  it("does not silently substitute when the forced provider is unconfigured", () => {
    process.env.GEMINI_API_KEY = FAKE_GEMINI;
    process.env[DRAFT_PROVIDER_VAR] = "openai";
    expect(getDraftProvider()).toBeUndefined();
  });

  it("ignores an unrecognised DRAFT_PROVIDER rather than failing", () => {
    process.env.OPENAI_API_KEY = FAKE_OPENAI;
    process.env[DRAFT_PROVIDER_VAR] = "anthropic";
    expect(getDraftProvider()?.name).toBe("openai");
  });

  it("never exposes a key through the status", () => {
    process.env.OPENAI_API_KEY = FAKE_OPENAI;
    const status = draftProviderStatus();
    expect(JSON.stringify(status)).not.toContain(FAKE_OPENAI);
    if (!status.configured) throw new Error("expected configured");
    expect(status.provider).toBe("openai");
    expect(status.model).toBe("gpt-4.1");
  });

  it("takes a model override from the environment", () => {
    process.env.OPENAI_API_KEY = FAKE_OPENAI;
    process.env.OPENAI_MODEL = "gpt-5";
    expect(getDraftProvider()?.model).toBe("gpt-5");
  });

  it("picks up a rotated key with no cache to clear", () => {
    process.env.OPENAI_API_KEY = FAKE_OPENAI;
    expect(getDraftProvider()?.name).toBe("openai");

    delete process.env.OPENAI_API_KEY;
    expect(getDraftProvider()).toBeUndefined();
  });
});
