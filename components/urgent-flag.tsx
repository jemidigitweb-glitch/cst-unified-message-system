import { urgentBadge } from "@/lib/domain/before-shipment-urgency";

/**
 * The URGENT badge: a before-shipping query on an order that has not left yet.
 *
 * ------------------------------------------------------------------------
 * WHY A LABELLED CHIP AND NOT ANOTHER RIBBON
 * ------------------------------------------------------------------------
 * `PriorityRibbon` is deliberately wordless — three levels, one colour each —
 * because its job is to be countable at a glance down a column. This is the
 * opposite job. An urgent row is rare and has to say WHAT it is, because red
 * already means HIGH on every row beside it, and a reviewer cannot act on a
 * colour they have seen forty times today.
 *
 * SOLID RED, WHITE TEXT. The category chip uses a 15% tint and the ribbon a
 * solid block; a tinted badge here would read as a twelfth category. Solid red
 * with white text is the only treatment in the list that looks like a warning
 * rather than a label, which is the entire point of it.
 *
 * ------------------------------------------------------------------------
 * IT IS A SIGN, NOT A SWITCH
 * ------------------------------------------------------------------------
 * No button, no handler, no href. It cannot cancel an order, hold a dispatch or
 * message anybody — nothing in this application can. It tells a CST agent which
 * conversation to open first.
 *
 * WHAT RAISES IT IS NOT IN THIS FILE and is not text: see
 * `beforeShipmentEligibility`. The component renders a decision; it does not
 * make one, and it cannot be given one by a word in a message.
 */
export function UrgentFlag({
  urgent,
  /**
   * WHICH outcome raised the flag, so the badge can say the right thing.
   *
   * THREE ROWS WEAR THIS RED AND THEY DO NOT CLAIM THE SAME THING:
   *
   *   `eligible` — we looked the order up and it is still in the warehouse.
   *   The confident badge, and the only one entitled to say so.
   *
   *   `order_state_unverified` — they asked us to stop an order we CANNOT SEE.
   *   Wearing the confident badge it would tell an agent the parcel has not
   *   shipped, which is exactly what we failed to establish.
   *
   *   `unanswered_before_shipping` — a before-shipping case area nobody has
   *   replied to. Says that, and nothing about the parcel.
   *
   * Same red in every case, because all three are the same priority; different
   * word and hover text, because they are different claims.
   *
   * DEFAULTS TO NULL so every existing caller keeps the badge it already
   * renders. The mapping lives in `urgentBadge`, not here — a component that
   * decided this itself is how the flag and the rule disagreed once before.
   */
  outcome = null,
}: {
  urgent: boolean;
  /** The carried `InboxItem.beforeShipmentOutcome` — see `urgentBadge`. */
  outcome?: string | null;
}) {
  if (!urgent) return null;
  const { label, description } = urgentBadge(outcome);
  return (
    <span
      title={description}
      aria-label={description}
      className="inline-flex shrink-0 items-center rounded-sm bg-red-600 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white uppercase dark:bg-red-500"
    >
      {label}
    </span>
  );
}
