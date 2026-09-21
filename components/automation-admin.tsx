"use client";

import { useCallback, useEffect, useState } from "react";

import {
  AUTOMATION_ITEM_STATUSES,
  type AutomationItem,
  type AutomationItemStatus,
  type AutomationSettings,
  type AutomationTemplate,
} from "@/lib/domain/automation/automation-types";

import { StatusBadge, inZone, moment } from "./automation-status-badge";

/**
 * Post-dispatch automation: settings and records, on one page.
 *
 * DELIBERATELY SMALL. Switch it on, say when and where it applies, choose a
 * template, and watch the records. There is nothing to edit, regenerate or
 * review — this automation renders a saved template and records the result —
 * and the only action on a record is to stop one that has not run yet.
 *
 * IT SAYS WHAT TEST MODE MEANS, in the panel and again on every processed row.
 * A screen with a "Sent" column invites exactly one assumption, and it would be
 * wrong: nothing here reaches a customer.
 */

type Queue = {
  settings: AutomationSettings | null;
  templates: AutomationTemplate[];
  scanStatus: { running: boolean; reason: string | null };
  items: AutomationItem[];
  counts: Record<AutomationItemStatus, number> | null;
  page: { page: number; pageSize: number; total: number; status: AutomationItemStatus | null };
  storeReady?: boolean;
};

const PAGE_SIZE = 50;

function SettingsPanel({
  queue,
  onSaved,
}: {
  queue: Queue;
  onSaved: (next: Partial<Queue>) => void;
}) {
  const settings = queue.settings;
  const [notBefore, setNotBefore] = useState(settings?.notBefore?.slice(0, 10) ?? "");
  const [delayHours, setDelayHours] = useState(String(settings?.delayHours ?? 24));
  const [subSources, setSubSources] = useState((settings?.enabledSubSources ?? []).join(", "));
  /*
   * THE TEMPLATE IS NOT ON THIS SCREEN, deliberately.
   *
   * One approved template governs this automation and it is not a per-operator
   * choice. Showing it invited a change whose effect is invisible here — a
   * record stamps its template when it is SCHEDULED, so switching alters
   * nothing already queued and everything queued afterwards. It is set with
   * `PATCH /api/automations/settings` and read back on each record's own row,
   * which is where knowing it actually matters.
   */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch("/api/automations/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = (await response.json().catch(() => null)) as
          | { settings?: AutomationSettings; scanStatus?: Queue["scanStatus"]; error?: string }
          | null;
        if (!response.ok) throw new Error(payload?.error ?? "That change was not accepted.");
        onSaved({ settings: payload?.settings ?? null, scanStatus: payload?.scanStatus });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "That change was not accepted.");
      } finally {
        setBusy(false);
      }
    },
    [onSaved],
  );

  if (settings === null) {
    return (
      <section className="rounded-xl border border-black/10 dark:border-white/15 p-4">
        <h2 className="text-base font-medium">Post-dispatch automation</h2>
        <p className="mt-2 opacity-70">{queue.scanStatus.reason}</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-black/10 dark:border-white/15 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">Post-dispatch automation</h2>
          <p className="text-xs opacity-60">
            When this is on, a dispatched parcel is scheduled for{" "}
            {settings.delayHours} hours later, rechecked when due, and the selected template is
            rendered and recorded.
          </p>
        </div>
        <button
          type="button"
          data-testid="automation-toggle"
          disabled={busy}
          className={`rounded-lg px-4 py-2 font-medium disabled:opacity-50 ${
            settings.enabled
              ? "bg-emerald-600 text-white"
              : "border border-black/15 dark:border-white/20"
          }`}
          onClick={() => void patch({ enabled: !settings.enabled })}
        >
          {busy ? "Saving…" : settings.enabled ? "On — switch off" : "Off — switch on"}
        </button>
      </div>

      {/*
        TEST MODE IS STATED, NOT TOGGLED. There is no marketplace transport in
        this phase, so the only honest value is on — and a switch offering the
        other one would imply a capability that does not exist. The server
        refuses to turn it off for the same reason.
      */}
      <p className="mt-3 rounded-lg border border-emerald-600/30 bg-emerald-600/10 px-3 py-2 text-xs">
        <span className="font-medium">Test mode: on.</span> Records are processed locally — the
        template is rendered and stored, and nothing is transmitted. This phase has no
        marketplace transport, so test mode cannot be switched off.
      </p>

      {/*
        THE THREE SETTINGS SIT ON ONE ROW.
        They are read together — "from this date, this many hours later, for
        these storefronts" is one sentence — so wrapping one of them onto a
        second row made the reader re-scan to check they had seen all three.
        Stacked only on a phone, where three columns would be unreadable.
      */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase opacity-60">Earliest dispatch date</span>
          <input
            type="date"
            className="rounded-lg border border-black/15 dark:border-white/20 bg-transparent px-2 py-1 font-mono"
            value={notBefore}
            onChange={(event) => setNotBefore(event.target.value)}
          />
          <span className="text-[11px] opacity-60">
            Nothing dispatched before this is ever picked up.
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase opacity-60">Delay after dispatch (hours)</span>
          <input
            className="rounded-lg border border-black/15 dark:border-white/20 bg-transparent px-2 py-1 font-mono"
            value={delayHours}
            onChange={(event) => setDelayHours(event.target.value)}
          />
          <span className="text-[11px] opacity-60">Default 24.</span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase opacity-60">Storefronts in scope</span>
          <input
            className="rounded-lg border border-black/15 dark:border-white/20 bg-transparent px-2 py-1 font-mono"
            placeholder="e.g. 1, 22, 104"
            value={subSources}
            onChange={(event) => setSubSources(event.target.value)}
          />
          <span className="text-[11px] opacity-60">
            Storefront ids, comma separated. Empty means nothing is in scope.
          </span>
        </label>

      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          className="rounded-lg border border-black/15 dark:border-white/20 px-3 py-1.5 disabled:opacity-50"
          onClick={() =>
            void patch({
              notBefore: notBefore.trim() === "" ? null : notBefore.trim(),
              delayHours: Number.parseInt(delayHours, 10),
              enabledSubSources: subSources
                .split(",")
                .map((part) => Number.parseInt(part.trim(), 10))
                .filter((value) => Number.isInteger(value) && value > 0),
            })
          }
        >
          Save settings
        </button>
        <span className="text-xs opacity-60">
          Currently: {settings.enabled ? "on" : "off"} · from{" "}
          {settings.notBefore?.slice(0, 10) ?? "no date set"} · {settings.delayHours}h ·{" "}
          {settings.enabledSubSources.length} storefront
          {settings.enabledSubSources.length === 1 ? "" : "s"}
        </span>
      </div>

      {!queue.scanStatus.running && queue.scanStatus.reason !== null ? (
        <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-amber-800 dark:text-amber-200">
          Not running: {queue.scanStatus.reason}
        </p>
      ) : null}
      {error === null ? null : <p className="mt-3 text-red-600">{error}</p>}
    </section>
  );
}

/** The rendered template, on demand. Produced, never delivered. */
function RenderedBody({ item }: { item: AutomationItem }) {
  const [open, setOpen] = useState(false);
  if (item.renderedBody === null) return <span className="opacity-50">—</span>;
  return (
    <>
      <button
        type="button"
        className="text-xs underline opacity-70 hover:opacity-100"
        onClick={() => setOpen((was) => !was)}
      >
        {open ? "Hide" : "View"}
      </button>
      {open ? (
        <div className="mt-2 max-w-md whitespace-pre-wrap rounded-lg bg-black/[.03] dark:bg-white/[.06] p-2 text-xs">
          <p className="mb-2 font-medium opacity-60">
            Rendered in test mode. Not delivered to anyone.
          </p>
          {item.renderedBody}
        </div>
      ) : null}
    </>
  );
}

/** Why a record ended where it did, in the one column that can say so. */
function Outcome({ item }: { item: AutomationItem }) {
  if (item.status === "skipped") return <span className="text-xs">{item.skipReason}</span>;
  if (item.status === "failed") return <span className="text-xs">{item.lastError}</span>;
  if (item.status === "cancelled") {
    return (
      <span className="text-xs">
        {item.cancelledReason ?? "Cancelled by an operator"} · {moment(item.cancelledAt)}
      </span>
    );
  }
  if (item.status === "sent") {
    return (
      <span className="text-xs">
        Test mode · {moment(item.processedAt)} · <RenderedBody item={item} />
      </span>
    );
  }
  return <span className="opacity-50">—</span>;
}

export function AutomationAdmin() {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<AutomationItemStatus | "">("");
  const [error, setError] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (status !== "") query.set("status", status);
      const response = await fetch(`/api/automations?${query.toString()}`);
      if (!response.ok) throw new Error("Unable to load the automation records");
      setQueue((await response.json()) as Queue);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load the automation records");
    }
  }, [page, status]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads from the API; state is set in the response handler
    void loadQueue();
  }, [loadQueue]);

  /*
   * THERE IS NO "RUN NOW" HERE, deliberately.
   *
   * The automation is driven by the schedule — `/api/cron/automation`, which is
   * authenticated and bounded. A button that starts real work from an
   * unauthenticated page is the wrong shape for something that will one day
   * transmit to customers, and it made the screen look like the trigger when
   * the schedule is.
   *
   * This page reads, and changes settings. That is all it does.
   */

  const cancel = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const response = await fetch(`/api/automations/${id}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "Cancelled from the admin page" }),
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? "Unable to cancel this record.");
        }
        await loadQueue();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to cancel this record.");
      }
    },
    [loadQueue],
  );

  const zone = queue?.settings?.dispatchTimeZone ?? "UTC";

  return (
    <main className="mx-auto max-w-7xl p-6 text-sm">
      <h1 className="text-2xl font-semibold">Post-dispatch automation</h1>
      <p className="mt-2 opacity-70">
        A dispatched parcel is scheduled, rechecked when due, and the selected template is
        rendered and recorded. Nothing on this page contacts a customer.
      </p>

      {error === null ? null : <p className="mt-6 text-red-600">{error}</p>}
      {queue === null && error === null ? <p className="mt-6 opacity-70">Loading…</p> : null}

      {queue === null ? null : (
        <>
          <div className="mt-6">
            <SettingsPanel
              queue={queue}
              onSaved={(next) => setQueue((was) => (was === null ? was : { ...was, ...next }))}
            />
          </div>

          <section className="mt-8">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-lg font-medium">Records</h2>
              <span className="text-xs opacity-60">
                Runs on a schedule. This page does not start one.
              </span>
            </div>

            {/* Counts double as the filter: the number and the way to see it. */}
            <div className="mb-3 flex flex-wrap gap-2">
              <button
                type="button"
                className={`rounded-full border px-3 py-1 text-xs ${
                  status === "" ? "border-black/40 dark:border-white/50 font-medium" : "border-black/15 dark:border-white/20"
                }`}
                onClick={() => {
                  setStatus("");
                  setPage(1);
                }}
              >
                All {queue.counts === null ? "" : Object.values(queue.counts).reduce((a, b) => a + b, 0)}
              </button>
              {AUTOMATION_ITEM_STATUSES.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  className={`rounded-full border px-3 py-1 text-xs ${
                    status === candidate
                      ? "border-black/40 dark:border-white/50 font-medium"
                      : "border-black/15 dark:border-white/20"
                  }`}
                  onClick={() => {
                    setStatus(candidate);
                    setPage(1);
                  }}
                >
                  {/*
                    The chip describes the DEPLOYMENT, not one row: it reads
                    "Processed (test)" while this deployment has no transport,
                    and "Sent" once it has. Individual rows keep their own
                    answer, which is why a row processed during the test phase
                    still says so after a transport is connected.
                  */}
                  <StatusBadge
                    status={candidate}
                    testMode={queue.settings?.testMode ?? true}
                  />{" "}
                  <span className="ml-1">{queue.counts?.[candidate] ?? 0}</span>
                </button>
              ))}
            </div>

            {queue.items.length === 0 ? (
              <p className="opacity-70">No records to show.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-left align-top">
                  <thead>
                    <tr className="border-b border-black/10 dark:border-white/15">
                      <th className="p-2">Customer</th>
                      <th className="p-2">Order</th>
                      <th className="p-2">Shipment</th>
                      <th className="p-2">Channel</th>
                      <th className="p-2">
                        Dispatched
                        <span className="block text-[10px] font-normal opacity-50">{zone}</span>
                      </th>
                      <th className="p-2">
                        Scheduled
                        <span className="block text-[10px] font-normal opacity-50">{zone}</span>
                      </th>
                      <th className="p-2">Template</th>
                      <th className="p-2">Status</th>
                      <th className="p-2">Updated</th>
                      <th className="p-2">Result</th>
                      <th className="p-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {queue.items.map((item) => (
                      <tr key={item.id} className="border-b border-black/5 dark:border-white/10">
                        <td className="p-2">{item.recipientName ?? "Not recorded"}</td>
                        <td className="p-2 font-mono">{item.orderNumber ?? item.orderId}</td>
                        <td className="p-2 font-mono">{item.shipmentId}</td>
                        <td className="p-2">{item.channel}</td>
                        <td className="p-2 font-mono text-xs">{item.dispatchedAt}</td>
                        {/*
                          BOTH ZONES, with the source's first.
                          Dispatch is stored without a zone and read in the
                          order system's; the scheduled moment is a real
                          instant. Showing the two side by side in the SOURCE
                          zone is what makes the delay visible at a glance —
                          07:27:51 and 07:27:51, a day apart. The reader's own
                          clock is what they will actually be working to, so it
                          is underneath rather than missing.
                        */}
                        <td className="p-2 font-mono text-xs">
                          {inZone(item.scheduledAt, item.dispatchTimeZone)}
                          <span className="block font-sans opacity-50">
                            {moment(item.scheduledAt)} local
                          </span>
                        </td>
                        <td className="p-2 text-xs">
                          {item.templateName ?? item.templateId} (v{item.templateVersion})
                        </td>
                        <td className="p-2">
                          <StatusBadge status={item.status} testMode={item.testMode} />
                        </td>
                        <td className="p-2 text-xs opacity-70">{moment(item.updatedAt)}</td>
                        <td className="p-2">
                          <Outcome item={item} />
                        </td>
                        <td className="p-2">
                          {item.status === "scheduled" ? (
                            <button
                              type="button"
                              className="text-xs underline"
                              onClick={() => void cancel(item.id)}
                            >
                              Cancel
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={page <= 1}
                className="rounded-lg border border-black/15 dark:border-white/20 px-3 py-1.5 disabled:opacity-40"
                onClick={() => setPage((was) => Math.max(1, was - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={page * PAGE_SIZE >= queue.page.total}
                className="rounded-lg border border-black/15 dark:border-white/20 px-3 py-1.5 disabled:opacity-40"
                onClick={() => setPage((was) => was + 1)}
              >
                Next
              </button>
              <span className="text-xs opacity-60">
                {queue.page.total === 0
                  ? "No records"
                  : `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(
                      page * PAGE_SIZE,
                      queue.page.total,
                    )} of ${queue.page.total}`}
              </span>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
