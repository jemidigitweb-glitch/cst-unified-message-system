import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    // Backend/domain logic only — no DOM environment is needed yet.
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
