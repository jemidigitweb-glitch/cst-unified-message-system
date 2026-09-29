import { describe, expect, it } from "vitest";

import {
  MESSAGE_APP_ROOT_CAUSE_HEADING,
  type MessageAppRootCauseCandidate,
  type MessageAppRootCauseResponse,
  ambiguousRootCauseNotice,
  messageAppRootCauseView,
  resolveMessageAppRootCause,
  rootCauseLabelKey,
  sameRootCauseLabel,
} from "@/lib/domain/message-app-root-cause";

/**
 * The resolution rule, unit-tested without a database.
 *
 * Every label used here is a real value observed in the source vocabulary, but no
 * customer data appears: a root cause is a business classification, and the two
 * free-text cases below are written for this test rather than copied from a row.
 *
 * CANDIDATES ARE NEWEST FIRST in every case, because that is the contract the
 * repository satisfies and the only ordering this function is defined against.
 */

function candidates(...values: (string | null)[]): MessageAppRootCauseCandidate[] {
  return values.map((value) => ({ value }));
}

describe("resolveMessageAppRootCause", () => {
  it("resolves a single stored label", () => {
    const result = resolveMessageAppRootCause(candidates("FULFILMENT_CARRIER"));

    expect(result).toEqual({
      state: "resolved",
      value: "FULFILMENT_CARRIER",
      distinctLabelCount: 1,
    });
  });

  it("resolves when the classifier wrote the same label across a thread slice", () => {
    // The message application's classifier writes one label to every row of the
    // slice it selected, so repetition is the NORMAL shape, not a conflict.
    const result = resolveMessageAppRootCause(
      candidates("Delivery Issue", "Delivery Issue", "Delivery Issue"),
    );

    expect(result.state).toBe("resolved");
    expect(result.value).toBe("Delivery Issue");
    expect(result.distinctLabelCount).toBe(1);
  });

  it("reports nothing recorded rather than an empty value", () => {
    for (const empty of [candidates(), candidates(null), candidates(null, null)]) {
      const result = resolveMessageAppRootCause(empty);
      expect(result).toEqual({ state: "unavailable", value: null, distinctLabelCount: 0 });
    }
  });

  it("treats a blank string as nothing recorded, not as a value", () => {
    // Saving an empty root cause clears it. It lands as NULL through the current
    // writer and as '' on rows older code touched; both mean the same thing, and
    // neither may reach the panel as a label made of spaces.
    const result = resolveMessageAppRootCause(candidates("", "   ", "\t\n"));

    expect(result.state).toBe("unavailable");
    expect(result.value).toBeNull();
  });

  it("ignores blank rows without losing the value beside them", () => {
    const result = resolveMessageAppRootCause(candidates("", null, "RETURN"));

    expect(result.state).toBe("resolved");
    expect(result.value).toBe("RETURN");
  });

  it("refuses to choose between two different labels", () => {
    const result = resolveMessageAppRootCause(candidates("FULFILMENT_CARRIER", "PRODUCT_QUALITY"));

    expect(result.state).toBe("ambiguous");
    // The point of the whole rule: NEITHER label is returned. Taking the newest
    // is what the owning application does, and it can — it is about to overwrite
    // the row. This cannot write, so it must not pick.
    expect(result.value).toBeNull();
    expect(result.distinctLabelCount).toBe(2);
  });

  it("counts how many distinct labels disagree", () => {
    const result = resolveMessageAppRootCause(
      candidates("RETURN", "INVOICE", "Wrong Address", "RETURN"),
    );

    expect(result.state).toBe("ambiguous");
    expect(result.distinctLabelCount).toBe(3);
  });

  describe("case variants are one label, and the stored text is never rewritten", () => {
    it("does not treat a case variant as a conflict", () => {
      // Both spellings are live in the source, because the writer's validation
      // folds case (strcasecmp) while its storage is verbatim.
      const result = resolveMessageAppRootCause(candidates("Out of stock", "OUT OF STOCK"));

      expect(result.state).toBe("resolved");
      expect(result.distinctLabelCount).toBe(1);
    });

    it("returns the newest spelling exactly as stored", () => {
      expect(resolveMessageAppRootCause(candidates("Out of stock", "OUT OF STOCK")).value).toBe(
        "Out of stock",
      );
      // Same two rows, other way round: the answer follows the ORDER, and in
      // neither direction is the string re-cased to a canonical form.
      expect(resolveMessageAppRootCause(candidates("OUT OF STOCK", "Out of stock")).value).toBe(
        "OUT OF STOCK",
      );
    });

    it("does not upper-case, lower-case or trim the displayed value", () => {
      const stored = "  Charge Back  ";
      const result = resolveMessageAppRootCause(candidates(stored));

      expect(result.value).toBe(stored);
      expect(result.value).not.toBe(stored.trim());
    });

    it("folds padding and case for comparison only", () => {
      expect(sameRootCauseLabel("RETURN", "  return ")).toBe(true);
      expect(sameRootCauseLabel("RETURN", "Return")).toBe(true);
      expect(sameRootCauseLabel("RETURN", "RETURNS")).toBe(false);
      expect(rootCauseLabelKey("  Out Of Stock ")).toBe("out of stock");
    });
  });

  describe("free text from the OTHER flow is valid data", () => {
    /*
     * The message application REFUSES to store the literal label `OTHER`: it
     * demands at least 30 characters of explanation and saves that prose as the
     * root cause. So free text is not a data-quality problem to clean up, it is
     * the designed output of a supported path, and it must survive intact.
     */
    const prose =
      "Customer is returning the item themselves and the courier has not collected it yet.";

    it("preserves a free-text root cause exactly", () => {
      const result = resolveMessageAppRootCause(candidates(prose));

      expect(result.state).toBe("resolved");
      expect(result.value).toBe(prose);
    });

    it("does not reject free text for failing to match a known label", () => {
      // Nothing here consults a vocabulary. There is no allowlist to fail.
      expect(resolveMessageAppRootCause(candidates("no stock, customer declined the alternative")).state).toBe(
        "resolved",
      );
    });

    it("preserves newlines rather than collapsing them", () => {
      const multiline = "Tracking stopped after handover.\nCourier opened a lost-parcel case.";
      expect(resolveMessageAppRootCause(candidates(multiline)).value).toBe(multiline);
    });

    it("treats free text and a standard label on one thread as ambiguous", () => {
      const result = resolveMessageAppRootCause(candidates(prose, "RETURN"));

      expect(result.state).toBe("ambiguous");
      expect(result.value).toBeNull();
    });
  });
});

describe("what the panel is given to render", () => {
  it("names the section for the system that owns the value", () => {
    // Not "Root cause": CST does not have one. The heading says whose it is, so
    // a reviewer cannot read it as something CST concluded or can change.
    expect(MESSAGE_APP_ROOT_CAUSE_HEADING).toBe("System Suggestion");
  });

  it("states the disagreement without naming any of the labels", () => {
    const notice = ambiguousRootCauseNotice(2);

    expect(notice).toContain("2 different root causes");
    expect(notice).toContain("none is shown");
    expect(notice).not.toMatch(/FULFILMENT|RETURN|PRODUCT_QUALITY/);
  });

  /*
   * The projection the panel renders from. It exists so the component never
   * names a resolution state -- `tests/guards/order-context-display.test.ts`
   * forbids that vocabulary in the panel, and the decision is a rule, so it is
   * tested here rather than asserted about JSX.
   */
  describe("messageAppRootCauseView", () => {
    function response(
      overrides: Partial<MessageAppRootCauseResponse>,
    ): MessageAppRootCauseResponse {
      return {
        conversationId: "42",
        state: "unavailable",
        value: null,
        distinctLabelCount: 0,
        sourceRowCount: 1,
        unreadableSourceRowCount: 0,
        ...overrides,
      };
    }

    it("hides the section while there is no response yet", () => {
      expect(messageAppRootCauseView(null)).toEqual({ kind: "hidden" });
    });

    it("hides the section when nothing is recorded", () => {
      expect(messageAppRootCauseView(response({ state: "unavailable" }))).toEqual({
        kind: "hidden",
      });
    });

    it("shows the stored value verbatim when one resolves", () => {
      const view = messageAppRootCauseView(
        response({ state: "resolved", value: "Out of stock", distinctLabelCount: 1 }),
      );

      expect(view).toEqual({ kind: "value", value: "Out of stock" });
    });

    it("shows a sentence and no label when values disagree", () => {
      const view = messageAppRootCauseView(
        response({ state: "ambiguous", value: null, distinctLabelCount: 2 }),
      );

      expect(view.kind).toBe("notice");
      expect(view).toEqual({ kind: "notice", text: ambiguousRootCauseNotice(2) });
    });

    it("hides rather than draws a heading over a blank label", () => {
      // `resolved` carries a value by construction. A malformed payload from
      // anywhere must still not render an empty row under a heading.
      for (const value of [null, "", "   "]) {
        expect(messageAppRootCauseView(response({ state: "resolved", value }))).toEqual({
          kind: "hidden",
        });
      }
    });
  });
});
