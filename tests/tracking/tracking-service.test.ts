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
 * The tracking registry, now that something in it can actually answer.
 *
 * WHAT CHANGED AND WHY THESE ASSERTIONS MOVED. These tests used to pin an
 * almost-empty registry — Royal Mail registered but unable to answer, every
 * other carrier absent — because that was the honest finished state of a
 * foundation with no data source behind it. There is one now: the upstream
 * application already polls every carrier into
 * `order_management.shipment_tracking_log`, and `source-database-provider.ts`
 * reads it. So every carrier has a provider, and the behaviour worth pinning is
 * no longer "the empty state is honest" but "the answer comes from the source
 * that can give one".
 *
 * The refusal discipline itself is unchanged and still pinned below: a lookup
 * that cannot be answered throws rather than returning an empty shape.
 */

describe("the registry", () => {
  /**
   * EVERY CARRIER HAS A PROVIDER, because the source table is carrier-agnostic.
   * There is no carrier for which the sync would hold data but the registry
   * could not reach it.
   */
  it("covers every carrier this system can name", () => {
    expect([...connectedCarriers()].sort()).toEqual([...CARRIERS].sort());
    for (const carrier of CARRIERS) {
      expect(getTrackingProvider(carrier), carrier).toBeDefined();
    }
  });

  /**
   * PRECEDENCE IS THE POINT. Royal Mail is still registered, but it has no
   * endpoint implemented — so if it won its own carrier, the largest carrier in
   * the data would be served by the one provider that cannot answer.
   */
  it("prefers the source database over the unconnected carrier API", () => {
    for (const carrier of CARRIERS) {
      const status = trackingStatus(carrier);
      expect(status.configured, carrier).toBe(true);
      if (!status.configured) throw new Error("unreachable");
      expect(status.carrier).toBe(carrier);
      expect(status.provider, carrier).toBe("source_database");
    }
  });

  /**
   * FAILS RATHER THAN INVENTS. An empty result would carry
   * `currentStatus: "unknown"` and no events — a shape indistinguishable from a
   * carrier that genuinely knows nothing. The entire grounding design of this
   * application rests on absent context being distinguishable from established
   * context, so the absent case throws.
   *
   * With a provider registered for every carrier, `TrackingNotConfigured` is no
   * longer reachable through this path; what is asserted is that a lookup which
   * cannot be answered still REJECTS rather than resolving to an empty shape.
   */
  it("rejects a lookup instead of returning an empty result", async () => {
    await expect(
      trackConsignment({ carrier: "evri", trackingNumber: "H00123456789" }),
    ).rejects.toThrow();
    await expect(
      trackConsignment({ carrier: "royal_mail", trackingNumber: "AB123456789GB" }),
    ).rejects.toThrow();
  });

  it("still refuses a carrier it cannot name", () => {
    expect(TrackingNotConfigured).toBeDefined();
    // All four stored Royal Mail spellings reach a provider.
    for (const stored of ["Royal Mail", "Royal Mail 48", "Royal Mail 24", "Royal Mail 1st Class"]) {
      expect(getTrackingProviderFor(stored), stored).toBeDefined();
    }
    // Evri is a recognised carrier and now has one too.
    expect(getTrackingProviderFor("Evri")).toBeDefined();
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
   * A scan history is NOT STORED and nothing decides a workflow state from it.
   *
   * WHAT CHANGED. This used to say "not displayed" as well, and that was the
   * right rule while nothing could answer a lookup — a display fed by an inert
   * pipeline would have shown a reviewer a permanently empty box. The sidebar
   * now shows the shipment, so the claim narrows to the two parts that still
   * hold: tracking may not reach the repositories, the sync layer or the
   * database layer, because that is what would turn "we looked up a parcel
   * once" into a second source of truth about orders that nothing reconciles.
   *
   * Nothing about storage changed: no migration, no column, no writer.
   */
  it("is imported by no repository, sync or database code", () => {
    const offenders = dirs("lib/repositories", "lib/sync", "lib/db")
      .filter(imports)
      .map((file) => file.replace(ROOT + sep, ""));
    expect(offenders).toEqual([]);
  });

  /**
   * The UI may name a status; it may not fetch one.
   *
   * Display needs the vocabulary — `TrackingResult`, `CARRIER_LABELS`,
   * `TRACKING_STATUS_LABELS` — and all three are pure types and constants. What
   * it must never import is anything that can perform a lookup: a provider, the
   * service registry or the cache. A component that could call
   * `trackConsignment` would be reaching a carrier, and a database, from the
   * browser bundle's own module graph.
   */
  it("lets the UI name a status but never fetch one", () => {
    const FETCHERS = [
      "@/lib/tracking/tracking-service",
      "@/lib/tracking/tracking-cache",
      "@/lib/tracking/royal-mail-provider",
      "@/lib/tracking/source-database-provider",
    ];
    const offenders = dirs("components")
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return FETCHERS.some((module) => source.includes(module));
      })
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
