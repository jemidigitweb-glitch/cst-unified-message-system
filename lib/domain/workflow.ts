import { z } from "zod";

/**
 * Phase 1 workflow.
 *
 *   received -> drafting -> pending_review -> reviewed
 *
 * `reviewed` is TERMINAL. Phase 1 has no capability to transmit a reply to a
 * customer, so there is deliberately no state after review: no `approved`,
 * `sending`, `sent`, or `manual_handoff`. Adding one would mean adding a
 * transport, which is out of scope for this phase.
 */
export const WORKFLOW_STATES = ["received", "drafting", "pending_review", "reviewed"] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const workflowStateSchema = z.enum(WORKFLOW_STATES);

export const TERMINAL_STATE: WorkflowState = "reviewed";

/**
 * Allowed transitions. Regeneration and further edits move a thread back from
 * `pending_review` to `drafting`, which is why that edge exists.
 */
const TRANSITIONS: Readonly<Record<WorkflowState, readonly WorkflowState[]>> = {
  received: ["drafting"],
  drafting: ["pending_review"],
  pending_review: ["drafting", "reviewed"],
  reviewed: [],
};

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function nextStates(from: WorkflowState): readonly WorkflowState[] {
  return TRANSITIONS[from];
}

export function isTerminal(state: WorkflowState): boolean {
  return TRANSITIONS[state].length === 0;
}
