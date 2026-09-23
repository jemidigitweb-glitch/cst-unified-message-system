/**
 * The seven Customer Service Insights KPIs, and what each one is waiting for.
 *
 * PURE. No network, no database, no clock.
 *
 * ------------------------------------------------------------------------
 * THE UNAVAILABLE STATES ARE THE POINT OF THIS FILE
 * ------------------------------------------------------------------------
 * Six of the seven KPIs cannot be computed honestly today. The tempting move is
 * to ship the one that works and leave the others off the screen, or worse to
 * render them as `0%` until the data arrives.
 *
 * Both hide the same thing. A missing tile makes a requirement look unrequested;
 * a zero makes a missing measurement look like a measured absence, and nobody
 * chases a number that already appears to exist. So every KPI is on the page,
 * every one that cannot be computed says so, and each says WHICH dependency is
 * unresolved and WHOSE it is.
 *
 * This is the same discipline `RESPONSE_SLA_MINUTES` shipped with — the
 * machinery complete and the number visibly blank — and the reason
 * `lib/domain/agent-directory.ts` rejects a staff row rather than inventing a
 * name for it.
 *
 * ------------------------------------------------------------------------
 * THREE KINDS OF BLOCKER, KEPT APART
 * ------------------------------------------------------------------------
 *   missing_data        nothing anywhere holds it. Someone must create it.
 *   not_imported        it exists and is verified; CST has not copied it yet.
 *   missing_definition  the data exists; the business rule does not.
 *
 * The distinction is what makes this list actionable: `not_imported` is
 * engineering work that can start today, `missing_definition` cannot start at
 * all, and `missing_data` is not an engineering task in the first place.
 *
 * ------------------------------------------------------------------------
 * AGENT-ATTRIBUTED AND MARKETPLACE-WIDE ARE NOT THE SAME MEASUREMENT
 * ------------------------------------------------------------------------
 * `scope` separates them, and the dashboard must keep them visually apart.
 * Customer feedback and buyer contact rate are properties of a marketplace over
 * a period — no agent owns an order, and no feedback row carries an agent. Put
 * beside a per-agent figure they read as that agent's feedback, which would be
 * an accusation or a credit nobody earned.
 */

/** Every figure quoted below was measured; none is an estimate. */
export type BlockerKind = "missing_data" | "not_imported" | "missing_definition";

export type Blocker = {
  readonly kind: BlockerKind;
  /** What is missing, in one line a non-engineer can act on. */
  readonly detail: string;
  /** Measured evidence, so the claim can be checked rather than believed. */
  readonly evidence?: string;
};

export type KpiScope =
  /** Attributable to a named agent. */
  | "agent"
  /** A property of a marketplace over a period. Never per agent. */
  | "marketplace";

export type KpiAvailability =
  | { readonly state: "available" }
  | { readonly state: "unavailable"; readonly blockers: readonly Blocker[] };

export type KpiDefinition = {
  readonly key: KpiKey;
  readonly label: string;
  /** The calculation, stated plainly enough to be argued with. */
  readonly calculation: string;
  readonly scope: KpiScope;
  readonly availability: KpiAvailability;
  /**
   * Three or four words for the card face.
   *
   * The cards used to carry the full blocker text — row counts, table names,
   * the lot — which made a screen of seven tiles unreadable and buried the one
   * number that works. The detail did not stop being true, so it moved to a
   * single collapsible section rather than being deleted. This is what remains
   * on the face: enough to know the tile is waiting on something, and on what
   * kind of thing.
   */
  readonly shortStatus?: string;
};

export type KpiKey =
  | "messages_handled"
  | "average_response_time"
  | "sla_performance"
  | "unresolved_cases"
  | "buyer_contact_rate"
  | "buyer_dissatisfaction_rate"
  | "customer_feedback";

/**
 * The source actions that count as handling a message.
 *
 * Only the two that put words in front of a customer. `move_to_resolved`,
 * `root_cause_confirmed` and the confirm actions are real work and are recorded,
 * but counting them here would answer a different question than the one the tile
 * asks — and would inflate a per-agent figure by roughly 2x.
 */
export const MESSAGES_HANDLED_ACTIONS = ["reply_to_message", "reply_with_warning"] as const;

/** Shared by several blockers, so the wording cannot drift between tiles. */
const ARRIVAL_TIMESTAMP: Blocker = {
  kind: "missing_data",
  detail:
    "No authoritative message arrival time. The ingestion owner must confirm the source timezone so source_ts_utc can be populated.",
  evidence:
    "source_ts_utc and source_ts_zone are empty on all 32,033 messages; ingested_at is a backfill time for 16,793 of them (52.4%).",
};

const TEAM_MEMBERSHIP: Blocker = {
  kind: "missing_data",
  detail: "No system records which agents belong to which customer-service team.",
  evidence:
    "agent_directory has no team column; employee_management.team holds 36 teams and no CS team, with 79 of 105 active staff unassigned.",
};

export const KPI_DEFINITIONS: readonly KpiDefinition[] = [
  {
    key: "messages_handled",
    label: "Messages handled",
    calculation:
      "Count of reply_to_message and reply_with_warning actions, grouped by the agent who performed them.",
    scope: "agent",
    availability: { state: "available" },
  },
  {
    key: "average_response_time",
    label: "Average response time",
    calculation:
      "Mean interval between a customer's message arriving and the first CST reply to it.",
    scope: "agent",
    shortStatus: "Needs arrival timestamp",
    availability: { state: "unavailable", blockers: [ARRIVAL_TIMESTAMP] },
  },
  {
    key: "sla_performance",
    label: "SLA performance",
    calculation: "Share of conversations answered within the approved response target.",
    scope: "agent",
    shortStatus: "Needs timestamp and target",
    availability: {
      state: "unavailable",
      blockers: [
        ARRIVAL_TIMESTAMP,
        {
          kind: "missing_definition",
          detail:
            "Two different approved targets are in play. The business must confirm which governs.",
          evidence:
            "CST applies 24h to before-shipment urgent conversations; message_app.sla_configs sets 16h on weekdays, 24h at weekends, and 4h for cancel_before_dispatch.",
        },
        {
          kind: "not_imported",
          detail: "The approved SLA policy has not been imported into CST.",
          evidence: "message_app.sla_configs — 874 rows, per channel and per seller account.",
        },
      ],
    },
  },
  {
    key: "unresolved_cases",
    label: "Unresolved cases",
    calculation:
      "Conversations in scope, minus those whose latest recorded state is a resolution. Counted per conversation, not per action.",
    // Marketplace, not agent: a conversation's resolution state belongs to the
    // conversation. Attributing a backlog to whoever last touched it would
    // credit or blame one person for a queue many people worked.
    scope: "marketplace",
    availability: { state: "available" },
  },
  {
    key: "buyer_contact_rate",
    label: "Buyer contact rate",
    calculation: "Conversations in the period divided by orders placed in the same period.",
    scope: "marketplace",
    shortStatus: "Needs order counts",
    availability: {
      state: "unavailable",
      blockers: [
        {
          kind: "not_imported",
          detail: "Order counts are not in CST. A daily per-marketplace aggregate is enough.",
          evidence:
            "order_management.order holds 1,144,358 rows; Jun–Sep 2026 gives eBay 18,185, Amazon 32,251, Shopify 14,132, B&Q 3,220.",
        },
        {
          kind: "missing_definition",
          detail:
            "The basis is undecided: conversations or individual contacts, and which order statuses count.",
        },
      ],
    },
  },
  {
    key: "buyer_dissatisfaction_rate",
    label: "Buyer dissatisfaction rate",
    calculation: "Dissatisfaction events in the period divided by orders in the same period.",
    scope: "marketplace",
    shortStatus: "Needs a definition",
    availability: {
      state: "unavailable",
      blockers: [
        {
          kind: "missing_definition",
          detail:
            "No definition exists for what counts as dissatisfaction. Every candidate input is available; none has been chosen.",
          evidence:
            "Candidates: negative and neutral feedback (30 and 58 since June), ebay_returns 42,364, amazon_returns 15,663, ebay_order_cancellations 4,569.",
        },
      ],
    },
  },
  {
    key: "customer_feedback",
    label: "Customer feedback",
    calculation:
      "Seller feedback left in the period, counted as positive, neutral and negative — with negative as a share of all feedback received.",
    scope: "marketplace",
    availability: { state: "available" },
  },
];

export type FilterKey = "agent" | "marketplace" | "date_range" | "team" | "message_category";

export type FilterDefinition = {
  readonly key: FilterKey;
  readonly label: string;
  readonly availability: KpiAvailability;
  /** Stated even when available, because "available" rarely means "complete". */
  readonly coverageNote?: string;
};

export const FILTER_DEFINITIONS: readonly FilterDefinition[] = [
  {
    key: "date_range",
    label: "Date range",
    availability: { state: "available" },
    coverageNote:
      "Activity is recorded per day, not per hour — the source stores a DATE. Intra-day filtering is not possible.",
  },
  {
    key: "marketplace",
    label: "Marketplace",
    availability: { state: "available" },
    coverageNote:
      "All five marketplaces hold conversations, but agent activity exists only for eBay, so any agent figure is eBay-only.",
  },
  {
    key: "agent",
    label: "Agent",
    availability: { state: "available" },
    coverageNote:
      "10 agents with recorded eBay activity, named from a 234-row directory. Amazon, B&Q and Temu have no agent activity at source and never will.",
  },
  {
    key: "team",
    label: "Team",
    availability: { state: "unavailable", blockers: [TEAM_MEMBERSHIP] },
  },
  {
    key: "message_category",
    label: "Message category",
    availability: {
      state: "unavailable",
      blockers: [
        {
          kind: "not_imported",
          detail: "Message tags exist for all five marketplaces but have not been imported.",
          evidence:
            "message_app.msg_tag_etl — 89,800 tagged messages (eBay 48,131, Shopify 21,782, B&Q 8,662, Amazon 4,920, Temu 816). The mapping into CST was verified at 99.5%.",
        },
        {
          kind: "missing_definition",
          detail:
            "Two taxonomies exist and one must be chosen; the imported set also mixes query types with product types.",
          evidence:
            "CST's category_definitions holds 11 codes with an unused classifier (conversation_rule_analysis is empty); msg_tag_etl holds 39 tags including product names such as Bulbs and Cable.",
        },
      ],
    },
  },
];

export function kpiByKey(key: KpiKey): KpiDefinition {
  const found = KPI_DEFINITIONS.find((k) => k.key === key);
  if (!found) throw new Error(`unknown KPI: ${key}`);
  return found;
}

export function availableKpiKeys(): readonly KpiKey[] {
  return KPI_DEFINITIONS.filter((k) => k.availability.state === "available").map((k) => k.key);
}

/** How many of the seven are computable, for an honest headline on the page. */
export function readiness(): { readonly available: number; readonly total: number } {
  return { available: availableKpiKeys().length, total: KPI_DEFINITIONS.length };
}
