import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getRun, listRuns, mutateRun, normalizeForkInput, replayRun, signalRun } from "@acpus/runtime";
import { runSupervisorTick } from "../src/supervisor/tick.js";
import { openExistingWritableRuntimeStore } from "../src/store/store.js";
import {
  admitSyntheticWorkflow,
  failingPureWorkflow,
  inputEchoWorkflow,
  missingProviderWorkflow,
  prepareSyntheticWorkflow,
  replacementTaskWorkflow,
  runtimeRow,
  runtimeRows,
  signalWorkflow,
  taskArtifactWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";

describe.concurrent("runtime controls and recovery use cases", () => {
  it("pauses, resumes, and applies retry commands to durable runs", async () => {
    await withRuntimeWorkspace("runtime-controls", async workspace => {
      const pending = await admitSyntheticWorkflow(workspace, missingProviderWorkflow());
      expect(pending.status).toBe("blocked");
      const runId = pending.run.id;

      await expect(mutateRun(workspace, runId, "pause")).resolves.toMatchObject({ run: { status: "paused" } });
      await expect(mutateRun(workspace, runId, "resume")).resolves.toMatchObject({ run: { status: "pending" } });
      expect(runtimeRows(workspace, "SELECT type, status FROM commands WHERE run_id = ? ORDER BY created_at", runId)).toEqual([
        { type: "pause", status: "applied" },
        { type: "resume", status: "applied" },
      ]);

      const failed = await admitSyntheticWorkflow(workspace, failingPureWorkflow());
      expect(failed.status).toBe("failed");
      const failedId = failed.run.id;
      const store = await openExistingWritableRuntimeStore(workspace);
      expect(store).toBeDefined();
      try {
        const retried = store!.retryRun(failedId);
        expect(retried.status).toBe("pending");
      } finally {
        store?.close();
      }

      const rerun = await admitSyntheticWorkflow(workspace, failingPureWorkflow());
      expect(rerun.status).toBe("failed");
      await expect(mutateRun(workspace, rerun.run.id, "retry")).resolves.toMatchObject({
        run: { status: "failed" },
        advanced: { status: "failed" },
      });
      expect(runtimeRow(workspace, "SELECT type, status FROM commands WHERE run_id = ? AND type = 'retry'", rerun.run.id)).toMatchObject({ type: "retry", status: "applied" });
    });
  }, 15_000);

  it("forks completed runs with inherited outputs and artifact refs", async () => {
    await withRuntimeWorkspace("runtime-fork-completed", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      expect(source.status).toBe("completed");

      const fork = await mutateRun(workspace, source.run.id, "fork");

      expect(fork?.run.status).toBe("completed");
      expect(fork?.run.id).not.toBe(source.run.id);
      const sourceArtifacts = runtimeRows(workspace, "SELECT id, media_type, digest, size, relative_path FROM artifacts WHERE run_id = ? ORDER BY id", source.run.id);
      const forkArtifacts = runtimeRows(workspace, "SELECT id, media_type, digest, size, relative_path FROM artifacts WHERE run_id = ? ORDER BY id", fork!.run.id);
      expect(forkArtifacts).toHaveLength(sourceArtifacts.length);
      expect(forkArtifacts.map(row => row.id)).not.toEqual(sourceArtifacts.map(row => row.id));
      expect(forkArtifacts.map(({ id: _id, ...row }) => row)).toEqual(sourceArtifacts.map(({ id: _id, ...row }) => row));
      await expect(getRun(workspace, fork!.run.id)).resolves.toMatchObject({ output: { ok: true } });
    });
  }, 15_000);

  it("forks with replacement workflow and input override without inheriting stale output", async () => {
    await withRuntimeWorkspace("runtime-fork-replacement", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      expect(source.status).toBe("completed");
      const replacement = await prepareSyntheticWorkflow(workspace, replacementTaskWorkflow());

      const fork = await mutateRun(workspace, source.run.id, "fork", { prepared: replacement });

      expect(fork?.run).toMatchObject({ name: "cli-task-replacement", status: "pending" });
      const store = await openExistingWritableRuntimeStore(workspace);
      expect(store).toBeDefined();
      try {
        await runSupervisorTick(workspace, store!);
      } finally {
        store?.close();
      }
      await expect(getRun(workspace, fork!.run.id)).resolves.toMatchObject({ status: "completed", output: { ok: true, extra: true } });

      const inputSource = await admitSyntheticWorkflow(workspace, inputEchoWorkflow(), { value: "old" });
      const input = await normalizeForkInput(workspace, inputSource.run.id, { value: "new" });
      if (input === undefined) throw new Error("expected fork input to normalize");
      const inputFork = await mutateRun(workspace, inputSource.run.id, "fork", { input });
      expect(inputFork?.run.status).toBe("pending");
      const store2 = await openExistingWritableRuntimeStore(workspace);
      expect(store2).toBeDefined();
      try {
        await runSupervisorTick(workspace, store2!);
      } finally {
        store2?.close();
      }
      await expect(getRun(workspace, inputFork!.run.id)).resolves.toMatchObject({ status: "completed", output: { value: "new" } });
    });
  }, 20_000);

  it("signals awaiting runs and rejects invalid signals without mutation", async () => {
    await withRuntimeWorkspace("runtime-signal", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, signalWorkflow());
      expect(awaiting.status).toBe("awaiting");
      const runId = awaiting.run.id;
      await expect(listRuns(workspace)).resolves.toEqual([
        expect.objectContaining({ id: runId, status: "awaiting" }),
      ]);

      await expect(signalRun(workspace, runId, "approve", { ok: "yes" })).rejects.toThrow("Signal payload does not match schema");
      await expect(signalRun(workspace, runId, "missing", { ok: true })).rejects.toThrow("Signal node 'missing' was not found.");
      expect(runtimeRows(workspace, "SELECT type FROM run_events WHERE run_id = ? ORDER BY sequence", runId).map(row => row.type)).toEqual([
        "run.admitted",
        "signal.awaiting",
      ]);

      await expect(signalRun(workspace, runId, "approve", { ok: true })).resolves.toMatchObject({
        run: { status: "completed", output: { ok: true } },
      });
      await expect(getRun(workspace, runId)).resolves.toMatchObject({ status: "completed", output: { ok: true } });
    });
  });

  it("detects replay artifact and projection drift without mutating state", async () => {
    await withRuntimeWorkspace("runtime-replay-drift", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const artifact = runtimeRow(workspace, "SELECT id, relative_path FROM artifacts WHERE run_id = ?", admitted.run.id);
      await writeFile(join(workspace, ".acpus", "runs", admitted.run.id, String(artifact?.relative_path)), "corrupted\n");
      await expect(replayRun(workspace, admitted.run.id)).resolves.toMatchObject({
        ok: false,
        artifacts: {
          mismatched: [expect.objectContaining({ id: artifact?.id })],
        },
      });
    });
  });
});
