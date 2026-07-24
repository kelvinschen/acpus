import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskNodeIR } from "@acpus/core/ir";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import type { RegisterArtifactInput } from "../src/store/store.js";
import {
  executeTaskNode,
  inlineTask,
  withTaskExecutorWorkspace,
} from "./support/task-executor-fixture.js";

describe("task executor loading and process context", () => {
  it("executes inline task source that contains esbuild name helpers", async () => {
    await withTaskExecutorWorkspace(async ({ workspace, taskOptions }) => {
      const metadata: unknown[] = [];
      const node = {
        id: "inline",
        kind: "task",
        run: {
          input: {
            value: { kind: "literal", value: "ok" },
          },
          target: {
            kind: "inline",
            source: `async ({ input }) => {
              const finish = __name((value) => ({ value }), "finish");
              return finish(input.value);
            }`,
          },
        },
      } satisfies TaskNodeIR;
      const options = taskOptions("run_1");
      options.store.writeExecutionMetadata = input => metadata.push(input);

      await expect(executeTaskNode(node, {}, options)).resolves.toEqual({ value: "ok" });
      expect(metadata).toEqual([
        expect.objectContaining({
          runId: "run_1",
          kind: "task_attempt",
          metadata: {
            nodeId: "inline",
            nodeKey: "inline",
            attemptNo: 1,
            input: { value: "ok" },
            cwd: workspace,
          },
        }),
      ]);
    });
  });

  it("does not create implicit output or work directories", async () => {
    await withTaskExecutorWorkspace(async ({ runtimeRunDir, taskOptions }) => {
      const runId = "run_plain";
      const runDir = runtimeRunDir(runId);
      await mkdir(runDir, { recursive: true });
      await Promise.all([
        writeFile(join(runDir, "workflow.ir.json"), "{}\n"),
        writeFile(join(runDir, "lock.json"), "{}\n"),
      ]);

      await expect(executeTaskNode(
        inlineTask("plain", "async () => ({ ok: true })"),
        {},
        taskOptions(runId),
      )).resolves.toEqual({ ok: true });
      await expect(readdir(runDir).then(entries => entries.sort()))
        .resolves.toEqual(["lock.json", "workflow.ir.json"]);
    });
  });

  it("gives task code, Node APIs, artifacts, env, and $ one live process context", async () => {
    await withTaskExecutorWorkspace(async ({ workspace, runtimeRunDir, taskOptions }) => {
      const workDir = join(workspace, "worktree");
      const runDir = runtimeRunDir("run_context");
      await mkdir(join(workDir, "nested"), { recursive: true });
      await mkdir(runDir, { recursive: true });
      await Promise.all([
        writeFile(join(runDir, "workflow.ir.json"), "{}\n"),
        writeFile(join(runDir, "lock.json"), "{}\n"),
      ]);
      await writeFile(join(workDir, "marker.txt"), "root-marker\n");
      await writeFile(join(workDir, "nested", "marker.txt"), "nested-marker\n");
      const artifacts: RegisterArtifactInput[] = [];
      const node = inlineTask("context", [
        "async ({ $, env, artifact }) => {",
        "  const fs = await import('node:fs/promises');",
        "  const path = await import('node:path');",
        "  const initialCwd = process.cwd();",
        "  const initialMarker = await fs.readFile('marker.txt', 'utf8');",
        "  const sameEnvObject = env === process.env;",
        "  process.chdir('nested');",
        "  env.RUNTIME_MUTATED = 'yes';",
        "  const shellCwd = (await $`pwd`).stdout.trim();",
        "  const shellEnv = (await $`node -e ${\"process.stdout.write(process.env.RUNTIME_MUTATED ?? '')\"}`).stdout.trim();",
        "  const artifactRef = await artifact.write('marker.txt', await fs.readFile('marker.txt'));",
        "  return { initialCwd, initialMarker, sameEnvObject, shellCwd, shellEnv, resolved: path.resolve('marker.txt'), artifactRef, artifactPath: artifact.path(artifactRef), runEnv: process.env.RUNTIME_TASK_ENV, inheritedPath: Boolean(process.env.PATH) };",
        "}",
      ].join("\n"), {
        cwd: { kind: "literal", value: workDir },
        env: { RUNTIME_TASK_ENV: { kind: "literal", value: "from-run-env" } },
      });

      const output = await executeTaskNode(
        node,
        {},
        taskOptions("run_context", artifact => artifacts.push(artifact)),
      ) as Record<string, unknown>;
      expect(output).toEqual({
        initialCwd: workDir,
        initialMarker: "root-marker\n",
        sameEnvObject: true,
        shellCwd: join(workDir, "nested"),
        shellEnv: "yes",
        resolved: join(workDir, "nested", "marker.txt"),
        artifactRef: expect.objectContaining({ kind: "artifact" }),
        artifactPath: expect.any(String),
        runEnv: "from-run-env",
        inheritedPath: true,
      });
      expect(artifacts).toHaveLength(1);
      await expect(readFile(join(runDir, artifacts[0]!.relativePath), "utf8"))
        .resolves.toBe("nested-marker\n");
      expect(output.artifactPath).toBe(join(runDir, artifacts[0]!.relativePath));
      expect(artifacts[0]!.mediaType).toBeUndefined();
      await expect(readdir(runDir).then(entries => entries.sort()))
        .resolves.toEqual(["artifacts", "lock.json", "workflow.ir.json"]);
    });
  });

  it("isolates concurrent task cwd and env values", async () => {
    await withTaskExecutorWorkspace(async ({ workspace, taskOptions }) => {
      const left = join(workspace, "left");
      const right = join(workspace, "right");
      await Promise.all([mkdir(left), mkdir(right)]);
      await Promise.all([
        writeFile(join(left, "marker.txt"), "left"),
        writeFile(join(right, "marker.txt"), "right"),
      ]);
      const source = [
        "async () => {",
        "  const fs = await import('node:fs/promises');",
        "  const seen = [];",
        "  for (let index = 0; index < 5; index += 1) {",
        "    await new Promise(resolve => setTimeout(resolve, 10));",
        "    seen.push(`${process.cwd()}|${process.env.ISOLATED}|${await fs.readFile('marker.txt', 'utf8')}`);",
        "  }",
        "  return { seen };",
        "}",
      ].join("\n");

      const [leftOutput, rightOutput] = await Promise.all([
        executeTaskNode(
          inlineTask("left", source, {
            cwd: { kind: "literal", value: left },
            env: { ISOLATED: { kind: "literal", value: "L" } },
          }),
          {},
          taskOptions("run_left"),
        ),
        executeTaskNode(
          inlineTask("right", source, {
            cwd: { kind: "literal", value: right },
            env: { ISOLATED: { kind: "literal", value: "R" } },
          }),
          {},
          taskOptions("run_right"),
        ),
      ]) as [{ seen: string[] }, { seen: string[] }];

      expect(new Set(leftOutput.seen)).toEqual(new Set([`${left}|L|left`]));
      expect(new Set(rightOutput.seen)).toEqual(new Set([`${right}|R|right`]));
    });
  });

  it("starts reusable task modules fresh for every attempt", async () => {
    await withTaskExecutorWorkspace(async ({ workspace, taskOptions }) => {
      const coreURL = import.meta.resolve("@acpus/core");
      const moduleCwd = join(workspace, "module-cwd");
      await mkdir(moduleCwd);
      await writeFile(join(workspace, "workflow.ts"), "");
      await writeFile(join(workspace, "counter.mjs"), [
        `import { task, z } from ${JSON.stringify(coreURL)};`,
        "let count = 0;",
        "const loadedCwd = process.cwd();",
        "const loadedEnv = process.env.MODULE_ENV;",
        "export const counter = task.define({ inputSchema: z.object({}), exec: async () => ({ count: ++count, loadedCwd, loadedEnv }) });",
      ].join("\n"));
      const node = {
        id: "counter",
        kind: "task",
        run: {
          input: {},
          target: {
            kind: "module",
            specifier: "./counter.mjs",
            exportName: "counter",
            referrer: { path: "workflow.ts" },
          },
          cwd: { kind: "literal", value: moduleCwd },
          env: { MODULE_ENV: { kind: "literal", value: "module-env" } },
        },
      } satisfies TaskNodeIR;

      await expect(executeTaskNode(node, {}, taskOptions("run_counter_1")))
        .resolves.toEqual({ count: 1, loadedCwd: moduleCwd, loadedEnv: "module-env" });
      await expect(executeTaskNode(node, {}, taskOptions("run_counter_2")))
        .resolves.toEqual({ count: 1, loadedCwd: moduleCwd, loadedEnv: "module-env" });
    });
  });

  it("loads frozen catalog reusable tasks with workspace dependency authority", async () => {
    await withTaskExecutorWorkspace(async ({ workspace, taskOptions }) => {
      const sourceRoot = join(resolveRuntimeLayout(workspace).sourcesRoot, "catalog", "sample", "digest");
      const packageDir = join(workspace, "node_modules", "workspace-only-package");
      await Promise.all([
        mkdir(join(sourceRoot, "tasks"), { recursive: true }),
        mkdir(packageDir, { recursive: true }),
      ]);
      await writeFile(join(sourceRoot, "workflow.ts"), "");
      await writeFile(join(packageDir, "package.json"), JSON.stringify({
        name: "workspace-only-package",
        type: "module",
        exports: "./index.mjs",
      }));
      await writeFile(
        join(packageDir, "index.mjs"),
        "export const decorate = value => `workspace:${value}`;\n",
      );
      await writeFile(join(sourceRoot, "tasks", "catalog-task.mjs"), [
        `import { task, z } from ${JSON.stringify(import.meta.resolve("@acpus/core"))};`,
        "import { decorate } from 'workspace-only-package';",
        "export const catalogTask = task.define({",
        "  inputSchema: z.object({ value: z.string() }),",
        "  exec: async ({ input }) => ({ value: decorate(input.value) }),",
        "});",
      ].join("\n"));
      const node = {
        id: "catalog_task",
        kind: "task",
        run: {
          input: { value: { kind: "literal", value: "frozen" } },
          target: {
            kind: "module",
            specifier: "./tasks/catalog-task.mjs",
            exportName: "catalogTask",
            referrer: { path: "workflow.ts" },
          },
        },
      } satisfies TaskNodeIR;

      await expect(executeTaskNode(node, {}, {
        ...taskOptions("run_catalog_task"),
        sourceRoot,
      })).resolves.toEqual({ value: "workspace:frozen" });
    });
  });
});
