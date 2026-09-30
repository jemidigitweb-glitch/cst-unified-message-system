<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Working on this codebase

**Read `documentation/ai-coding-context.md` before writing any code here.**

This repository has conventions that are deliberate rather than stylistic, and
a suite of 24 architecture guards that will reject a change which ignores them.
That file covers, in order of how quickly they will bite:

- the five rules that fail the build — including that this application **cannot
  send to a customer** and the marketplace database is **strictly read-only**
- how migrations work here (applied by hand; reviewed by tests that read the
  SQL as text and never execute it)
- what the guards enforce, and why a guard failure is a design question rather
  than a test to fix
- SQL, React and test conventions
- how to verify your own work by running the app and reading it, rather than
  asking the user what is on their screen
- which tests already fail on a clean checkout, so you do not chase them

If a guard blocks what you were asked to do, do not weaken it — either the
request needs rethinking, or the guard's premise genuinely changed and it
should be rewritten to enforce the new intent.
