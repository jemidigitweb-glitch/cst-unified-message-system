/**
 * Turning a row of `message_app.sla_configs` into a CST response-SLA policy.
 *
 * PURE. No network, no database, no clock. Every decision here is a decision
 * about MEANING — which rows are policy at all, which seller account a target
 * belongs to, and what to do when two rows claim the same scope — and those are
 * the things worth testing in isolation and arguing about in review. The
 * transport is somewhere else.
 *
 * ------------------------------------------------------------------------
 * THIS FILE COPIES A POLICY. IT DOES NOT APPLY ONE.
 * ------------------------------------------------------------------------
 * Nothing here compares an interval to a target, computes a compliance
 * percentage, or decides whether a conversation met its SLA. CST's own 24-hour
 * rule lives in `lib/domain/response-sla.ts` and is untouched; the two targets
 * disagree, and which governs is a business decision (handover A1) that is
 * still open.
 *
 * Importing what a policy SAYS commits to nothing about which policy GOVERNS.
 * That is what makes this safe to ship while the decision is outstanding.
 *
 * ------------------------------------------------------------------------
 * TWO POPULATIONS, ONE TABLE NAME
 * ------------------------------------------------------------------------
 * `sla_configs` holds 1,081 rows and only 42 are policy:
 *
 *   type='response'    42 rows, `key_value` NULL on every one, all written
 *                      2026-04-15. Two per account: week 16h, weekend 24h.
 *   type='urgent'   1,039 rows, `key_value` populated on every one with a
 *                      marketplace MESSAGE ID, written 2026-04-16 and stopped
 *                      2026-05-06. A per-case escalation log.
 *
 * The reader selects only `type='response'`, and `isResponsePolicyType` is
 * here so the rule is stated once and testable. The urgent rows are not
 * imported: they are a different kind of thing, they have been dead for four
 * months, and their `reason` column quotes phrases from customer messages.
 *
 * ------------------------------------------------------------------------
 * IT NEVER INVENTS AN ACCOUNT
 * ------------------------------------------------------------------------
 * The same discipline `agent-directory.ts` applies to names. A row whose
 * channel is unmapped, whose mailbox does not resolve, or whose situation is a
 * concept CST has not modelled is REJECTED and reported — never stored under a
 * guessed account. A policy row attached to the wrong seller account is a
 * target silently applied to the wrong customers.
 *
 * The one apparent exception is Amazon, and it is not one: see
 * `resolveAccount`.
 */

/** The only `type` that is policy. The other 1,039 rows are a per-case log. */
export const RESPONSE_POLICY_TYPE = "response";

/**
 * The only `situation` the response population uses — all 42 rows carry it.
 *
 * Stored nowhere, because a column holding one value teaches readers to ignore
 * it. Instead a response row with any OTHER situation is rejected: it would be
 * a new applicability dimension (a target that depends on what the customer is
 * asking about), and CST's table has no column for that. A new concept is a
 * thing to notice, not to silently flatten into the default.
 */
export const DEFAULT_SITUATION = "default";

/** Source `channel` -> CST `marketplace`. Unmapped channels are rejected. */
const CHANNEL_TO_MARKETPLACE: Readonly<Record<string, Marketplace>> = {
  ebay: "ebay",
  amazon: "amazon",
  shopify: "shopify",
};

export type Marketplace = "ebay" | "amazon" | "shopify" | "bandq" | "temu";

/** Mirrors `ck_response_sla_policy_week_scope`. Source vocabulary, verbatim. */
export type WeekScope = "week" | "weekend";

const WEEK_SCOPES: ReadonlySet<string> = new Set<WeekScope>(["week", "weekend"]);

/**
 * One `sla_configs` row, exactly the seven columns the reader selects.
 *
 * `key_value` and `reason` are absent BY CONSTRUCTION. The first is a
 * customer's marketplace message id; the second quotes phrases from customer
 * messages. This module cannot leak them because it never receives them — the
 * same device `agent-directory.ts` uses against the credential columns.
 */
export type SourceSlaConfigRow = {
  readonly sourcePk: string;
  readonly type: string;
  readonly channel: string | null;
  readonly weekScope: string | null;
  readonly situation: string | null;
  readonly hours: number | null;
  readonly subSource: number | null;
  readonly mailId: number | null;
};

/** One `mails` row. Two columns; the rest are credentials and hostnames. */
export type SourceMailRow = {
  readonly mailId: number;
  /** NULL is meaningful — see `resolveAccount`. */
  readonly subSource: number | null;
};

/** One row ready for `cst_app.response_sla_policy`. Timestamps are the writer's. */
export type PolicyEntry = {
  readonly marketplace: Marketplace;
  /** NULL = the whole channel. A verified reading, not a missing value. */
  readonly subSourceId: number | null;
  readonly weekScope: WeekScope;
  readonly targetHours: number;
  readonly sourcePk: string;
  readonly sourceMailId: number | null;
};

export type PolicyRejectionReason =
  /** `type` is not 'response' — an urgent per-case row, or something new. */
  | "not_policy_type"
  /** A channel with no CST marketplace. B&Q and Temu never appear at all. */
  | "unmapped_channel"
  /** A response row describing a situation CST has no column for. */
  | "unmapped_situation"
  /** `week_scope` absent or outside week/weekend. */
  | "invalid_week_scope"
  /** `hours` absent, not an integer, or not positive. */
  | "invalid_target_hours"
  /** Both `sub_source` and `mail_id` set — the source cannot say which wins. */
  | "ambiguous_account_key"
  /** Neither key set. The row names no account and no channel-wide intent. */
  | "no_account_key"
  /** `mail_id` names a mailbox absent from `mails`. Not the same as a NULL one. */
  | "unresolved_mail_id";

export type MappedPolicy =
  | { readonly ok: true; readonly entry: PolicyEntry }
  | {
      readonly ok: false;
      readonly sourcePk: string;
      readonly reason: PolicyRejectionReason;
      /** What the row actually said, so a report can name it. */
      readonly detail: string;
    };

/** Whether this row is policy at all. Stated once so the filter is testable. */
export function isResponsePolicyType(type: string | null): boolean {
  return type?.trim().toLowerCase() === RESPONSE_POLICY_TYPE;
}

/** A mailbox index, built once by the caller from the 18-row `mails` table. */
export type MailIndex = ReadonlyMap<number, SourceMailRow>;

export function buildMailIndex(rows: readonly SourceMailRow[]): MailIndex {
  return new Map(rows.map((row) => [row.mailId, row]));
}

type AccountResolution =
  | { readonly ok: true; readonly subSourceId: number | null; readonly sourceMailId: number | null }
  | { readonly ok: false; readonly reason: PolicyRejectionReason; readonly detail: string };

/**
 * Which seller account a policy row belongs to.
 *
 * THREE SHAPES EXIST IN THE SOURCE, and the difference between the last two is
 * the subtlest thing in this file.
 *
 *   sub_source set, mail_id NULL     eBay. 30 rows. The account is stated
 *                                    outright; use it.
 *
 *   mail_id set, mails row EXISTS    Shopify (10 rows) and Amazon (2). Resolve
 *   with a sub_source                through the mailbox.
 *
 *   mail_id set, mails row EXISTS    AMAZON, mail_id 1. The mailbox is real and
 *   with sub_source NULL             its account is genuinely unrecorded, so
 *                                    the target applies to the whole channel.
 *                                    This is a VERIFIED READING.
 *
 *   mail_id set, NO mails row        A dangling reference. REJECTED.
 *
 * The last two both produce "no account id", and collapsing them would be the
 * mistake. A mailbox that exists and records no account is the source telling
 * us the target is channel-wide; a mailbox that does not exist is the source
 * being broken. One is data, the other is a bug, and storing a dangling
 * reference as a channel-wide policy would silently widen a target from one
 * seller account to every conversation on the marketplace.
 *
 * CST holds exactly one Amazon account (`sub_source_id` 8), so writing 8 would
 * very probably be right. It would also be a fabricated join, indistinguishable
 * in the table from the 14 eBay rows where the source states the account. NULL
 * is the honest value and the migration's index coalesces it.
 */
export function resolveAccount(
  row: SourceSlaConfigRow,
  mails: MailIndex,
): AccountResolution {
  const hasSubSource = row.subSource !== null;
  const hasMailId = row.mailId !== null;

  if (hasSubSource && hasMailId) {
    return {
      ok: false,
      reason: "ambiguous_account_key",
      detail: `sub_source=${row.subSource} and mail_id=${row.mailId} both set`,
    };
  }

  if (hasSubSource) {
    return { ok: true, subSourceId: row.subSource, sourceMailId: null };
  }

  if (!hasMailId) {
    return { ok: false, reason: "no_account_key", detail: "sub_source and mail_id both NULL" };
  }

  const mailbox = mails.get(row.mailId as number);
  if (mailbox === undefined) {
    return {
      ok: false,
      reason: "unresolved_mail_id",
      detail: `mail_id=${row.mailId} is absent from mails`,
    };
  }

  // The mailbox exists. Its sub_source may legitimately be NULL — channel-wide.
  return { ok: true, subSourceId: mailbox.subSource, sourceMailId: row.mailId };
}

/**
 * Maps one source row, rejecting rather than guessing.
 *
 * Order matters only for which reason a bad row reports; every check is
 * independent. Type is first so a per-case escalation row that reaches this
 * function by mistake is named as such rather than reported as a broken policy.
 */
export function mapPolicyRow(row: SourceSlaConfigRow, mails: MailIndex): MappedPolicy {
  const reject = (reason: PolicyRejectionReason, detail: string): MappedPolicy => ({
    ok: false,
    sourcePk: row.sourcePk,
    reason,
    detail,
  });

  if (!isResponsePolicyType(row.type)) {
    return reject("not_policy_type", `type=${row.type ?? "NULL"}`);
  }

  const situation = row.situation?.trim().toLowerCase() ?? "";
  if (situation !== DEFAULT_SITUATION) {
    return reject("unmapped_situation", `situation=${row.situation ?? "NULL"}`);
  }

  const channel = row.channel?.trim().toLowerCase() ?? "";
  const marketplace = CHANNEL_TO_MARKETPLACE[channel];
  if (marketplace === undefined) {
    return reject("unmapped_channel", `channel=${row.channel ?? "NULL"}`);
  }

  const weekScope = row.weekScope?.trim().toLowerCase() ?? "";
  if (!WEEK_SCOPES.has(weekScope)) {
    return reject("invalid_week_scope", `week_scope=${row.weekScope ?? "NULL"}`);
  }

  // Integer and positive. `hours` is int(5) at source and has never been null
  // or non-positive across 42 rows — which is exactly why an unchecked import
  // would carry a broken value straight through to a stored promise.
  if (row.hours === null || !Number.isInteger(row.hours) || row.hours <= 0) {
    return reject("invalid_target_hours", `hours=${row.hours ?? "NULL"}`);
  }

  const account = resolveAccount(row, mails);
  if (!account.ok) return reject(account.reason, account.detail);

  return {
    ok: true,
    entry: {
      marketplace,
      subSourceId: account.subSourceId,
      weekScope: weekScope as WeekScope,
      targetHours: row.hours,
      sourcePk: row.sourcePk,
      sourceMailId: account.sourceMailId,
    },
  };
}

/** The scope key. The real identity of a policy row, and the upsert's conflict target. */
export function scopeKey(entry: {
  readonly marketplace: Marketplace;
  readonly subSourceId: number | null;
  readonly weekScope: WeekScope;
}): string {
  return `${entry.marketplace}/${entry.subSourceId ?? "channel"}/${entry.weekScope}`;
}

/** One stored row, plus how many agreeing source rows produced it. */
export type CollapsedPolicy = PolicyEntry & { readonly sourceRows: number };

/** Two source rows claiming one scope with different targets. Fatal. */
export type PolicyConflict = {
  readonly scope: string;
  readonly targets: readonly number[];
  readonly sourcePks: readonly string[];
};

export type CollapseOutcome = {
  readonly policies: readonly CollapsedPolicy[];
  /** Non-empty means the caller must refuse the whole import. */
  readonly conflicts: readonly PolicyConflict[];
};

/**
 * Collapses many source rows onto one row per scope.
 *
 * THIS IS NOT A TIDY-UP. It is load-bearing, and the shape of the source is
 * why: three Shopify mailboxes resolve to one seller account —
 *
 *   mail_id 2 (sales@), 3 (admin@) and 8 (german@)  ->  sub_source 104
 *
 * so six source rows describe two real scopes. Inserted as they stand, a
 * lookup for account 104 would return three answers and whichever the query
 * happened to order first would win. The unique index in 0019 makes that
 * impossible to store; this is what makes it impossible to attempt.
 *
 * DETERMINISTIC WINNER: the lowest source id. Not "the first one seen", which
 * would depend on the source's row order and make a re-run's stored
 * `source_pk` drift for no reason.
 *
 * DISAGREEMENT IS FATAL, NOT A VOTE. Today all three carry 16/24 and the
 * collapse loses nothing — verified, not assumed. If a future edit gives
 * sales@ 16h and german@ 12h, picking either would store a target nobody
 * approved and silently apply it to every conversation on that account. So
 * conflicts are returned rather than resolved, and the importer refuses the
 * whole run.
 *
 * ALL-OR-NOTHING on purpose: a partial import would leave the table in a state
 * no single version of the source ever described.
 */
export function collapsePolicies(entries: readonly PolicyEntry[]): CollapseOutcome {
  const byScope = new Map<string, PolicyEntry[]>();
  for (const entry of entries) {
    const key = scopeKey(entry);
    const bucket = byScope.get(key);
    if (bucket === undefined) byScope.set(key, [entry]);
    else bucket.push(entry);
  }

  const policies: CollapsedPolicy[] = [];
  const conflicts: PolicyConflict[] = [];

  for (const [scope, bucket] of byScope) {
    const targets = [...new Set(bucket.map((e) => e.targetHours))].sort((a, b) => a - b);
    if (targets.length > 1) {
      conflicts.push({
        scope,
        targets,
        sourcePks: bucket.map((e) => e.sourcePk).sort(numericPk),
      });
      continue;
    }

    // Lowest source id wins, so the stored provenance is stable across runs.
    const winner = [...bucket].sort((a, b) => numericPk(a.sourcePk, b.sourcePk))[0];
    policies.push({ ...winner, sourceRows: bucket.length });
  }

  // Sorted so a dry-run report reads the same way twice, and so a reviewer
  // comparing two runs is looking at a diff rather than a reshuffle.
  policies.sort((a, b) => scopeKey(a).localeCompare(scopeKey(b)));
  conflicts.sort((a, b) => a.scope.localeCompare(b.scope));

  return { policies, conflicts };
}

/**
 * Numeric comparison on an id carried as text.
 *
 * `source_pk` is text because the column that stores it is text, and `"10" <
 * "9"` under a string sort. Getting this wrong would not fail anything loudly —
 * it would just pick a different, still-valid winner, and the stored
 * `source_pk` would flip between runs for no reason a reader could explain.
 */
function numericPk(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

/**
 * Which CST seller accounts the imported policy does NOT cover.
 *
 * REPORTED, NEVER FILLED. The absences are real and specific:
 *
 *   shopify  109, 198, 233, 245, 248   mailboxes created 2026-04-21, six days
 *                                      after the policy was written
 *   bandq    104                       no sla_configs row of either type
 *   temu     248                       no sla_configs row of either type
 *
 * A conversation on one of those accounts has NO approved target, and the only
 * honest reading is "missing" — never `met`, never `missed`, and never a
 * default borrowed from a neighbouring account. This function exists so the
 * gap is a number an importer prints rather than a paragraph in a document.
 *
 * `channelWide` marketplaces (Amazon today) cover every account on the channel,
 * so an account there is covered even though no row names it.
 */
export function uncoveredAccounts(
  cstAccounts: readonly { readonly marketplace: Marketplace; readonly subSourceId: number }[],
  policies: readonly { readonly marketplace: Marketplace; readonly subSourceId: number | null }[],
): readonly { readonly marketplace: Marketplace; readonly subSourceId: number }[] {
  const channelWide = new Set(
    policies.filter((p) => p.subSourceId === null).map((p) => p.marketplace),
  );
  const named = new Set(
    policies
      .filter((p) => p.subSourceId !== null)
      .map((p) => `${p.marketplace}/${p.subSourceId}`),
  );

  return cstAccounts.filter(
    (a) => !channelWide.has(a.marketplace) && !named.has(`${a.marketplace}/${a.subSourceId}`),
  );
}
