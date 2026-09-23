import { describe, expect, it } from "vitest";

import {
  buildMailIndex,
  collapsePolicies,
  DEFAULT_SITUATION,
  isResponsePolicyType,
  mapPolicyRow,
  RESPONSE_POLICY_TYPE,
  resolveAccount,
  scopeKey,
  uncoveredAccounts,
  type PolicyEntry,
  type SourceMailRow,
  type SourceSlaConfigRow,
} from "@/lib/domain/sla-policy";

/**
 * The response-SLA policy mapping.
 *
 * SYNTHETIC ROWS ONLY. Every fixture below is written for the test; no customer
 * data and no copied source row appears. The shapes mirror what was measured in
 * `evidence/2026-09-23-response-time-sla-evidence.md`, which is a different
 * thing from copying the data.
 *
 * These tests are about the SHAPE of the mapping — which rows are policy, which
 * account a target belongs to, what happens on a collision. None asserts a
 * compliance percentage, because nothing in this feature computes one and the
 * target that governs is still an open business decision.
 */

const MAILS: readonly SourceMailRow[] = [
  // Amazon's mailbox. Real, and records NO account — the load-bearing NULL.
  { mailId: 1, subSource: null },
  // Three Shopify mailboxes on one seller account. The collapse case.
  { mailId: 2, subSource: 104 },
  { mailId: 3, subSource: 104 },
  { mailId: 8, subSource: 104 },
  { mailId: 7, subSource: 108 },
  { mailId: 4, subSource: 112 },
];

const mails = buildMailIndex(MAILS);

function row(overrides: Partial<SourceSlaConfigRow> = {}): SourceSlaConfigRow {
  return {
    sourcePk: "2",
    type: RESPONSE_POLICY_TYPE,
    channel: "ebay",
    weekScope: "week",
    situation: DEFAULT_SITUATION,
    hours: 16,
    subSource: 1,
    mailId: null,
    ...overrides,
  };
}

function entry(overrides: Partial<PolicyEntry> = {}): PolicyEntry {
  return {
    marketplace: "ebay",
    subSourceId: 1,
    weekScope: "week",
    targetHours: 16,
    sourcePk: "2",
    sourceMailId: null,
    ...overrides,
  };
}

describe("which rows are policy at all", () => {
  /**
   * 42 of 1,081 rows are policy. The other 1,039 are a per-case escalation log
   * that stopped being written on 2026-05-06 and carries customer message ids.
   * Importing them would be the single worst outcome of this feature.
   */
  it("accepts only type='response'", () => {
    expect(isResponsePolicyType("response")).toBe(true);
    expect(isResponsePolicyType("urgent")).toBe(false);
    expect(isResponsePolicyType(null)).toBe(false);
    expect(isResponsePolicyType("")).toBe(false);
  });

  it("tolerates casing and padding on the type", () => {
    expect(isResponsePolicyType(" Response ")).toBe(true);
    expect(isResponsePolicyType("RESPONSE")).toBe(true);
  });

  it("rejects an urgent row that reaches the mapper, naming it as such", () => {
    const mapped = mapPolicyRow(row({ type: "urgent", sourcePk: "900" }), mails);
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.reason).toBe("not_policy_type");
    expect(mapped.sourcePk).toBe("900");
  });

  /**
   * A response row with a situation other than 'default' is a NEW APPLICABILITY
   * DIMENSION — a target that depends on what the customer is asking about.
   * cst_app.response_sla_policy has no column for it, so flattening it into the
   * default would silently apply a specialised target channel-wide.
   */
  it("rejects a response row describing an unmodelled situation", () => {
    const mapped = mapPolicyRow(row({ situation: "cancel_before_dispatch" }), mails);
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.reason).toBe("unmapped_situation");
    expect(mapped.detail).toContain("cancel_before_dispatch");
  });
});

describe("the channel mapping", () => {
  it.each([
    ["ebay", "ebay"],
    ["amazon", "amazon"],
    ["shopify", "shopify"],
  ])("maps channel %s to marketplace %s", (channel, marketplace) => {
    const mapped = mapPolicyRow(row({ channel, subSource: 1, mailId: null }), mails);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.entry.marketplace).toBe(marketplace);
  });

  /**
   * B&Q and Temu appear in NO sla_configs row of either type, and neither
   * carries an outbound message to measure against. A channel this file has not
   * seen is rejected rather than passed through as a marketplace name that
   * happens to match.
   */
  it.each(["bandq", "temu", "walmart", "", null])(
    "rejects the unmapped channel %s",
    (channel) => {
      const mapped = mapPolicyRow(row({ channel }), mails);
      expect(mapped.ok).toBe(false);
      if (mapped.ok) return;
      expect(mapped.reason).toBe("unmapped_channel");
    },
  );
});

describe("resolving the seller account", () => {
  it("takes the account directly when the source states it (eBay)", () => {
    const resolved = resolveAccount(row({ subSource: 238, mailId: null }), mails);
    expect(resolved).toEqual({ ok: true, subSourceId: 238, sourceMailId: null });
  });

  it("resolves a mailbox to its account (Shopify)", () => {
    const resolved = resolveAccount(row({ subSource: null, mailId: 7 }), mails);
    expect(resolved).toEqual({ ok: true, subSourceId: 108, sourceMailId: 7 });
  });

  /**
   * THE SUBTLEST CASE IN THE FEATURE, and the one most likely to be "fixed"
   * later by someone who has not read why.
   *
   * Amazon's mail_id 1 EXISTS in `mails` and its sub_source is NULL. That NULL
   * is the source saying the target applies to the whole channel, not that the
   * mailbox is missing. CST holds exactly one Amazon account (8), so writing 8
   * would very probably be right and would be a fabricated join.
   */
  it("reads a real mailbox with no account as channel-wide, not as an error", () => {
    const resolved = resolveAccount(row({ channel: "amazon", subSource: null, mailId: 1 }), mails);
    expect(resolved).toEqual({ ok: true, subSourceId: null, sourceMailId: 1 });
  });

  /**
   * The mirror of the case above, and the reason the two must not be collapsed.
   * A dangling mail_id stored as channel-wide would silently widen a target
   * from one seller account to every conversation on the marketplace.
   */
  it("rejects a mail_id that names no mailbox at all", () => {
    const resolved = resolveAccount(row({ subSource: null, mailId: 999 }), mails);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("unresolved_mail_id");
  });

  it("distinguishes a NULL account from a missing mailbox", () => {
    const channelWide = resolveAccount(row({ subSource: null, mailId: 1 }), mails);
    const dangling = resolveAccount(row({ subSource: null, mailId: 999 }), mails);
    expect(channelWide.ok).toBe(true);
    expect(dangling.ok).toBe(false);
  });

  /** The source cannot say which key wins, so neither may this. */
  it("rejects a row carrying both account keys", () => {
    const resolved = resolveAccount(row({ subSource: 1, mailId: 2 }), mails);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("ambiguous_account_key");
  });

  it("rejects a row carrying neither account key", () => {
    const resolved = resolveAccount(row({ subSource: null, mailId: null }), mails);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("no_account_key");
  });
});

describe("the target hours", () => {
  it("carries a positive integer through unchanged", () => {
    const mapped = mapPolicyRow(row({ hours: 24 }), mails);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.entry.targetHours).toBe(24);
  });

  /**
   * `hours` has never been null or non-positive across 42 rows — which is
   * exactly why an unchecked import would carry a broken value straight through
   * to a stored promise the first time it happened.
   */
  it.each([null, 0, -4, 1.5, Number.NaN])("rejects the target %s", (hours) => {
    const mapped = mapPolicyRow(row({ hours }), mails);
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.reason).toBe("invalid_target_hours");
  });
});

describe("the week scope", () => {
  it.each(["week", "weekend"])("accepts the source vocabulary %s verbatim", (weekScope) => {
    const mapped = mapPolicyRow(row({ weekScope }), mails);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.entry.weekScope).toBe(weekScope);
  });

  /**
   * 'weekday' would read better in CST and would put a translation step in
   * every query, screen and report that compares this to sla_configs. The
   * source's word is kept — the same reasoning 0011 recorded for `sent`.
   */
  it("does not rename week to weekday", () => {
    const mapped = mapPolicyRow(row({ weekScope: "week" }), mails);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.entry.weekScope).not.toBe("weekday");
  });

  it.each(["saturday", "all", "", null])("rejects the scope %s", (weekScope) => {
    const mapped = mapPolicyRow(row({ weekScope }), mails);
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.reason).toBe("invalid_week_scope");
  });
});

describe("collapsing several source rows onto one scope", () => {
  /**
   * THE LOAD-BEARING CASE. Three Shopify mailboxes resolve to account 104, so
   * six source rows describe two real scopes. Stored as they stand, a lookup
   * would return three answers and whichever sorted first would win.
   */
  it("collapses three agreeing mailboxes into one row per scope", () => {
    const { policies, conflicts } = collapsePolicies([
      entry({ marketplace: "shopify", subSourceId: 104, sourcePk: "7", sourceMailId: 2 }),
      entry({ marketplace: "shopify", subSourceId: 104, sourcePk: "4", sourceMailId: 3 }),
      entry({ marketplace: "shopify", subSourceId: 104, sourcePk: "6", sourceMailId: 8 }),
    ]);

    expect(conflicts).toEqual([]);
    expect(policies).toHaveLength(1);
    expect(policies[0].sourceRows).toBe(3);
    expect(policies[0].targetHours).toBe(16);
  });

  /** Lowest source id, so a re-run stores the same provenance rather than drifting. */
  it("picks the lowest source id as the winner, deterministically", () => {
    const build = (order: string[]) =>
      collapsePolicies(
        order.map((pk) => entry({ marketplace: "shopify", subSourceId: 104, sourcePk: pk })),
      ).policies[0];

    expect(build(["7", "4", "6"]).sourcePk).toBe("4");
    expect(build(["6", "7", "4"]).sourcePk).toBe("4");
    expect(build(["4", "6", "7"]).sourcePk).toBe("4");
  });

  /**
   * `source_pk` is text because the column that stores it is text, and
   * `"10" < "9"` under a string sort. This would not fail loudly — it would
   * just flip the stored provenance between runs for no explicable reason.
   */
  it("compares source ids numerically, not as strings", () => {
    const { policies } = collapsePolicies([
      entry({ marketplace: "shopify", subSourceId: 104, sourcePk: "10" }),
      entry({ marketplace: "shopify", subSourceId: 104, sourcePk: "9" }),
    ]);
    expect(policies[0].sourcePk).toBe("9");
  });

  /**
   * DISAGREEMENT IS FATAL, NOT A VOTE. Today all three Shopify rows carry
   * 16/24. If a future edit gives one of them 12h, picking either would store a
   * target nobody approved and apply it to every conversation on that account.
   */
  it("reports a conflict rather than choosing when targets disagree", () => {
    const { policies, conflicts } = collapsePolicies([
      entry({ marketplace: "shopify", subSourceId: 104, sourcePk: "4", targetHours: 16 }),
      entry({ marketplace: "shopify", subSourceId: 104, sourcePk: "6", targetHours: 12 }),
    ]);

    expect(policies).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].targets).toEqual([12, 16]);
    expect(conflicts[0].sourcePks).toEqual(["4", "6"]);
  });

  it("keeps a conflicting scope out of the output entirely", () => {
    const { policies } = collapsePolicies([
      entry({ marketplace: "shopify", subSourceId: 104, sourcePk: "4", targetHours: 16 }),
      entry({ marketplace: "shopify", subSourceId: 104, sourcePk: "6", targetHours: 12 }),
      entry({ marketplace: "ebay", subSourceId: 1, sourcePk: "2", targetHours: 16 }),
    ]);
    expect(policies.map(scopeKey)).toEqual(["ebay/1/week"]);
  });

  it("keeps week and weekend apart on the same account", () => {
    const { policies } = collapsePolicies([
      entry({ subSourceId: 1, weekScope: "week", targetHours: 16, sourcePk: "2" }),
      entry({ subSourceId: 1, weekScope: "weekend", targetHours: 24, sourcePk: "23" }),
    ]);
    expect(policies).toHaveLength(2);
    expect(policies.map((p) => p.targetHours).sort()).toEqual([16, 24]);
  });

  /**
   * 104 is a Shopify seller account AND a B&Q one; 248 is Shopify and Temu.
   * A scope key without the marketplace would merge two different businesses'
   * targets into one row.
   */
  it("does not merge the same account id across marketplaces", () => {
    const { policies } = collapsePolicies([
      entry({ marketplace: "shopify", subSourceId: 104, sourcePk: "4" }),
      entry({ marketplace: "bandq", subSourceId: 104, sourcePk: "99" }),
    ]);
    expect(policies).toHaveLength(2);
  });

  /** A channel-wide row and a named-account row are different scopes. */
  it("keeps a channel-wide target apart from a named account on the same marketplace", () => {
    const { policies } = collapsePolicies([
      entry({ marketplace: "amazon", subSourceId: null, sourcePk: "1" }),
      entry({ marketplace: "amazon", subSourceId: 8, sourcePk: "50" }),
    ]);
    expect(policies).toHaveLength(2);
  });

  /**
   * Two channel-wide rows for one marketplace DO share a scope. Without this,
   * Amazon's NULL would slip past the collapse and the database's coalesce()
   * index would be the only thing catching it.
   */
  it("treats two channel-wide rows on one marketplace as one scope", () => {
    const { policies } = collapsePolicies([
      entry({ marketplace: "amazon", subSourceId: null, sourcePk: "1" }),
      entry({ marketplace: "amazon", subSourceId: null, sourcePk: "60" }),
    ]);
    expect(policies).toHaveLength(1);
    expect(policies[0].sourceRows).toBe(2);
  });

  it("records a single-source scope as one row", () => {
    const { policies } = collapsePolicies([entry()]);
    expect(policies[0].sourceRows).toBe(1);
  });

  /** A dry run read twice must be a diff, not a reshuffle. */
  it("returns policies in a stable order regardless of input order", () => {
    const a = entry({ marketplace: "shopify", subSourceId: 108, sourcePk: "5" });
    const b = entry({ marketplace: "ebay", subSourceId: 22, sourcePk: "13" });
    const c = entry({ marketplace: "amazon", subSourceId: null, sourcePk: "1" });

    const one = collapsePolicies([a, b, c]).policies.map(scopeKey);
    const two = collapsePolicies([c, a, b]).policies.map(scopeKey);
    expect(one).toEqual(two);
  });

  it("returns nothing for no input, rather than throwing", () => {
    expect(collapsePolicies([])).toEqual({ policies: [], conflicts: [] });
  });
});

describe("coverage reporting", () => {
  const policies = [
    { marketplace: "ebay", subSourceId: 1 },
    { marketplace: "shopify", subSourceId: 104 },
    { marketplace: "amazon", subSourceId: null },
  ] as const;

  /**
   * Five Shopify accounts, all of B&Q and all of Temu have no approved target.
   * The gap is DATA, not a bug, and this is what makes it a number somebody
   * prints rather than a paragraph in a document.
   */
  it("names the accounts with no policy row", () => {
    const uncovered = uncoveredAccounts(
      [
        { marketplace: "ebay", subSourceId: 1 },
        { marketplace: "shopify", subSourceId: 104 },
        { marketplace: "shopify", subSourceId: 245 },
        { marketplace: "bandq", subSourceId: 104 },
        { marketplace: "temu", subSourceId: 248 },
      ],
      policies,
    );

    expect(uncovered).toEqual([
      { marketplace: "shopify", subSourceId: 245 },
      { marketplace: "bandq", subSourceId: 104 },
      { marketplace: "temu", subSourceId: 248 },
    ]);
  });

  /** Amazon's channel-wide row covers every account on that marketplace. */
  it("treats a channel-wide policy as covering any account on that channel", () => {
    const uncovered = uncoveredAccounts([{ marketplace: "amazon", subSourceId: 8 }], policies);
    expect(uncovered).toEqual([]);
  });

  /** B&Q's account id is 104 — the same number as a COVERED Shopify account. */
  it("does not let a covered account on one marketplace cover another", () => {
    const uncovered = uncoveredAccounts([{ marketplace: "bandq", subSourceId: 104 }], policies);
    expect(uncovered).toEqual([{ marketplace: "bandq", subSourceId: 104 }]);
  });

  /** A channel-wide row on Amazon must not silently cover Shopify. */
  it("does not let a channel-wide policy cover a different marketplace", () => {
    const uncovered = uncoveredAccounts([{ marketplace: "shopify", subSourceId: 245 }], policies);
    expect(uncovered).toHaveLength(1);
  });
});

describe("the whole mapping, end to end", () => {
  /**
   * The three real shapes in one pass, with synthetic ids: eBay stating its
   * account, Shopify resolving through a mailbox, Amazon channel-wide.
   */
  it("maps and collapses the three source shapes", () => {
    const rows: SourceSlaConfigRow[] = [
      row({ sourcePk: "2", channel: "ebay", subSource: 1, mailId: null, weekScope: "week", hours: 16 }),
      row({ sourcePk: "23", channel: "ebay", subSource: 1, mailId: null, weekScope: "weekend", hours: 24 }),
      row({ sourcePk: "4", channel: "shopify", subSource: null, mailId: 3, weekScope: "week", hours: 16 }),
      row({ sourcePk: "6", channel: "shopify", subSource: null, mailId: 8, weekScope: "week", hours: 16 }),
      row({ sourcePk: "1", channel: "amazon", subSource: null, mailId: 1, weekScope: "week", hours: 16 }),
    ];

    const entries = rows
      .map((r) => mapPolicyRow(r, mails))
      .filter((m): m is Extract<typeof m, { ok: true }> => m.ok)
      .map((m) => m.entry);

    expect(entries).toHaveLength(5);

    const { policies, conflicts } = collapsePolicies(entries);
    expect(conflicts).toEqual([]);
    expect(policies.map(scopeKey)).toEqual([
      "amazon/channel/week",
      "ebay/1/week",
      "ebay/1/weekend",
      "shopify/104/week",
    ]);
    expect(policies.find((p) => p.marketplace === "shopify")?.sourceRows).toBe(2);
    expect(policies.find((p) => p.marketplace === "amazon")?.subSourceId).toBeNull();
  });

  /** A rejected row must not quietly reduce the policy; it must be reportable. */
  it("reports a rejection rather than dropping it silently", () => {
    const mapped = mapPolicyRow(row({ sourcePk: "77", channel: "bandq" }), mails);
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.sourcePk).toBe("77");
    expect(mapped.detail).toContain("bandq");
  });
});

describe("what the mapped entry does not carry", () => {
  /**
   * `key_value` (a customer's marketplace message id) and `reason` (quoted
   * phrases from customer messages) are absent from the row type BY
   * CONSTRUCTION — the reader never selects them. This asserts the entry shape
   * so a future widening of the reader has nowhere to put them.
   */
  it("carries no customer-derived field", () => {
    const mapped = mapPolicyRow(row(), mails);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;

    expect(Object.keys(mapped.entry).sort()).toEqual([
      "marketplace",
      "sourceMailId",
      "sourcePk",
      "subSourceId",
      "targetHours",
      "weekScope",
    ]);
  });

  /** No interval, no comparison, no percentage. This module copies a target. */
  it("exposes nothing that evaluates a target against an elapsed time", () => {
    const mapped = mapPolicyRow(row(), mails);
    if (!mapped.ok) return;
    expect(mapped.entry).not.toHaveProperty("met");
    expect(mapped.entry).not.toHaveProperty("elapsed");
    expect(mapped.entry).not.toHaveProperty("dueAt");
  });
});
