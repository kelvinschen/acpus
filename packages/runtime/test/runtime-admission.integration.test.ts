import { access, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { getRun, inspectRaw, listRuns, tryNormalizeWorkflowInput } from "@acpus/runtime";
import { stableJson } from "../src/stable-json.js";
import type { TaskExecutionTargetIR, WorkflowIR } from "@acpus/core/ir";
import {
  admitPreparedWorkflowForTest,
  admitSyntheticWorkflow,
  failingPureWorkflow,
  failingTaskWorkflow,
  metaWorkflow,
  prepareFixture,
  prepareSyntheticWorkflow,
  preparedWorkflow,
  runtimeDatabasePath,
  runtimeRunDir,
  runtimeRunsRoot,
  runtimeRows,
  signalWorkflow,
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
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const admitted = await admitPreparedWorkflowForTest(workspace, prepared, tryNormalizeWorkflowInput(prepared.ir, { ready: true })._unsafeUnwrap());

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
      const admittedPayload = JSON.parse(String(runtimeRows(workspace, "SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'run.admitted'", admitted.run.id)[0]?.payload_json));
      expect(admittedPayload.workflow).toMatchObject({
        name: "cli-valid",
        description: "Validate a boolean ready input.",
      });
      const runDir = runtimeRunDir(workspace, admitted.run.id);
      const workflowIr = await readFile(join(runDir, "workflow.ir.json"));
      const workflowLock = await readFile(join(runDir, "lock.json"));
      expect(workflowIr.toString("utf8")).toBe(prepared.irJson);
      expect(workflowLock.toString("utf8")).toBe(`${stableJson(prepared.lock)}\n`);
      expect(JSON.parse(workflowLock.toString("utf8"))).toEqual(prepared.lock);
    });
  });

  it("inspects frozen static metadata without reading live workflow source", async () => {
    await withRuntimeWorkspace("runtime-inspect-frozen-static", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, signalWorkflow());
      const admitted = await admitPreparedWorkflowForTest(workspace, prepared, tryNormalizeWorkflowInput(prepared.ir, {})._unsafeUnwrap());
      await writeFile(join(workspace, prepared.source.entry), "throw new Error('live source should not be read');\n");

      await expect(rawInspection(workspace, admitted.run.id)).resolves.toMatchObject({
        run: { id: admitted.run.id, name: "cli-signal" },
        workflow: {
          name: "cli-signal",
          root: {
            nodes: expect.arrayContaining([
              expect.objectContaining({
                id: "approve",
                kind: "signal",
                outputSchema: expect.objectContaining({
                  kind: "object",
                  fields: { ok: { kind: "boolean" } },
                  required: ["ok"],
                }),
              }),
            ]),
          },
        },
      });
    });
  });

  it("rejects a frozen workflow file whose digest no longer matches", async () => {
    await withRuntimeWorkspace("runtime-frozen-digest-mismatch", async workspace => {
      const corrupted = await admitSyntheticWorkflow(workspace, validWorkflow(), { ready: true });
      await writeFile(join(runtimeRunDir(workspace, corrupted.run.id), "workflow.ir.json"), "{}\n");
      await expect(inspectionErrorMessage(workspace, corrupted.run.id)).resolves.toContain("Frozen workflow IR digest mismatch.");
    });
  });

  it("surfaces missing and non-contained frozen workflow files", async () => {
    await withRuntimeWorkspace("runtime-frozen-file-invariants", async workspace => {
      const missing = await admitSyntheticWorkflow(workspace, validWorkflow(), { ready: true });
      await rm(join(runtimeRunDir(workspace, missing.run.id), "workflow.ir.json"));
      await expect(inspectionErrorMessage(workspace, missing.run.id)).resolves.toContain("ENOENT");

      const escapedFile = await admitSyntheticWorkflow(workspace, validWorkflow(), { ready: true });
      const db = new DatabaseSync(runtimeDatabasePath(workspace));
      try {
        db.prepare("UPDATE run_inputs SET workflow_ir_path = '../outside.json' WHERE run_id = ?").run(escapedFile.run.id);
      } finally {
        db.close();
      }
      await expect(inspectionErrorMessage(workspace, escapedFile.run.id)).resolves.toContain("Path '../outside.json' escapes run directory.");

      const symlinkedRunDir = await admitSyntheticWorkflow(workspace, validWorkflow(), { ready: true });
      const symlinkedRunPath = runtimeRunDir(workspace, symlinkedRunDir.run.id);
      const outsideRunPath = join(workspace, "outside-run");
      await rename(symlinkedRunPath, outsideRunPath);
      await symlink(outsideRunPath, symlinkedRunPath, "dir");
      await expect(inspectionErrorMessage(workspace, symlinkedRunDir.run.id)).resolves.toContain(
        `Run directory '${symlinkedRunDir.run.id}' is outside runtime runs root '${runtimeRunsRoot(workspace)}'.`,
      );

      const symlinkedFile = await admitSyntheticWorkflow(workspace, validWorkflow(), { ready: true });
      const workflowPath = join(runtimeRunDir(workspace, symlinkedFile.run.id), "workflow.ir.json");
      const outsideWorkflowPath = join(workspace, "outside-workflow.ir.json");
      await writeFile(outsideWorkflowPath, await readFile(workflowPath));
      await rm(workflowPath);
      await symlink(outsideWorkflowPath, workflowPath);
      await expect(inspectionErrorMessage(workspace, symlinkedFile.run.id)).resolves.toContain("is a symbolic link");

      const symlinkedRunsRoot = await admitSyntheticWorkflow(workspace, validWorkflow(), { ready: true });
      const runsRoot = runtimeRunsRoot(workspace);
      const outsideRunsRoot = join(workspace, "outside-runs-root");
      await rename(runsRoot, outsideRunsRoot);
      await symlink(outsideRunsRoot, runsRoot, "dir");
      await expect(inspectionErrorMessage(workspace, symlinkedRunsRoot.run.id)).resolves.toContain(
        `Runtime runs root '${runsRoot}' is not a regular directory.`,
      );
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
      const runDir = runtimeRunDir(workspace, admitted.run.id);
      const bytes = await readFile(join(runDir, String(artifact?.relative_path)));
      expect(bytes.toString("utf8")).toBe("artifact-ok\n");
      expect(artifact?.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      await access(join(runDir, "workflow.ir.json"));
      await access(join(runDir, "lock.json"));
    });
  });

  it("passes task run invocation input, cwd, env, and default command timeout to runtime tasks", async () => {
    await withRuntimeWorkspace("runtime-task-run-options", async workspace => {
      const workDir = join(workspace, "task-workdir");
      await mkdir(workDir);

      const admitted = await admitSyntheticWorkflow(workspace, taskInvocationOptionsWorkflow(), {
        workDir,
        commandTimeout: "5s",
        runSlowCommand: false,
      });

      expect(admitted.status).toBe("completed");
      const run = await getRun(workspace, admitted.run.id);
      expect(run).toMatchObject({
        status: "completed",
        output: {
          inputName: "runtime",
          cwd: workDir,
          processCwd: workDir,
          envValue: "from-run-env",
          processEnvValue: "from-run-env",
          sameEnvObject: true,
          inputMode: "strict",
        },
      });
      expect(run?.dynamic?.executionMetadata.find(entry => entry.kind === "task_attempt")?.metadata).toMatchObject({
        defaultCommandTimeout: "5s",
      });

      const timedOut = await admitSyntheticWorkflow(workspace, taskInvocationOptionsWorkflow(), {
        workDir,
        commandTimeout: "100ms",
        runSlowCommand: true,
      });
      expect(timedOut.status).toBe("failed");
      const timedOutRun = await getRun(workspace, timedOut.run.id);
      expect(timedOutRun?.dynamic?.nodeInstances.find(instance => instance.nodeId === "inspect_invocation")?.status).toBe("failed");
      expect(timedOutRun?.dynamic?.attempts.find(attempt => attempt.nodeId === "inspect_invocation")?.status).toBe("failed");
      expect(timedOutRun?.dynamic?.executionMetadata.find(entry => entry.kind === "task_attempt")?.metadata).toMatchObject({
        defaultCommandTimeout: "100ms",
      });
    });
  });

  it("projects task and pure execution failures through public run state", async () => {
    await withRuntimeWorkspace("runtime-failed-state", async workspace => {
      const task = await admitSyntheticWorkflow(workspace, failingTaskWorkflow());
      expect(task.status).toBe("failed");
      const taskNode = (await getRun(workspace, task.run.id))?.dynamic?.nodeInstances
        .find(node => node.nodeId === "boom");
      expect(taskNode).toMatchObject({ status: "failed" });
      expect(taskNode?.output).toBeUndefined();

      const pure = await admitSyntheticWorkflow(workspace, failingPureWorkflow());
      expect(pure.status).toBe("failed");
      const failedFrame = (await getRun(workspace, pure.run.id))?.dynamic?.frames
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
      await expect(getRun(workspace, admitted.run.id)).resolves.toMatchObject({
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
      await expect(getRun(workspace, admitted.run.id)).resolves.toMatchObject({
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

async function rawInspection(workspace: string, runId: string) {
  const result = await inspectRaw(workspace, { runId });
  if (result.isErr()) throw new Error(result.error.message);
  return result.value;
}

async function inspectionErrorMessage(workspace: string, runId: string): Promise<string> {
  const result = await inspectRaw(workspace, { runId });
  if (result.isOk()) throw new Error("Expected inspection to fail.");
  return result.error.message;
}

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
