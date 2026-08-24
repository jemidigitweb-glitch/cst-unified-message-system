"use client";

import type { Marketplace } from "@/lib/domain/marketplace";
import {
  MARKETPLACE_TAB_ORDER,
  capabilityOf,
} from "@/lib/domain/marketplace-capabilities";

/**
 * Marketplace tabs.
 *
 * All five are visible, in a fixed product-defined order, and every one is
 * clickable. None is disabled, greyed out, or marked "coming soon".
 *
 * That is a truthfulness decision, not a cosmetic one. Every one of these
 * sources holds real messages right now. A disabled tab says there is nothing
 * there; what is actually true is that some sources prove less about their
 * messages than others. The tab opens either way and the panel behind it states
 * exactly what is and is not established.
 */
export function MarketplaceTabs({
  selected,
  onSelect,
}: {
  selected: Marketplace;
  onSelect: (marketplace: Marketplace) => void;
}) {
  return (
    <nav aria-label="Marketplace" className="flex min-w-0 gap-1 overflow-x-auto px-4">
      {MARKETPLACE_TAB_ORDER.map((marketplace) => {
        const capability = capabilityOf(marketplace);
        const active = marketplace === selected;
        return (
          <button
            key={marketplace}
            type="button"
            role="tab"
            aria-selected={active}
            data-marketplace={marketplace}
            data-mode={capability.mode}
            onClick={() => onSelect(marketplace)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              active
                ? "border-emerald-600 font-medium dark:border-emerald-400"
                : "border-transparent hover:border-black/20 dark:hover:border-white/25"
            }`}
          >
            {capability.label}
          </button>
        );
      })}
    </nav>
  );
}
