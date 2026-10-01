"use client";

import { useEffect, useState } from "react";

import type {
  WarningReasonType,
} from "@/lib/domain/repeat-customer-warning";

/**
 * The Repeat-Customer Warning for the conversation currently open.
 *
 * ------------------------------------------------------------------------
 * ONE FETCH PER CONVERSATION, AND STALE ANSWERS ARE DISCARDED
 * ------------------------------------------------------------------------
 * The effect is keyed on `conversationId` alone, so it runs when the agent
 * selects a different thread and at no other time. It does NOT re-run on
 * ordinary re-renders, on a draft being generated or on a workflow change —
 * none of those alters a customer's prior history.
 *
 * `cancelled` is the important part, and it guards a specific wrong screen:
 * two conversations opened quickly in succession can have their responses
 * arrive out of order, and without this the FIRST customer's history would
 * land in the second customer's header and stay there. The same shape
 * `useConversationFollowUps` uses, for the same reason.
 *
 * ------------------------------------------------------------------------
 * THE THREE STATES ARE DISTINCT, AND COLLAPSING ANY TWO IS THE BUG
 * ------------------------------------------------------------------------
 *   state === "loading"      nothing is known yet. Render NOTHING — not a
 *                            warning, not an "all clear".
 *   state === "unavailable"  the lookup could not run (unsupported
 *                            marketplace, platform sender, request failed).
 *                            Render NOTHING. This is not "no history".
 *   state === "ready"        the question was asked and answered. Render the
 *                            warning if `warning` is true, otherwise nothing.
 *
 * A failed request becomes `unavailable`, never `ready` with zero counts — an
 * API error must never be displayed as a clean history.
 *
 * Every `setState` sits after an `await`, because a synchronous `setState` in
 * an effect body trips `react-hooks/set-state-in-effect` and causes a
 * cascading render. The previous conversation's answer cannot linger, because
 * the state resets to `loading` keyed on the id — see the reset below.
 */

export type CustomerHistoryReason = {
  readonly type: WarningReasonType | string;
  readonly count: number;
};

export type CustomerHistoryState =
  | { readonly state: "loading" }
  | { readonly state: "unavailable" }
  | {
      readonly state: "ready";
      readonly warning: boolean;
      readonly reasons: readonly CustomerHistoryReason[];
      readonly unavailableSignals: readonly string[];
      readonly historyAsOf: string | null;
    };

type Payload = {
  available?: boolean;
  warning?: boolean;
  reasons?: readonly CustomerHistoryReason[];
  unavailableSignals?: readonly string[];
  historyAsOf?: string | null;
};

const LOADING: CustomerHistoryState = { state: "loading" };
const UNAVAILABLE: CustomerHistoryState = { state: "unavailable" };

export function useCustomerHistory(conversationId: string | null): CustomerHistoryState {
  const [state, setState] = useState<CustomerHistoryState>(LOADING);
  /**
   * Which conversation `state` belongs to.
   *
   * THIS IS THE STALE-WARNING GUARD, and `cancelled` alone is not enough for
   * it. `cancelled` stops a late RESPONSE from landing, but between the agent
   * clicking a new conversation and its first response arriving, `state` still
   * holds the PREVIOUS customer's answer — so the old warning would render
   * over the new thread for as long as the request takes.
   *
   * Comparing during render and resetting is the pattern React documents for
   * adjusting state on prop change, and it is what the repository's lint rules
   * allow: a `useEffect` doing this would be a synchronous `setState` in an
   * effect body.
   */
  const [loadedFor, setLoadedFor] = useState<string | null>(conversationId);

  if (conversationId !== loadedFor) {
    setLoadedFor(conversationId);
    setState(LOADING);
  }

  useEffect(() => {
    if (conversationId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/api/conversations/${conversationId}/customer-history`,
        );
        if (!response.ok) throw new Error("request failed");
        const payload = (await response.json()) as Payload;
        if (cancelled) return;
        /*
         * `available === false` is the server saying it could not establish a
         * verified customer. It maps to `unavailable`, NOT to a ready state
         * with no reasons — the interface must stay silent rather than imply a
         * clean history.
         */
        if (payload.available !== true) {
          setState(UNAVAILABLE);
          return;
        }
        setState({
          state: "ready",
          warning: payload.warning === true,
          reasons: payload.reasons ?? [],
          unavailableSignals: payload.unavailableSignals ?? [],
          historyAsOf: payload.historyAsOf ?? null,
        });
      } catch {
        /*
         * No reason is surfaced and no warning is shown. An unreadable history
         * and a clean one must not look the same, and of the two possible
         * mistakes — hiding a real warning, or inventing one — hiding is the
         * one that cannot mislead an agent about a customer.
         */
        if (cancelled) return;
        setState(UNAVAILABLE);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  return state;
}
