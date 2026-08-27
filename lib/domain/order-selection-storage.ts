/**
 * Remembering which order a reviewer picked, in their own browser and nowhere
 * else.
 *
 * WHY THE BROWSER AND NOT THE DATABASE. The application schema reserves
 * `verification_method = 'user_confirmed'` for a confirmation that names the
 * confirming user, and this phase has no user identity to name — so there is
 * no honest way to write a selection into `context_snapshots`, and inventing a
 * user to satisfy the constraint would put a false name on an audit record.
 * A reviewer's working choice is not a business fact anyway: it is a note to
 * themselves about which of several real orders they are looking at. Browser
 * storage is the right size for that, and it needs no migration.
 *
 * NOT A CONFIRMATION, AND NOT SHARED. Nothing here is sent anywhere, and a
 * second reviewer opening the same conversation sees no selection — which is
 * correct, because nobody has confirmed anything. The choice grounds the
 * generations run by the person who made it, and stops there.
 *
 * KEYED PER CONVERSATION. Two conversations cannot see each other's choice,
 * so switching away and back restores the right one and switching to a
 * different thread restores nothing.
 *
 * STORAGE IS ALLOWED TO FAIL. Safari's private mode throws on `setItem`, a
 * quota can be full, and an embedded webview may deny storage entirely. Every
 * call here is wrapped: losing a remembered selection is a small annoyance,
 * and a panel that throws while rendering an order is not.
 *
 * PURE OVER AN INJECTED STORE. These take a `StorageLike` rather than reaching
 * for `window`, so the rules below are testable without a DOM.
 */

/** The slice of the Web Storage API this needs. */
export type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

/**
 * Namespaced so a key cannot collide with anything else on the origin, and so
 * every stored selection is identifiable at a glance in devtools.
 */
export const ORDER_SELECTION_KEY_PREFIX = "cst.selected-order.";

export function orderSelectionKey(conversationId: string): string {
  return `${ORDER_SELECTION_KEY_PREFIX}${conversationId}`;
}

/** The selection remembered for one conversation, or null if there is none. */
export function readStoredSelection(
  storage: StorageLike | null,
  conversationId: string,
): string | null {
  if (storage === null) return null;
  try {
    const stored = storage.getItem(orderSelectionKey(conversationId));
    return stored === null || stored.trim() === "" ? null : stored;
  } catch {
    return null;
  }
}

/** Remembers a selection, or forgets it when given null. */
export function saveStoredSelection(
  storage: StorageLike | null,
  conversationId: string,
  orderNumber: string | null,
): void {
  if (storage === null) return;
  try {
    const key = orderSelectionKey(conversationId);
    if (orderNumber === null || orderNumber.trim() === "") {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, orderNumber);
  } catch {
    // Storage refused. The in-memory selection still works for this visit.
  }
}

/**
 * The stored selection, but only if it is still one of the orders on screen.
 *
 * WHY VALIDATION IS NOT OPTIONAL. What was stored yesterday may not be a
 * choice today: the buyer may have ordered again, an order may have been
 * cancelled, or the source may simply return a different set. Restoring a
 * value that is no longer in the list would tick nothing on screen while
 * quietly grounding the next draft in an order the reviewer can no longer see
 * — the worst of both. A stale value is discarded and treated as no selection.
 *
 * This is a display-side check, not the security one: `resolveSelectedOrderContext`
 * independently re-matches the chosen number against the orders the resolver
 * itself found before any fact is built from it.
 */
export function restorableSelection(
  stored: string | null,
  availableOrderNumbers: readonly (string | null)[],
): string | null {
  if (stored === null) return null;
  return availableOrderNumbers.includes(stored) ? stored : null;
}

/**
 * The real store, or null where there isn't one.
 *
 * Null during server rendering (no `window`) and wherever the browser denies
 * access. Every function above takes null happily, so callers need no second
 * branch for it.
 */
export function browserOrderSelectionStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}
