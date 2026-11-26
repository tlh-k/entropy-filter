import { defineConfig } from "vitest/config";

// Runs against the built bundle in dist/; run `npm run build` first.
export default defineConfig({
  test: { include: ["test/e2e/**/*.e2e.test.ts"], testTimeout: 30_000 },
});
