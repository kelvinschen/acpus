import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { admitWorkflowRun, getRun, listRuns, normalizeSignalPayload, normalizeWorkflowInput } from "@acpus/runtime";
import type { TaskExecutionTargetIR, WorkflowIR } from "@acpus/core/ir";
import {
  admitFixture,
  admitSyntheticWorkflow,
  defaultRefInputWorkflow,
  failingPureWorkflow,
  failingTaskWorkflow,
  metaWorkflow,
  prepareFixture,
  prepareSyntheticWorkflow,
  preparedWorkflow,
  runtimeRow,
  runtimeRows,
  taskArtifactWorkflow,
  taskInvocationOptionsWorkflow,
  validWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";

const exec = promisify(execFile);
const runIdPattern = /^\d{14}[A-F0-9]{20}$/;

describe.concurrent("runtime admission use cases", () => {
  it("admits a pure run and exposes read-only inspection", async () => {
    await withRuntimeWorkspace("runtime-admit-pure", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, validWorkflow(), { ready: true });

      expect(admitted.status).toBe("completed");
      expect(admitted.run.id).toMatch(runIdPattern);
      expect(await listRuns(workspace)).toEqual([
        expect.objectContaining({ id: admitted.run.id, status: "completed", name: "cli-valid" }),
      ]);
      const inspected = await getRun(workspace, admitted.run.id);
      expect(inspected).toMatchObject({
        id: admitted.run.id,
        status: "completed",
        input: { ready: true },
        output: { ready: true },
        nodeCount: 1,
      });
      expect(inspected?.eventCount).toBeGreaterThan(2);
      expect(runtimeRows(workspace, "SELECT type FROM run_events WHERE run_id = ? ORDER BY sequence", admitted.run.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "run.admitted" }),
        expect.objectContaining({ type: "run.completed" }),
      ]));
    });
  });

  it("injects run-level workflow meta into expressions", async () => {
    await withRuntimeWorkspace("runtime-meta", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, metaWorkflow());
      expect(admitted.status).toBe("completed");
      await expect(getRun(workspace, admitted.run.id)).resolves.toMatchObject({
        output: {
          runId: admitted.run.id,
          workflowPath: "cli-meta.workflow.ts",
          workflowName: "cli-meta",
          workspaceDir: workspace,
        },
      });
    });
  });

  it("normalizes input defaults and rejects invalid plain artifact ref objects before admission", async () => {
    await withRuntimeWorkspace("runtime-input-normalize", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, defaultRefInputWorkflow());
      expect(normalizeWorkflowInput(prepared.ir, {
        patch: { kind: "artifact", uri: "artifact://patch", mediaType: "text/plain" },
        token: "API_TOKEN",
      })).toEqual({
        base: "main",
        patch: { kind: "artifact", uri: "artifact://patch", mediaType: "text/plain" },
        token: "API_TOKEN",
      });
      expect(() => normalizeWorkflowInput(prepared.ir, {
        patch: { kind: "artifact", uri: "artifact://patch", mediaType: "application/json" },
        token: "API_TOKEN",
      })).toThrow("$.patch.mediaType expected literal \"text/plain\"");
    });
  });

  it("normalizes schema-backed signal payloads and requires raw strings without schema", () => {
    const ir: WorkflowIR = {
      irVersion: 2,
      name: "signals",
      inputSchema: { kind: "object", fields: {}, required: [], additionalProperties: false },
      agents: {},
      root: {
        nodes: [
          {
            id: "raw",
            kind: "signal",
            run: { kind: "signal_run", prompt: { kind: "template", parts: [] } },
          },
          {
            id: "structured",
            kind: "signal",
            outputSchema: {
              kind: "object",
              fields: { ok: { kind: "boolean" } },
              required: ["ok"],
              additionalProperties: false,
            },
            run: { kind: "signal_run", prompt: { kind: "template", parts: [] } },
          },
        ],
        outputs: {},
      },
      outputs: {},
      lock: { acpusCoreVersion: "test", generatedAt: "2026-06-30T00:00:00.000Z", notes: [] },
      diagnostics: [],
    };

    expect(normalizeSignalPayload(ir, "raw", "approved")).toBe("approved");
    expect(() => normalizeSignalPayload(ir, "raw", { text: "approved" })).toThrow("Signal payload expected string.");
    expect(normalizeSignalPayload(ir, "structured", { ok: true })).toEqual({ ok: true });
  });

  it("admits inline task source and registers artifacts for admitted task runs", async () => {
    await withRuntimeWorkspace("runtime-task-artifact", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      expect(admitted.status).toBe("completed");
      const run = await getRun(workspace, admitted.run.id);
      expect(run?.output).toMatchObject({ ok: true, artifact: { kind: "artifact" } });
      const artifacts = runtimeRows(workspace, "SELECT node_key, attempt, media_type, digest, size, relative_path FROM artifacts WHERE run_id = ? ORDER BY id", admitted.run.id);
      expect(artifacts).toHaveLength(1);
      const artifact = artifacts[0];
      expect(artifact).toMatchObject({ attempt: 1, media_type: "text/plain", size: 12 });
      expect(String(artifact?.relative_path)).toContain(`${String(artifact?.node_key)}/attempt-1/`);
      const bytes = await readFile(join(workspace, ".acpus", ".local", "runs", admitted.run.id, String(artifact?.relative_path)));
      expect(bytes.toString("utf8")).toBe("artifact-ok\n");
      expect(artifact?.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      await access(join(workspace, ".acpus", ".local", "runs", admitted.run.id, "workflow.ir.json"));
      await access(join(workspace, ".acpus", ".local", "runs", admitted.run.id, "lock.json"));
    });
  });

  it("passes task run invocation input, cwd, env, and execution options to runtime tasks", async () => {
    await withRuntimeWorkspace("runtime-task-run-options", async workspace => {
      const workDir = join(workspace, "task-workdir");
      await mkdir(workDir);

      const admitted = await admitSyntheticWorkflow(workspace, taskInvocationOptionsWorkflow(), { workDir });

      expect(admitted.status).toBe("completed");
      await expect(getRun(workspace, admitted.run.id)).resolves.toMatchObject({
        status: "completed",
        output: {
          inputName: "runtime",
          cwd: workDir,
          envValue: "from-run-env",
          inputMode: "strict",
        },
      });
    });
  });

  it("persists durable failed state for task and pure execution failures", async () => {
    await withRuntimeWorkspace("runtime-failed-state", async workspace => {
      const task = await admitSyntheticWorkflow(workspace, failingTaskWorkflow());
      expect(task.status).toBe("failed");
      if (task.status !== "failed") throw new Error("expected task run to fail");
      expect(task.message).toBe("task exploded");
      expect(runtimeRow(workspace, "SELECT status, output_json FROM node_instances WHERE run_id = ? AND node_id = 'boom'", task.run.id)).toMatchObject({
        status: "failed",
        output_json: null,
      });

      const pure = await admitSyntheticWorkflow(workspace, failingPureWorkflow());
      expect(pure.status).toBe("failed");
      if (pure.status !== "failed") throw new Error("expected pure run to fail");
      expect(pure.message).toBe("Assert node 'fail' failed.");
      expect(runtimeRows(workspace, "SELECT node_id, status, result_json FROM scheduler_frames WHERE run_id = ? AND node_id = 'fail' ORDER BY node_id", pure.run.id)).toEqual([
        { node_id: "fail", status: "failed", result_json: null },
      ]);
    });
  });

  it.sequential("admits a workflow prepared from a real TypeScript fixture", async () => {
    await withRuntimeWorkspace("runtime-compiler-wiring", async workspace => {
      const admitted = await admitFixture(workspace, "workflows/valid.workflow.ts", { ready: true });

      expect(admitted).toMatchObject({
        status: "completed",
        run: {
          name: "runtime-wiring",
        },
      });
      await expect(getRun(workspace, admitted.run.id)).resolves.toMatchObject({
        output: { ready: true },
      });
    });
  });

  it.sequential("executes same-file reusable task references prepared from workflow module exports", async () => {
    await withRuntimeWorkspace("runtime-same-file-reusable", async workspace => {
      const prepared = await prepareFixture(workspace, "workflows/same-file-reusable.workflow.ts");
      const otherCwd = join(workspace, "not-the-workflow-dir");
      await mkdir(otherCwd);
      setSingleTaskCwd(prepared.ir, otherCwd);
      const frozen = preparedWorkflow(prepared.ir, prepared.workflowPath, workspace);
      const admitted = await admitWorkflowRun(workspace, frozen, normalizeWorkflowInput(frozen.ir, { path: "src\\workflow.ts" }));

      expect(admitted).toMatchObject({
        status: "completed",
        run: {
          name: "runtime-same-file-reusable",
        },
      });
      await expect(getRun(workspace, admitted.run.id)).resolves.toMatchObject({
        output: { normalized: "src/workflow.ts" },
      });
    });
  });

  it("fails task attempts for live reusable module load failures", async () => {
    await withRuntimeWorkspace("runtime-live-module-load-failure", async workspace => {
      const cases = [
        { name: "missing_module", specifier: "./missing-task.ts", exportName: "run", moduleSource: undefined, message: "Cannot find module" },
        { name: "missing_export", specifier: "./missing-export-task.ts", exportName: "run", moduleSource: "export const other = {};\n", message: "is not an Acpus task" },
        { name: "non_task_export", specifier: "./non-task-export-task.ts", exportName: "run", moduleSource: "export const run = {};\n", message: "is not an Acpus task" },
      ];

      for (const item of cases) {
        const prepared = await prepareSyntheticWorkflow(workspace, taskArtifactWorkflow(), `${item.name}.workflow.ts`);
        if (item.moduleSource !== undefined) await writeFile(join(workspace, item.specifier.slice(2)), item.moduleSource);
        setSingleTaskTarget(prepared.ir, {
          kind: "module",
          runtime: "node",
          specifier: item.specifier,
          exportName: item.exportName,
          referrer: { kind: "workflow", path: `${item.name}.workflow.ts` },
        });
        const frozen = preparedWorkflow(prepared.ir, prepared.workflowPath, workspace);
        const admitted = await admitWorkflowRun(workspace, frozen, normalizeWorkflowInput(frozen.ir, {}));

        expect(admitted.status).toBe("failed");
        if (admitted.status !== "failed") throw new Error("expected failed reusable module load run");
        expect(admitted.message).toContain(item.message);
      }
    });
  });

  it("executes reusable package tasks from @acpus/tasks", async () => {
    await withRuntimeWorkspace("runtime-acpus-tasks", async workspace => {
      const repo = join(workspace, "repo");
      const worktree = join(workspace, "worktree");
      await git(workspace, "init", "repo");
      await writeFile(join(repo, "README.md"), "ok\n");
      await git(repo, "add", "README.md");
      await git(repo, "-c", "user.name=Acpus Test", "-c", "user.email=test@example.com", "commit", "-m", "init");
      const head = (await git(repo, "rev-parse", "HEAD")).stdout.trim();

      const admitted = await admitFixture(workspace, "workflows/create-worktree.workflow.ts", { repo, path: worktree });

      expect(admitted.status).toBe("completed");
      await expect(getRun(workspace, admitted.run.id)).resolves.toMatchObject({
        output: {
          ok: true,
          worktreePath: worktree,
          baseSha: head,
        },
      });
      await expect(git(worktree, "rev-parse", "HEAD")).resolves.toMatchObject({ stdout: head + "\n" });
    });
  });

  it("loads package task source without ambient development conditions", async () => {
    const tsxImport = await import.meta.resolve("tsx");
    const coreSourceURL = new URL("../../core/src/index.ts", import.meta.url).href;
    const sourceResolverImport = sourcePackageResolverImport({
      "@acpus/loader": new URL("../../loader/src/index.ts", import.meta.url).href,
    });
    const script = `
      import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { executeTaskNode } from ${JSON.stringify(new URL("../src/execution/task-executor.ts", import.meta.url).href)};

      const workspace = await mkdtemp(join(tmpdir(), "acpus-package-loader-"));
      try {
        const nodeModules = join(workspace, "node_modules");
        const packageDir = join(nodeModules, "fallback-task-package");
        await mkdir(packageDir, { recursive: true });
        await writeFile(join(packageDir, "package.json"), JSON.stringify({
          name: "fallback-task-package",
          type: "module",
          exports: {
            "./task": {
              development: "./task.ts",
              default: "./dist/missing.js",
            },
            "./throwing": {
              development: "./task.ts",
              default: "./throwing.js",
            },
          },
        }));
        await writeFile(join(packageDir, "task.ts"), [
          ${JSON.stringify(`import { task, z } from ${JSON.stringify(coreSourceURL)};`)},
          "export const fallbackTask = task.define({",
          "  inputSchema: z.object({ value: z.string() }),",
          "  exec: async ({ input }) => ({ ok: true, value: 'dev:' + input.value }),",
          "});",
        ].join("\\n"));
        await writeFile(join(packageDir, "throwing.js"), "throw new Error('default exploded');\\n");
        await writeFile(join(workspace, "workflow.ts"), "");
        const output = await executeTaskNode({
          id: "fallback",
          kind: "task",
          run: {
            kind: "task_run",
            input: {
              value: { kind: "literal", value: "loaded" },
            },
            target: {
              kind: "module",
              runtime: "node",
              specifier: "fallback-task-package/task",
              exportName: "fallbackTask",
              referrer: { kind: "workflow", path: "workflow.ts" },
            },
          },
        }, {}, {
          cwd: workspace,
          runId: "run_1",
          store: { getRunDir: () => ".acpus/.local/runs/run_1", registerArtifact: () => {} },
        });
        if (output.value !== "dev:loaded") throw new Error("development export fallback was not used");
        let masked = false;
        try {
          await executeTaskNode({
            id: "throwing",
            kind: "task",
            run: {
              kind: "task_run",
              input: {
                value: { kind: "literal", value: "loaded" },
              },
              target: {
                kind: "module",
                runtime: "node",
                specifier: "fallback-task-package/throwing",
                exportName: "fallbackTask",
                referrer: { kind: "workflow", path: "workflow.ts" },
              },
            },
          }, {}, {
            cwd: workspace,
            runId: "run_2",
            store: { getRunDir: () => ".acpus/.local/runs/run_2", registerArtifact: () => {} },
          });
          masked = true;
        } catch (error) {
          if (!String(error instanceof Error ? error.message : error).includes("default exploded")) throw error;
        }
        if (masked) throw new Error("development fallback masked a module evaluation error");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    `;

    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    await expect(exec(process.execPath, ["--import", tsxImport, "--import", sourceResolverImport, "--eval", script], { cwd: process.cwd(), env })).resolves.toBeDefined();
  });
});

function sourcePackageResolverImport(aliases: Record<string, string>): string {
  const loader = `
const aliases = new Map(${JSON.stringify(Object.entries(aliases))});
export async function resolve(specifier, context, nextResolve) {
  const url = aliases.get(specifier);
  if (url) return { url, shortCircuit: true };
  return nextResolve(specifier, context);
}
`;
  const registerer = `
import { register } from "node:module";
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);
`;
  return `data:text/javascript,${encodeURIComponent(registerer)}`;
}

function setSingleTaskTarget(ir: WorkflowIR, target: TaskExecutionTargetIR): void {
  const node = ir.root.nodes.find(item => item.kind === "task");
  if (!node || node.kind !== "task") throw new Error("expected task node");
  node.run.target = target;
}

function setSingleTaskCwd(ir: WorkflowIR, cwd: string): void {
  const node = ir.root.nodes.find(item => item.kind === "task");
  if (!node || node.kind !== "task") throw new Error("expected task node");
  node.run.cwd = { kind: "literal", value: cwd };
}

function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec("git", args, { cwd, env: { ...process.env, ...testGitEnv() } });
}

function testGitEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: "Acpus Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Acpus Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
}
