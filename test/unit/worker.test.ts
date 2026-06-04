import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { readRunIndex, updateRunIndex } from "../../src/run-index/read-write.js";
import { prepareRun } from "../../src/runtime/run-workflow.js";
import { claimWorker, heartbeatWorker, markWorkerExit, terminalRunStatus, workerIsActive, workerSummary, WORKER_STALE_AFTER_MS } from "../../src/runtime/worker.js";
import { WorkflowSpecSchema } from "../../src/schema/workflow-spec.js";

describe("run worker metadata", () => {
  it("records heartbeat metadata and guards against a second active worker", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-worker-state-"));
    const prepared = await prepareRun(workerSpec(), { cwd, input: { cwd } });

    const activePid = process.pid;
    const stalePid = 999_999_999;
    const claimed = await claimWorker(cwd, prepared.logicalRunId, activePid);
    await heartbeatWorker(cwd, prepared.logicalRunId, activePid);
    const heartbeat = await readRunIndex(cwd, prepared.logicalRunId);

    expect(claimed.status).toBe("running");
    expect(heartbeat.worker).toMatchObject({ pid: activePid, generation: 1, status: "running" });
    expect(workerIsActive(heartbeat.worker)).toBe(true);
    await expect(claimWorker(cwd, prepared.logicalRunId, stalePid)).rejects.toThrow("already has an active worker");
    const sameWorker = await claimWorker(cwd, prepared.logicalRunId, activePid);
    expect(sameWorker.worker?.generation).toBe(1);

    await updateRunIndex(cwd, prepared.logicalRunId, (index) => ({
      ...index,
      worker: index.worker ? {
        ...index.worker,
        heartbeatAt: new Date(Date.now() - WORKER_STALE_AFTER_MS - 1_000).toISOString()
      } : undefined
    }));
    const stale = await readRunIndex(cwd, prepared.logicalRunId);
    expect(workerSummary(stale.worker)?.status).toBe("stale");

    const nextWorker = await spawnLiveProcess();
    try {
      const reclaimed = await claimWorker(cwd, prepared.logicalRunId, nextWorker.pid);
      expect(reclaimed.worker).toMatchObject({ pid: nextWorker.pid, generation: 2, status: "running" });
      expect(await heartbeatWorker(cwd, prepared.logicalRunId, stalePid, 1)).toBe(false);
      await markWorkerExit(cwd, prepared.logicalRunId, stalePid, "failed", 1, 1);
      expect((await readRunIndex(cwd, prepared.logicalRunId)).worker).toMatchObject({ pid: nextWorker.pid, generation: 2, status: "running" });
    } finally {
      nextWorker.kill();
    }

    const killed = await claimWorker(cwd, prepared.logicalRunId, stalePid, { force: true });
    expect(workerSummary(killed.worker)?.status).toBe("stale");
    expect(workerIsActive(killed.worker)).toBe(false);

    const exited = await markWorkerExit(cwd, prepared.logicalRunId, stalePid, "exited", 0, killed.worker?.generation);
    expect(exited.worker).toMatchObject({ pid: stalePid, status: "exited", exitCode: 0 });
    expect(exited.worker?.exitedAt).toEqual(expect.any(String));
  });

  it("rejects stale worker reclaim for terminal runs", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-worker-terminal-"));
    const prepared = await prepareRun(workerSpec(), { cwd, input: { cwd } });
    await updateRunIndex(cwd, prepared.logicalRunId, (index) => ({
      ...index,
      status: "completed"
    }));

    // Terminal runs should not allow reclaiming even with stale worker
    const index = await readRunIndex(cwd, prepared.logicalRunId);
    expect(terminalRunStatus(index.status)).toBe(true);
    await expect(claimWorker(cwd, prepared.logicalRunId, process.pid, { force: true })).rejects.toThrow("Cannot start worker for terminal run");
  });
});

async function spawnLiveProcess(): Promise<ChildProcess & { pid: number }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore"
  });
  if (child.pid === undefined) throw new Error("Failed to spawn live process");
  child.unref();
  return child as ChildProcess & { pid: number };
}

function workerSpec() {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "worker-state",
    root: "task",
    stages: [
      { id: "task", kind: "task", mode: "agent", actor: { agent: "gpt-test", mode: "readOnly", label: "implementer" }, prompt: "Observe worker state." }
    ]
  });
}
