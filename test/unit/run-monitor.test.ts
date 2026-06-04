import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunMonitorView, buildTaskDetailView } from "../../src/projections/run-monitor.js";
import { runDir } from "../../src/run-index/paths.js";
import type { RunIndex } from "../../src/run-index/read-write.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "../../src/schema/workflow-spec.js";

describe("RunMonitorView", () => {
  it("projects stages and known Stage Tasks without reading events", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-monitor-"));
    const spec = monitorSpec();
    const index = monitorIndex();
    const dir = runDir(index.logicalRunId, cwd);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "events.ndjson"), `${"x".repeat(128 * 1024)}\n`, "utf8");

    const view = await buildRunMonitorView(cwd, spec, index);

    expect(view.version).toBe("acpus.monitor/v1");
    expect(view.run).toMatchObject({ logicalRunId: "monitor-run", workflowName: "monitor-workflow", status: "running" });
    expect(view.run.worker).toMatchObject({ pid: process.pid, status: "running" });
    expect(view).not.toHaveProperty("eventTail");
    expect(view.progress).toEqual({ knownTasks: 8, completedTasks: 4 });
    expect(view.stages.find((stage) => stage.id === "review")?.taskCounts).toMatchObject({ total: 2, running: 1, pending: 1 });
    expect(view.stages.find((stage) => stage.id === "final_gate")?.taskCounts).toMatchObject({ total: 1, completed: 1 });
    expect(view.tasks.map((task) => task.id)).toEqual(expect.arrayContaining([
      "task:task",
      "task:review:item:item-1:lane:a",
      "task:review:fanin",
      "task:quality_loop:round:1:stage:body",
      "task:quality_loop:round:1:stage:body_gate",
      "task:quality_loop:round:1:fanout:body_fanout:item:item-2:lane:a",
      "task:quality_loop:round:1:fanout:body_fanout:fanin",
      "task:final_gate"
    ]));
    expect(view.tasks.find((task) => task.id === "task:task")).toMatchObject({
      status: "completed",
      execution: "agent",
      actorLabel: "implementer",
      agent: "gpt-test",
      actorMode: "readOnly",
      attemptId: "task:attempt-1",
      durationMs: 10_000
    });
    expect(view.tasks.find((task) => task.id === "task:final_gate")).toMatchObject({
      status: "completed",
      execution: "deterministic",
      attemptIds: [],
      durationMs: 1_000
    });
    expect(view.tasks.find((task) => task.id === "task:review:fanin")).toMatchObject({
      status: "pending",
      execution: "deterministic",
      attemptIds: []
    });
    expect(view.tasks.find((task) => task.id === "task:review:fanin")?.startedAt).toBeUndefined();
    expect(view.tasks.find((task) => task.id === "task:quality_loop:round:1:fanout:body_fanout:fanin")).toMatchObject({
      status: "pending",
      execution: "deterministic",
      attemptIds: []
    });
    expect(view.tasks.find((task) => task.id === "task:quality_loop:round:1:fanout:body_fanout:fanin")?.startedAt).toBeUndefined();
  });

  it("freezes elapsed counters at the last worker heartbeat when the worker is stale", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-monitor-stale-"));
    const spec = monitorSpec();
    const index = monitorIndex();
    const review = index.stages.review;
    const item = review.fanout?.items[0];
    const lane = item?.lanes[0];
    review.startedAt = "2026-06-02T00:00:20.000Z";
    if (item) item.startedAt = "2026-06-02T00:00:20.000Z";
    if (lane) lane.startedAt = "2026-06-02T00:00:20.000Z";
    index.worker = {
      pid: 999_999_999,
      generation: 1,
      status: "running",
      startedAt: "2026-06-02T00:00:00.000Z",
      heartbeatAt: "2026-06-02T00:01:00.000Z"
    };

    const view = await buildRunMonitorView(cwd, spec, index);

    expect(view.run.worker).toMatchObject({ status: "stale" });
    expect(view.run.elapsedMs).toBe(60_000);
    expect(view.stages.find((stage) => stage.id === "review")?.elapsedMs).toBe(40_000);
    expect(view.tasks.find((task) => task.id === "task:review:item:item-1:lane:a")?.elapsedMs).toBe(40_000);
  });

  it("does not borrow fanout stage start time for completed program fanin tasks", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-monitor-fanin-"));
    const spec = monitorSpec();
    const index = monitorIndex();
    const review = index.stages.review;
    const item = review.fanout?.items[0];
    const lane = item?.lanes[0];
    review.status = "completed";
    review.startedAt = "2026-06-02T00:00:15.000Z";
    review.completedAt = "2026-06-02T00:00:35.000Z";
    review.outputPath = "outputs/review.json";
    if (review.fanout) {
      review.fanout.completedItems = 1;
    }
    if (item && lane) {
      item.status = "completed";
      item.completedAt = "2026-06-02T00:00:34.000Z";
      item.outputPath = "outputs/review/item-1.json";
      lane.status = "completed";
      lane.completedAt = "2026-06-02T00:00:34.000Z";
    }

    const view = await buildRunMonitorView(cwd, spec, index);
    const fanin = view.tasks.find((task) => task.id === "task:review:fanin");

    expect(fanin).toMatchObject({
      status: "completed",
      execution: "deterministic",
      attemptIds: [],
      completedAt: "2026-06-02T00:00:35.000Z"
    });
    expect(fanin?.startedAt).toBeUndefined();
  });

  it("includes finalOutput for terminal runs when the gate output artifact exists", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-monitor-final-output-"));
    const spec = monitorSpec();
    const index = monitorIndex();
    index.status = "completed";
    index.gateVerdict = "pass";
    const dir = runDir(index.logicalRunId, cwd);
    const gateOutput = {
      status: "completed",
      summary: "Gate passed.",
      verdict: "pass",
      data: { value: 42 }
    };
    await fs.mkdir(path.join(dir, "outputs"), { recursive: true });
    await fs.writeFile(path.join(dir, "outputs", "final_gate.json"), `${JSON.stringify(gateOutput)}\n`, "utf8");

    const view = await buildRunMonitorView(cwd, spec, index);

    expect(view.finalOutput).toEqual(gateOutput);
  });

  it("omits finalOutput for non-terminal runs", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-monitor-final-output-running-"));
    const spec = monitorSpec();
    const index = monitorIndex();
    const dir = runDir(index.logicalRunId, cwd);
    await fs.mkdir(path.join(dir, "outputs"), { recursive: true });
    await fs.writeFile(path.join(dir, "outputs", "final_gate.json"), `${JSON.stringify({ status: "completed", verdict: "pass" })}\n`, "utf8");

    const view = await buildRunMonitorView(cwd, spec, index);

    expect(view.finalOutput).toBeUndefined();
  });

  it("omits finalOutput when the workflow has no gate", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-monitor-final-output-no-gate-"));
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpus.workflow/v1",
      name: "no-gate",
      root: "task",
      stages: [
        { id: "task", kind: "task", mode: "agent", actor: { agent: "gpt-test", mode: "readOnly" }, prompt: "Do work." }
      ]
    });
    const index = {
      ...monitorIndex(),
      workflowName: "no-gate",
      status: "completed",
      stages: {
        task: { stageId: "task", status: "completed", attempts: [], outputPath: "outputs/task.json" }
      }
    } as RunIndex;

    const view = await buildRunMonitorView(cwd, spec, index);

    expect(view.finalOutput).toBeUndefined();
  });

  it("omits finalOutput when the gate output artifact is missing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-monitor-final-output-missing-"));
    const spec = monitorSpec();
    const index = monitorIndex();
    index.status = "completed";

    const view = await buildRunMonitorView(cwd, spec, index);

    expect(view.finalOutput).toBeUndefined();
  });

  it("returns bounded task details from run-index attempts and output files", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-monitor-detail-"));
    const spec = monitorSpec();
    const index = monitorIndex();
    const dir = runDir(index.logicalRunId, cwd);
    await fs.mkdir(path.join(dir, "outputs"), { recursive: true });
    await fs.writeFile(path.join(dir, "outputs", "task.json"), `${JSON.stringify({
      status: "completed",
      summary: "Task completed.",
      data: { text: "x".repeat(4096) }
    }, null, 2)}\n`, "utf8");

    const detail = await buildTaskDetailView(cwd, spec, index, "task:task");

    expect(detail.version).toBe("acpus.task-detail/v1");
    expect(detail.task).toMatchObject({ id: "task:task", status: "completed" });
    expect(detail.prompt).toMatchObject({ lines: 1, preview: "Implement task." });
    expect(detail.activity).toMatchObject({ totalAttempts: 1 });
    expect(detail.outcome).toMatchObject({
      status: "completed",
      summary: "Task completed."
    });
    expect(detail.outcome?.preview?.length).toBeLessThanOrEqual(2100);
  });

  it("projects retry metadata and final attempt identity for retried fanout lanes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-monitor-retry-detail-"));
    const spec = monitorSpec();
    const index = monitorIndex();
    const dir = runDir(index.logicalRunId, cwd);
    const review = index.stages.review;
    const item = review.fanout?.items[0];
    const lane = item?.lanes[0];
    if (!item || !lane) throw new Error("missing monitor fixture lane");
    item.status = "completed";
    item.retryOf = "review:item-1:a:attempt-1";
    item.retryOrdinal = 1;
    item.retryReason = "continuation";
    item.outputPath = "outputs/review/item-1.json";
    lane.status = "completed";
    lane.attemptId = "review:item-1:a:attempt-2";
    lane.retryOf = "review:item-1:a:attempt-1";
    lane.retryOrdinal = 1;
    lane.retryReason = "continuation";
    lane.outputPath = "outputs/review/item-1/a.json";
    index.attempts["review:item-1:a:attempt-1"] = {
      ...index.attempts["review:item-1:a:attempt-1"],
      status: "blocked",
      endedAt: "2026-06-02T00:00:25.000Z",
      blockedReason: "OUTPUT_PARSE_FAILED",
      parseErrorCode: "OUTPUT_PARSE_FAILED",
      retryBudgetUsed: 0,
      retryBudgetLimit: 2
    };
    index.attempts["review:item-1:a:attempt-2"] = {
      id: "review:item-1:a:attempt-2",
      stageId: "review",
      itemId: "item-1",
      laneId: "a",
      kind: "attempt",
      status: "completed",
      path: "attempts/review/item-item-1/lane-a/attempt-2",
      startedAt: "2026-06-02T00:00:26.000Z",
      endedAt: "2026-06-02T00:00:30.000Z",
      agent: "gpt-review",
      actorMode: "readOnly",
      isRetry: true,
      retryReason: "continuation",
      retryOf: "review:item-1:a:attempt-1",
      retryOrdinal: 1,
      retryBudgetUsed: 1,
      retryBudgetLimit: 2,
      promptPolicy: "continuation",
      lastFailureCode: "OUTPUT_PARSE_FAILED"
    };
    await fs.mkdir(path.join(dir, "outputs", "review", "item-1"), { recursive: true });
    await fs.writeFile(path.join(dir, "outputs", "review", "item-1", "a.json"), `${JSON.stringify({
      status: "completed",
      summary: "retry completed"
    }, null, 2)}\n`, "utf8");

    const view = await buildRunMonitorView(cwd, spec, index);
    const task = view.tasks.find((candidate) => candidate.id === "task:review:item:item-1:lane:a");
    const detail = await buildTaskDetailView(cwd, spec, index, "task:review:item:item-1:lane:a");

    expect(task).toMatchObject({
      status: "completed",
      attemptId: "review:item-1:a:attempt-2",
      attemptCount: 2,
      currentAttemptOrdinal: 2,
      lastRetryReason: "continuation",
      retryBudgetUsed: 1,
      retryBudgetLimit: 2,
      lastFailureCode: "OUTPUT_PARSE_FAILED"
    });
    expect(detail.activity.totalAttempts).toBe(2);
    expect(detail.activity.attempts.at(-1)).toMatchObject({
      id: "review:item-1:a:attempt-2",
      isRetry: true,
      retryReason: "continuation",
      retryOf: "review:item-1:a:attempt-1",
      retryOrdinal: 1,
      promptPolicy: "continuation",
      lastFailureCode: "OUTPUT_PARSE_FAILED"
    });
  });

  it("returns deterministic task details without attempts", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-monitor-deterministic-detail-"));
    const spec = monitorSpec();
    const index = monitorIndex();
    const dir = runDir(index.logicalRunId, cwd);
    await fs.mkdir(path.join(dir, "outputs"), { recursive: true });
    await fs.writeFile(path.join(dir, "outputs", "final_gate.json"), `${JSON.stringify({
      status: "completed",
      summary: "Gate passed.",
      verdict: "pass"
    }, null, 2)}\n`, "utf8");

    const detail = await buildTaskDetailView(cwd, spec, index, "task:final_gate");

    expect(detail.task).toMatchObject({ execution: "deterministic", id: "task:final_gate" });
    expect(detail.activity.totalAttempts).toBe(0);
    expect(detail.prompt).toBeUndefined();
    expect(detail.outcome).toMatchObject({ status: "completed", summary: "Gate passed." });
  });

  it("rejects unknown task ids", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-run-monitor-missing-"));
    await expect(buildTaskDetailView(cwd, monitorSpec(), monitorIndex(), "missing")).rejects.toThrow("Unknown task: missing");
  });
});

function monitorSpec(): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "monitor-workflow",
    root: "task",
    input: { schema: "{items:[unknown]}", default: { items: [] } },
    stages: [
      { id: "task", kind: "task", mode: "agent", actor: { agent: "gpt-test", mode: "readOnly", label: "implementer" }, prompt: "Implement task." },
      {
        id: "review",
        kind: "fanout",
        dependsOn: ["task"],
        items: { source: "input.items" },
        lanes: [{ id: "a", actor: { agent: "gpt-review", mode: "readOnly", label: "reviewer" }, prompt: "Review item." }],
        fanin: { mode: "program", operation: "mergeArrays" }
      },
      {
        id: "quality_loop",
        kind: "loop",
        dependsOn: ["review"],
        maxRounds: 1,
        body: {
          root: "body",
          output: "body",
          stages: [
            { id: "body", kind: "task", mode: "agent", actor: { agent: "gpt-test", mode: "readOnly", label: "implementer" }, prompt: "Review loop." },
            { id: "body_gate", kind: "route", mode: "program", dependsOn: ["body"], rules: [{ when: { source: "outputs.body.status", op: "eq", value: "completed" }, to: "body_fanout" }], routes: ["body_fanout"] },
            {
              id: "body_fanout",
              kind: "fanout",
              dependsOn: ["body_gate"],
              items: { source: "input.items" },
              lanes: [{ id: "a", actor: { agent: "gpt-review", mode: "readOnly", label: "reviewer" }, prompt: "Loop fanout." }],
              fanin: { mode: "program", operation: "mergeArrays" }
            }
          ]
        },
        continueWhen: { source: "loop.round", op: "eq", value: 0 },
        onExhausted: "blocked"
      },
      { id: "final_gate", kind: "gate", dependsOn: ["quality_loop"], mode: "program" }
    ]
  });
}

function monitorIndex(): RunIndex {
  return {
    schemaVersion: "acpus.run/v2",
    logicalRunId: "monitor-run",
    workflowName: "monitor-workflow",
    status: "running",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:01:00.000Z",
    stages: {
      task: { stageId: "task", status: "completed", attempts: ["task:attempt-1"], outputPath: "outputs/task.json", startedAt: "2026-06-02T00:00:00.000Z", completedAt: "2026-06-02T00:00:10.000Z" },
      review: {
        stageId: "review",
        status: "running",
        attempts: [],
        fanout: {
          totalItems: 1,
          completedItems: 0,
          blockedItems: 0,
          allowPartial: false,
          workUnits: 1,
          items: [{
            id: "item-1",
            index: 0,
            status: "running",
            lanes: [{ id: "a", actorLabel: "reviewer", status: "running", attemptId: "review:item-1:a:attempt-1", outputPath: "outputs/review/item-1/a.json" }]
          }]
        }
      },
      quality_loop: {
        stageId: "quality_loop",
        status: "running",
        attempts: ["loop:round-1__stage-body:attempt-1"],
        loop: {
          maxRounds: 1,
          currentRound: 1,
          bodyOutputStageId: "body",
          rounds: [{
            round: 1,
            status: "running",
            bodyOutputStageId: "body",
            stages: {
              body: { stageId: "body", status: "completed", attempts: ["loop:round-1__stage-body:attempt-1"], outputPath: "outputs/quality_loop/round-1/body.json" },
              body_gate: { stageId: "body_gate", status: "completed", attempts: [], outputPath: "outputs/quality_loop/round-1/body_gate.json", startedAt: "2026-06-02T00:00:45.000Z", completedAt: "2026-06-02T00:00:46.000Z" },
              body_fanout: {
                stageId: "body_fanout",
                status: "running",
                attempts: [],
                fanout: {
                  totalItems: 1,
                  completedItems: 0,
                  blockedItems: 0,
                  allowPartial: false,
                  items: [{
                    id: "item-2",
                    index: 0,
                    status: "running",
                    lanes: [{ id: "a", actorLabel: "reviewer", status: "running", attemptId: "loop:round-1__stage-body_fanout__item-item-2:a:attempt-1", outputPath: "outputs/quality_loop/round-1/body_fanout/item-2/a.json" }]
                  }]
                }
              }
            }
          }]
        }
      },
      final_gate: { stageId: "final_gate", status: "completed", attempts: [], outputPath: "outputs/final_gate.json", startedAt: "2026-06-02T00:00:58.000Z", completedAt: "2026-06-02T00:00:59.000Z" }
    },
    attempts: {
      "task:attempt-1": { id: "task:attempt-1", stageId: "task", kind: "attempt", status: "completed", path: "attempts/task/attempt-1", startedAt: "2026-06-02T00:00:00.000Z", endedAt: "2026-06-02T00:00:10.000Z", promptPreview: "Implement task.", agent: "gpt-test", actorMode: "readOnly" },
      "review:item-1:a:attempt-1": { id: "review:item-1:a:attempt-1", stageId: "review", itemId: "item-1", laneId: "a", kind: "attempt", status: "running", path: "attempts/review/item-item-1/lane-a/attempt-1", startedAt: "2026-06-02T00:00:20.000Z", promptPreview: "Review item.", agent: "gpt-review", actorMode: "readOnly" },
      "loop:round-1__stage-body:attempt-1": { id: "loop:round-1__stage-body:attempt-1", stageId: "quality_loop", itemId: "round-1__stage-body", kind: "attempt", status: "completed", path: "attempts/quality_loop/item-round-1__stage-body/attempt-1", startedAt: "2026-06-02T00:00:30.000Z", endedAt: "2026-06-02T00:00:40.000Z", promptPreview: "Review loop.", agent: "gpt-test", actorMode: "readOnly" },
      "loop:round-1__stage-body_fanout__item-item-2:a:attempt-1": { id: "loop:round-1__stage-body_fanout__item-item-2:a:attempt-1", stageId: "quality_loop", itemId: "round-1__stage-body_fanout__item-item-2", laneId: "a", kind: "attempt", status: "running", path: "attempts/quality_loop/item-round-1__stage-body_fanout__item-item-2/lane-a/attempt-1", startedAt: "2026-06-02T00:00:50.000Z", promptPreview: "Loop fanout.", agent: "gpt-review", actorMode: "readOnly" }
    },
    agentUsage: { planned: 4, actual: 2, retryCalls: 0, retries: { runtime: 0, stale: 0, continuation: 0 } },
    worker: {
      pid: process.pid,
      generation: 1,
      status: "running",
      startedAt: "2026-06-02T00:00:00.000Z",
      heartbeatAt: new Date().toISOString()
    }
  };
}
