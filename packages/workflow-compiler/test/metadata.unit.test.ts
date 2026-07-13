import { describe, expect, it } from "vitest";
import { extractWorkflowMetadata } from "../src/metadata.js";

describe("workflow metadata extraction", () => {
  it.each([
    ["named import", 'import { defineWorkflow } from "acpus/core";\nexport default defineWorkflow({ name: "release" }).build(() => ({}));'],
    ["aliased import", 'import { defineWorkflow as workflow } from "@acpus/core";\nexport default workflow({ name: `release` }).build(() => ({}));'],
    ["namespace import", 'import * as acpus from "acpus/core";\nexport default acpus.defineWorkflow({ name: "release" }).build(() => ({}));'],
    ["top-level const", 'import { defineWorkflow } from "acpus/core";\nconst release = defineWorkflow({ name: "release" }).build(() => ({}));\nexport default release;'],
    ["spread before name", 'import { defineWorkflow } from "acpus/core";\nconst base = {};\nexport default defineWorkflow({ ...base, name: "release" }).build(() => ({}));'],
    ["literal overriding a nonliteral", 'import { defineWorkflow } from "acpus/core";\nconst dynamic = "other";\nexport default defineWorkflow({ name: dynamic, name: "release" }).build(() => ({}));'],
  ])("extracts a literal name from %s", async (_label, source) => {
    await expect(extractWorkflowMetadata(source, "/tmp/workflow.ts")).resolves.toMatchObject({
      value: { name: "release" },
    });
  });

  it.each([
    ["syntax errors", 'import { defineWorkflow } from "acpus/core";\nexport default defineWorkflow({ name: "release" ).build(() => ({}));', "syntax-invalid"],
    ["missing default export", 'import { defineWorkflow } from "acpus/core";\ndefineWorkflow({ name: "release" }).build(() => ({}));', "default-export-missing"],
    ["unrelated factory", 'const defineWorkflow = (value: unknown) => value as any;\nexport default defineWorkflow({ name: "release" }).build(() => ({}));', "workflow-definition-not-static"],
    ["nonliteral name", 'import { defineWorkflow } from "acpus/core";\nconst name = "release";\nexport default defineWorkflow({ name }).build(() => ({}));', "workflow-name-not-static"],
    ["substituted template name", 'import { defineWorkflow } from "acpus/core";\nconst suffix = "x";\nexport default defineWorkflow({ name: `release-${suffix}` }).build(() => ({}));', "workflow-name-not-static"],
    ["overriding spread", 'import { defineWorkflow } from "acpus/core";\nconst base = {};\nexport default defineWorkflow({ name: "release", ...base }).build(() => ({}));', "workflow-name-not-static"],
    ["computed property after name", 'import { defineWorkflow } from "acpus/core";\nconst key = "name";\nexport default defineWorkflow({ name: "release", [key]: "other" }).build(() => ({}));', "workflow-name-not-static"],
    ["ambiguous top-level const", 'import { defineWorkflow } from "acpus/core";\nconst release = defineWorkflow({ name: "release" }).build(() => ({}));\nconst release = defineWorkflow({ name: "other" }).build(() => ({}));\nexport default release;', "workflow-definition-not-static"],
    ["multiple default exports", 'import { defineWorkflow } from "acpus/core";\nexport default defineWorkflow({ name: "release" }).build(() => ({}));\nexport default defineWorkflow({ name: "other" }).build(() => ({}));', "workflow-definition-not-static"],
  ])("rejects %s", async (_label, source, type) => {
    const result = await extractWorkflowMetadata(source, "/tmp/workflow.ts");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(type);
  });
});
