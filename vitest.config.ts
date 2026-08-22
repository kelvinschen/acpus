import { transform } from "esbuild";
import { defineConfig } from "vitest/config";

const unitTests = "packages/*/test/**/*.unit.test.ts";
const isolatedUnitTests = [
  "packages/acp/test/reverse-rpc.unit.test.ts",
  "packages/core/test/schema.unit.test.ts",
  "packages/dsh/test/preset.unit.test.ts",
  "packages/dsh/test/supervisor-state.unit.test.ts",
  "packages/expression/test/evaluator.unit.test.ts",
  "packages/web/test/assets.unit.test.ts",
  "packages/web/test/vite-config.unit.test.ts",
];
const contractTests = "packages/*/test/**/*.contract.test.ts";
const isolatedContractTests = ["packages/web/test/api.contract.test.ts"];
const integrationTests = "packages/*/test/**/*.integration.test.ts";
const e2eTests = "packages/*/test/**/*.e2e.test.ts";
const regressionTests = "packages/*/test/**/*.regression.test.ts";
const typeContractTests = "packages/*/test/**/*.type.test-d.ts";
const slowProjectTestTimeout = process.env.CI ? 30_000 : 15_000;
const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m;

function standardDecoratorPlugin() {
  return {
    name: "standard-typescript-decorators",
    enforce: "pre" as const,
    async transform(code: string, id: string) {
      const file = id.split("?", 1)[0]!;
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return;
      const result = await transform(code, {
        loader: file.endsWith("x") ? "tsx" : "ts",
        target: "es2024",
        format: "esm",
        sourcefile: file,
        sourcemap: true,
      });
      return {
        code: result.code,
        map: result.map,
      };
    },
  };
}

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: {
    conditions: ["development", "node", "import", "default"]
  },
  test: {
    slowTestThreshold: 1_000,
    coverage: {
      reporter: ["text", "html"]
    },
    projects: [
      {
        plugins: [standardDecoratorPlugin()],
        test: {
          name: "unit",
          include: [unitTests],
          exclude: isolatedUnitTests,
          pool: "vmForks"
        }
      },
      {
        plugins: [standardDecoratorPlugin()],
        test: {
          name: "unit-isolated",
          include: isolatedUnitTests,
          pool: "forks"
        }
      },
      {
        plugins: [standardDecoratorPlugin()],
        test: {
          name: "contract",
          include: [contractTests],
          exclude: isolatedContractTests,
          pool: "vmForks",
          testTimeout: slowProjectTestTimeout
        }
      },
      {
        plugins: [standardDecoratorPlugin()],
        test: {
          name: "contract-isolated",
          include: isolatedContractTests,
          pool: "forks",
          testTimeout: slowProjectTestTimeout
        }
      },
      {
        plugins: [standardDecoratorPlugin()],
        test: {
          name: "integration",
          include: [integrationTests],
          testTimeout: slowProjectTestTimeout
        }
      },
      {
        plugins: [standardDecoratorPlugin()],
        test: {
          name: "e2e",
          include: [e2eTests],
          testTimeout: slowProjectTestTimeout
        }
      },
      {
        plugins: [standardDecoratorPlugin()],
        test: {
          name: "regression",
          include: [regressionTests]
        }
      },
      {
        plugins: [standardDecoratorPlugin()],
        test: {
          name: "type-contract",
          include: [],
          typecheck: {
            enabled: true,
            checker: "./node_modules/.bin/tsc",
            include: [typeContractTests],
            tsconfig: "tsconfig.vitest.json"
          }
        }
      }
    ]
  }
});
