import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    // Pick up both .test.ts (regular unit/integration) and .bench.ts
    // (Pass A context-efficiency benchmark; runs as vitest assertions
    // because the 60% reduction target is a hard gate, not a histogram).
    include: ["test/**/*.test.ts", "test/**/*.bench.ts"],
    exclude: ["node_modules", "dist"],
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/index.ts"],
    },
  },
});
