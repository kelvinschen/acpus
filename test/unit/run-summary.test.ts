import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatRunSummaryList, listRunSummaries } from "../../src/run-index/run-summary.js";
import type { RunIndex } from "../../src/run-index/read-write.js";

describe("run summaries", () => {
  it("lists runs newest first with lightweight metadata", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-summary-"));
    await writeRun(cwd, runIndex({
      logicalRunId: "2026-06-04T01-00-00-000Z-old",
      workflowName: "old-workflow",
      status: "completed",
      createdAt: "2026-06-04T01:00:00.000Z",
      updatedAt: "2026-06-04T01:01:00.000Z"
    }));
    await writeRun(cwd, runIndex({
      logicalRunId: "2026-06-04T02-00-00-000Z-new",
      workflowName: "new-workflow",
      status: "running",
      createdAt: "2026-06-04T02:00:00.000Z",
      updatedAt: "2026-06-04T02:01:00.000Z",
      worker: {
        pid: 99999999,
        generation: 1,
        status: "running",
        startedAt: "2026-06-04T02:00:00.000Z",
        heartbeatAt: "2026-06-04T02:00:00.000Z"
      }
    }));

    const list = await listRunSummaries(cwd);

    expect(list.entries.map((entry) => entry.runId)).toEqual([
      "2026-06-04T02-00-00-000Z-new",
      "2026-06-04T01-00-00-000Z-old"
    ]);
    expect(list.entries[0]).toMatchObject({
      workflowName: "new-workflow",
      status: "running",
      progress: { completedStages: 0, totalStages: 2, label: "0/2 stages" },
      worker: { status: "stale" }
    });
    expect(formatRunSummaryList(list)).toContain("new-workflow");
  });

  it("returns an empty list for projects with no runs directory", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-summary-empty-"));

    const list = await listRunSummaries(cwd);

    expect(list.entries).toEqual([]);
    expect(formatRunSummaryList(list)).toContain("No runs found.");
  });

  it("keeps unreadable runs as invalid rows", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-summary-invalid-"));
    const dir = path.join(cwd, ".acpus", "runs", "bad-run");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "run.json"), "{bad", "utf8");

    const list = await listRunSummaries(cwd);

    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]).toMatchObject({ runId: "bad-run", invalid: true });
  });

  it("falls back to a valid timestamp when run dates are malformed", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-summary-invalid-time-"));
    await writeRun(cwd, runIndex({
      logicalRunId: "2026-06-04T03-00-00-000Z-newer-created",
      workflowName: "newer-created",
      status: "running",
      createdAt: "2026-06-04T03:00:00.000Z",
      updatedAt: "not-a-date"
    }));
    await writeRun(cwd, runIndex({
      logicalRunId: "2026-06-04T04-00-00-000Z-newer-id",
      workflowName: "newer-id",
      status: "running",
      createdAt: "2026-06-04T02:00:00.000Z",
      updatedAt: "also-not-a-date"
    }));

    const list = await listRunSummaries(cwd);

    expect(list.entries.map((entry) => entry.runId)).toEqual([
      "2026-06-04T03-00-00-000Z-newer-created",
      "2026-06-04T04-00-00-000Z-newer-id"
    ]);
  });
});

async function writeRun(cwd: string, index: RunIndex): Promise<void> {
  const dir = path.join(cwd, ".acpus", "runs", index.logicalRunId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "run.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function runIndex(input: Partial<RunIndex> & Pick<RunIndex, "logicalRunId" | "workflowName" | "status" | "createdAt" | "updatedAt">): RunIndex {
  return {
    schemaVersion: "acpus.run/v2",
    logicalRunId: input.logicalRunId,
    workflowName: input.workflowName,
    status: input.status,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    stages: {
      task: { stageId: "task", status: input.status === "completed" ? "completed" : "running", attempts: [], completedAt: input.status === "completed" ? input.updatedAt : undefined },
      gate: { stageId: "gate", status: input.status === "completed" ? "completed" : "pending", attempts: [], completedAt: input.status === "completed" ? input.updatedAt : undefined }
    },
    attempts: {},
    agentUsage: { planned: 0, actual: 0, retryCalls: 0, retries: { runtime: 0, stale: 0, continuation: 0 } },
    worker: input.worker
  };
}
