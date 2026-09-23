"use client";

import { useEffect, useState } from "react";

import type { AutomationDispatchDetails } from "@/lib/domain/automation/automation-dispatch-detail-service";
import type { AutomationItem } from "@/lib/domain/automation/automation-types";
import {
  NOT_AVAILABLE,
  datePart,
  timePart,
} from "@/lib/domain/automation/dispatch-detail-view";

import { StatusBadge, inZone, moment, statusLabel } from "./automation-status-badge";

/**
 * What is really behind one post-dispatch record.
 *
 * A DRAWER, BECAUSE THAT IS WHAT THIS WORKSPACE ALREADY USES. Backdrop that
 * dismisses on click, `role="dialog"`, panel on the right — the same shell as
 * `notification-drawer.tsx`, so this screen gains no new interaction idiom.
 *
 * ------------------------------------------------------------------------
 * "NOT AVAILABLE" MEANS THE SOURCE HAS NO VALUE
 * ------------------------------------------------------------------------
 * Every field goes through `Field`, and a null prints NOT_AVAILABLE. Nothing on
 * this screen is defaulted, inferred or filled in from a neighbouring column: a
 * shipment with no carrier says so. Real dispatched orders store
 * `order_info.shipping_method` as an empty string, which is why blanks are
 * normalised to null in the repository rather than printed as nothing at all.
 *
 * THE DISPATCH TIME IS THE RECORD'S OWN. It is read from `item.dispatchedAt`, the
 * column the Records table prints, and never from the live shipment read that
 * sits beside it in the same payload. `automation-dispatch-detail-service.ts`
 * explains why at length. Where the source has since moved, the drift is shown as
 * its own line, clearly labelled, and the displayed dispatch time does not change.
 *
 * THE COURIER IS THE RESOLVED NAME. `carrier_service.carrier` is what a reviewer
 * is told; the numeric `carrier_service_id` appears only when no name resolves,
 * and then it is labelled as an unresolved id rather than presented as a courier.
 */

/** One labelled value. A null is the absent case and says so in words. */
function Field({
  label,
  value,
  mono = false,
  hint,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  hint?: string;
}) {
  const absent = value === null || value.trim() === "";
  return (
    <div className="flex flex-col gap-0.5 py-1.5">
      <dt className="text-[11px] uppercase tracking-wide opacity-55">{label}</dt>
      <dd
        className={`text-sm ${mono && !absent ? "font-mono" : ""} ${absent ? "opacity-50 italic" : ""}`}
      >
        {absent ? NOT_AVAILABLE : value}
      </dd>
      {hint === undefined ? null : <p className="text-[10px] opacity-50">{hint}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-black/10 px-4 py-3 first:border-t-0 dark:border-white/15">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-70">{title}</h3>
      <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">{children}</dl>
    </section>
  );
}

export function AutomationDispatchDetailDrawer({
  item,
  onClose,
}: {
  /** The row that was clicked. Its stored values are shown while the source loads. */
  item: AutomationItem;
  onClose: () => void;
}) {
  const [details, setDetails] = useState<AutomationDispatchDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * NO STATE IS RESET HERE, and that is why this effect does not call setState
   * synchronously. The parent mounts this panel with `key={item.id}`, so clicking
   * a different order number REMOUNTS it and the two `useState` initialisers
   * above are the reset. Clearing them in the effect body instead would be the
   * cascading-render pattern `react-hooks/set-state-in-effect` exists to catch.
   */
  useEffect(() => {
    // `ignore` rather than an abort: a reviewer clicking two order numbers
    // quickly must not have the first response paint over the second.
    let ignore = false;
    void (async () => {
      try {
        const response = await fetch(`/api/automations/${item.id}/shipment-details`);
        const payload = (await response.json().catch(() => null)) as
          | (AutomationDispatchDetails & { error?: string })
          | null;
        if (ignore) return;
        if (!response.ok) {
          setError(payload?.error ?? "Unable to load dispatch details.");
          return;
        }
        setDetails(payload as AutomationDispatchDetails);
      } catch {
        if (!ignore) setError("Unable to load dispatch details.");
      }
    })();
    return () => {
      ignore = true;
    };
  }, [item.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const event = details?.event ?? null;
  const shipment = details?.shipment ?? null;
  const title = `Order ${item.orderNumber ?? item.orderId}`;

  /*
   * THE COURIER, AND ONLY A REAL ONE.
   *
   * `carrier_service.carrier` is the courier. Where it does not resolve, the
   * field is absent — the numeric service id is reported on its own line, as an
   * id, rather than standing in for a name it is not.
   */
  const courier = event?.carrier ?? null;

  return (
    <>
      <div onClick={onClose} aria-hidden className="fixed inset-0 z-40 bg-black/40" />
      <div
        role="dialog"
        aria-label={title}
        data-testid="dispatch-detail-drawer"
        className="fixed inset-y-0 right-0 z-50 flex w-[90vw] max-w-md flex-col overflow-y-auto border-l border-black/10 bg-[var(--background)] shadow-xl dark:border-white/15"
      >
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-black/10 px-4 py-3 dark:border-white/15">
          <div className="flex flex-col gap-0.5">
            <h2 className="font-mono text-sm font-semibold">{title}</h2>
            <p className="text-[11px] opacity-70">
              Read from the order system · nothing on this panel contacts a customer
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg border border-black/15 px-2 py-1 text-xs dark:border-white/20"
          >
            Close
          </button>
        </div>

        {error !== null ? (
          <p data-testid="dispatch-detail-error" className="px-4 py-3 text-sm text-red-600">
            {error}
          </p>
        ) : null}

        {details === null && error === null ? (
          <p data-testid="dispatch-detail-loading" className="px-4 py-3 text-sm opacity-70">
            Loading dispatch details…
          </p>
        ) : null}

        {/* Order — the record's own identifiers, which are never in doubt. */}
        <Section title="Order details">
          <Field label="Order number" value={item.orderNumber ?? item.orderId} mono />
          <Field label="Marketplace / channel" value={item.channel} />
          <Field
            label="Storefront"
            value={event?.subSourceName ?? String(item.subSourceId)}
            hint={event?.subSourceName === null ? "Storefront name not recorded" : undefined}
          />
          <Field label="Customer" value={event?.customerName ?? item.recipientName} />
          <Field label="Order status" value={event?.orderStatus ?? null} />
        </Section>

        <Section title="Dispatch details">
          <Field label="Shipment ID" value={item.shipmentId} mono />
          {/*
            THE SAME TIMESTAMP THE RECORDS TABLE PRINTS, split for reading. Taken
            from the record, whose `dispatch_source` names the column it came
            from, so the table and this panel can never disagree.
          */}
          <Field
            label="Dispatch date"
            value={datePart(item.dispatchedAt)}
            mono
            hint={`${item.dispatchSource} · ${item.dispatchTimeZone}`}
          />
          <Field label="Dispatch time" value={timePart(item.dispatchedAt)} mono />
          <Field label="Shipment status" value={event?.shipmentStatus ?? null} />
          <Field label="Shipping method" value={shipment?.shippingMethod ?? null} />
          <Field label="Courier / carrier" value={courier} />
          <Field label="Carrier service" value={shipment?.carrierServiceName ?? null} />
          <Field label="Tracking number" value={event?.trackingNumber ?? null} mono />
          <Field
            label="Shipment created"
            value={shipment?.shipmentCreatedAt ?? null}
            mono
            hint="When the label was written, not when the parcel left"
          />
          <Field label="Shipment cancelled" value={shipment?.cancelledAt ?? null} />
          {/* Only shown when it resolved to nothing — never as the courier. */}
          {courier === null && shipment?.carrierServiceId != null ? (
            <Field
              label="Unresolved carrier service id"
              value={shipment.carrierServiceId}
              mono
              hint="No carrier name resolves for this id in the order system"
            />
          ) : null}
          {shipment?.shippedError == null ? null : (
            <Field label="Dispatch error recorded" value={shipment.shippedError} />
          )}
          {shipment === null || shipment.shipmentsOnOrder <= 1 ? null : (
            <Field
              label="Shipments on this order"
              value={String(shipment.shipmentsOnOrder)}
              hint="This panel shows the shipment this record was scheduled for"
            />
          )}
        </Section>

        {/*
          A dispatch timestamp that has moved since the record was written. Its
          own line, clearly labelled, and it does NOT change what is shown above.
        */}
        {details?.dispatchDrift == null ? null : (
          <Section title="Dispatch timestamp changed at source">
            <Field label="Scheduled from" value={details.dispatchDrift.recorded} mono />
            <Field label="Source now reads" value={details.dispatchDrift.sourceNow} mono />
          </Section>
        )}

        {details !== null && details.event === null && details.shipment === null ? (
          <p className="px-4 py-3 text-sm opacity-70">
            The order system no longer returns shipment {item.shipmentId}. The automation details
            below are unaffected.
          </p>
        ) : null}

        <Section title="Automation details">
          <Field label="Automation type" value={item.automationKey} />
          <Field
            label="Template"
            value={`${item.templateName ?? item.templateId} (v${item.templateVersion})`}
          />
          <Field
            label="Scheduled time"
            value={inZone(item.scheduledAt, item.dispatchTimeZone)}
            mono
            hint={`${moment(item.scheduledAt)} local`}
          />
          <Field label="Automation status" value={statusLabel(item.status, item.testMode)} />
          <Field
            label="Test mode"
            value={item.testMode ? "Yes — nothing is sent" : "No — a transport is connected"}
          />
          <Field label="Processed at" value={item.processedAt === null ? null : moment(item.processedAt)} />
          <Field label="Last updated" value={moment(item.updatedAt)} />
          {item.skipReason === null ? null : <Field label="Skip reason" value={item.skipReason} />}
          {item.lastError === null ? null : <Field label="Failure reason" value={item.lastError} />}
          {item.cancelledAt === null ? null : (
            <Field label="Cancelled at" value={moment(item.cancelledAt)} />
          )}
          {item.cancelledReason === null ? null : (
            <Field label="Cancellation reason" value={item.cancelledReason} />
          )}
          <div className="py-1.5">
            <dt className="text-[11px] uppercase tracking-wide opacity-55">Current state</dt>
            <dd className="mt-1">
              <StatusBadge status={item.status} testMode={item.testMode} />
            </dd>
          </div>
        </Section>
      </div>
    </>
  );
}
