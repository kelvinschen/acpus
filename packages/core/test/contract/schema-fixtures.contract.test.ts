import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileWorkflow } from "../../src/index.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");

describe("Production YAML fixtures pass Schema validation", () => {
  const fixtureDir = fixtures;
  const yamlFiles = globSync(join(fixtureDir, "**/*.yaml"));

  for (const file of yamlFiles) {
    const relativeName = file.slice(fixtureDir.length + 1);
    const fileName = basename(file);
    const expectedInvalid = fileName.startsWith("invalid-") || fileName.startsWith("include-cycle");
    const nonWorkflowFixture = fileName === "mock.yaml";

    if (expectedInvalid || nonWorkflowFixture) continue;

    it(`passes Schema validation: ${relativeName}`, () => {
      const source = readFileSync(file, "utf8");
      const result = compileWorkflow(source, {
        sourcePath: file,
        includeResolver: (includePath, fromPath) => readFileSync(resolve(dirname(fromPath ?? file), includePath), "utf8")
      });
      expect(result.ok).toBe(true);

      const schemaErrors = result.diagnostics.filter(
        (d) =>
          d.severity === "error" &&
          (d.code === "SPEC_SHAPE" || d.code === "STEP_SHAPE" || d.code === "AGENT_SHAPE") &&
          d.message.includes("Unknown")
      );
      expect(schemaErrors).toHaveLength(0);
    });
  }
});
