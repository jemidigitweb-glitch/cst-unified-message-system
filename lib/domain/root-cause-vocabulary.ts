/**
 * The lists a CST agent chooses from when recording a root cause.
 *
 * ---------------------------------------------------------------------------
 * THE ROOT CAUSE LABELS ARE THE MESSAGE APPLICATION'S, MEASURED AND NOT INVENTED
 * ---------------------------------------------------------------------------
 * CST has no access to the message application's own option list — that list
 * lives in its UI, in a database this application holds no grant on. So the
 * eighteen labels below were taken from what it has actually STORED, by a
 * read-only `GROUP BY root_cause` across all five marketplace tables in
 * `customer_service`. Every one is a label its agents have really selected, and
 * the ordering here is by how often, most-used first, because a chip grid a
 * person uses forty times a day should put the common answer nearest.
 *
 * Three kinds of stored value were deliberately NOT brought across:
 *
 *   * Case variants. `Out of stock` (8 rows) is the same label as `OUT OF
 *     STOCK` (9,409) — the writer validates case-insensitively and stores
 *     verbatim. Offering both would split one label across two chips.
 *   * Free prose. Five rows hold sentences rather than labels; those are the
 *     OTHER flow working as designed, not options to offer.
 *   * Nothing was added. No label appears here that no agent has ever chosen.
 *
 * THE SPELLINGS ARE VERBATIM AND SHOUTY ON PURPOSE. `FULFILMENT_CARRIER` is not
 * prettied into "Fulfilment carrier" and `PARTS MISSING` is not title-cased,
 * because a value recorded here has to be findable character-for-character in
 * the owning application by somebody comparing the two screens. Presentation is
 * the component's business; see `rootCauseChipText`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS VERSIONED RATHER THAN JUST LISTED
 * ---------------------------------------------------------------------------
 * The message application's classifier and its agents will add labels without
 * telling us, and this list will be re-measured and change. A row recorded
 * today must still be readable against the list that offered it, so every write
 * stamps `ROOT_CAUSE_VOCABULARY_VERSION` — the same reasoning `automation_items`
 * uses for `template_version`. BUMP IT whenever any of the three lists below
 * changes, and never reuse a number.
 *
 * PURE. No network, no database, no clock.
 */

import { rootCauseLabelKey } from "@/lib/domain/message-app-root-cause";

/**
 * Bump on ANY change to the three lists in this file.
 *
 * 1 — the eighteen labels measured from `customer_service` on 2026-09-29, and
 *     the courier and issue-type lists as agreed for this feature.
 */
export const ROOT_CAUSE_VOCABULARY_VERSION = 1;

/**
 * The eighteen labels, most-used first, with OTHER last.
 *
 * OTHER IS MOVED OUT OF FREQUENCY ORDER, and it is the only one that is. It is
 * the second most recorded value in the source, which would put it second on
 * screen — directly beside the answer, as the easy way out of thinking of one.
 * It is the escape hatch, so it sits at the end where an escape hatch belongs.
 */
export const ROOT_CAUSE_LABELS = [
  "OUT OF STOCK",
  "LISTING_CONTENT",
  "RETURN",
  "CUSTOMER_MISUSE",
  "Charge Back",
  "Delivery Issue",
  "INVOICE",
  "PRODUCT_QUALITY",
  "Wrong Address",
  "FULFILMENT_WAREHOUSE",
  "FULFILMENT_CARRIER",
  "MARKETPLACE_ADMIN",
  "PRE_SALES_QUERY",
  "PARTS MISSING",
  "DISCOUNT",
  "EBAY_RECALL",
  "TRANSFORMER_ISSUE",
  "OTHER",
] as const;

export type RootCauseLabel = (typeof ROOT_CAUSE_LABELS)[number];

/**
 * The escape hatch, named once.
 *
 * IT IS STORED, and that is a REVERSAL of how this feature first worked.
 *
 * The first version copied the message application exactly: choosing OTHER
 * there opens a textarea, demands 30 characters, and saves that prose AS the
 * root cause — the word itself is never stored. A CHECK enforced the same here.
 *
 * CST now needs something that application cannot do: report on how often no
 * predefined cause fitted. That question is unanswerable if OTHER is never
 * recorded, because every such case is filed under a different one-off sentence
 * and nothing marks them as a group.
 *
 * So `root_cause` now holds `OTHER` verbatim and the agent's own wording goes
 * in `custom_root_cause`, its own column. The concern behind the original rule
 * — that no row should be filed under a category meaning "not categorised" —
 * is served better than before, not abandoned: OTHER is now recorded AND is
 * required to carry an explanation, which the database enforces as a pair.
 */
export const OTHER_LABEL = "OTHER";

/**
 * The ceiling on an agent's own statement of the root cause.
 *
 * NO MINIMUM BEYOND NON-BLANK. The 30-character minimum that used to guard this
 * field was the message application's, and it belonged to a different field:
 * there, the prose BECAME the root cause, so a two-word answer left a case
 * effectively uncategorised. Here the category is already recorded — it is
 * `OTHER` — and this column supplies the detail. "Packaging change after
 * dispatch" is a complete and useful answer at 34 characters, and would have
 * been rejected at 29.
 *
 * 2,000 matches `ISSUE_NOTE_MAX_LENGTH` and `INTERNAL_NOTE_MAX_LENGTH`, which
 * is this project's one answer to "how long may an agent's own text be". It is
 * a technical ceiling against a pathological payload — `custom_root_cause` is
 * `text`, which PostgreSQL does not constrain — and not a business rule about
 * how long a root cause ought to be.
 */
export const CUSTOM_ROOT_CAUSE_MAX_LENGTH = 2_000;

/**
 * The three labels that open the courier levels.
 *
 * THESE ARE EXISTING LABELS, not new ones. The four-level hierarchy this
 * feature adds — cause, courier, issue type, note — hangs off the vocabulary
 * the message application already uses, so a CST recording stays comparable
 * with a message-app one. Inventing a "Courier Issue" level-1 label would have
 * made every CST row unmatchable against the 1,616 rows already filed under
 * `FULFILMENT_CARRIER`.
 *
 * `Delivery Issue` and `FULFILMENT_CARRIER` are plainly carrier-shaped.
 * `FULFILMENT_WAREHOUSE` is here too, and that is a judgement worth stating:
 * an agent cannot always tell a mis-pick from a mis-scan at the point of
 * recording, and the courier is a fact they can supply either way. Offering the
 * levels does not require filling them beyond the courier itself.
 */
export const COURIER_DETAIL_LABELS = [
  "Delivery Issue",
  "FULFILMENT_CARRIER",
  "FULFILMENT_WAREHOUSE",
] as const;

/**
 * Level 2. MUST MATCH `ck_conversation_root_causes_courier` exactly.
 *
 * This list and that CHECK are pinned to each other by
 * `tests/domain/root-cause-vocabulary.test.ts` and
 * `tests/migrations/conversation-root-cause-schema.test.ts`. Editing one alone
 * makes a chip an agent can press into a save the database rejects.
 */
export const COURIERS = [
  "Royal Mail",
  "EVRI",
  "DHL",
  "DPD",
  "GLS",
  "Amazon Shipping",
  "USPS",
  "Intelcom",
  "Smart Track",
  "Other",
] as const;

export type Courier = (typeof COURIERS)[number];

/**
 * Level 3. Same contract with the database as `COURIERS`.
 *
 * ---------------------------------------------------------------------------
 * THESE STRINGS ARE THE APPROVED ONES, CHARACTER FOR CHARACTER
 * ---------------------------------------------------------------------------
 * The casing is the business's, not a style choice, and it is deliberately
 * irregular: item 1 is capitalised and items 2-10 are not. An earlier version
 * of this file "tidied" all ten into sentence case and replaced the two
 * slashes with the word "or" — `false/incorrect delivery scan` became `False or
 * incorrect delivery scan`. That was corrected before migration 0020 was ever
 * applied, which is the only reason it cost nothing.
 *
 * DO NOT RE-TIDY THEM. These are not labels that merely appear on a screen:
 * they are the stored value, the CHECK vocabulary and the report's GROUP BY
 * key. Re-casing one after this table holds rows splits a courier issue across
 * two lines of a comparison and understates both.
 */
export const COURIER_ISSUE_TYPES = [
  "Lost parcel",
  "transit damage",
  "parcel damaged by courier",
  "delivered to wrong address",
  "false/incorrect delivery scan",
  "delayed delivery",
  "no tracking update",
  "returned to sender",
  "collection/drop-off issue",
  "other",
] as const;

export type CourierIssueType = (typeof COURIER_ISSUE_TYPES)[number];

/**
 * Level 4's ceiling — A TECHNICAL LIMIT, NOT A BUSINESS RULE.
 *
 * The requirement asks for "a short free-text note explaining the exact
 * problem" and says nothing about length, so nothing here decides how long a
 * note ought to be. There is NO MINIMUM: an agent is never made to pad a note
 * to reach a number, and the note is optional at every level.
 *
 * What remains is a ceiling against a pathological payload. `issue_note` is
 * `text`, which PostgreSQL does not constrain, so without one an accidental
 * paste — or a hostile request — stores a megabyte in a sidebar field and fills
 * the panel that renders it.
 *
 * 2,000 IS THE NUMBER THIS PROJECT ALREADY USES for exactly this kind of field:
 * `INTERNAL_NOTE_MAX_LENGTH` caps an agent's own words about a case at 2,000,
 * for the same stated reason. Matching it means CST has one answer to "how long
 * may a note be" rather than two that drift. It is roughly 300 words — far more
 * than a short account of what a courier did, and small enough that a runaway
 * paste cannot fill the column.
 *
 * The UI, the domain rule and the API all read THIS constant, so the three
 * cannot disagree. The database deliberately does not restate it: a length
 * CHECK would turn a raised ceiling into a migration.
 */
export const ISSUE_NOTE_MAX_LENGTH = 2_000;

/*
 * Case-folded lookups, built once.
 *
 * Membership is decided the way `sameRootCauseLabel` decides equality — folded
 * and trimmed — because the source itself holds `Out of stock` beside `OUT OF
 * STOCK`, and a selection arriving in either spelling names the same thing. The
 * map returns the CANONICAL spelling, so what gets stored is this list's, never
 * whatever casing a request happened to carry.
 */
const LABEL_BY_KEY = new Map(ROOT_CAUSE_LABELS.map((l) => [rootCauseLabelKey(l), l]));
const COURIER_BY_KEY = new Map(COURIERS.map((c) => [rootCauseLabelKey(c), c]));
const COURIER_DETAIL_KEYS = new Set(COURIER_DETAIL_LABELS.map(rootCauseLabelKey));

/*
 * THE ISSUE TYPE IS MATCHED EXACTLY, AND IT IS THE ONLY ONE THAT IS.
 *
 * A Set of the approved strings, not a folded map. `Transit damage` is NOT
 * `transit damage` here: it is refused, rather than quietly normalised into the
 * approved spelling.
 *
 * The reason the three fields differ is that their vocabularies have different
 * provenance, and the matching follows the provenance:
 *
 *   root cause   FOLDED. The source genuinely holds `Out of stock` beside `OUT
 *                OF STOCK` and `Return` beside `RETURN`, because the message
 *                application validates case-insensitively and stores verbatim.
 *                Those ARE the same label and must not read as a conflict.
 *   courier      FOLDED, unchanged by this correction and outside its scope.
 *   issue type   EXACT. This list has no upstream system and no historical
 *                rows — it was specified, character for character, for this
 *                feature. There is no variant spelling that is legitimately
 *                the same value, so accepting one would mean the approved list
 *                and the storable list had quietly stopped being the same list.
 */
const APPROVED_ISSUE_TYPES: ReadonlySet<string> = new Set(COURIER_ISSUE_TYPES);

/** The canonical spelling of an offered label, or null if it is not offered. */
export function canonicalRootCauseLabel(raw: string): RootCauseLabel | null {
  return LABEL_BY_KEY.get(rootCauseLabelKey(raw)) ?? null;
}

/** The canonical spelling of an offered courier, or null. */
export function canonicalCourier(raw: string): Courier | null {
  return COURIER_BY_KEY.get(rootCauseLabelKey(raw)) ?? null;
}

/**
 * An approved issue type, or null.
 *
 * EXACT. Surrounding whitespace is trimmed — a trailing space is a transport
 * artefact, not a different answer — and nothing else is forgiven. A different
 * casing or a substituted separator is a value that is not on the approved
 * list, and it is refused rather than repaired.
 */
export function canonicalCourierIssueType(raw: string): CourierIssueType | null {
  const trimmed = raw.trim();
  return APPROVED_ISSUE_TYPES.has(trimmed) ? (trimmed as CourierIssueType) : null;
}

/** Whether choosing this label opens levels 2 to 4. */
export function requiresCourierDetail(rawLabel: string): boolean {
  return COURIER_DETAIL_KEYS.has(rootCauseLabelKey(rawLabel));
}

/** Whether this is the escape hatch, in any casing the source uses. */
export function isOtherLabel(rawLabel: string): boolean {
  return rootCauseLabelKey(rawLabel) === rootCauseLabelKey(OTHER_LABEL);
}

/**
 * What a chip SHOWS, as distinct from what it stores.
 *
 * `FULFILMENT_CARRIER` is a machine spelling on a screen a person reads all
 * day, so the underscore becomes a space and the shouting is softened — but
 * ONLY for display, and only for the screaming-snake labels. `Charge Back`,
 * `OUT OF STOCK` and `PARTS MISSING` are left exactly as the source holds them:
 * they are already readable, and re-casing a label that a reviewer might be
 * eyeballing against the other application's screen buys nothing.
 *
 * Nothing consumes the return value as data. The stored value is always the
 * entry from `ROOT_CAUSE_LABELS`.
 */
export function rootCauseChipText(label: string): string {
  if (!/^[A-Z][A-Z_]*_[A-Z_]+$/.test(label)) return label;
  const [first, ...rest] = label.split("_");
  return [first!, ...rest.map((word) => word.toLowerCase())].join(" ");
}
