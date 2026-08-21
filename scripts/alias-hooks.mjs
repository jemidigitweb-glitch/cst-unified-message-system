/**
 * Resolves the project's `@/` alias for scripts run under plain Node.
 *
 * `@/` is a Next/vitest resolution defined in tsconfig `paths`. Node knows
 * nothing about it, so importing any library module directly — which is how the
 * scripts reuse reviewed application code instead of duplicating it — fails at
 * the first `@/lib/...` specifier.
 *
 * The alternative was relative imports throughout `lib/`, which would mean
 * editing dozens of reviewed files so that a command-line script could load
 * them. A twenty-line resolver is the smaller change and leaves the application
 * code untouched.
 *
 * Extensionless relative specifiers get the same treatment: TypeScript allows
 * `./rule-extraction`, ESM requires `./rule-extraction.ts`.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The first of `x.ts`, `x.tsx`, `x/index.ts` that exists. */
function resolveSourceFile(base) {
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const file = resolveSourceFile(join(ROOT, specifier.slice(2)));
    if (file !== null) return nextResolve(pathToFileURL(file).href, context);
  }

  // A relative import with no extension, from a TypeScript parent.
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
    const parent = dirname(fileURLToPath(context.parentURL));
    const file = resolveSourceFile(join(parent, specifier));
    if (file !== null) return nextResolve(pathToFileURL(file).href, context);
  }

  return nextResolve(specifier, context);
}
