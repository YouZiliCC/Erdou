import { defineConfig } from "vitest/config";

export default defineConfig({
  // VM boots are seconds; the gated conformance suite needs a generous budget.
  test: { environment: "node", include: ["src/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000 },
});
