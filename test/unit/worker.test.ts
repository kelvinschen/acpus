import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRunIndex, updateRunIndex } from "../../src/run-index/read-write.js";
import { prepareRun } from "../../src/runtime/run-workflow.js";
import { claimWorker, heartbeatWorker, markWorkerExit, recoverDriver, workerIsActive, workerSummary, WORKER_STALE_AFTER_MS } from "../../src/runtime/worker.js";
import { WorkflowSpecSchema } from "../../src/schema/workflow-spec.js";

describe("run worker metadata", () => {
  it("records heartbeat metadata and guards against a second active worker", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-worker-state-"));
    const prepared = await prepareRun(workerSpec(), { cwd, input: { cwd } });

    const claimed = await claimWorker(cwd, prepared.logicalRunId, 111);
    await heartbeatWorker(cwd, prepared.logicalRunId, 111);
    const heartbeat = await readRunIndex(cwd, prepared.logicalRunId);

    expect(claimed.status).toBe("running");
    expect(heartbeat.worker).toMatchObject({ pid: 111, generation: 1, status: "running" });
    expect(workerIsActive(heartbeat.worker)).toBe(true);
    await expect(claimWorker(cwd, prepared.logicalRunId, 222)).rejects.toThrow("already has an active worker");
    const sameWorker = await claimWorker(cwd, prepared.logicalRunId, 111);
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

    const reclaimed = await claimWorker(cwd, prepared.logicalRunId, 222);
    expect(reclaimed.worker).toMatchObject({ pid: 222, generation: 2, status: "running" });
    expect(await heartbeatWorker(cwd, prepared.logicalRunId, 111, 1)).toBe(false);
    await markWorkerExit(cwd, prepared.logicalRunId, 111, "failed", 1, 1);
    expect((await readRunIndex(cwd, prepared.logicalRunId)).worker).toMatchObject({ pid: 222, generation: 2, status: "running" });

    const exited = await markWorkerExit(cwd, prepared.logicalRunId, 222, "exited", 0, 2);
    expect(exited.worker).toMatchObject({ pid: 222, status: "exited", exitCode: 0 });
    expect(exited.worker?.exitedAt).toEqual(expect.any(String));
  });

  it("rejects driver recovery for terminal runs", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-worker-terminal-"));
    const prepared = await prepareRun(workerSpec(), { cwd, input: { cwd } });
    await updateRunIndex(cwd, prepared.logicalRunId, (index) => ({
      ...index,
      status: "completed"
    }));

    await expect(recoverDriver(prepared.dir)).rejects.toThrow("Cannot recover terminal run");
  });
});

function workerSpec() {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "worker-state",
    root: "task",
    roles: {
      implementer: { category: "implementation", agent: "gpt-test", mode: "readOnly" }
    },
    stages: [
      { id: "task", kind: "agentTask", role: "implementer", prompt: "Observe worker state." }
    ]
  });
}
