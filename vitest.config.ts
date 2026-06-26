import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      reporter: ["text", "html"]
    },
    include: ["packages/tui/test/**/*.test.ts"]
  }
});
