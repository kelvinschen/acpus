import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    conditions: ["development", "node", "import", "default"],
  },
  test: {
    include: ["test/**/*.test.{ts,mjs}"],
  },
});
