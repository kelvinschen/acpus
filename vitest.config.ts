import { defineConfig } from "vitest/config";

const unitTests = "packages/*/test/**/*.unit.test.ts";
const contractTests = "packages/*/test/**/*.contract.test.ts";
const integrationTests = "packages/*/test/**/*.integration.test.ts";
const e2eTests = "packages/*/test/**/*.e2e.test.ts";
const regressionTests = "packages/*/test/**/*.regression.test.ts";

export default defineConfig({
  test: {
    coverage: {
      reporter: ["text", "html"]
    },
    projects: [
      {
        test: {
          name: "unit",
          include: [unitTests]
        }
      },
      {
        test: {
          name: "contract",
          include: [contractTests]
        }
      },
      {
        test: {
          name: "integration",
          include: [integrationTests]
        }
      },
      {
        test: {
          name: "e2e",
          include: [e2eTests]
        }
      },
      {
        test: {
          name: "regression",
          include: [regressionTests]
        }
      }
    ]
  }
});
