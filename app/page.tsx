import { WORKFLOW_STATES } from "@/lib/domain/workflow";

/**
 * Placeholder landing page. The conversation UI is a later task — this exists so
 * the app builds and renders, not as a design starting point.
 */
export default function Home() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">CST Unified Message System</h1>
        <p className="text-sm opacity-70">Phase 1 foundation — eBay-first, review only.</p>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">Workflow</h2>
        <ol className="flex flex-wrap items-center gap-2 text-sm">
          {WORKFLOW_STATES.map((state, index) => (
            <li key={state} className="flex items-center gap-2">
              <code className="rounded bg-black/5 px-2 py-1 dark:bg-white/10">{state}</code>
              {index < WORKFLOW_STATES.length - 1 && <span aria-hidden className="opacity-40">→</span>}
            </li>
          ))}
        </ol>
        <p className="text-sm opacity-70">
          <code>reviewed</code> is terminal. This phase has no capability to send a reply to a
          customer.
        </p>
      </section>
    </main>
  );
}
