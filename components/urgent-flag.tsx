import {
  URGENT_DESCRIPTION,
  URGENT_LABEL,
  URGENT_UNVERIFIED_DESCRIPTION,
  URGENT_UNVERIFIED_LABEL,
} from "@/lib/domain/before-shipment-urgency";

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
   * Whether the order behind this row was actually found.
   *
   * DEFAULTS TO TRUE so every existing caller keeps the badge it already
   * renders. Only the inbox list, which knows the outcome, passes `false`.
   *
   * WHY THE TWO MUST LOOK DIFFERENT. A row flagged because the customer asked
   * us to stop an order we CANNOT SEE is urgent for a different reason than one
   * whose order was looked up and is still in the warehouse. Wearing the
   * confident badge, it would tell an agent the parcel has not shipped — which
   * is exactly what we failed to establish. Same red, because both are the same
   * priority; a question mark and different hover text, because they are not
   * the same claim.
   */
  orderVerified = true,
}: {
  urgent: boolean;
  orderVerified?: boolean;
}) {
  if (!urgent) return null;
  const description = orderVerified ? URGENT_DESCRIPTION : URGENT_UNVERIFIED_DESCRIPTION;
  return (
    <span
      title={description}
      aria-label={description}
      className="inline-flex shrink-0 items-center rounded-sm bg-red-600 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white uppercase dark:bg-red-500"
    >
      {orderVerified ? URGENT_LABEL : URGENT_UNVERIFIED_LABEL}
    </span>
  );
}
