import { defineConfig } from "vitest/config";

// vitest 4 widened its default include pattern and started collecting the
// compiled output under dist/ as well as the sources, running every suite
// twice - once from TypeScript and once from whatever JavaScript happened to
// be lying in dist/ from an earlier build. A stale dist/ would then report
// passes for code that no longer exists.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
