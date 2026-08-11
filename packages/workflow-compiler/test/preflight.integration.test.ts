import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareWorkflow,
  tryPrepareWorkflow,
} from "@acpus/workflow-compiler";
import { describe, expect, it } from "vitest";
import {
  copyFixture,
  expectPreparationFailure,
  pathOptions,
  withCompilerWorkspace,
} from "./support/preflight.js";

describe("workflow preparation", () => {
  it("returns typed check failures without throwing", async () => {
    await withCompilerWorkspace("compiler-task-check-result", async workspaceDir => {
      const workflow = await copyFixture(workspaceDir, "workflows/inline-capture.workflow.ts");
      const result = await tryPrepareWorkflow(pathOptions(workspaceDir, workflow));

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected check failure");
      if (result.error.type !== "check-failed") throw new Error("expected typed check failure");
      expect(result.error.phase).toBe("check");
      expect(result.error.diagnostics).toContainEqual(expect.objectContaining({
        code: "TB003",
        source: expect.objectContaining({ file: expect.stringContaining("inline-capture.workflow.ts") }),
        hint: expect.stringContaining("through Task input"),
      }));
    });
  });

  it("returns validation diagnostics for compiled invalid IR", async () => {
    await withCompilerWorkspace("compiler-validate", async workspaceDir => {
      const workflow = await copyFixture(workspaceDir, "workflows/basic/malformed.workflow.ts");
      const failure = await expectPreparationFailure(workflow, workspaceDir);
      expect(failure).toMatchObject({
        type: "validate-failed",
        phase: "validate",
      });
      if (failure.phase !== "validate") throw new Error("expected validate failure");
      expect(failure.diagnostics).toContainEqual(expect.objectContaining({
        code: "ID001",
        severity: "error",
        path: "root.nodes.bad id",
      }));
    });
  });

  it("retains the typed compile worker failure", async () => {
    await withCompilerWorkspace("compiler-worker-result", async workspaceDir => {
      const workflow = join(workspaceDir, "invalid.workflow.ts");
      await writeFile(workflow, "export default {};\n");

      const result = await tryPrepareWorkflow(pathOptions(workspaceDir, workflow));

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected compile failure");
      expect(result.error).toEqual({
        type: "compile-failed",
        phase: "compile",
        message: `Default export of ${workflow} is not an Acpus workflow definition.`,
        failure: {
          type: "invalid-default-export",
          entry: workflow,
          message: `Default export of ${workflow} is not an Acpus workflow definition.`,
        },
      });
    });
  });

  it("rejects a live workspace entry that changes while it is compiling", async () => {
    await withCompilerWorkspace("compiler-source-generation", async workspaceDir => {
      const workflow = join(workspaceDir, "workflow.ts");
      const changedSource = `import { defineWorkflow } from "acpus/core";
export default defineWorkflow({ name: "changed" }).build(() => ({}));
`;
      const checkedSource = `import { writeFileSync } from "node:fs";
import { defineWorkflow } from "acpus/core";
writeFileSync(${JSON.stringify(workflow)}, ${JSON.stringify(changedSource)});
export default defineWorkflow({ name: "checked" }).build(() => ({}));
`;
      await writeFile(workflow, checkedSource);

      const result = await tryPrepareWorkflow(pathOptions(workspaceDir, workflow));

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("expected source generation failure");
      expect(result.error).toMatchObject({
        type: "compile-failed",
        phase: "compile",
        failure: {
          type: "workflow-source-changed",
          entry: workflow,
        },
      });
      expect(await readFile(workflow, "utf8")).toBe(changedSource);
    });
  });

  it("preserves an external workflow installed under node_modules", async () => {
    const [workspaceDir, installationRoot] = await Promise.all([
      mkdtemp(join(tmpdir(), "compiler-installed-workspace-")),
      mkdtemp(join(tmpdir(), "compiler-installed-package-")),
    ]);
    const packageRoot = join(installationRoot, "node_modules", "acpus");
    try {
      await mkdir(packageRoot, { recursive: true });
      await Promise.all([
        writeFile(join(packageRoot, "package.json"), "{\"type\":\"module\"}\n"),
        writeFile(join(packageRoot, "helper.ts"), `import { basename } from "node:path";
export const installed = [...new Set([basename("/installed")])][0]!;
`),
        writeFile(join(packageRoot, "workflow.ts"), `import { defineWorkflow } from "acpus/core";
import { installed } from "./helper.js";
void installed;
export default defineWorkflow({ name: "installed-external" }).build(() => ({ ok: true }));
`),
      ]);

      const prepared = await prepareWorkflow(pathOptions(workspaceDir, join(packageRoot, "workflow.ts")));

      expect(prepared.source).toEqual({
        kind: "snapshot",
        entry: "workflow.ts",
        digest: prepared.sourceGraphDigest,
      });
      expect(prepared.sourceBundle?.files.map(file => file.path)).toEqual([
        "helper.ts",
        "package.json",
        "workflow.ts",
      ]);
      expect(prepared.ir.name).toBe("installed-external");
      expect(prepared.ir.diagnostics).toEqual([]);
    } finally {
      await Promise.all([
        rm(workspaceDir, { recursive: true, force: true }),
        rm(installationRoot, { recursive: true, force: true }),
      ]);
    }
  });
});
