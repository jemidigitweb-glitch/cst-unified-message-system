import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // `server-only` throws outside a react-server resolution condition, which
      // the runner does not provide. Stubbing it lets tests exercise the real
      // server modules. `next build` still enforces the boundary for real.
      "server-only": fileURLToPath(new URL("./tests/support/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    // Backend/domain logic only — no DOM environment is needed yet.
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
