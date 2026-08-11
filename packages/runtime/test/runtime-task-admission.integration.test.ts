import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TaskExecutionTargetIR, WorkflowIR } from "@acpus/core/ir";
import { getRun, tryNormalizeWorkflowInput } from "@acpus/runtime";
import { describe, expect, it } from "vitest";
import {
  admitPreparedWorkflowForTest,
  admitSyntheticWorkflow,
  failingPureWorkflow,
  failingTaskWorkflow,
  prepareFixture,
  prepareSyntheticWorkflow,
  preparedWorkflow,
  taskArtifactWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";

const exec = promisify(execFile);

describe.concurrent("runtime task admission use cases", () => {
  it("projects task and pure execution failures through public run state", async () => {
    await withRuntimeWorkspace("runtime-failed-state", async workspace => {
      const task = await admitSyntheticWorkflow(workspace, failingTaskWorkflow());
      expect(task.status).toBe("failed");
      const taskNode = (await getRun(workspace, task.run.id))._unsafeUnwrap()?.dynamic?.nodeInstances
        .find(node => node.nodeId === "boom");
      expect(taskNode).toMatchObject({ status: "failed" });
      expect(taskNode?.output).toBeUndefined();

      const pure = await admitSyntheticWorkflow(workspace, failingPureWorkflow());
      expect(pure.status).toBe("failed");
      const failedFrame = (await getRun(workspace, pure.run.id))._unsafeUnwrap()?.dynamic?.frames
        .find(frame => frame.nodeId === "fail");
      expect(failedFrame).toMatchObject({ status: "failed" });
      expect(failedFrame?.result).toBeUndefined();
    });
  });

  it("executes same-file reusable task references prepared from workflow module exports", async () => {
    await withRuntimeWorkspace("runtime-same-file-reusable", async workspace => {
      const packageLock = "lockfileVersion: '9.0'\n";
      await writeFile(join(workspace, "pnpm-lock.yaml"), packageLock);
      const prepared = await prepareFixture(workspace, "workflows/same-file-reusable.workflow.ts");
      const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
      const sourceDigest = digest(await readFile(join(workspace, prepared.source.entry), "utf8"));
      const packageLockDigest = digest(packageLock);
      const task = prepared.ir.root.nodes.find(node => node.id === "normalize_path");

      expect(JSON.parse(prepared.irJson)).toMatchObject({ irVersion: 7, name: "runtime-same-file-reusable" });
      expect(prepared.lock.workflow.entryDigest).toBe(sourceDigest);
      expect(prepared.packageLockDigest).toBe(packageLockDigest);
      expect(prepared.lock.packageLockDigest).toBe(packageLockDigest);
      expect(prepared.sourceGraphDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(prepared.lock.sourceGraphDigest).toBe(prepared.sourceGraphDigest);
      expect(prepared.lock.ir.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(prepared.lock.ir.digest).toBe(digest(prepared.irJson));
      expect(prepared.lock).toEqual({
        kind: "acpus_workflow_preparation_lock",
        version: 2,
        workflow: {
          source: { kind: "workspace", entry: "same-file-reusable.workflow.ts" },
          entryDigest: sourceDigest,
        },
        ir: { path: "workflow.ir.json", digest: prepared.lock.ir.digest },
        packageLockDigest,
        sourceGraphDigest: prepared.sourceGraphDigest,
      });
      expect(task).toMatchObject({
        kind: "task",
        run: {
          target: {
            kind: "module",
            specifier: "./same-file-reusable.workflow.ts",
            exportName: "normalizePath",
            referrer: { path: expect.stringContaining("same-file-reusable.workflow.ts") },
          },
        },
      });
      expect(prepared.ir.root.output).toMatchObject({ kind: "object", fields: { normalized: { kind: "ref", path: ["nodes", "normalize_path", "output", "normalized"] } } });
      const otherCwd = join(workspace, "not-the-workflow-dir");
      await mkdir(otherCwd);
      setSingleTaskCwd(prepared.ir, otherCwd);
      const frozen = preparedWorkflow(prepared.ir, join(workspace, prepared.source.entry), workspace);
      const admitted = await admitPreparedWorkflowForTest(workspace, frozen, tryNormalizeWorkflowInput(frozen.ir, { path: "src\\workflow.ts" })._unsafeUnwrap());

      expect(admitted).toMatchObject({
        status: "completed",
        run: {
          name: "runtime-same-file-reusable",
        },
      });
      expect((await getRun(workspace, admitted.run.id))._unsafeUnwrap()).toMatchObject({
        output: { normalized: "src/workflow.ts" },
      });
    }, { authoringEnvironment: true });
  });

  it("fails task attempts for live reusable module load failures", async () => {
    const cases = [
      { name: "missing_module", specifier: "./missing-task.ts", exportName: "run", moduleSource: undefined, message: "Cannot find module" },
      { name: "missing_export", specifier: "./missing-export-task.ts", exportName: "run", moduleSource: "export const other = {};\n", message: "is not an Acpus task" },
      { name: "non_task_export", specifier: "./non-task-export-task.ts", exportName: "run", moduleSource: "export const run = {};\n", message: "is not an Acpus task" },
    ];

    await Promise.all(cases.map(item =>
      withRuntimeWorkspace(`runtime-live-module-load-failure-${item.name}`, async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, taskArtifactWorkflow(), `${item.name}.workflow.ts`);
        if (item.moduleSource !== undefined) await writeFile(join(workspace, item.specifier.slice(2)), item.moduleSource);
        setSingleTaskTarget(prepared.ir, {
          kind: "module",
          specifier: item.specifier,
          exportName: item.exportName,
          referrer: { path: `${item.name}.workflow.ts` },
        });
        const frozen = preparedWorkflow(prepared.ir, join(workspace, prepared.source.entry), workspace);
        const admitted = await admitPreparedWorkflowForTest(workspace, frozen, tryNormalizeWorkflowInput(frozen.ir, {})._unsafeUnwrap());

        expect(admitted.status).toBe("failed");
        if (admitted.status !== "failed") throw new Error("expected failed reusable module load run");
        expect(admitted.message).toContain(item.message);
      }),
    ));
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

      const prepared = await prepareFixture(workspace, "workflows/create-worktree.workflow.ts");
      const task = prepared.ir.root.nodes.find(node => node.id === "create_worktree");
      expect(task).toMatchObject({
        kind: "task",
        run: {
          target: {
            kind: "module",
            specifier: "acpus/tasks/git",
            exportName: "createWorktree",
            referrer: { path: "create-worktree.workflow.ts" },
          },
        },
      });
      const admitted = await admitPreparedWorkflowForTest(
        workspace,
        prepared,
        tryNormalizeWorkflowInput(prepared.ir, { repo, path: worktree })._unsafeUnwrap(),
      );

      expect(admitted.status).toBe("completed");
      expect((await getRun(workspace, admitted.run.id))._unsafeUnwrap()).toMatchObject({
        output: {
          worktreePath: worktree,
          baseSha: head,
        },
      });
      await expect(git(worktree, "rev-parse", "HEAD")).resolves.toMatchObject({ stdout: head + "\n" });
    }, { authoringEnvironment: true });
  });

  it("loads package task source without ambient development conditions", async () => {
    const tsxImport = await import.meta.resolve("tsx");
    const sourceResolverImport = sourcePackageResolverImport({
      "@acpus/loader": new URL("../../loader/src/index.ts", import.meta.url).href,
    });
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
    delete env.NODE_OPTIONS;
    try {
      await exec(process.execPath, [
        "--import",
        tsxImport,
        "--import",
        sourceResolverImport,
        fileURLToPath(new URL("./fixtures/package-loader-subprocess.ts", import.meta.url)),
      ], { cwd: process.cwd(), env });
    } catch (error) {
      const failed = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
      throw new Error([
        "package loader subprocess failed",
        `stdout:\n${String(failed.stdout ?? "").trim()}`,
        `stderr:\n${String(failed.stderr ?? "").trim()}`,
      ].join("\n"));
    }
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
