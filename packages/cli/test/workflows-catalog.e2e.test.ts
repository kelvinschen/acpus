import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSourceCli } from "./support/cli-runner.js";
import { copyWorkflowFixture, fixturePath } from "./support/fixtures.js";
import { repoRoot } from "./support/cli-runner.js";
import { withTestWorkspace } from "./support/workspace.js";

describe.concurrent("workflow catalog e2e", () => {
  it("checks a project catalog workflow", async () => {
    await withTestWorkspace("catalog-check-project", async workspace => {
      await mkdir(join(workspace, ".acpus", "workflows", "release"), { recursive: true });
      await writeFile(
        join(workspace, ".acpus", "workflows", "release", "workflow.ts"),
        await readFile(fixturePath("workflows/basic/valid.workflow.ts"), "utf8"),
      );

      const result = await runSourceCli(workspace, ["workflows", "check", "release", "--json"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        phase: "check",
        workflow: { name: "cli-valid" },
        catalog: {
          scope: "project",
          name: "release",
          entryPath: join(workspace, ".acpus", "workflows", "release", "workflow.ts"),
        },
      });

      const run = await runSourceCli(workspace, ["workflows", "run", "release", "--project", "--input", "{\"ready\":true}", "--json"]);
      expect(run.exitCode).toBe(0);
      expect(run.stderr).toBe("");
      const terminal = run.stdout.trim().split("\n").map(line => JSON.parse(line)).at(-1);
      expect(terminal).toMatchObject({
        ok: true,
        phase: "run",
        run: { status: "completed", output: { ready: true } },
        catalog: { scope: "project", name: "release" },
      });
    });
  }, 25_000);

  it("runs a global catalog workflow after materializing package-relative tasks", async () => {
    await withTestWorkspace("catalog-run-global", async workspace => {
      await withTestHome("catalog-run-global-home", async home => {
        await globalTaskWorkflowPackage(join(home, ".acpus", "workflows"), "global-task");

        const checked = await runSourceCli(
          workspace,
          ["workflows", "check", "global-task", "--input", "{\"value\":\" ok \"}", "--json"],
          { env: { HOME: home } },
        );
        expect(checked.exitCode).toBe(0);
        expect(checked.stderr).toBe("");
        expect(JSON.parse(checked.stdout)).toMatchObject({
          ok: true,
          phase: "check",
          catalog: {
            scope: "global",
            name: "global-task",
          },
        });

        const result = await runSourceCli(
          workspace,
          ["workflows", "run", "global-task", "--input", "{\"value\":\" ok \"}", "--json"],
          { env: { HOME: home } },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        const records = result.stdout.trim().split("\n").map(line => JSON.parse(line));
        const terminal = records.at(-1);
        expect(terminal).toMatchObject({
          ok: true,
          phase: "run",
          run: {
            status: "completed",
            output: { normalized: "ok" },
          },
          catalog: {
            scope: "global",
            name: "global-task",
            entryPath: join(home, ".acpus", "workflows", "global-task", "workflow.ts"),
          },
        });
        expect(terminal.run.workflowEntry).toContain(".acpus/.local/catalog-cache/global/global-task/");
        const materializedTask = join(workspace, dirname(terminal.run.workflowEntry), "tasks", "normalize.task.ts");
        expect((await lstat(materializedTask)).isSymbolicLink()).toBe(false);

        const inspected = await runSourceCli(workspace, ["runs", "inspect", terminal.run.id, "--json"], { env: { HOME: home } });
        expect(inspected.exitCode).toBe(0);
        expect(inspected.stderr).toBe("");
        expect(JSON.parse(inspected.stdout).catalog).toBeUndefined();
      });
    });
  }, 15_000);

  it("keeps path-like workflow arguments on the direct path flow", async () => {
    await withTestWorkspace("catalog-path-precedence", async workspace => {
      await mkdir(join(workspace, ".acpus", "workflows", "workflow"), { recursive: true });
      await writeFile(
        join(workspace, ".acpus", "workflows", "workflow", "workflow.ts"),
        projectWorkflow("catalog-workflow"),
      );
      await copyWorkflowFixture(workspace, "workflows/basic/valid.workflow.ts", "workflow.ts");

      const result = await runSourceCli(workspace, ["workflows", "check", "workflow.ts", "--json"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        ok: true,
        phase: "check",
        workflow: { name: "cli-valid" },
      });
      expect(output.catalog).toBeUndefined();
    });
  });
});

async function globalTaskWorkflowPackage(root: string, name: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(join(dir, "tasks"), { recursive: true });
  await writeFile(join(dir, "workflow.ts"), [
    'import { defineWorkflow, z } from "acpus/core";',
    'import normalizeTask from "./tasks/normalize.task.js";',
    "",
    "export default defineWorkflow({",
    '  name: "global-task",',
    "  inputSchema: z.object({ value: z.string() }),",
    "}).build(({ input, step }) => {",
    '  const normalized = step("normalize").task({',
    "    run: {",
    "      task: normalizeTask,",
    "      input: { value: input.value },",
    "    },",
    "  });",
    "  return { normalized: normalized.output.normalized };",
    "});",
    "",
  ].join("\n"));
  await writeFile(join(dir, "tasks", "normalize.real.task.ts"), [
    'import { task, z } from "acpus/core";',
    "",
    "export default task.define({",
    "  inputSchema: z.object({ value: z.string() }),",
    "  exec: async ({ input }) => ({ normalized: input.value.trim() }),",
    "});",
    "",
  ].join("\n"));
  await symlink("normalize.real.task.ts", join(dir, "tasks", "normalize.task.ts"));
}

function projectWorkflow(name: string): string {
  return [
    'import { defineWorkflow } from "acpus/core";',
    "",
    `export default defineWorkflow({ name: ${JSON.stringify(name)} }).build(() => ({ ok: true }));`,
    "",
  ].join("\n");
}

async function withTestHome<T>(name: string, fn: (home: string) => Promise<T>): Promise<T> {
  const root = join(repoRoot, ".tmp-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(join(root, `${name}-`));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
