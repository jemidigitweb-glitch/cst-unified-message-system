/**
 * Test-harness stub for the `server-only` package.
 *
 * `server-only` throws unless it is resolved under React's `react-server`
 * condition, which the vitest runner does not provide. Aliasing it here lets
 * tests exercise the real server modules (`lib/config/env.ts`, `lib/db/pools.ts`)
 * instead of a copy of them.
 *
 * This does NOT weaken the production boundary: `next build` still resolves the
 * real package and still fails if a server module is imported from client code.
 */
export {};
