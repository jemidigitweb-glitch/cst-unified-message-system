import { displayBody } from "@/lib/domain/inbox";
import { countDistinctIssues, customerText } from "@/lib/knowledge/case-type";

import type { DraftRequest } from "./provider";

/**
 * Which model answers THIS conversation.
 *
 * WHY NOT ONE MODEL. Every draft used to run on whatever `OPENAI_MODEL` named,
 * so a one-line "has my parcel shipped?" and a five-message dispute involving
 * damage, a refund, an invoice and a threatened chargeback cost the same and
 * took the same time. Both halves of that are wrong: the first is paying for
 * reasoning it does not need, and there is no headroom left to give the second
 * something stronger.
 *
 * THREE TIERS, NAMED BY CONFIGURATION, NOT BY VENDOR. `DRAFT_MODEL_SIMPLE`,
 * `DRAFT_MODEL_STANDARD` and `DRAFT_MODEL_COMPLEX`. No model id appears in this
 * file, and none should: changing which model serves a tier must be an
 * environment change, not a deploy. An unset tier falls back to the next one up
 * and finally to `OPENAI_MODEL`, so the existing single-model setup keeps
 * working untouched.
 *
 * WHAT IT MEASURES, AND WHAT IT CANNOT. This runs BEFORE the model call, so it
 * cannot know how much CST evidence retrieval will return — with File Search
 * that is decided inside the request it is choosing the model for. What it does
 * have is the conversation itself, and the count of distinct issues the
 * customer raised is the closest honest proxy for "how many rule areas will
 * this touch". Stated here rather than implied, because a reader will
 * reasonably expect retrieved-evidence volume to be one of the inputs.
 *
 * IT ESCALATES, IT NEVER DE-ESCALATES. Anything touching safety, injury, legal
 * threat or a formal complaint goes straight to the strongest tier regardless
 * of how short the message is — "the heater caught fire" is nine words and is
 * not a simple case. Getting the tier wrong downwards on one of those is the
 * only failure here that actually matters.
 *
 * PURE. No network, no database, no model call. Given a request it returns a
 * tier and the reasons for it, so a decision can be logged and argued with.
 */

export const DRAFT_TIERS = ["simple", "standard", "complex"] as const;
export type DraftTier = (typeof DRAFT_TIERS)[number];

/** The environment variable naming the model for each tier. */
export const TIER_MODEL_VARS: Readonly<Record<DraftTier, string>> = {
  simple: "DRAFT_MODEL_SIMPLE",
  standard: "DRAFT_MODEL_STANDARD",
  complex: "DRAFT_MODEL_COMPLEX",
};

/**
 * Words that force the strongest tier.
 *
 * Deliberately an explicit, reviewable list rather than a judgement call. Each
 * entry is something a person would escalate on sight: bodily harm, a fire or
 * electrical risk, a legal or regulatory threat, or money being disputed
 * through a third party. A false positive here costs a slightly more expensive
 * draft; a false negative gives a weaker model a case that could end up in
 * front of a regulator.
 */
const ESCALATION_SIGNALS: readonly string[] = [
  // Harm.
  "injury",
  "injured",
  "hurt",
  "hospital",
  "burn",
  "burnt",
  "fire",
  "smoke",
  "electric shock",
  "shocked me",
  "unsafe",
  "dangerous",
  "hazard",
  "child",
  "baby",
  // Legal and regulatory.
  "solicitor",
  "lawyer",
  "legal action",
  "take you to court",
  "court",
  "trading standards",
  "ombudsman",
  "small claims",
  "consumer rights act",
  "sue",
  // Money disputed elsewhere, and formal process.
  "chargeback",
  "charge back",
  "fraud",
  "scam",
  "police",
  "formal complaint",
  "escalate",
  "a to z",
  "case against",
];

function contains(haystack: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

export type ComplexityAssessment = {
  readonly tier: DraftTier;
  /** The accumulated weight. Reported so a tier boundary can be argued with. */
  readonly score: number;
  /** Plain-language reasons, in the order they were applied. */
  readonly reasons: readonly string[];
  /** Set when a safety, legal or escalation signal forced the top tier. */
  readonly escalated: boolean;
};

/**
 * Scores a conversation and picks a tier.
 *
 * The weights are ordinary judgement, not a fitted model, and they are written
 * as data so they can be argued with in review. Boundaries: 0–1 simple,
 * 2–3 standard, 4+ complex.
 */
export function assessComplexity(request: {
  readonly messages: DraftRequest["messages"];
  readonly facts?: DraftRequest["facts"];
}): ComplexityAssessment {
  const messages = request.messages;
  const reasons: string[] = [];
  let score = 0;

  const inbound = messages.filter((message) => message.direction === "inbound");
  const text = customerText(messages);

  // 1. Length of the thread. A long back-and-forth carries history the reply
  //    has to stay consistent with.
  if (messages.length >= 6) {
    score += 2;
    reasons.push(`${messages.length} messages in the thread`);
  } else if (messages.length >= 3) {
    score += 1;
    reasons.push(`${messages.length} messages in the thread`);
  }

  // 2. How much the customer actually wrote.
  if (text.length >= 4_000) {
    score += 2;
    reasons.push("long customer text");
  } else if (text.length >= 1_200) {
    score += 1;
    reasons.push("substantial customer text");
  }

  // 3. Distinct issues raised — the best cheap proxy for rule areas touched.
  const issues = countDistinctIssues(messages);
  if (issues >= 3) {
    score += 2;
    reasons.push(`${issues} distinct issues raised`);
  } else if (issues === 2) {
    score += 1;
    reasons.push("two distinct issues raised");
  }

  // 4. Verified context the reply has to be consistent with.
  const facts = request.facts?.length ?? 0;
  if (facts >= 4) {
    score += 1;
    reasons.push(`${facts} verified facts to reconcile`);
  }

  // 5. Evidence the customer sent. A photograph usually means a claim that
  //    turns on what it shows.
  const attachments = inbound.reduce((total, message) => total + message.attachments.length, 0);
  if (attachments > 0) {
    score += 1;
    reasons.push("customer sent attachments");
  }

  // 6. Undecodable bodies. The model is reasoning with a hole in the thread,
  //    which is exactly when a weaker one starts filling it in.
  const undecodable = messages.filter((message) => !displayBody(message).available).length;
  if (undecodable > 0) {
    score += 1;
    reasons.push(`${undecodable} message(s) could not be decoded`);
  }

  // 7. The override. Applied last and unconditionally.
  const escalation = ESCALATION_SIGNALS.find((signal) => contains(text, signal));
  if (escalation !== undefined) {
    reasons.push(`safety, legal or escalation wording: "${escalation}"`);
    return { tier: "complex", score, reasons, escalated: true };
  }

  const tier: DraftTier = score >= 4 ? "complex" : score >= 2 ? "standard" : "simple";
  if (reasons.length === 0) reasons.push("short single-issue conversation");
  return { tier, score, reasons, escalated: false };
}

/**
 * The model configured for a tier, falling upward when one is not set.
 *
 * simple → standard → complex → the caller's default. Falling UP rather than
 * down is deliberate: a half-configured environment should over-serve a simple
 * case, never under-serve a complex one.
 *
 * `process.env` is read on every call and never memoised, matching the rest of
 * this project's configuration — a changed variable takes effect on the next
 * draft rather than the next restart.
 */
export function modelForTier(tier: DraftTier, fallback: string): string {
  const read = (name: string): string | undefined => {
    const value = process.env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };

  const order: DraftTier[] =
    tier === "simple"
      ? ["simple", "standard", "complex"]
      : tier === "standard"
        ? ["standard", "complex"]
        : ["complex"];

  for (const candidate of order) {
    const configured = read(TIER_MODEL_VARS[candidate]);
    if (configured !== undefined) return configured;
  }
  return fallback;
}

/** Whether any tier is configured at all. Used only for reporting. */
export function tieredModelsConfigured(): boolean {
  return DRAFT_TIERS.some((tier) => (process.env[TIER_MODEL_VARS[tier]]?.trim() ?? "") !== "");
}
