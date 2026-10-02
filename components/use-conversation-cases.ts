"use client";

import { useEffect, useState } from "react";

import type { CaseDetectionResponse } from "@/lib/domain/marketplace-case-display";

/**
 * The marketplace cases already on record for the conversation currently open.
 *
 * ------------------------------------------------------------------------
 * ONE FETCH PER CONVERSATION, AND STALE ANSWERS ARE DISCARDED
 * ------------------------------------------------------------------------
 * The effect is keyed on `conversationId` alone, so it runs when the agent
 * selects a different thread and at no other time. It does NOT re-run on
 * ordinary re-renders, on a draft being generated, or on a workflow change —
 * none of those changes which cases exist.
 *
 * `cancelled` guards a specific wrong screen: two conversations opened quickly
 * in succession can have their responses arrive out of order, and without it
 * the FIRST customer's case list would land in the second customer's panel and
 * stay there. The same shape `useCustomerHistory` uses, for the same reason —
 * and here the consequence is worse, because a case list names order references
 * and an agent could act on one belonging to someone else.
 *
 * ------------------------------------------------------------------------
 * THREE STATES HERE, FIVE ON THE PAYLOAD, AND NONE OF THEM MAY COLLAPSE
 * ------------------------------------------------------------------------
 *   state === "loading"      nothing is known yet. Render NOTHING — not a
 *                            list, not an "all clear".
 *   state === "unavailable"  the request failed. Render the sentence that says
 *                            the records could not be CHECKED. This is not
 *                            "no cases", and an API error must never be drawn
 *                            as a clean record.
 *   state === "ready"        the question was asked and answered, and
 *                            `data.state` says which of the four answers it
 *                            was: cases found, a published snapshot searched
 *                            and empty, a marketplace never imported, or no
 *                            verified order or customer to search on.
 *
 * Every `setState` sits after an `await`, because a synchronous `setState` in
 * an effect body trips `react-hooks/set-state-in-effect` and causes a
 * cascading render. The previous conversation's answer cannot linger, because
 * the state resets to `loading` keyed on the id — see the reset below.
 */

export type ConversationCasesState =
  | { readonly state: "loading" }
  | { readonly state: "unavailable" }
  | { readonly state: "ready"; readonly data: CaseDetectionResponse };

const LOADING: ConversationCasesState = { state: "loading" };
const UNAVAILABLE: ConversationCasesState = { state: "unavailable" };

export function useConversationCases(conversationId: string | null): ConversationCasesState {
  const [state, setState] = useState<ConversationCasesState>(LOADING);
  /**
   * Which conversation `state` belongs to.
   *
   * THIS IS THE STALE-LIST GUARD, and `cancelled` alone is not enough for it.
   * `cancelled` stops a late RESPONSE from landing, but between the agent
   * clicking a new conversation and its first response arriving, `state` still
   * holds the PREVIOUS customer's cases — so the old list would render over the
   * new thread for as long as the request takes.
   *
   * Comparing during render and resetting is the pattern React documents for
   * adjusting state on prop change, and it is what this repository's lint rules
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
        const response = await fetch(`/api/conversations/${conversationId}/cases`);
        if (!response.ok) throw new Error("request failed");
        const payload = (await response.json()) as CaseDetectionResponse;
        if (cancelled) return;
        setState({ state: "ready", data: payload });
      } catch {
        /*
         * Reported as "could not be checked", never as an empty list. Of the
         * two possible mistakes — telling an agent a case exists when it does
         * not, or telling them the check failed when it did — only the first
         * can send them to the wrong answer, and an empty list after a failed
         * request would be the first dressed as the second.
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
