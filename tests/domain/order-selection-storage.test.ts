import { describe, expect, it } from "vitest";

import {
  ORDER_SELECTION_KEY_PREFIX,
  type StorageLike,
  orderSelectionKey,
  readStoredSelection,
  restorableSelection,
  saveStoredSelection,
} from "@/lib/domain/order-selection-storage";

/**
 * A remembered selection grounds the next draft. So the rules that decide
 * whether to restore one matter as much as the storing does — a stale value
 * restored without checking would tick nothing on screen while still reaching
 * the model.
 */

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: StorageLike = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  return { data, storage };
}

/** Safari private mode throws on setItem; an embedded webview may deny it all. */
function refusingStorage(): StorageLike {
  return {
    getItem: () => {
      throw new Error("storage denied");
    },
    setItem: () => {
      throw new Error("storage denied");
    },
    removeItem: () => {
      throw new Error("storage denied");
    },
  };
}

describe("keys are per conversation", () => {
  it("namespaces the key and includes the conversation id", () => {
    expect(orderSelectionKey("32103")).toBe(`${ORDER_SELECTION_KEY_PREFIX}32103`);
  });

  /**
   * The whole reason switching conversations shows no selection: two threads
   * cannot read each other's key.
   */
  it("gives two conversations different keys, so neither sees the other's choice", () => {
    const { storage } = fakeStorage();
    saveStoredSelection(storage, "32103", "00-00000-00000");

    expect(readStoredSelection(storage, "32103")).toBe("00-00000-00000");
    expect(readStoredSelection(storage, "32104")).toBeNull();
  });
});

describe("storing and reading back", () => {
  it("remembers a selection and returns it on the next read", () => {
    const { storage } = fakeStorage();
    saveStoredSelection(storage, "32103", "12-34567-89012");
    expect(readStoredSelection(storage, "32103")).toBe("12-34567-89012");
  });

  it("forgets the selection when it is cleared", () => {
    const { data, storage } = fakeStorage();
    saveStoredSelection(storage, "32103", "12-34567-89012");
    saveStoredSelection(storage, "32103", null);

    expect(readStoredSelection(storage, "32103")).toBeNull();
    expect(data.has(orderSelectionKey("32103"))).toBe(false);
  });

  it("treats a blank stored value as no selection, and never stores one", () => {
    const { data, storage } = fakeStorage({ [orderSelectionKey("32103")]: "   " });
    expect(readStoredSelection(storage, "32103")).toBeNull();

    saveStoredSelection(storage, "32104", "  ");
    expect(data.has(orderSelectionKey("32104"))).toBe(false);
  });

  it("returns nothing when there is no storage at all", () => {
    expect(readStoredSelection(null, "32103")).toBeNull();
    expect(() => saveStoredSelection(null, "32103", "00-00000-00000")).not.toThrow();
  });

  /**
   * Losing a remembered selection is an annoyance. A panel that throws while
   * rendering an order is not — so a refusing store must be survivable.
   */
  it("survives a storage that refuses every operation", () => {
    const storage = refusingStorage();
    expect(readStoredSelection(storage, "32103")).toBeNull();
    expect(() => saveStoredSelection(storage, "32103", "00-00000-00000")).not.toThrow();
    expect(() => saveStoredSelection(storage, "32103", null)).not.toThrow();
  });
});

describe("a stored selection is only restored if it is still on screen", () => {
  const available = ["00-00000-00000", "12-34567-89012"];

  it("restores a value that is still one of the matching orders", () => {
    expect(restorableSelection("12-34567-89012", available)).toBe("12-34567-89012");
  });

  /**
   * The buyer may have ordered again, or an order may have gone. Restoring a
   * value no longer in the list would arm the next draft with an order the
   * reviewer cannot see.
   */
  it("discards a value that is no longer among the matching orders", () => {
    expect(restorableSelection("NO-SUCH-ORDER", available)).toBeNull();
  });

  it("discards everything when the conversation now matches nothing", () => {
    expect(restorableSelection("00-00000-00000", [])).toBeNull();
  });

  it("has nothing to restore when nothing was stored", () => {
    expect(restorableSelection(null, available)).toBeNull();
  });

  it("ignores a null order number in the list rather than matching on it", () => {
    expect(restorableSelection("00-00000-00000", [null, "12-34567-89012"])).toBeNull();
  });

  it("requires an exact match, never a prefix or a case-insensitive one", () => {
    expect(restorableSelection("00-00000", available)).toBeNull();
    expect(restorableSelection("00-00000-00000 ", available)).toBeNull();
  });
});
