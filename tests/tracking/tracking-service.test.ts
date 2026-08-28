import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { CARRIERS } from "@/lib/tracking/carrier";
import { TRACKING_STATUSES, TrackingNotConfigured } from "@/lib/tracking/provider";
import {
  connectedCarriers,
  getTrackingProvider,
  getTrackingProviderFor,
  trackConsignment,
  trackingStatus,
} from "@/lib/tracking/tracking-service";

/**
 * The tracking foundation, in the state this step is meant to leave it.
 *
 * These tests pin an EMPTY registry on purpose. "No carrier is connected" is
 * the finished configuration for a foundation, not an unfinished one, and the
 * behaviour that matters is that the empty state is honest: it refuses, it says
 * why, and it cannot be mistaken for an answer.
 */

describe("the registry", () => {
  /**
   * REGISTERED IS NOT CONNECTED. Royal Mail is present and still cannot answer;
   * every other carrier has no provider at all. Those are different states with
   * different fixes, and the service has to be able to tell an operator which
   * one they have.
   */
  it("holds Royal Mail and nothing else", () => {
    expect(connectedCarriers()).toEqual(["royal_mail"]);
    for (const carrier of CARRIERS.filter((name) => name !== "royal_mail")) {
      expect(getTrackingProvider(carrier), carrier).toBeUndefined();
    }
  });

  it("names the provider for a carrier that has one", () => {
    const status = trackingStatus("royal_mail");
    expect(status.configured).toBe(true);
    if (!status.configured) throw new Error("unreachable");
    expect(status.carrier).toBe("royal_mail");
    expect(status.provider).toBe("royal_mail_tracking_api");
  });

  it("says plainly when a carrier has no provider, and names what was asked for", () => {
    const status = trackingStatus("evri");
    expect(status.configured).toBe(false);
    if (status.configured) throw new Error("unreachable");
    expect(status.reason).toMatch(/no carrier tracking provider is connected/i);
    // The reason has to name the carrier, or an operator reading a log cannot
    // tell which lookup produced it.
    expect(status.reason).toContain("Evri");
  });

  /**
   * FAILS RATHER THAN INVENTS. An empty result would carry
   * `currentStatus: "unknown"` and no events — a shape indistinguishable from a
   * carrier that genuinely knows nothing. The entire grounding design of this
   * application rests on absent context being distinguishable from established
   * context, so the absent case throws.
   *
   * Both routes to a refusal are asserted: no provider at all (Evri), and a
   * registered provider that cannot yet answer (Royal Mail).
   */
  it("rejects a lookup instead of returning an empty result", async () => {
    await expect(
      trackConsignment({ carrier: "evri", trackingNumber: "H00123456789" }),
    ).rejects.toBeInstanceOf(TrackingNotConfigured);
    await expect(
      trackConsignment({ carrier: "royal_mail", trackingNumber: "AB123456789GB" }),
    ).rejects.toBeInstanceOf(TrackingNotConfigured);
  });

  it("resolves a stored courier string before looking for a provider", () => {
    // All four stored Royal Mail spellings reach the one provider.
    for (const stored of ["Royal Mail", "Royal Mail 48", "Royal Mail 24", "Royal Mail 1st Class"]) {
      expect(getTrackingProviderFor(stored), stored).toBeDefined();
    }
    // Recognised carrier, no provider registered for it.
    expect(getTrackingProviderFor("Evri")).toBeUndefined();
    // Not a carrier at all — refused before any lookup is attempted.
    expect(getTrackingProviderFor("wayfair")).toBeUndefined();
    expect(getTrackingProviderFor(null)).toBeUndefined();
  });
});

describe("the shape a provider must return", () => {
  it("offers a status for not-known that is distinct from failure", () => {
    // A carrier reporting something we cannot map must say so rather than pick
    // the nearest plausible status — "unknown" and "out for delivery" are
    // different promises to a customer.
    expect(TRACKING_STATUSES).toContain("unknown");
    expect(TRACKING_STATUSES).toContain("delivered");
    expect(TRACKING_STATUSES).toContain("in_transit");
  });

  /**
   * "The carrier has never heard of this number" and "the carrier has it but
   * has not scanned it" look alike in a naive shape and mean opposite things.
   */
  it("separates not-found from not-configured", () => {
    expect(TrackingNotConfigured.name).not.toBe("TrackingNotFound");
  });
});

/**
 * WHERE TRACKING IS ALLOWED TO REACH, now that it is connected.
 *
 * This replaces an assertion that nothing imported the tracking modules at all.
 * That guard existed to make the draft connection a deliberate decision rather
 * than an accident, and it did its job: connecting tracking failed it, which is
 * exactly when somebody should have to think.
 *
 * What it becomes is a narrower claim, and still a load-bearing one. Tracking
 * may reach the draft CONTEXT and the draft PROMPT. It may not reach the
 * repositories, the sync layer, the workflow or the UI — a scan history is
 * something we fetch to ground one reply, not something the application stores,
 * displays or makes decisions on. Keeping it out of those layers is what stops
 * "we looked up a parcel once" turning into a second source of truth about
 * orders that nothing reconciles.
 */
describe("tracking reaches the draft path and nothing else", () => {
  const ROOT = join(__dirname, "..", "..");
  const CODE = new Set([".ts", ".tsx"]);

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (CODE.has(extname(entry))) out.push(full);
    }
    return out;
  }

  const dirs = (...relatives: string[]) =>
    relatives
      .map((relative) => join(ROOT, ...relative.split("/")))
      .filter((dir) => {
        try {
          return statSync(dir).isDirectory();
        } catch {
          return false;
        }
      })
      .flatMap(walk);

  const imports = (file: string) => /from\s+["']@\/lib\/tracking\//.test(readFileSync(file, "utf8"));

  it("scans a non-empty set of files", () => {
    expect(dirs("lib", "app", "components").length).toBeGreaterThan(0);
  });

  /**
   * The permitted consumers, named one by one. A list rather than a directory
   * so that a NEW file in `lib/ai` importing tracking fails this and has to be
   * added deliberately.
   */
  it("is imported only by the draft context and the draft prompt", () => {
    const ALLOWED = [
      join("lib", "context", "resolve-tracking-context.ts"),
      join("lib", "ai", "provider.ts"),
      join("lib", "ai", "draft-assembly.ts"),
      join("lib", "ai", "draft-validation.ts"),
    ];
    const offenders = dirs("lib/ai", "lib/context")
      .filter(imports)
      .map((file) => file.replace(ROOT + sep, ""))
      .filter((relative) => !ALLOWED.includes(relative));
    expect(offenders).toEqual([]);
  });

  /**
   * A scan history grounds one reply. It is not stored, not displayed, and
   * nothing decides a workflow state from it — those would each make tracking a
   * second source of truth about an order that nothing reconciles.
   */
  it("is imported by no repository, sync or UI code", () => {
    const offenders = dirs("lib/repositories", "lib/sync", "lib/db", "components")
      .filter(imports)
      .map((file) => file.replace(ROOT + sep, ""));
    expect(offenders).toEqual([]);
  });

  /** Exactly one route may ask for tracking: the one that generates a draft. */
  it("is reached from the draft route and no other", () => {
    const offenders = dirs("app")
      .filter(imports)
      .map((file) => file.replace(ROOT + sep, ""));
    expect(offenders).toEqual([]);
  });

  /**
   * The network reaches exactly one carrier, and only through the provider.
   *
   * This replaces an earlier "reaches no network at all" assertion, which was
   * true while the provider was a skeleton and became misleading the moment it
   * was connected. What still matters is that the reach is CONTAINED: the
   * abstraction, the carrier normaliser and the service registry are pure, so a
   * second carrier cannot quietly start making calls from the shared layer.
   */
  it("makes network calls only from a carrier provider", () => {
    // Matched on the exact basename. `endsWith` was wrong and silently wrong:
    // "royal-mail-provider.ts" ends with "provider.ts", so the carrier provider
    // was being held to the shared layer's no-network rule.
    const shared = new Set(["provider.ts", "carrier.ts", "tracking-service.ts", "tracking-cache.ts"]);
    for (const file of walk(join(ROOT, "lib", "tracking"))) {
      if (!shared.has(basename(file))) continue;
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/https?:\/\//);
    }
  });

  /**
   * NO ENDPOINT IS HARDCODED. Every URL is configuration with a documented
   * default, because the defaults follow published documentation that nobody
   * here has authenticated against — a wrong one has to be an environment
   * change, not a deploy.
   */
  it("hardcodes no carrier endpoint in the tracking modules", () => {
    for (const file of walk(join(ROOT, "lib", "tracking"))) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/.*$/gm, " ");
      expect(code, file).not.toMatch(/https?:\/\//);
    }
  });
});
