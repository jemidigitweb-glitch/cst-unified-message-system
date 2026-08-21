import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GeminiNotConfigured,
  geminiStatus,
  getDraftModelClient,
  requireDraftModelClient,
} from "@/lib/ai/gemini-client";
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_API_KEY_VAR,
  geminiConfig,
  resetConfigCacheForTests,
} from "@/lib/config/env";

/**
 * Gemini API key configuration.
 *
 * Covers the three things that can go wrong with a credential read from the
 * environment: it is absent, it is present but junk, or it is fine but leaks.
 * No key is ever contacted — every assertion here is about configuration, and
 * nothing in this file makes a network call.
 *
 * The fake key is a synthetic string, not a real credential.
 */

const FAKE_KEY = "test-key-not-a-real-credential";

const GEMINI_VARS = ["GEMINI_API_KEY", "GOOGLE_AI_API_KEY", "GEMINI_MODEL"] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(GEMINI_VARS.map((name) => [name, process.env[name]]));
  for (const name of GEMINI_VARS) delete process.env[name];
  resetConfigCacheForTests();
});

afterEach(() => {
  for (const name of GEMINI_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetConfigCacheForTests();
});

describe("gemini configuration", () => {
  it("reports unconfigured when no key is set", () => {
    const status = geminiStatus();
    expect(status.configured).toBe(false);
    expect(status.configured === false && status.reason).toContain(GEMINI_API_KEY_VAR);
  });

  it("does not throw at import or read time when unconfigured", () => {
    // The application must start without a key: everything except draft
    // generation works, so an absent key degrades one feature, not the process.
    expect(() => geminiConfig()).not.toThrow();
    expect(geminiConfig()).toBeUndefined();
    expect(getDraftModelClient()).toBeUndefined();
  });

  it("gives a clear, actionable error when a caller requires the client", () => {
    expect(() => requireDraftModelClient()).toThrow(GeminiNotConfigured);
    try {
      requireDraftModelClient();
      expect.unreachable("should have thrown");
    } catch (cause) {
      const message = (cause as Error).message;
      // Names the variable to set and where the template documents it.
      expect(message).toContain(GEMINI_API_KEY_VAR);
      expect(message).toContain(".env.example");
      expect(message).toContain("NEXT_PUBLIC_");
    }
  });

  it("treats a blank or whitespace-only key as unconfigured", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      resetConfigCacheForTests();
      process.env.GEMINI_API_KEY = blank;
      expect(geminiConfig()).toBeUndefined();
      expect(geminiStatus().configured).toBe(false);
    }
  });

  it("rejects the .env.example placeholder rather than sending it to Google", () => {
    process.env.GEMINI_API_KEY = "<gemini-api-key>";
    const status = geminiStatus();
    expect(status.configured).toBe(false);
    expect(status.configured === false && status.reason).toContain("placeholder");
    expect(() => geminiConfig()).toThrow(GEMINI_API_KEY_VAR);
  });

  it("initialises the client when a key is present", () => {
    process.env.GEMINI_API_KEY = FAKE_KEY;

    const status = geminiStatus();
    expect(status).toEqual({ configured: true, model: DEFAULT_GEMINI_MODEL });

    const client = getDraftModelClient();
    expect(client).toBeDefined();
    expect(client?.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(typeof client?.generate).toBe("function");
    expect(() => requireDraftModelClient()).not.toThrow();
  });

  it("trims a key that picked up surrounding whitespace", () => {
    process.env.GEMINI_API_KEY = `  ${FAKE_KEY}  `;
    expect(geminiConfig()?.apiKey).toBe(FAKE_KEY);
  });

  it("honours GEMINI_MODEL and falls back to the default when blank", () => {
    process.env.GEMINI_API_KEY = FAKE_KEY;
    process.env.GEMINI_MODEL = "gemini-2.5-pro";
    expect(geminiConfig()?.model).toBe("gemini-2.5-pro");

    resetConfigCacheForTests();
    process.env.GEMINI_MODEL = "   ";
    expect(geminiConfig()?.model).toBe(DEFAULT_GEMINI_MODEL);
  });

  it("accepts GOOGLE_AI_API_KEY as an alias", () => {
    process.env.GOOGLE_AI_API_KEY = FAKE_KEY;
    expect(geminiStatus().configured).toBe(true);
  });

  /**
   * Rotating the key must take effect WITHOUT clearing the cache by hand.
   *
   * This is a regression test for a real incident: a new API key from a new
   * Google Cloud project was put in `.env`, the running server kept sending the
   * old one, and the 429 that followed looked exactly like a Google quota
   * problem. Nothing about the symptom pointed at a stale cache. Note the
   * absence of `resetConfigCacheForTests()` below — that absence IS the test.
   */
  it("picks up a rotated key without a manual cache reset", () => {
    process.env.GEMINI_API_KEY = FAKE_KEY;
    expect(geminiConfig()?.apiKey).toBe(FAKE_KEY);

    const rotated = `${FAKE_KEY}-rotated`;
    process.env.GEMINI_API_KEY = rotated;
    expect(geminiConfig()?.apiKey).toBe(rotated);
  });

  it("picks up a changed model without a manual cache reset", () => {
    process.env.GEMINI_API_KEY = FAKE_KEY;
    expect(geminiConfig()?.model).toBe(DEFAULT_GEMINI_MODEL);

    process.env.GEMINI_MODEL = "gemini-3.6-pro";
    expect(geminiConfig()?.model).toBe("gemini-3.6-pro");
  });

  /**
   * There must be NO cache at all, by instruction after this bit twice.
   * Reference inequality is the assertion: two calls returning the same object
   * would mean something is being held between them.
   */
  it("holds no cached config between calls", () => {
    process.env.GEMINI_API_KEY = FAKE_KEY;
    const first = geminiConfig();
    const second = geminiConfig();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it("stops reporting a key the moment it is removed", () => {
    process.env.GEMINI_API_KEY = FAKE_KEY;
    expect(geminiConfig()?.apiKey).toBe(FAKE_KEY);

    delete process.env.GEMINI_API_KEY;
    expect(geminiConfig()).toBeUndefined();
  });
});

describe("gemini key confinement", () => {
  it("never exposes the key through the status or the client", () => {
    process.env.GEMINI_API_KEY = FAKE_KEY;

    const status = geminiStatus();
    expect(JSON.stringify(status)).not.toContain(FAKE_KEY);

    const client = getDraftModelClient();
    // The key is captured in the closure that signs the request and is not a
    // property of anything a caller can read or serialise.
    expect(JSON.stringify(Object.keys(client ?? {}))).not.toContain("apiKey");
    expect(JSON.stringify(client)).not.toContain(FAKE_KEY);
  });

  it("marks every module that can read the key as server-only", () => {
    const root = join(__dirname, "..", "..");
    for (const relative of ["lib/config/env.ts", "lib/ai/gemini-client.ts"]) {
      const source = readFileSync(join(root, relative), "utf8");
      expect(source, `${relative} must be server-only`).toContain('import "server-only"');
    }
  });

  it("defines no NEXT_PUBLIC_ Gemini variable anywhere in tracked files", () => {
    const root = join(__dirname, "..", "..");
    const tracked = execSync("git ls-files", { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "" && /\.(ts|tsx|mjs|mts|json|md|example)$/.test(line));

    const offenders = tracked.filter((relative) => {
      try {
        return /NEXT_PUBLIC_[A-Z_]*(GEMINI|GOOGLE_AI)/.test(readFileSync(join(root, relative), "utf8"));
      } catch {
        return false;
      }
    });
    expect(offenders).toEqual([]);
  });

  it("reads the key only from lib/config/env.ts", () => {
    const root = join(__dirname, "..", "..");
    const tracked = execSync("git ls-files", { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .filter((line) => /\.(ts|tsx)$/.test(line));

    // A second reader is a second place the key can escape. Config is the one
    // door; this test file references the names only to set them for a case.
    const allowed = new Set(["lib/config/env.ts", "tests/ai/gemini-config.test.ts"]);
    const offenders = tracked.filter((relative) => {
      if (allowed.has(relative)) return false;
      try {
        const source = readFileSync(join(root, relative), "utf8");
        return /process\.env\.(GEMINI_API_KEY|GOOGLE_AI_API_KEY)/.test(source);
      } catch {
        return false;
      }
    });
    expect(offenders).toEqual([]);
  });
});
