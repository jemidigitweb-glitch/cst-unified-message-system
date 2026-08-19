import { describe, expect, it } from "vitest";

import {
  TERMINAL_STATE,
  WORKFLOW_STATES,
  canTransition,
  isTerminal,
  nextStates,
  workflowStateSchema,
} from "@/lib/domain/workflow";

describe("Phase 1 workflow", () => {
  it("contains exactly the four Phase 1 states", () => {
    expect(WORKFLOW_STATES).toEqual(["received", "drafting", "pending_review", "reviewed"]);
  });

  it("has no state capable of transmitting a reply", () => {
    const forbidden = ["approved", "sending", "sent", "manual_handoff", "queued", "delivered"];
    for (const state of forbidden) {
      expect(WORKFLOW_STATES as readonly string[]).not.toContain(state);
      expect(workflowStateSchema.safeParse(state).success).toBe(false);
    }
  });

  it("walks the happy path to reviewed", () => {
    expect(canTransition("received", "drafting")).toBe(true);
    expect(canTransition("drafting", "pending_review")).toBe(true);
    expect(canTransition("pending_review", "reviewed")).toBe(true);
  });

  it("allows returning to drafting for edits and regeneration", () => {
    expect(canTransition("pending_review", "drafting")).toBe(true);
  });

  it("treats reviewed as terminal", () => {
    expect(TERMINAL_STATE).toBe("reviewed");
    expect(isTerminal("reviewed")).toBe(true);
    expect(nextStates("reviewed")).toEqual([]);
    for (const state of WORKFLOW_STATES) {
      expect(canTransition("reviewed", state)).toBe(false);
    }
  });

  it("rejects skipping review", () => {
    expect(canTransition("received", "reviewed")).toBe(false);
    expect(canTransition("drafting", "reviewed")).toBe(false);
  });
});
