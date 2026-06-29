import { access, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getRun, listRuns, normalizeWorkflowInput, replayRun } from "@acpus/runtime";
import {
  admitFixture,
  admitSyntheticWorkflow,
  defaultRefInputWorkflow,
  failingPureWorkflow,
  failingTaskWorkflow,
  prepareSyntheticWorkflow,
  runtimeRow,
  runtimeRows,
  taskArtifactWorkflow,
  taskInvocationOptionsWorkflow,
  validWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";

describe.concurrent("runtime admission use cases", () => {
  it("admits a pure run and exposes read-only inspection and replay", async () => {
    await withRuntimeWorkspace("runtime-admit-pure", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, validWorkflow(), { ready: true });

      expect(admitted.status).toBe("completed");
      expect(await listRuns(workspace)).toEqual([
        expect.objectContaining({ id: admitted.run.id, status: "completed", name: "cli-valid" }),
      ]);
      await expect(getRun(workspace, admitted.run.id)).resolves.toMatchObject({
        id: admitted.run.id,
        status: "completed",
        input: { ready: true },
        output: { ready: true },
        eventCount: 2,
        nodeCount: 1,
      });
      await expect(replayRun(workspace, admitted.run.id)).resolves.toMatchObject({
        ok: true,
        expected: { ready: true },
        actual: { ready: true },
      });
      expect(runtimeRows(workspace, "SELECT sequence, type FROM run_events WHERE run_id = ? ORDER BY sequence", admitted.run.id)).toEqual([
        expect.objectContaining({ sequence: 1, type: "run.admitted" }),
        expect.objectContaining({ sequence: 2, type: "run.completed" }),
      ]);
    });
  });

  it("normalizes input defaults and rejects invalid artifact refs before admission", async () => {
    await withRuntimeWorkspace("runtime-input-normalize", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, defaultRefInputWorkflow());
      expect(normalizeWorkflowInput(prepared.ir, {
        patch: { kind: "artifact", uri: "artifact://patch", mediaType: "text/plain" },
        token: { kind: "secret", name: "API_TOKEN" },
      })).toEqual({
        base: "main",
        patch: { kind: "artifact", uri: "artifact://patch", mediaType: "text/plain" },
        token: { kind: "secret", name: "API_TOKEN" },
      });
      expect(() => normalizeWorkflowInput(prepared.ir, {
        patch: { kind: "artifact", uri: "artifact://patch", mediaType: "application/json" },
        token: { kind: "secret", name: "API_TOKEN" },
      })).toThrow("$.patch.mediaType expected \"text/plain\"");
    });
  });

  it("copies task bundles and registers artifacts for admitted task runs", async () => {
    await withRuntimeWorkspace("runtime-task-artifact", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      expect(admitted.status).toBe("completed");
      const run = await getRun(workspace, admitted.run.id);
      expect(run?.output).toMatchObject({ ok: true, artifact: { kind: "artifact" } });
      const artifact = runtimeRow(workspace, "SELECT media_type, digest, size, relative_path FROM artifacts WHERE run_id = ? AND node_key = ?", admitted.run.id, "local_task");
      expect(artifact).toMatchObject({ media_type: "text/plain", size: 12 });
      const bytes = await readFile(join(workspace, ".acpus", "runs", admitted.run.id, String(artifact?.relative_path)));
      expect(bytes.toString("utf8")).toBe("artifact-ok\n");
      expect(artifact?.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      await access(join(workspace, ".acpus", "runs", admitted.run.id, "workflow.ir.json"));
      await access(join(workspace, ".acpus", "runs", admitted.run.id, "lock.json"));
    });
  });

  it("passes task run invocation input, cwd, env, params, and execution options to runtime tasks", async () => {
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
          paramsMode: "strict",
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
      expect(runtimeRow(workspace, "SELECT status, output_json FROM node_states WHERE run_id = ? AND node_key = 'boom'", task.run.id)).toMatchObject({
        status: "failed",
        output_json: null,
      });

      const pure = await admitSyntheticWorkflow(workspace, failingPureWorkflow());
      expect(pure.status).toBe("failed");
      if (pure.status !== "failed") throw new Error("expected pure run to fail");
      expect(pure.message).toBe("Assert node 'fail' failed.");
      expect(runtimeRows(workspace, "SELECT node_key, status, output_json FROM node_states WHERE run_id = ? ORDER BY node_key", pure.run.id)).toEqual([
        { node_key: "fail", status: "failed", output_json: null },
      ]);
    });
  });

  it("admits a workflow prepared from a real TypeScript fixture", async () => {
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
});
