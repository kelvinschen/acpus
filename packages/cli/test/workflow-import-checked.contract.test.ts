import { access, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./support/cli-runner.js";
import {
  globalImportRoot,
  projectImportRoot,
  readNames,
  runImportText,
  withTestHome,
} from "./support/workflow-import.js";
import { withAuthoringTestWorkspace } from "./support/workspace.js";

describe("checked workflow import contracts", () => {
  it("returns checked global-import diagnostics in workspace context", async () => {
    await withAuthoringTestWorkspace("workflow-import-check", async workspace => {
      await withTestHome("workflow-import-check-home", async home => {
        await installWorkspaceOnlyDependency(workspace);
        const checkedSource = join(workspace, "workspace-checked.ts");
        await writeFile(checkedSource, workspaceDependencyWorkflowSource("workspace-checked"));

        const checked = await runImportText(workspace, [
          "workflow",
          "import",
          checkedSource,
          "--global",
          "--check",
        ]);
        expect(checked.exitCode).toBe(0);
        expect(checked.stdout).toContain("Catalog workflow: workspace-checked\nCatalog scope: global");
        expect(checked.stdout).toContain("Checked: yes");
        expect(checked.stdout).toMatch(/Source graph: sha256:[a-f0-9]{64}/u);
        expect(checked.stdout).toMatch(/workflow\.ts:3:\d+ \[warning SC001\]/u);
        expect(checked.stderr).toBe("");
        await expect(access(join(home, ".acpus", "workflows", "workspace-checked", "workflow.ts"))).resolves.toBeUndefined();
        expect(await readNames(globalImportRoot(home))).toEqual([]);
        expect(await readNames(projectImportRoot(workspace))).toEqual([]);
      });
    });
  });
});

function workspaceDependencyWorkflowSource(name: string): string {
  return [
    'import { defineWorkflow } from "acpus/core";',
    'import { workspaceValue } from "workspace-only";',
    "export async function load(moduleName: string): Promise<unknown> { return import(moduleName); }",
    `export default defineWorkflow({ name: ${JSON.stringify(name)}, description: workspaceValue }).build(() => ({ ok: true }));`,
    "",
  ].join("\n");
}

async function installWorkspaceOnlyDependency(workspace: string): Promise<void> {
  const nodeModules = join(workspace, "node_modules");
  await rm(nodeModules);
  await mkdir(join(nodeModules, "workspace-only"), { recursive: true });
  await symlink(join(repoRoot, "packages", "cli"), join(nodeModules, "acpus"), "dir");
  await symlink(join(repoRoot, "node_modules", "@types"), join(nodeModules, "@types"), "dir");
  await writeFile(join(nodeModules, "workspace-only", "package.json"), JSON.stringify({
    name: "workspace-only",
    type: "module",
    exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
  }));
  await writeFile(join(nodeModules, "workspace-only", "index.d.ts"), 'export declare const workspaceValue: "from-workspace";\n');
  await writeFile(join(nodeModules, "workspace-only", "index.js"), 'export const workspaceValue = "from-workspace";\n');
}
