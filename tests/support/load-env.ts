import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Loads .env into process.env as the framework would at runtime, so the real
 * config modules see the same values inside the test harness.
 *
 * Values are never returned, logged, or exposed. Existing process values win, so
 * an explicitly exported variable is not overwritten.
 */
export function loadEnvFile(): void {
  const path = join(__dirname, "..", "..", ".env");
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const value = match[2]!.trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
