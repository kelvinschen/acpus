import { access, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getRun, listRuns, readInspection, tryNormalizeWorkflowInput } from "@acpus/runtime";
import { openExistingRuntimeStore, openRuntimeStore } from "../src/store/store.js";
import { stableJson } from "../src/stable-json.js";
import {
  admitPreparedWorkflowForTest,
  admitSyntheticWorkflow,
  metaWorkflow,
  prepareSyntheticWorkflow,
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

const runIdPattern = /^\d{14}[A-F0-9]{20}$/;

describe.concurrent("runtime admission use cases", () => {
  it("replays one admission request without creating another run or event", async () => {
    await withRuntimeWorkspace("runtime-admission-request-replay", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const request = {
          prepared,
          input: { ready: true },
          cwd: workspace,
          requestId: "admission-request-replay",
        } as const;
        const first = await store.admitRun(request);
        const replay = await store.admitRun(request);

        expect(first.isOk()).toBe(true);
        expect(replay.isOk() && first.isOk() ? replay.value.id : undefined).toBe(first.isOk() ? first.value.id : undefined);
        expect(runtimeRows(workspace, "SELECT run_id FROM run_events WHERE type = 'run.admitted'"))
          .toEqual([{ run_id: first.isOk() ? first.value.id : undefined }]);
        expect(await readdir(runtimeRunsRoot(workspace))).toEqual([first.isOk() ? first.value.id : undefined]);
      } finally {
        store.close();
      }
    });
  });

  it("rejects reuse of an admission request for a different fingerprint without writes", async () => {
    await withRuntimeWorkspace("runtime-admission-request-conflict", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const admitted = await store.admitRun({
          prepared,
          input: { ready: true },
          cwd: workspace,
          requestId: "admission-request-conflict",
        });
        const beforeRuns = await readdir(runtimeRunsRoot(workspace));
        const conflict = await store.admitRun({
          prepared,
          input: { ready: false },
          cwd: workspace,
          requestId: "admission-request-conflict",
        });

        expect(admitted.isOk()).toBe(true);
        expect(conflict.isErr() ? conflict.error : undefined).toEqual({
          type: "admission-request-conflict",
          requestId: "admission-request-conflict",
          message: "Admission request 'admission-request-conflict' conflicts with a different prepared run.",
        });
        expect(await readdir(runtimeRunsRoot(workspace))).toEqual(beforeRuns);
        expect(runtimeRows(workspace, "SELECT run_id FROM run_events WHERE type = 'run.admitted'"))
          .toHaveLength(1);
      } finally {
        store.close();
      }
    });
  });

  it("admits a pure run and exposes read-only inspection", async () => {
    await withRuntimeWorkspace("runtime-admit-pure", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const admitted = await admitPreparedWorkflowForTest(workspace, prepared, tryNormalizeWorkflowInput(prepared.ir, { ready: true })._unsafeUnwrap());

      expect(admitted.status).toBe("completed");
      expect(admitted.run.id).toMatch(runIdPattern);
      expect((await listRuns(workspace))._unsafeUnwrap()).toEqual([
        expect.objectContaining({ id: admitted.run.id, status: "completed", name: "cli-valid" }),
      ]);
      const inspected = (await getRun(workspace, admitted.run.id))._unsafeUnwrap();
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
      const forensics = await readInspection(workspace, {
        kind: "target", runId: admitted.run.id, target: "root", detail: "forensics",
      });
      expect(forensics.isOk() ? forensics.value : undefined).toMatchObject({
        kind: "target",
        detail: "forensics",
        run: { id: admitted.run.id, status: "completed" },
        definition: { kind: "workflow", name: "cli-valid" },
        invocation: { status: "resolved", kind: "workflow", input: { ready: true } },
        result: { status: "accepted", value: { ready: true } },
      });
    });
  });

  it("inspects frozen static metadata without reading live workflow source", async () => {
    await withRuntimeWorkspace("runtime-inspect-frozen-static", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, signalWorkflow());
      const admitted = await admitPreparedWorkflowForTest(workspace, prepared, tryNormalizeWorkflowInput(prepared.ir, {})._unsafeUnwrap());
      await writeFile(join(workspace, prepared.source.entry), "throw new Error('live source should not be read');\n");

      const inspected = await readInspection(workspace, {
        kind: "target", runId: admitted.run.id, target: "approve", detail: "summary",
      });
      expect(inspected.isOk() ? inspected.value : undefined).toMatchObject({
        kind: "target",
        detail: "summary",
        run: { id: admitted.run.id },
        subject: { label: "approve", kind: "signal" },
      });
      const forensics = await readInspection(workspace, {
        kind: "target", runId: admitted.run.id, target: "approve", detail: "forensics",
      });
      expect(forensics.isOk() ? forensics.value : undefined).toMatchObject({
        kind: "target",
        detail: "forensics",
        definition: { kind: "signal" },
      });
    });
  });

  it("rejects a frozen workflow file whose digest no longer matches", async () => {
    await withRuntimeWorkspace("runtime-frozen-digest-mismatch", async workspace => {
      const corrupted = await admitSyntheticWorkflow(workspace, validWorkflow(), { ready: true });
      await writeFile(join(runtimeRunDir(workspace, corrupted.run.id), "workflow.ir.json"), "{}\n");
      await expect(frozenReadErrorMessage(workspace, corrupted.run.id)).resolves.toContain("Frozen workflow IR digest mismatch.");
    });
  });

  it("surfaces missing and non-contained frozen workflow files", async () => {
    await withRuntimeWorkspace("runtime-frozen-file-invariants", async workspace => {
      const missing = await admitSyntheticWorkflow(workspace, validWorkflow(), { ready: true });
      await rm(join(runtimeRunDir(workspace, missing.run.id), "workflow.ir.json"));
      await expect(frozenReadErrorMessage(workspace, missing.run.id)).resolves.toContain("ENOENT");

      const escapedFile = await admitSyntheticWorkflow(workspace, validWorkflow(), { ready: true });
      const db = new DatabaseSync(runtimeDatabasePath(workspace));
      try {
        db.prepare("UPDATE run_inputs SET workflow_ir_path = '../outside.json' WHERE run_id = ?").run(escapedFile.run.id);
      } finally {
        db.close();
      }
      await expect(frozenReadErrorMessage(workspace, escapedFile.run.id)).resolves.toContain("Path '../outside.json' escapes run directory.");

      const symlinkedRunDir = await admitSyntheticWorkflow(workspace, validWorkflow(), { ready: true });
      const symlinkedRunPath = runtimeRunDir(workspace, symlinkedRunDir.run.id);
      const outsideRunPath = join(workspace, "outside-run");
      await rename(symlinkedRunPath, outsideRunPath);
      await symlink(outsideRunPath, symlinkedRunPath, "dir");
      await expect(frozenReadErrorMessage(workspace, symlinkedRunDir.run.id)).resolves.toContain(
        `Run directory '${symlinkedRunDir.run.id}' is outside runtime runs root '${runtimeRunsRoot(workspace)}'.`,
      );

      const symlinkedFile = await admitSyntheticWorkflow(workspace, validWorkflow(), { ready: true });
      const workflowPath = join(runtimeRunDir(workspace, symlinkedFile.run.id), "workflow.ir.json");
      const outsideWorkflowPath = join(workspace, "outside-workflow.ir.json");
      await writeFile(outsideWorkflowPath, await readFile(workflowPath));
      await rm(workflowPath);
      await symlink(outsideWorkflowPath, workflowPath);
      await expect(frozenReadErrorMessage(workspace, symlinkedFile.run.id)).resolves.toContain("is a symbolic link");

      const symlinkedRunsRoot = await admitSyntheticWorkflow(workspace, validWorkflow(), { ready: true });
      const runsRoot = runtimeRunsRoot(workspace);
      const outsideRunsRoot = join(workspace, "outside-runs-root");
      await rename(runsRoot, outsideRunsRoot);
      await symlink(outsideRunsRoot, runsRoot, "dir");
      await expect(frozenReadErrorMessage(workspace, symlinkedRunsRoot.run.id)).resolves.toContain(
        "is incomplete: entry 'runs' has an invalid file type.",
      );
    });
  });

  it("injects run-level workflow meta into expressions", async () => {
    await withRuntimeWorkspace("runtime-meta", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, metaWorkflow());
      expect(admitted.status).toBe("completed");
      expect((await getRun(workspace, admitted.run.id))._unsafeUnwrap()).toMatchObject({
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
      const run = (await getRun(workspace, admitted.run.id))._unsafeUnwrap();
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
      const run = (await getRun(workspace, admitted.run.id))._unsafeUnwrap();
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
      const invocation = run?.dynamic?.executionMetadata.find(entry => entry.kind === "task_attempt")?.metadata;
      expect(invocation).toMatchObject({
        defaultCommandTimeout: "5s",
      });
      expect(invocation).toHaveProperty("env", { RUNTIME_TASK_ENV: "from-run-env" });
      const inspected = await readInspection(workspace, {
        kind: "target", runId: admitted.run.id, target: "inspect_invocation", detail: "forensics",
      });
      expect(inspected.isOk() ? inspected.value : undefined).toMatchObject({
        kind: "target",
        detail: "forensics",
        invocation: {
          status: "resolved",
          kind: "task",
          attempt: 1,
          cwd: workDir,
          env: { RUNTIME_TASK_ENV: "from-run-env" },
          defaultCommandTimeout: "5s",
        },
      });

      const timedOut = await admitSyntheticWorkflow(workspace, taskInvocationOptionsWorkflow(), {
        workDir,
        commandTimeout: "100ms",
        runSlowCommand: true,
      });
      expect(timedOut.status).toBe("failed");
      const timedOutRun = (await getRun(workspace, timedOut.run.id))._unsafeUnwrap();
      expect(timedOutRun?.dynamic?.nodeInstances.find(instance => instance.nodeId === "inspect_invocation")?.status).toBe("failed");
      expect(timedOutRun?.dynamic?.attempts.find(attempt => attempt.nodeId === "inspect_invocation")?.status).toBe("failed");
      const timedOutInvocation = timedOutRun?.dynamic?.executionMetadata.find(entry => entry.kind === "task_attempt")?.metadata;
      expect(timedOutInvocation).toMatchObject({
        defaultCommandTimeout: "100ms",
      });
      expect(timedOutInvocation).toHaveProperty("env", { RUNTIME_TASK_ENV: "from-run-env" });
    });
  });
});

async function frozenReadErrorMessage(workspace: string, runId: string): Promise<string> {
  let store: Awaited<ReturnType<typeof openExistingRuntimeStore>> | undefined;
  try {
    store = await openExistingRuntimeStore(workspace);
    if (!store) throw new Error("Expected runtime store.");
    store.readRunInspection(runId);
    throw new Error("Expected frozen workflow read to fail.");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    store?.close();
  }
}
