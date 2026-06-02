import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AcpRuntimeEvent, AcpRuntimeHandle } from "acpx/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { buildRunDiagnosticsView, RunDiagnosticCodes } from "../../src/projections/run-diagnostics.js";
import { buildRunMonitorView } from "../../src/projections/run-monitor.js";
import { runDir } from "../../src/run-index/paths.js";
import { appendEvent, readRunIndex, RuntimeErrorCodes, writeRunIndex, type RunIndex } from "../../src/run-index/read-write.js";
import { setAgentRuntimeFactoryForTests, type AgentTurnRequest, type AgentTurnResult, type OrchestratorAgentRuntime } from "../../src/runtime/agent-runtime.js";
import { startDiagnosticRun } from "../../src/runtime/diagnose-run.js";
import { prepareRun, startPreparedRun } from "../../src/runtime/run-workflow.js";
import { syncRun } from "../../src/runtime/sync.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "../../src/schema/workflow-spec.js";
import { baseOutput, gateOutput, implementationOutput, validationOutput, plainJsonOutput } from "../helpers/fake-runtime.js";

describe("fanout runtime stability", () => {
  afterEach(() => setAgentRuntimeFactoryForTests(undefined));

  it("serializes concurrent event appends without leaking lock contention", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-event-queue-"));
    const logicalRunId = "event-queue";

    await Promise.all(Array.from({ length: 50 }, (_, index) =>
      appendEvent(cwd, logicalRunId, { type: "probe", sequence: index })
    ));

    const text = await fs.readFile(path.join(runDir(logicalRunId, cwd), "events.ndjson"), "utf8");
    const events = text.trim().split("\n").map((line) => JSON.parse(line) as { sequence: number });
    expect(events).toHaveLength(50);
    expect(new Set(events.map((event) => event.sequence)).size).toBe(50);
    expect(text).not.toContain("Lock file is already being held");
  });

  it("converts one thrown fanout item into an item-level blocked result", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-isolation-"));
    const runtime = new SelectiveFanoutRuntime("item-2");
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = fanoutSpec(3, { allowPartial: false });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }, { id: "item-2" }, { id: "item-3" }] }
    });

    const index = await startPreparedRun(cwd, prepared);
    const stage = index.stages.fanout;
    const itemStatuses = stage?.fanout?.items.map((item) => [item.id, item.status, item.errorCode]);
    const failedOutput = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "fanout", "item-2.json"), "utf8")) as {
      blockedReason: string;
      runtimeDiagnostics?: { errorCode?: string };
    };
    const events = await fs.readFile(path.join(prepared.dir, "events.ndjson"), "utf8");

    expect(index.status).toBe("blocked");
    expect(itemStatuses).toEqual([
      ["item-1", "completed", undefined],
      ["item-2", "blocked", RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR],
      ["item-3", "completed", undefined]
    ]);
    expect(failedOutput.blockedReason).toBe(RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR);
    expect(failedOutput.runtimeDiagnostics?.errorCode).toBe(RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR);
    expect(stage?.fanout?.completedItems).toBe(2);
    expect(stage?.fanout?.blockedItems).toBe(1);
    expect(events).toContain("fanout_pool_completed");
    expect(events).not.toContain("scheduler_batch_completed");
  });

  it("expands heterogeneous all and oneOf lane groups into lane outputs", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-heterogeneous-fanout-"));
    const runtime = new StaticRuntime();
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpus.workflow/v1",
      name: "heterogeneous-fanout",
      root: "review",
      inputs: {
        cwd: { type: "path" },
        items: { type: "array<json>" }
      },
      roles: {
        pi: { category: "coordination", agent: "pi", mode: "readOnly" },
        aiden: { category: "coordination", agent: "aiden", mode: "readOnly" },
        claude: { category: "coordination", agent: "claude", mode: "readOnly" }
      },
      stages: [
        {
          id: "review",
          kind: "fanout",
          items: { source: "input.items" },
          limits: { maxConcurrency: 3, maxFanoutItems: 2 },
          prompt: "Review one item",
          laneGroups: [
            { id: "cross", mode: "all", lanes: [{ id: "pi", role: "pi" }, { id: "aiden", role: "aiden" }] },
            {
              id: "route",
              mode: "oneOf",
              lanes: [
                { id: "claude", role: "claude", when: { source: "item.area", op: "eq", value: "schema" } },
                { id: "pi_default", role: "pi", default: true }
              ]
            }
          ]
        },
        { id: "gate", kind: "gate", dependsOn: ["review"] }
      ]
    });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1", area: "schema" }, { id: "item-2", area: "runtime" }] }
    });

    const index = await startPreparedRun(cwd, prepared, { drainFanoutPool: true });
    const aggregate = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "review.json"), "utf8")) as { laneOutputs: Array<{ itemId: string; groupId: string; laneId: string }> };

    expect(index.status).toBe("completed");
    expect(index.stages.review?.fanout?.workUnits).toBe(6);
    expect(aggregate.laneOutputs.map((lane) => [lane.itemId, lane.groupId, lane.laneId])).toEqual([
      ["item-1", "cross", "pi"],
      ["item-1", "cross", "aiden"],
      ["item-1", "route", "claude"],
      ["item-2", "cross", "pi"],
      ["item-2", "cross", "aiden"],
      ["item-2", "route", "pi_default"]
    ]);
  });

  it("continues batched fanout after the first concurrency window completes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-batches-"));
    setAgentRuntimeFactoryForTests(() => new StaticRuntime());
    const spec = fanoutSpec(20, { allowPartial: false }, { maxConcurrency: 10 });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: fanoutInputItems(20) }
    });

    const firstTick = await startPreparedRun(cwd, prepared);
    const secondTick = await syncRun(cwd, prepared.logicalRunId);

    expect(firstTick.status).toBe("running");
    expect(firstTick.stages.fanout?.status).toBe("ready");
    expect(firstTick.stages.fanout?.fanout?.completedItems).toBe(10);
    expect(queuedFanoutItemCount(firstTick)).toBe(10);
    expect(secondTick.status).toBe("completed");
    expect(secondTick.stages.fanout?.status).toBe("completed");
    expect(secondTick.stages.fanout?.fanout?.completedItems).toBe(20);
    expect(await fanoutPoolStartedCount(prepared.dir)).toBeGreaterThanOrEqual(2);
    expect(hasStuckFanoutPendingBatch(secondTick)).toBe(false);
  });

  it("continues queued fanout items after a partial item runtime error", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-partial-batches-"));
    setAgentRuntimeFactoryForTests(() => new SelectiveFanoutRuntime("item-2"));
    const spec = fanoutSpec(20, { allowPartial: true }, { maxConcurrency: 10 });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: fanoutInputItems(20) }
    });

    const firstTick = await startPreparedRun(cwd, prepared);
    const secondTick = await syncRun(cwd, prepared.logicalRunId);

    expect(firstTick.status).toBe("running");
    expect(firstTick.stages.fanout?.status).toBe("ready");
    expect(firstTick.stages.fanout?.fanout?.completedItems).toBe(9);
    expect(firstTick.stages.fanout?.fanout?.blockedItems).toBe(1);
    expect(queuedFanoutItemCount(firstTick)).toBe(10);
    expect(secondTick.status).toBe("completed");
    expect(secondTick.stages.fanout?.status).toBe("completed");
    expect(secondTick.stages.fanout?.fanout).toMatchObject({
      completedItems: 19,
      blockedItems: 1
    });
    expect(await fanoutPoolStartedCount(prepared.dir)).toBeGreaterThanOrEqual(2);
    expect(hasStuckFanoutPendingBatch(secondTick)).toBe(false);
  });

  it("drains a fanout pool by refilling slots as items settle", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-drain-"));
    const runtime = new DelayedFanoutRuntime({ "item-1": 200, "item-2": 1, "item-3": 1 });
    const spec = fanoutSpec(3, { allowPartial: false }, { maxConcurrency: 2 });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: fanoutInputItems(3) }
    });
    let item2StatusBeforeItem3: string | undefined;
    let actualCallsBeforeItem3: number | undefined;
    runtime.onStart = async (itemId) => {
      if (itemId !== "item-3") return;
      const runIndex = JSON.parse(await fs.readFile(path.join(prepared.dir, "run.json"), "utf8")) as RunIndex;
      item2StatusBeforeItem3 = runIndex.stages.fanout?.fanout?.items.find((item) => item.id === "item-2")?.status;
      actualCallsBeforeItem3 = runIndex.agentUsage.actual;
    };
    setAgentRuntimeFactoryForTests(() => runtime);

    const index = await syncRun(cwd, prepared.logicalRunId, { drainFanoutPool: true });
    const events = await readEvents(prepared.dir);
    const item2Settled = events.findIndex((event) => event.type === "fanout_pool_item_settled" && event.itemId === "item-2");
    const item3Started = events.findIndex((event) => event.type === "fanout_pool_item_started" && event.itemId === "item-3");
    const item1Settled = events.findIndex((event) => event.type === "fanout_pool_item_settled" && event.itemId === "item-1");

    expect(index.status).toBe("completed");
    expect(index.stages.fanout?.fanout?.completedItems).toBe(3);
    expect(runtime.maxActive).toBe(2);
    expect(item2StatusBeforeItem3).toBe("completed");
    expect(actualCallsBeforeItem3).toBeGreaterThanOrEqual(1);
    expect(item2Settled).toBeGreaterThanOrEqual(0);
    expect(item3Started).toBeGreaterThan(item2Settled);
    expect(item3Started).toBeLessThan(item1Settled);
    expect(events.map((event) => event.type)).not.toContain("scheduler_batch_started");
    expect(events.map((event) => event.type)).not.toContain("scheduler_batch_completed");
  });

  it("persists loop body fanout lanes while they are running", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-fanout-realtime-"));
    const runtime = new DelayedFanoutRuntime({ "item-1": 50 });
    const spec = loopFanoutRealtimeSpec();
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }] }
    });
    let runningLaneStatus: string | undefined;
    runtime.onStart = async (itemId) => {
      if (itemId !== "item-1" || runningLaneStatus) return;
      runningLaneStatus = await waitForLoopFanoutLaneStatus(cwd, prepared.logicalRunId, spec, "item-1");
    };
    setAgentRuntimeFactoryForTests(() => runtime);

    const index = await syncRun(cwd, prepared.logicalRunId, { drainFanoutPool: true });
    const finalView = await buildRunMonitorView(cwd, spec, index);
    const finalLane = finalView.tasks.find((task) => task.kind === "loopFanoutLane" && task.itemId === "item-1");

    expect(runningLaneStatus).toBe("running");
    expect(finalLane).toMatchObject({
      kind: "loopFanoutLane",
      status: "completed",
      outputPath: expect.stringContaining("outputs/review_loop/round-1/body_fanout/item-1/work/worker.json")
    });
  });

  it("persists loop body fanout lane settlement before the whole fanout pool finishes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-fanout-realtime-settle-"));
    const runtime = new DelayedFanoutRuntime({ "item-1": 1, "item-2": 400 });
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopFanoutSpec(cwd, {
      maxConcurrency: 2,
      laneGroups: [{ id: "work", mode: "all", lanes: [{ id: "worker", role: "worker" }] }]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: fanoutInputItems(2) } });

    const running = syncRun(cwd, prepared.logicalRunId, { drainFanoutPool: true });
    const settledLane = await waitForLoopFanoutLane(cwd, prepared.logicalRunId, spec, "item-1", (unit) => unit.status === "completed");
    const concurrentLane = await waitForLoopFanoutLane(cwd, prepared.logicalRunId, spec, "item-2", (unit) => unit.status === "running");
    const finalIndex = await running;

    expect(settledLane).toMatchObject({
      kind: "loopFanoutLane",
      status: "completed",
      outputPath: expect.stringContaining("outputs/quality_loop/round-1/review_items/item-1/work/worker.json")
    });
    expect(concurrentLane).toMatchObject({ kind: "loopFanoutLane", status: "running" });
    expect(finalIndex.status).toBe("completed");
  });

  it("does not overwrite loop body fanout startedAt or attempts during later lane starts", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-fanout-progress-merge-"));
    const runtime = new DelayedFanoutRuntime({ "item-1": 1, "item-2": 50 });
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopFanoutSpec(cwd, {
      maxConcurrency: 1,
      laneGroups: [{ id: "work", mode: "all", lanes: [{ id: "worker", role: "worker" }] }]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: fanoutInputItems(2) } });
    let firstStartedAt: string | undefined;
    let secondStartedAt: string | undefined;
    let attemptsDuringSecondStart: string[] = [];
    runtime.onStart = async (itemId) => {
      if (itemId === "item-1") {
        const stage = await waitForLoopBodyStage(cwd, prepared.logicalRunId, "quality_loop", "review_items", (entry) => entry.status === "running");
        firstStartedAt = stage?.startedAt;
      }
      if (itemId === "item-2") {
        const stage = await waitForLoopBodyStage(cwd, prepared.logicalRunId, "quality_loop", "review_items", (entry) => (entry.attempts?.length ?? 0) > 0);
        secondStartedAt = stage?.startedAt;
        attemptsDuringSecondStart = stage?.attempts ?? [];
      }
    };

    const finalIndex = await syncRun(cwd, prepared.logicalRunId, { drainFanoutPool: true });

    expect(finalIndex.status).toBe("completed");
    expect(firstStartedAt).toEqual(expect.any(String));
    expect(secondStartedAt).toBe(firstStartedAt);
    expect(attemptsDuringSecondStart).toHaveLength(1);
    expect(attemptsDuringSecondStart[0]).toContain("item-item-1");
  });

  it("cascade-blocks pending fanout items after an allowPartial=false item failure", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-cascade-block-"));
    const runtime = new DelayedFanoutRuntime({ "item-1": 40, "item-2": 1 }, ["item-2"]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = fanoutSpec(4, { allowPartial: false }, { maxConcurrency: 2 });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: fanoutInputItems(4) }
    });

    const index = await syncRun(cwd, prepared.logicalRunId, { drainFanoutPool: true });
    const items = index.stages.fanout?.fanout?.items ?? [];
    const requested = runtime.requests.map((request) => itemIdFromSessionKey(request.sessionKey));
    const events = await readEvents(prepared.dir);
    const diagnostics = await buildRunDiagnosticsView(cwd, index);

    expect(index.status).toBe("blocked");
    expect(index.blockedReason).toBe(RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR);
    expect(index.stages.fanout?.blockedReason).toBe(RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR);
    expect(items.map((item) => [item.id, item.status, item.errorCode])).toEqual([
      ["item-1", "completed", undefined],
      ["item-2", "blocked", RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR],
      ["item-3", "blocked", RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED],
      ["item-4", "blocked", RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED]
    ]);
    expect(requested.sort()).toEqual(["item-1", "item-2", "item-2"]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "fanout_pool_item_settled",
      itemId: "item-3",
      cascade: true
    }));
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      stageId: "fanout",
      itemId: "item-2"
    }));
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED,
      stageId: "fanout",
      itemId: "item-3"
    }));
  });

  it("recovers a running fanout item when its output file already exists", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-recover-"));
    const spec = fanoutSpec(1, { allowPartial: false });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }] }
    });
    const staleStartedAt = staleRecoveryStartedAt();
    const outputPath = path.join(prepared.dir, "outputs", "fanout", "item-1.json");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(baseOutput({ summary: "already done" }), null, 2)}\n`, "utf8");
    await writeRunIndex(cwd, {
      ...prepared.index,
      status: "running",
      attempts: {
        "fanout:item-1:attempt-1": {
          id: "fanout:item-1:attempt-1",
          stageId: "fanout",
          itemId: "item-1",
          kind: "attempt",
          status: "running",
          path: path.join("attempts", "fanout", "item-item-1", "attempt-1"),
          startedAt: staleStartedAt
        }
      },
      stages: {
        ...prepared.index.stages,
        fanout: {
          stageId: "fanout",
          status: "running",
          attempts: ["fanout:item-1:attempt-1"],
          startedAt: staleStartedAt,
          fanout: {
            totalItems: 1,
            completedItems: 0,
            blockedItems: 0,
            allowPartial: false,
            items: [{ id: "item-1", index: 0, status: "running", startedAt: staleStartedAt, attemptId: "fanout:item-1:attempt-1" }]
          }
        }
      }
    });

    const recovered = await syncRun(cwd, prepared.logicalRunId);
    const item = recovered.stages.fanout?.fanout?.items[0];

    expect(recovered.status).toBe("completed");
    expect(item).toMatchObject({
      id: "item-1",
      status: "completed",
      outputPath: path.join("outputs", "fanout", "item-1.json")
    });
    expect(recovered.attempts["fanout:item-1:attempt-1"]).toMatchObject({ status: "completed" });
    expect(Object.values(recovered.attempts).filter((attempt) => attempt.status === "running")).toHaveLength(0);
    await expect(fs.stat(path.join(prepared.dir, "outputs", "fanout.json"))).resolves.toBeTruthy();
  });

  it("cleans up a running fanout attempt when recovered output is blocked", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-recover-blocked-"));
    const spec = fanoutSpec(1, { allowPartial: true });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }] }
    });
    const staleStartedAt = staleRecoveryStartedAt();
    const outputPath = path.join(prepared.dir, "outputs", "fanout", "item-1.json");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify({
      status: "blocked",
      summary: "Recovered blocked item",
      artifacts: [],
      nextFocus: "diagnose",
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      runtimeDiagnostics: { errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR }
    }, null, 2)}\n`, "utf8");
    await writeRunIndex(cwd, {
      ...prepared.index,
      status: "running",
      attempts: {
        "fanout:item-1:attempt-1": {
          id: "fanout:item-1:attempt-1",
          stageId: "fanout",
          itemId: "item-1",
          kind: "attempt",
          status: "running",
          path: path.join("attempts", "fanout", "item-item-1", "attempt-1"),
          startedAt: staleStartedAt
        }
      },
      stages: {
        ...prepared.index.stages,
        fanout: {
          stageId: "fanout",
          status: "running",
          attempts: ["fanout:item-1:attempt-1"],
          startedAt: staleStartedAt,
          fanout: {
            totalItems: 1,
            completedItems: 0,
            blockedItems: 0,
            allowPartial: true,
            items: [{ id: "item-1", index: 0, status: "running", startedAt: staleStartedAt, attemptId: "fanout:item-1:attempt-1" }]
          }
        }
      }
    });

    const recovered = await syncRun(cwd, prepared.logicalRunId);

    expect(recovered.stages.fanout?.fanout?.items[0]).toMatchObject({
      status: "blocked",
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR
    });
    expect(recovered.attempts["fanout:item-1:attempt-1"]).toMatchObject({
      status: "blocked",
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      runtimeErrorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR
    });
    expect(Object.values(recovered.attempts).filter((attempt) => attempt.status === "running")).toHaveLength(0);
  });

  it("recovers a stale running fanout item and continues queued work", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-stale-queued-"));
    setAgentRuntimeFactoryForTests(() => new StaticRuntime());
    const spec = fanoutSpec(2, { allowPartial: true }, { maxConcurrency: 1 });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: fanoutInputItems(2) }
    });
    const staleStartedAt = staleRecoveryStartedAt();
    await writeRunIndex(cwd, {
      ...prepared.index,
      status: "running",
      stages: {
        ...prepared.index.stages,
        fanout: {
          stageId: "fanout",
          status: "running",
          attempts: [],
          startedAt: staleStartedAt,
          fanout: {
            totalItems: 2,
            completedItems: 0,
            blockedItems: 0,
            allowPartial: true,
            items: [
              { id: "item-1", index: 0, status: "running", startedAt: staleStartedAt, attemptId: "fanout:item-1:attempt-1" },
              { id: "item-2", index: 1, status: "pending" }
            ]
          }
        }
      }
    });

    const retryTick = await syncRun(cwd, prepared.logicalRunId);
    const recovered = await syncRun(cwd, prepared.logicalRunId);
    const items = recovered.stages.fanout?.fanout?.items ?? [];

    expect(retryTick.stages.fanout?.fanout?.items.find((item) => item.id === "item-1")).toMatchObject({
      status: "completed"
    });
    expect(recovered.status).toBe("completed");
    expect(recovered.stages.fanout?.status).toBe("completed");
    expect(items.map((item) => [item.id, item.status, item.errorCode])).toEqual([
      ["item-1", "completed", undefined],
      ["item-2", "completed", undefined]
    ]);
    expect(recovered.stages.fanout?.fanout).toMatchObject({
      completedItems: 2,
      blockedItems: 0
    });
    expect(recovered.attempts["fanout:item-1:attempt-1"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY
    });
    expect(recovered.attempts["fanout:item-1:work:worker:attempt-1-runtime-retry-1"]).toMatchObject({
      status: "completed",
      runtimeRetryOf: "fanout:item-1:attempt-1",
      runtimeRetryOrdinal: 1
    });
    expect(hasStuckFanoutPendingBatch(recovered)).toBe(false);
  });

  it("keeps observation-only sync read-only for stale running fanout items", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-observe-readonly-"));
    const spec = fanoutSpec(1, { allowPartial: true });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }] }
    });
    const staleStartedAt = staleRecoveryStartedAt();
    const runningIndex: RunIndex = {
      ...prepared.index,
      status: "running",
      stages: {
        ...prepared.index.stages,
        fanout: {
          stageId: "fanout",
          status: "running",
          attempts: ["fanout:item-1:attempt-1"],
          startedAt: staleStartedAt,
          fanout: {
            totalItems: 1,
            completedItems: 0,
            blockedItems: 0,
            allowPartial: true,
            items: [{ id: "item-1", index: 0, status: "running", startedAt: staleStartedAt, attemptId: "fanout:item-1:attempt-1" }]
          }
        }
      },
      attempts: {
        "fanout:item-1:attempt-1": {
          id: "fanout:item-1:attempt-1",
          stageId: "fanout",
          itemId: "item-1",
          kind: "attempt",
          status: "running",
          path: path.join("attempts", "fanout", "item-item-1", "attempt-1"),
          startedAt: staleStartedAt
        }
      }
    };
    await writeRunIndex(cwd, runningIndex);
    const beforeIndex = await readRunIndex(cwd, prepared.logicalRunId);
    const beforeEvents = await fs.readFile(path.join(prepared.dir, "events.ndjson"), "utf8");

    const observed = await syncRun(cwd, prepared.logicalRunId, { startPending: false });
    const persisted = await readRunIndex(cwd, prepared.logicalRunId);
    const afterEvents = await fs.readFile(path.join(prepared.dir, "events.ndjson"), "utf8");

    expect(observed).toEqual(beforeIndex);
    expect(persisted).toEqual(beforeIndex);
    expect(afterEvents).toBe(beforeEvents);
    expect(observed.stages.fanout?.fanout?.items[0]).toMatchObject({
      status: "running",
      attemptId: "fanout:item-1:attempt-1"
    });
    await expect(fs.stat(path.join(prepared.dir, "outputs", "fanout", "item-1.json"))).rejects.toThrow();
  });

  it("does not recover a stale-started fanout item with a recent same-attempt heartbeat", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-heartbeat-"));
    const spec = fanoutSpec(1, { allowPartial: true });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }] }
    });
    const staleStartedAt = staleRecoveryStartedAt();
    await writeRunIndex(cwd, {
      ...prepared.index,
      status: "running",
      stages: {
        ...prepared.index.stages,
        fanout: {
          stageId: "fanout",
          status: "running",
          attempts: ["fanout:item-1:attempt-1"],
          startedAt: staleStartedAt,
          fanout: {
            totalItems: 1,
            completedItems: 0,
            blockedItems: 0,
            allowPartial: true,
            items: [{ id: "item-1", index: 0, status: "running", startedAt: staleStartedAt, attemptId: "fanout:item-1:attempt-1" }]
          }
        }
      },
      attempts: {
        "fanout:item-1:attempt-1": {
          id: "fanout:item-1:attempt-1",
          stageId: "fanout",
          itemId: "item-1",
          kind: "attempt",
          status: "running",
          path: path.join("attempts", "fanout", "item-item-1", "attempt-1"),
          startedAt: staleStartedAt
        }
      }
    });
    await appendEvent(cwd, prepared.logicalRunId, {
      type: "agent_event",
      stageId: "fanout",
      itemId: "item-1",
      attemptId: "fanout:item-1:attempt-1",
      event: { type: "text_delta", stream: "output", text: "still running" }
    });

    const observed = await syncRun(cwd, prepared.logicalRunId);

    expect(observed.status).toBe("running");
    expect(observed.stages.fanout?.fanout?.items[0]).toMatchObject({
      status: "running",
      attemptId: "fanout:item-1:attempt-1"
    });
    expect(observed.attempts["fanout:item-1:attempt-1"]).toMatchObject({ status: "running" });
    expect(observed.attempts["fanout:item-1:attempt-1-runtime-retry-1"]).toBeUndefined();
    await expect(fs.stat(path.join(prepared.dir, "outputs", "fanout", "item-1.json"))).rejects.toThrow();
  });

  it("blocks exhausted stale fanout retries with a stale recovery code", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-stale-exhausted-"));
    const spec = fanoutSpec(1, { allowPartial: true });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }] }
    });
    const staleStartedAt = staleRecoveryStartedAt();
    await writeRunIndex(cwd, {
      ...prepared.index,
      status: "running",
      stages: {
        ...prepared.index.stages,
        fanout: {
          stageId: "fanout",
          status: "running",
          attempts: ["fanout:item-1:attempt-1", "fanout:item-1:attempt-1-runtime-retry-1"],
          startedAt: staleStartedAt,
          fanout: {
            totalItems: 1,
            completedItems: 0,
            blockedItems: 0,
            allowPartial: true,
            items: [{
              id: "item-1",
              index: 0,
              status: "running",
              startedAt: staleStartedAt,
              attemptId: "fanout:item-1:attempt-1-runtime-retry-1",
              runtimeRetryOf: "fanout:item-1:attempt-1",
              runtimeRetryOrdinal: 1
            }]
          }
        }
      },
      attempts: {
        "fanout:item-1:attempt-1": {
          id: "fanout:item-1:attempt-1",
          stageId: "fanout",
          itemId: "item-1",
          kind: "attempt",
          status: "failed",
          path: path.join("attempts", "fanout", "item-item-1", "attempt-1"),
          startedAt: staleStartedAt,
          endedAt: staleStartedAt,
          runtimeErrorCode: RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY
        },
        "fanout:item-1:attempt-1-runtime-retry-1": {
          id: "fanout:item-1:attempt-1-runtime-retry-1",
          stageId: "fanout",
          itemId: "item-1",
          kind: "attempt",
          status: "running",
          path: path.join("attempts", "fanout", "item-item-1", "attempt-1-runtime-retry-1"),
          startedAt: staleStartedAt,
          runtimeRetryOf: "fanout:item-1:attempt-1",
          runtimeRetryOrdinal: 1
        }
      }
    });

    const recovered = await syncRun(cwd, prepared.logicalRunId);
    const item = recovered.stages.fanout?.fanout?.items[0];
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "fanout", "item-1.json"), "utf8")) as {
      blockedReason: string;
      runtimeDiagnostics?: { errorCode?: string };
    };

    expect(recovered.status).toBe("completed");
    expect(item).toMatchObject({
      status: "blocked",
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY,
      errorCode: RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY
    });
    expect(recovered.attempts["fanout:item-1:attempt-1-runtime-retry-1"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY
    });
    expect(output.blockedReason).toBe(RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY);
    expect(output.runtimeDiagnostics?.errorCode).toBe(RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY);
    const events = await readEvents(prepared.dir);
    expect(events).toContainEqual(expect.objectContaining({
      type: "runtime_retry_exhausted",
      itemId: "item-1",
      errorCode: RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "fanout_item_recovered",
      itemId: "item-1",
      errorCode: RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY
    }));
  });

  it("continues a legacy fanout stage stuck running with queued items", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-legacy-stuck-"));
    setAgentRuntimeFactoryForTests(() => new StaticRuntime());
    const spec = fanoutSpec(2, { allowPartial: false }, { maxConcurrency: 1 });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: fanoutInputItems(2) }
    });
    const firstOutputPath = path.join(prepared.dir, "outputs", "fanout", "item-1.json");
    await fs.mkdir(path.dirname(firstOutputPath), { recursive: true });
    await fs.writeFile(firstOutputPath, `${JSON.stringify(baseOutput({ summary: "already complete" }), null, 2)}\n`, "utf8");
    await writeRunIndex(cwd, {
      ...prepared.index,
      status: "running",
      stages: {
        ...prepared.index.stages,
        fanout: {
          stageId: "fanout",
          status: "running",
          attempts: [],
          fanout: {
            totalItems: 2,
            completedItems: 1,
            blockedItems: 0,
            allowPartial: false,
            items: [
              { id: "item-1", index: 0, status: "completed", outputPath: path.join("outputs", "fanout", "item-1.json"), completedAt: new Date().toISOString() },
              { id: "item-2", index: 1, status: "pending" }
            ]
          }
        }
      }
    });

    const synced = await syncRun(cwd, prepared.logicalRunId);

    expect(synced.status).toBe("completed");
    expect(synced.stages.fanout?.status).toBe("completed");
    expect(synced.stages.fanout?.fanout?.completedItems).toBe(2);
    expect(await fanoutPoolStartedCount(prepared.dir)).toBe(1);
    expect(hasStuckFanoutPendingBatch(synced)).toBe(false);
  });

  it("retries a transient agentTask runtime throw once and completes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-retry-stage-"));
    const runtime = new ScriptedRuntime([
      { kind: "throw", message: "transport reset while starting agent" },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "retried" })) }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = simpleTaskSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);

    expect(index.status).toBe("completed");
    expect(index.agentUsage.actual).toBe(2);
    expect(runtime.requests).toHaveLength(2);
    expect(index.attempts["task:attempt-1"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.AGENT_RUNTIME_ERROR
    });
    expect(index.attempts["task:attempt-1-runtime-retry-1"]).toMatchObject({
      status: "completed",
      runtimeRetryOf: "task:attempt-1",
      runtimeRetryOrdinal: 1
    });
  });

  it("retries one transient fanout item runtime throw without surfacing an item error", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-retry-fanout-"));
    const runtime = new TransientFanoutRuntime("item-2");
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = fanoutSpec(2, { allowPartial: false }, { maxConcurrency: 2 });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }, { id: "item-2" }] }
    });

    const index = await startPreparedRun(cwd, prepared);
    const diagnostics = await buildRunDiagnosticsView(cwd, index);

    expect(index.status).toBe("completed");
    const retriedItem = index.stages.fanout?.fanout?.items.find((item) => item.id === "item-2");
    expect(retriedItem).toMatchObject({
      status: "completed",
      runtimeRetryOrdinal: 1
    });
    expect(retriedItem?.errorCode).toBeUndefined();
    expect(index.attempts["fanout:item-2:work:worker:attempt-1"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.AGENT_RUNTIME_ERROR
    });
    expect(index.attempts["fanout:item-2:work:worker:attempt-1-runtime-retry-1"]).toMatchObject({
      status: "completed",
      runtimeRetryOf: "fanout:item-2:work:worker:attempt-1"
    });
    expect(diagnostics.diagnostics).not.toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      itemId: "item-2"
    }));
  });

  it("retries a transient loop body runtime throw and completes the loop", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-retry-loop-"));
    const runtime = new ScriptedRuntime([
      { kind: "throw", message: "agent process failed to start" },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "passed", data: { needsAnotherRound: false } })) }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopOnlySpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);

    expect(index.status).toBe("completed");
    expect(index.attempts["quality_loop:round-1__stage-review:attempt-1"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.AGENT_RUNTIME_ERROR
    });
    expect(index.attempts["quality_loop:round-1__stage-review:attempt-1-runtime-retry-1"]).toMatchObject({
      status: "completed",
      runtimeRetryOf: "quality_loop:round-1__stage-review:attempt-1"
    });
  });

  it("runs loop rounds while continueWhen matches", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-continue-"));
    const runtime = new ScriptedRuntime([
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "needs another round", data: { needsAnotherRound: true } })) },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "converged", data: { needsAnotherRound: false } })) }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const prepared = await prepareRun(loopOnlySpec(cwd), { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "quality_loop.json"), "utf8")) as { rounds: unknown[]; round: number };

    expect(index.status).toBe("completed");
    expect(output.round).toBe(2);
    expect(output.rounds).toHaveLength(2);
    expect(runtime.requests.map((request) => request.sessionKey)).toEqual([
      "role:reviewer:loop:quality_loop:round:1:stage:review",
      "role:reviewer:loop:quality_loop:round:2:stage:review"
    ]);
  });

  it("completes loop after one round when continueWhen is false", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-one-round-"));
    const runtime = new ScriptedRuntime([
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "done", data: { needsAnotherRound: false } })) },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "should not run" })) }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const prepared = await prepareRun(loopOnlySpec(cwd), { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);

    expect(index.status).toBe("completed");
    expect(runtime.requests.map((request) => request.sessionKey)).toEqual(["role:reviewer:loop:quality_loop:round:1:stage:review"]);
  });

  it("blocks loop as exhausted when continueWhen remains true through maxRounds", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-exhausted-"));
    const runtime = new ScriptedRuntime([
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "again", data: { needsAnotherRound: true } })) },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "again", data: { needsAnotherRound: true } })) }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const prepared = await prepareRun(loopOnlySpec(cwd), { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);

    expect(index.status).toBe("blocked");
    expect(index.stages.quality_loop?.blockedReason).toBe(RuntimeErrorCodes.LOOP_EXHAUSTED);
    expect(runtime.requests.map((request) => request.sessionKey)).toEqual([
      "role:reviewer:loop:quality_loop:round:1:stage:review",
      "role:reviewer:loop:quality_loop:round:2:stage:review"
    ]);
  });

  it("exposes loop.previous.output to continueWhen after a completed round", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-previous-continue-"));
    const runtime = new ScriptedRuntime([
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "first", data: { needsAnotherRound: true } })) },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "second", data: { needsAnotherRound: false } })) },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "third", data: { needsAnotherRound: false } })) }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopContinueWithPreviousSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);

    expect(index.status).toBe("completed");
    expect(runtime.requests).toHaveLength(3);
  });

  it("blocks ordinary stages with durable output when required variables are missing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-variable-missing-"));
    const runtime = new ScriptedRuntime([{ kind: "text", text: plainJsonOutput(baseOutput({ summary: "should not run" })) }]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = missingVariableSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "task.json"), "utf8")) as Record<string, unknown>;

    expect(index.status).toBe("blocked");
    expect(index.stages.task?.blockedReason).toBe(RuntimeErrorCodes.VARIABLE_RESOLUTION_FAILED);
    expect(output).toMatchObject({
      status: "blocked",
      blockedReason: RuntimeErrorCodes.VARIABLE_RESOLUTION_FAILED,
      runtimeDiagnostics: {
        variableName: "missing",
        source: "outputs.nope.summary"
      }
    });
    expect(runtime.requests).toHaveLength(0);
  });

  it("ignores corrupt author output artifacts instead of crashing scheduler collection", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-corrupt-author-output-"));
    setAgentRuntimeFactoryForTests(() => new ScriptedRuntime([
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "ok" })) }
    ]));
    const spec = simpleTaskSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });
    await fs.writeFile(path.join(prepared.dir, "outputs", "corrupt.json"), "{not-json", "utf8");

    const index = await startPreparedRun(cwd, prepared);

    expect(index.status).toBe("completed");
  });

  it("blocks loop body agent stages with durable output when required variables are missing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-variable-missing-"));
    const runtime = new ScriptedRuntime([{ kind: "text", text: plainJsonOutput(baseOutput({ summary: "should not run" })) }]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopMissingVariableSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);

    expect(index.status).toBe("blocked");
    expect(index.stages.quality_loop?.blockedReason).toBe(RuntimeErrorCodes.LOOP_BODY_STAGE_BLOCKED);
    expect(index.stages.quality_loop?.loop?.rounds[0]?.stages.review.blockedReason).toBe(RuntimeErrorCodes.VARIABLE_RESOLUTION_FAILED);
    expect(runtime.requests).toHaveLength(0);
  });

  it("runs loop body fanout with stage-local maxConcurrency", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-fanout-concurrency-"));
    const runtime = new DelayedFanoutRuntime({ "item-1": 25, "item-2": 25 });
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopFanoutSpec(cwd, {
      maxConcurrency: 2,
      laneGroups: [{ id: "work", mode: "all", lanes: [{ id: "worker", role: "worker" }] }]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: fanoutInputItems(2) } });

    const index = await startPreparedRun(cwd, prepared);

    expect(index.status).toBe("completed");
    expect(runtime.maxActive).toBe(2);
    expect(runtime.requests.map((request) => request.sessionKey)).toEqual(expect.arrayContaining([
      "role:worker:loop:quality_loop:round:1:stage:review_items:item:item-1:group:work:lane:worker",
      "role:worker:loop:quality_loop:round:1:stage:review_items:item:item-2:group:work:lane:worker"
    ]));
    expect(index.stages.quality_loop?.loop?.rounds[0]?.stages.review_items.fanout).toMatchObject({
      totalItems: 2,
      completedItems: 2,
      workUnits: 2
    });
  });

  it("aggregates loop body fanout lane results by task identity when completion order differs", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-fanout-order-"));
    const runtime = new DelayedFanoutRuntime({ "item-1": 25, "item-2": 1 });
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopFanoutSpec(cwd, {
      maxConcurrency: 2,
      laneGroups: [{ id: "work", mode: "all", lanes: [{ id: "worker", role: "worker" }] }]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: fanoutInputItems(2) } });

    const index = await startPreparedRun(cwd, prepared);
    const items = index.stages.quality_loop?.loop?.rounds[0]?.stages.review_items.fanout?.items ?? [];
    const itemSummaries = items.map((item) => {
      const lane = item.groups?.[0]?.lanes[0] as ({ output?: { summary?: string } } | undefined);
      const laneOutput = lane?.output;
      return [item.id, item.status, laneOutput?.summary];
    });

    expect(index.status).toBe("completed");
    expect(runtime.requests.map((request) => itemIdFromSessionKey(request.sessionKey)).sort()).toEqual(["item-1", "item-2"]);
    expect(itemSummaries).toEqual([
      ["item-1", "completed", expect.stringContaining("item:item-1:group:work:lane:worker")],
      ["item-2", "completed", expect.stringContaining("item:item-2:group:work:lane:worker")]
    ]);
  });

  it("aggregates same-item loop body fanout lanes after concurrent execution", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-fanout-lanes-"));
    const runtime = new DelayedFanoutRuntime({ "item-1": 10 });
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopFanoutSpec(cwd, {
      maxConcurrency: 2,
      laneGroups: [{
        id: "review",
        mode: "all",
        lanes: [
          { id: "static", role: "worker" },
          { id: "semantic", role: "worker" }
        ]
      }]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: fanoutInputItems(1) } });

    const index = await startPreparedRun(cwd, prepared);
    const group = index.stages.quality_loop?.loop?.rounds[0]?.stages.review_items.fanout?.items[0]?.groups?.[0];

    expect(index.status).toBe("completed");
    expect(runtime.maxActive).toBe(2);
    expect(group).toMatchObject({ id: "review", status: "completed" });
    expect(group?.lanes.map((lane) => {
      const output = (lane as { output?: { summary?: string } }).output;
      return [lane.id, lane.status, output?.summary];
    })).toEqual([
      ["static", "completed", expect.stringContaining("lane:static")],
      ["semantic", "completed", expect.stringContaining("lane:semantic")]
    ]);
  });

  it("cascade-blocks unstarted loop body fanout work when partial fanout is disabled", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-fanout-cascade-"));
    const runtime = new DelayedFanoutRuntime({ "item-1": 25, "item-2": 1 }, ["item-2"]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopFanoutSpec(cwd, {
      maxConcurrency: 2,
      laneGroups: [{ id: "work", mode: "all", lanes: [{ id: "worker", role: "worker" }] }],
      allowPartial: false
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: fanoutInputItems(4) } });

    const index = await startPreparedRun(cwd, prepared);
    const fanout = index.stages.quality_loop?.loop?.rounds[0]?.stages.review_items.fanout;
    const requested = runtime.requests.map((request) => itemIdFromSessionKey(request.sessionKey)).sort();

    expect(index.status).toBe("blocked");
    expect(requested).toEqual(["item-1", "item-2", "item-2"]);
    expect(fanout?.items.map((item) => [item.id, item.status, item.errorCode])).toEqual([
      ["item-1", "completed", undefined],
      ["item-2", "blocked", RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR],
      ["item-3", "blocked", RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED],
      ["item-4", "blocked", RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED]
    ]);
  });

  it("blocks loop body fanout lanes with durable output when required variables are missing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-fanout-variable-missing-"));
    const runtime = new ScriptedRuntime([{ kind: "text", text: plainJsonOutput(baseOutput({ summary: "should not run" })) }]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopFanoutMissingVariableSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: [{ id: "item-1" }] } });

    const index = await startPreparedRun(cwd, prepared);
    const fanout = index.stages.quality_loop?.loop?.rounds[0]?.stages.review_items.fanout;

    expect(index.status).toBe("blocked");
    expect(fanout?.items[0]).toMatchObject({
      status: "blocked",
      errorCode: RuntimeErrorCodes.VARIABLE_RESOLUTION_FAILED
    });
    expect(runtime.requests).toHaveLength(0);
  });

  it("blocks loop body fanout oneOf items with multiple matching lanes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-fanout-oneof-multi-"));
    const runtime = new ScriptedRuntime([{ kind: "text", text: plainJsonOutput(baseOutput({ summary: "should not run" })) }]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopFanoutSpec(cwd, {
      laneGroups: [{
        id: "route",
        mode: "oneOf",
        lanes: [
          { id: "a", role: "worker", when: { source: "item.kind", op: "eq", value: "both" } },
          { id: "b", role: "worker", when: { source: "item.kind", op: "eq", value: "both" } }
        ]
      }]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: [{ id: "item-1", kind: "both" }] } });

    const index = await startPreparedRun(cwd, prepared);
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "quality_loop", "round-1", "review_items.json"), "utf8")) as { blockedItems: Array<{ errorCode?: string }> };

    expect(index.status).toBe("blocked");
    expect(index.stages.quality_loop?.blockedReason).toBe(RuntimeErrorCodes.LOOP_BODY_STAGE_BLOCKED);
    expect(output.blockedItems[0]?.errorCode).toBe(RuntimeErrorCodes.FANOUT_LANE_SELECTION_FAILED);
    expect(runtime.requests).toHaveLength(0);
  });

  it("blocks loop body fanout oneOf items with no matching lane and no default", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-fanout-oneof-none-"));
    const runtime = new ScriptedRuntime([{ kind: "text", text: plainJsonOutput(baseOutput({ summary: "should not run" })) }]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopFanoutSpec(cwd, {
      laneGroups: [{
        id: "route",
        mode: "oneOf",
        lanes: [{ id: "a", role: "worker", when: { source: "item.kind", op: "eq", value: "a" } }]
      }]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: [{ id: "item-1", kind: "b" }] } });

    const index = await startPreparedRun(cwd, prepared);
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "quality_loop", "round-1", "review_items.json"), "utf8")) as { blockedItems: Array<{ errorCode?: string }> };

    expect(index.status).toBe("blocked");
    expect(output.blockedItems[0]?.errorCode).toBe(RuntimeErrorCodes.FANOUT_LANE_SELECTION_FAILED);
    expect(runtime.requests).toHaveLength(0);
  });

  it("skips loop body fanout items with no matching all-group lanes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-fanout-skipped-"));
    const runtime = new StaticRuntime();
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopFanoutSpec(cwd, {
      laneGroups: [{
        id: "work",
        mode: "all",
        lanes: [{ id: "worker", role: "worker", when: { source: "item.kind", op: "eq", value: "run" } }]
      }]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: [{ id: "item-1", kind: "skip" }] } });

    const index = await startPreparedRun(cwd, prepared);
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "quality_loop", "round-1", "review_items.json"), "utf8")) as { skippedItems: Array<{ skippedReason?: string }> };

    expect(index.status).toBe("completed");
    expect(output.skippedItems[0]?.skippedReason).toBe(RuntimeErrorCodes.NO_MATCHING_LANES);
  });

  it("blocks loop when a planned body stage is missing from the workflow spec", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-missing-body-stage-"));
    setAgentRuntimeFactoryForTests(() => new StaticRuntime());
    const spec = loopOnlySpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });
    const planPath = path.join(prepared.dir, "execution-plan.json");
    const plan = JSON.parse(await fs.readFile(planPath, "utf8")) as { stages: Array<{ id: string; loop?: { body: { stages: Array<{ id: string }> } } }> };
    plan.stages[0]?.loop?.body.stages.push({ ...plan.stages[0].loop.body.stages[0], id: "missing_review" });
    await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

    const index = await startPreparedRun(cwd, prepared);

    expect(index.status).toBe("blocked");
    expect(index.stages.quality_loop?.blockedReason).toBe(RuntimeErrorCodes.LOOP_BODY_STAGE_FAILED);
  });

  it("makes loop.current.output visible after the canonical loop body output stage runs", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-current-output-"));
    const runtime = new ScriptedRuntime([
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "canonical output", data: { needsAnotherRound: false } })) },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "after canonical" })) }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopCurrentOutputSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);

    expect(index.status).toBe("completed");
    expect(runtime.requests[1]?.prompt).toContain("canonical output");
  });

  it("retries a transient repair runtime throw and completes from repaired output", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-retry-repair-"));
    const runtime = new ScriptedRuntime([
      { kind: "text", text: plainJsonOutput({ status: "completed" }) },
      { kind: "throw", message: "queue rejected repair turn" },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "repaired" })) }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = simpleTaskSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);

    expect(index.status).toBe("completed");
    expect(index.agentUsage.actual).toBe(3);
    expect(index.agentUsage.repairCalls).toBe(2);
    expect(index.attempts["task:repair-1"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.AGENT_RUNTIME_ERROR
    });
    expect(index.attempts["task:repair-1-runtime-retry-1"]).toMatchObject({
      status: "completed",
      runtimeRetryOf: "task:repair-1"
    });
  });

  it("retries failed retryable turns but not non-retryable failed turns", async () => {
    const retryCwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-retry-failed-"));
    const retryRuntime = new ScriptedRuntime([
      { kind: "failed", message: "queue rejected prompt", errorCode: "ACP_TURN_FAILED", retryable: true },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "retried failed status" })) }
    ]);
    setAgentRuntimeFactoryForTests(() => retryRuntime);
    const retrySpec = simpleTaskSpec(retryCwd);
    const retryPrepared = await prepareRun(retrySpec, { cwd: retryCwd, input: { cwd: retryCwd } });

    const retried = await startPreparedRun(retryCwd, retryPrepared);

    expect(retried.status).toBe("completed");
    expect(retryRuntime.requests).toHaveLength(2);

    const blockedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-no-retry-failed-"));
    const blockedRuntime = new ScriptedRuntime([
      { kind: "failed", message: "permission denied", errorCode: "PERMISSION_DENIED", retryable: false },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "should not run" })) }
    ]);
    setAgentRuntimeFactoryForTests(() => blockedRuntime);
    const blockedSpec = simpleTaskSpec(blockedCwd);
    const blockedPrepared = await prepareRun(blockedSpec, { cwd: blockedCwd, input: { cwd: blockedCwd } });

    const blocked = await startPreparedRun(blockedCwd, blockedPrepared);

    expect(blocked.status).toBe("blocked");
    expect(blocked.stages.task?.blockedReason).toBe(RuntimeErrorCodes.AGENT_TURN_FAILED);
    expect(blockedRuntime.requests).toHaveLength(1);
  });

  it("blocks non-fanout stages with AGENT_RUNTIME_ERROR after retry exhaustion", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-retry-exhausted-"));
    const runtime = new ScriptedRuntime([
      { kind: "throw", message: "transport reset" },
      { kind: "throw", message: "transport reset again" }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = simpleTaskSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);
    const diagnostics = await buildRunDiagnosticsView(cwd, index);

    expect(index.status).toBe("blocked");
    expect(index.stages.task?.blockedReason).toBe(RuntimeErrorCodes.AGENT_RUNTIME_ERROR);
    expect(index.attempts["task:attempt-1-runtime-retry-1"]).toMatchObject({
      status: "failed",
      runtimeRetryOf: "task:attempt-1",
      runtimeRetryOrdinal: 1
    });
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.AGENT_RUNTIME_ERROR,
      stageId: "task"
    }));
  });

  it("retries stale non-fanout running stages and blocks after stale retry exhaustion", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-stale-stage-"));
    setAgentRuntimeFactoryForTests(() => new StaticRuntime());
    const spec = simpleTaskSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });
    const staleStartedAt = staleRecoveryStartedAt();
    await writeRunIndex(cwd, {
      ...prepared.index,
      status: "running",
      stages: {
        ...prepared.index.stages,
        task: {
          stageId: "task",
          status: "running",
          attempts: ["task:attempt-1"],
          startedAt: staleStartedAt
        }
      },
      attempts: {
        "task:attempt-1": {
          id: "task:attempt-1",
          stageId: "task",
          kind: "attempt",
          status: "running",
          path: path.join("attempts", "task", "attempt-1"),
          startedAt: staleStartedAt,
          requestId: "task:attempt-1"
        }
      }
    });

    const recovered = await syncRun(cwd, prepared.logicalRunId);

    expect(recovered.status).toBe("completed");
    expect(recovered.attempts["task:attempt-1"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.AGENT_STAGE_STALE_RECOVERY
    });
    expect(recovered.attempts["task:attempt-1-runtime-retry-1"]).toMatchObject({
      status: "completed",
      runtimeRetryOf: "task:attempt-1"
    });

    const exhaustedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-stale-stage-exhausted-"));
    const exhaustedPrepared = await prepareRun(spec, { cwd: exhaustedCwd, input: { cwd: exhaustedCwd } });
    await writeRunIndex(exhaustedCwd, {
      ...exhaustedPrepared.index,
      status: "running",
      stages: {
        ...exhaustedPrepared.index.stages,
        task: {
          stageId: "task",
          status: "running",
          attempts: ["task:attempt-1", "task:attempt-1-runtime-retry-1"],
          startedAt: staleStartedAt,
          runtimeRetryOf: "task:attempt-1",
          runtimeRetryOrdinal: 1
        }
      },
      attempts: {
        "task:attempt-1": {
          id: "task:attempt-1",
          stageId: "task",
          kind: "attempt",
          status: "failed",
          path: path.join("attempts", "task", "attempt-1"),
          startedAt: staleStartedAt,
          endedAt: staleStartedAt,
          runtimeErrorCode: RuntimeErrorCodes.AGENT_STAGE_STALE_RECOVERY
        },
        "task:attempt-1-runtime-retry-1": {
          id: "task:attempt-1-runtime-retry-1",
          stageId: "task",
          kind: "attempt",
          status: "running",
          path: path.join("attempts", "task", "attempt-1-runtime-retry-1"),
          startedAt: staleStartedAt,
          requestId: "task:attempt-1-runtime-retry-1",
          runtimeRetryOf: "task:attempt-1",
          runtimeRetryOrdinal: 1
        }
      }
    });

    const exhausted = await syncRun(exhaustedCwd, exhaustedPrepared.logicalRunId);

    expect(exhausted.status).toBe("blocked");
    expect(exhausted.stages.task?.blockedReason).toBe(RuntimeErrorCodes.AGENT_STAGE_STALE_RECOVERY);
    expect(exhausted.attempts["task:attempt-1-runtime-retry-1"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.AGENT_STAGE_STALE_RECOVERY
    });
  });

  it("preserves cancelled turn diagnostics in output and attempt index", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cancelled-turn-"));
    setAgentRuntimeFactoryForTests(() => new CancelledRuntime());
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpus.workflow/v1",
      name: "cancelled-turn",
      root: "task",
      inputs: { cwd: { type: "path", default: cwd } },
      roles: { worker: { category: "coordination", agent: "fake", mode: "readOnly" } },
      limits: { stageTimeoutMinutes: 1 },
      stages: [{ id: "task", kind: "agentTask", role: "worker", prompt: "Do work" }]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "task.json"), "utf8")) as { runtimeDiagnostics: Record<string, unknown> };
    const persisted = await readRunIndex(cwd, prepared.logicalRunId);
    const attempt = persisted.attempts["task:attempt-1"];

    expect(index.status).toBe("blocked");
    expect(output.runtimeDiagnostics).toMatchObject({
      stopReason: "cancelled",
      requestId: "task:attempt-1",
      sessionKey: "role:worker",
      agent: "fake",
      roleMode: "readOnly",
      runtimeDisposeInvoked: false,
      rawTextPreview: "partial cancelled text"
    });
    expect(attempt).toMatchObject({
      stopReason: "cancelled",
      requestId: "task:attempt-1",
      sessionKey: "role:worker",
      runtimeErrorCode: RuntimeErrorCodes.AGENT_TURN_CANCELLED
    });
  });

  it("surfaces item runtime errors in run diagnostics", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-diagnostics-"));
    setAgentRuntimeFactoryForTests(() => new SelectiveFanoutRuntime("item-2"));
    const spec = fanoutSpec(2, { allowPartial: false });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }, { id: "item-2" }] }
    });
    const index = await startPreparedRun(cwd, prepared);

    const diagnostics = await buildRunDiagnosticsView(cwd, index);
    const fanout = index.stages.fanout?.fanout;

    expect(fanout?.items.find((item) => item.id === "item-2")).toMatchObject({
      status: "blocked",
      errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR
    });
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      stageId: "fanout",
      itemId: "item-2"
    }));
  });

  it("diagnoses a fanout stage stuck running with queued items", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-stuck-diagnostics-"));
    const spec = fanoutSpec(2, { allowPartial: false }, { maxConcurrency: 1 });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: fanoutInputItems(2) }
    });
    const stuckIndex: RunIndex = {
      ...prepared.index,
      status: "running",
      stages: {
        ...prepared.index.stages,
        fanout: {
          stageId: "fanout",
          status: "running",
          attempts: [],
          fanout: {
            totalItems: 2,
            completedItems: 1,
            blockedItems: 0,
            allowPartial: false,
            items: [
              { id: "item-1", index: 0, status: "completed", completedAt: new Date().toISOString() },
              { id: "item-2", index: 1, status: "pending" }
            ]
          }
        }
      }
    };

    const diagnostics = await buildRunDiagnosticsView(cwd, stuckIndex);

    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.FANOUT_STAGE_STUCK_PENDING_BATCH,
      stageId: "fanout",
      itemId: undefined,
      summary: expect.stringContaining("queued item")
    }));
  });

  it("records a run-level blocked reason when the gate verdict is unknown", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-gate-verdict-"));
    setAgentRuntimeFactoryForTests(() => new GateVerdictRuntime("unknown"));
    const spec = gateSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);
    const diagnostics = await buildRunDiagnosticsView(cwd, index);

    expect(index.status).toBe("blocked");
    expect(index.agentUsage.actual).toBe(1);
    expect(index.gateVerdict).toBe("unknown");
    expect(index.blockedReason).toBe(RuntimeErrorCodes.GATE_VERDICT_UNKNOWN);
    expect(diagnostics.run.blockedReason).toBe(RuntimeErrorCodes.GATE_VERDICT_UNKNOWN);
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.GATE_VERDICT_UNKNOWN,
      stageId: undefined,
      itemId: undefined
    }));
  });

  it("distinguishes completed scheduler recovery from a blocked workflow verdict", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-recovery-verdict-"));
    const spec = fanoutSpec(1, { allowPartial: true });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }] }
    });
    for (const itemCode of [RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR, RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY]) {
      const index: RunIndex = {
        ...prepared.index,
        status: "blocked",
        gateVerdict: "blocked",
        blockedReason: RuntimeErrorCodes.GATE_VERDICT_BLOCKED,
        stages: {
          ...prepared.index.stages,
          fanout: {
            stageId: "fanout",
            status: "completed",
            attempts: [],
            fanout: {
              totalItems: 1,
              completedItems: 0,
              blockedItems: 1,
              allowPartial: true,
              items: [{
                id: "item-1",
                index: 0,
                status: "blocked",
                blockedReason: itemCode,
                errorCode: itemCode,
                completedAt: new Date().toISOString()
              }]
            }
          }
        }
      };

      const diagnostics = await buildRunDiagnosticsView(cwd, index);

      expect(diagnostics.run.status).toBe("blocked");
      expect(diagnostics.run.blockedReason).toBe(RuntimeErrorCodes.GATE_VERDICT_BLOCKED);
      expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
        code: RunDiagnosticCodes.SCHEDULER_RECOVERY_SUCCEEDED_WITH_BLOCKED_VERDICT,
        status: "completed",
        summary: expect.stringContaining("Scheduler recovery completed")
      }));
    }
  });

  it("applies persisted resume policy when re-aggregating blocked fanout", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-resume-policy-"));
    setAgentRuntimeFactoryForTests(() => new SelectiveFanoutRuntime("item-2"));
    const spec = fanoutSpec(3, { allowPartial: false });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }, { id: "item-2" }, { id: "item-3" }] }
    });
    const blocked = await startPreparedRun(cwd, prepared);

    await writeRunIndex(cwd, {
      ...blocked,
      status: "running",
      blockedReason: undefined,
      resumePolicy: { fanout: { fanout: { allowPartial: true } } },
      stages: blocked.stages
    });

    const resumed = await syncRun(cwd, prepared.logicalRunId);

    expect(resumed.status).toBe("completed");
    expect(resumed.stages.fanout?.status).toBe("completed");
    expect(resumed.stages.fanout?.fanout).toMatchObject({
      totalItems: 3,
      completedItems: 2,
      blockedItems: 1,
      allowPartial: true
    });
  });

  it("does not let resume allowPartial bypass fanout completion constraints", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-resume-partial-constraints-"));
    setAgentRuntimeFactoryForTests(() => new SelectiveFanoutRuntime("item-2"));
    const spec = fanoutSpec(3, { allowPartial: false, minCompletedRatio: 1, maxBlockedItems: 0 });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: fanoutInputItems(3) }
    });
    const blocked = await startPreparedRun(cwd, prepared);

    await writeRunIndex(cwd, {
      ...blocked,
      status: "running",
      blockedReason: undefined,
      resumePolicy: { fanout: { fanout: { allowPartial: true } } },
      stages: blocked.stages
    });

    const resumed = await syncRun(cwd, prepared.logicalRunId);

    expect(resumed.status).toBe("blocked");
    expect(resumed.stages.fanout?.status).toBe("blocked");
    expect(resumed.stages.fanout?.blockedReason).toBe(RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR);
    expect(resumed.stages.fanout?.fanout).toMatchObject({
      completedItems: 2,
      blockedItems: 1,
      allowPartial: true
    });
  });

  it("blocks fanout aggregation when a failed item has no output artifact", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-missing-output-"));
    const spec = fanoutSpec(2, { allowPartial: false });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: fanoutInputItems(2) }
    });
    const firstOutputPath = path.join(prepared.dir, "outputs", "fanout", "item-1.json");
    await fs.mkdir(path.dirname(firstOutputPath), { recursive: true });
    await fs.writeFile(firstOutputPath, `${JSON.stringify(baseOutput({ summary: "done" }), null, 2)}\n`, "utf8");
    await writeRunIndex(cwd, {
      ...prepared.index,
      status: "running",
      stages: {
        ...prepared.index.stages,
        fanout: {
          stageId: "fanout",
          status: "running",
          attempts: [],
          fanout: {
            totalItems: 2,
            completedItems: 1,
            blockedItems: 0,
            allowPartial: false,
            items: [
              { id: "item-1", index: 0, status: "completed", outputPath: path.join("outputs", "fanout", "item-1.json"), completedAt: new Date().toISOString() },
              { id: "item-2", index: 1, status: "failed", completedAt: new Date().toISOString(), errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR }
            ]
          }
        }
      }
    });

    const aggregated = await syncRun(cwd, prepared.logicalRunId);
    const aggregate = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "fanout.json"), "utf8")) as {
      blockedItems: Array<{ blockedReason?: string }>;
    };
    const diagnostics = await buildRunDiagnosticsView(cwd, aggregated);

    expect(aggregated.status).toBe("blocked");
    expect(aggregated.blockedReason).toBe(RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR);
    expect(aggregated.stages.fanout?.blockedReason).toBe(RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR);
    expect(aggregate.blockedItems).toContainEqual(expect.objectContaining({
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR
    }));
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR
    }));
  });

  it("does not remove running fanout items when applying resume maxItems or skip policy", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-resume-keeps-running-"));
    const spec = fanoutSpec(3, { allowPartial: true });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: fanoutInputItems(3) }
    });
    const startedAt = new Date().toISOString();
    await writeRunIndex(cwd, {
      ...prepared.index,
      status: "running",
      resumePolicy: { fanout: { fanout: { maxItems: 1, skipItemIndexes: [1] } } },
      stages: {
        ...prepared.index.stages,
        fanout: {
          stageId: "fanout",
          status: "running",
          attempts: [],
          startedAt,
          fanout: {
            totalItems: 3,
            completedItems: 0,
            blockedItems: 0,
            allowPartial: true,
            items: [
              { id: "item-1", index: 0, status: "pending" },
              { id: "item-2", index: 1, status: "running", startedAt, attemptId: "fanout:item-2:attempt-1" },
              { id: "item-3", index: 2, status: "pending" }
            ]
          }
        }
      }
    });

    const observed = await syncRun(cwd, prepared.logicalRunId);

    expect(observed.stages.fanout?.fanout?.items.map((item) => [item.id, item.status])).toEqual([
      ["item-1", "pending"],
      ["item-2", "running"]
    ]);
  });

  it("projects recovery call usage in RunView summaries", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runview-recovery-"));
    setAgentRuntimeFactoryForTests(() => new StaticRuntime());
    const spec = simpleTaskSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });
    const index = await startPreparedRun(cwd, prepared);
    await writeRunIndex(cwd, {
      ...index,
      agentUsage: {
        ...index.agentUsage,
        recoveryCalls: 2
      }
    });

    const persisted = await readRunIndex(cwd, prepared.logicalRunId);
    expect(persisted.agentUsage.recoveryCalls).toBe(2);
  });

  it("preserves diagnosed_blocked status during observation-only sync", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-diagnosed-sync-"));
    setAgentRuntimeFactoryForTests(() => new SelectiveFanoutRuntime("item-2"));
    const spec = fanoutSpec(2, { allowPartial: false });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }, { id: "item-2" }] }
    });
    await startPreparedRun(cwd, prepared);

    const diagnosed = await startDiagnosticRun(cwd, prepared.logicalRunId);
    const observed = await syncRun(cwd, prepared.logicalRunId, { startPending: false });

    expect(diagnosed.status).toBe("diagnosed_blocked");
    expect(observed.status).toBe("diagnosed_blocked");
  });

  it("does not use agent call accounting as a scheduler budget", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-agent-usage-not-budget-"));
    setAgentRuntimeFactoryForTests(() => new StaticRuntime());
    const spec = usageAccountingSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const firstTick = await startPreparedRun(cwd, prepared);
    await writeRunIndex(cwd, {
      ...firstTick,
      agentUsage: {
        ...firstTick.agentUsage,
        actual: firstTick.agentUsage.planned + 10
      }
    });
    const secondTick = await syncRun(cwd, prepared.logicalRunId);
    const diagnostics = await buildRunDiagnosticsView(cwd, secondTick);

    expect(firstTick.status).toBe("running");
    expect(secondTick.status).toBe("completed");
    expect(secondTick.stages.validate).toMatchObject({
      status: "completed"
    });
    expect(diagnostics.diagnostics.map((entry) => entry.code)).not.toContain("LIMIT_AGENT_BUDGET_EXHAUSTED");
  });
});

function fanoutSpec(
  count: number,
  policy: { allowPartial: boolean; minCompletedRatio?: number; maxBlockedItems?: number },
  limits: { maxConcurrency?: number; maxFanoutItems?: number } = {}
): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "fanout-stability",
    root: "fanout",
    inputs: {
      cwd: { type: "path" },
      items: { type: "array<json>" }
    },
    roles: { worker: { category: "coordination", agent: "fake", mode: "readOnly" } },
    limits: { stageTimeoutMinutes: 1 },
    stages: [{
      id: "fanout",
      kind: "fanout",
      items: { source: "input.items" },
      limits: {
        maxConcurrency: limits.maxConcurrency ?? count,
        maxFanoutItems: limits.maxFanoutItems ?? count
      },
      prompt: "Handle one item",
      laneGroups: [{ id: "work", mode: "all", lanes: [{ id: "worker", role: "worker" }] }],
      fanoutPolicy: policy
    }]
  });
}

function fanoutInputItems(count: number): Array<{ id: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: `item-${index + 1}` }));
}

function loopFanoutRealtimeSpec(): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "loop-fanout-realtime",
    root: "review_loop",
    inputs: {
      cwd: { type: "path" },
      items: { type: "array<json>" }
    },
    roles: { worker: { category: "coordination", agent: "fake", mode: "readOnly" } },
    limits: { stageTimeoutMinutes: 1 },
    stages: [{
      id: "review_loop",
      kind: "loop",
      maxRounds: 1,
      body: {
        root: "body_fanout",
        output: "body_fanout",
        stages: [{
          id: "body_fanout",
          kind: "fanout",
          items: { source: "input.items" },
          limits: { maxConcurrency: 1, maxFanoutItems: 1 },
          prompt: "Review loop fanout item",
          laneGroups: [{ id: "work", mode: "all", lanes: [{ id: "worker", role: "worker" }] }],
          fanoutPolicy: { allowPartial: false }
        }]
      },
      continueWhen: { source: "loop.current.output.status", op: "eq", value: "again" },
      onExhausted: "blocked"
    }]
  });
}

function queuedFanoutItemCount(index: RunIndex): number {
  return index.stages.fanout?.fanout?.items.filter((item) => item.status === "pending" || item.status === "ready").length ?? 0;
}

function hasStuckFanoutPendingBatch(index: RunIndex): boolean {
  return Object.values(index.stages).some((stage) => {
    if (stage.status !== "running" || !stage.fanout) return false;
    const hasRunningItems = stage.fanout.items.some((item) => item.status === "running");
    const hasQueuedItems = stage.fanout.items.some((item) => item.status === "pending" || item.status === "ready");
    return !hasRunningItems && hasQueuedItems;
  });
}

function staleRecoveryStartedAt(): string {
  return new Date(Date.now() - 130_000).toISOString();
}

async function fanoutPoolStartedCount(dir: string): Promise<number> {
  return (await readEvents(dir)).filter((event) => event.type === "fanout_pool_started").length;
}

async function readEvents(dir: string): Promise<Array<{ type?: string; itemId?: string; cascade?: boolean }>> {
  const text = await fs.readFile(path.join(dir, "events.ndjson"), "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string; itemId?: string; cascade?: boolean });
}

async function waitForLoopFanoutLaneStatus(cwd: string, runId: string, spec: WorkflowSpec, itemId: string): Promise<string | undefined> {
  return (await waitForLoopFanoutLane(cwd, runId, spec, itemId, () => true))?.status;
}

async function waitForLoopFanoutLane(
  cwd: string,
  runId: string,
  spec: WorkflowSpec,
  itemId: string,
  predicate: (task: Awaited<ReturnType<typeof buildRunMonitorView>>["tasks"][number]) => boolean
): Promise<Awaited<ReturnType<typeof buildRunMonitorView>>["tasks"][number] | undefined> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const snapshot = await readRunIndex(cwd, runId);
    const view = await buildRunMonitorView(cwd, spec, snapshot);
    const lane = view.tasks.find((task) => task.kind === "loopFanoutLane" && task.itemId === itemId);
    if (lane && predicate(lane)) return lane;
    await sleep(10);
  }
  return undefined;
}

async function waitForLoopBodyStage(
  cwd: string,
  runId: string,
  loopStageId: string,
  bodyStageId: string,
  predicate: (entry: NonNullable<NonNullable<RunIndex["stages"][string]["loop"]>["rounds"][number]["stages"][string]>) => boolean
): Promise<NonNullable<NonNullable<RunIndex["stages"][string]["loop"]>["rounds"][number]["stages"][string]> | undefined> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const snapshot = await readRunIndex(cwd, runId);
    const stage = snapshot.stages[loopStageId]?.loop?.rounds.at(-1)?.stages[bodyStageId];
    if (stage && predicate(stage)) return stage;
    await sleep(10);
  }
  return undefined;
}

function gateSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "gate-verdict",
    root: "gate",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      gater: { category: "validation", agent: "fake", mode: "readOnly" }
    },
    limits: { stageTimeoutMinutes: 1 },
    stages: [{ id: "gate", kind: "gate", mode: "agent", role: "gater", prompt: "Gate" }]
  });
}

function usageAccountingSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "agent-usage-not-budget",
    root: "plan",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      worker: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      { id: "plan", kind: "agentTask", role: "worker", prompt: "Plan" },
      { id: "validate", kind: "agentTask", role: "worker", dependsOn: ["plan"], prompt: "Validate" }
    ]
  });
}

function simpleTaskSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "simple-task",
    root: "task",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      worker: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { stageTimeoutMinutes: 1 },
    stages: [{ id: "task", kind: "agentTask", role: "worker", prompt: "Do work" }]
  });
}

function loopOnlySpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "loop-only",
    root: "quality_loop",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      reviewer: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { stageTimeoutMinutes: 1 },
    stages: [{
      id: "quality_loop",
      kind: "loop",
      maxRounds: 2,
      body: {
        root: "review",
        output: "review",
        stages: [{
          id: "review",
          kind: "agentTask",
          role: "reviewer",
          prompt: "Review"
        }]
      },
      continueWhen: { source: "loop.current.output.data.needsAnotherRound", op: "eq", value: true },
      onExhausted: "blocked"
    }]
  });
}

function loopContinueWithPreviousSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "loop-previous-continue",
    root: "quality_loop",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      reviewer: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { stageTimeoutMinutes: 1 },
    stages: [{
      id: "quality_loop",
      kind: "loop",
      maxRounds: 3,
      body: {
        root: "review",
        output: "review",
        stages: [{
          id: "review",
          kind: "agentTask",
          role: "reviewer",
          prompt: "Review"
        }]
      },
      continueWhen: {
        any: [
          { source: "loop.current.output.data.needsAnotherRound", op: "eq", value: true },
          { source: "loop.previous.output.summary", op: "eq", value: "first" }
        ]
      },
      onExhausted: "blocked"
    }]
  });
}

function missingVariableSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "missing-variable",
    root: "task",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      worker: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { stageTimeoutMinutes: 1 },
    stages: [{
      id: "task",
      kind: "agentTask",
      role: "worker",
      variables: [{ name: "missing", source: "outputs.nope.summary" }],
      prompt: "Use ${missing}"
    }]
  });
}

function loopMissingVariableSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "loop-missing-variable",
    root: "quality_loop",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      reviewer: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { stageTimeoutMinutes: 1 },
    stages: [{
      id: "quality_loop",
      kind: "loop",
      maxRounds: 1,
      body: {
        root: "review",
        output: "review",
        stages: [{
          id: "review",
          kind: "agentTask",
          role: "reviewer",
          variables: [{ name: "missing", source: "outputs.nope.summary" }],
          prompt: "Review ${missing}"
        }]
      },
      continueWhen: { source: "loop.current.output.data.needsAnotherRound", op: "eq", value: true },
      onExhausted: "blocked"
    }]
  });
}

function loopFanoutMissingVariableSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "loop-fanout-missing-variable",
    root: "quality_loop",
    inputs: {
      cwd: { type: "path", default: cwd },
      items: { type: "array<json>" }
    },
    roles: {
      worker: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { stageTimeoutMinutes: 1 },
    stages: [{
      id: "quality_loop",
      kind: "loop",
      maxRounds: 1,
      body: {
        root: "review_items",
        output: "review_items",
        stages: [{
          id: "review_items",
          kind: "fanout",
          items: { source: "input.items" },
          limits: { maxConcurrency: 1, maxFanoutItems: 1 },
          variables: [{ name: "missing", source: "outputs.nope.summary" }],
          prompt: "Review ${missing}",
          laneGroups: [{ id: "work", mode: "all", lanes: [{ id: "worker", role: "worker" }] }],
          fanoutPolicy: { allowPartial: false }
        }]
      },
      continueWhen: { source: "loop.current.output.data.needsAnotherRound", op: "eq", value: true },
      onExhausted: "blocked"
    }]
  });
}

function loopFanoutSpec(cwd: string, options: {
  maxConcurrency?: number;
  laneGroups: Array<{
    id: string;
    mode: "all" | "oneOf";
    lanes: Array<{
      id: string;
      role: string;
      when?: { source: string; op: "eq"; value: unknown };
      default?: boolean;
    }>;
  }>;
  allowPartial?: boolean;
}): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "loop-fanout",
    root: "quality_loop",
    inputs: {
      cwd: { type: "path", default: cwd },
      items: { type: "array<json>" }
    },
    roles: {
      worker: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { stageTimeoutMinutes: 1 },
    stages: [{
      id: "quality_loop",
      kind: "loop",
      maxRounds: 1,
      body: {
        root: "review_items",
        output: "review_items",
        stages: [{
          id: "review_items",
          kind: "fanout",
          items: { source: "input.items" },
          limits: { maxConcurrency: options.maxConcurrency ?? 1, maxFanoutItems: 10 },
          prompt: "Review item",
          laneGroups: options.laneGroups,
          fanoutPolicy: { allowPartial: options.allowPartial ?? false }
        }]
      },
      continueWhen: { source: "loop.current.output.data.needsAnotherRound", op: "eq", value: true },
      onExhausted: "blocked"
    }]
  });
}

function loopCurrentOutputSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "loop-current-output",
    root: "quality_loop",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      reviewer: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { stageTimeoutMinutes: 1 },
    stages: [{
      id: "quality_loop",
      kind: "loop",
      maxRounds: 1,
      body: {
        root: "review",
        output: "review",
        stages: [
          { id: "review", kind: "agentTask", role: "reviewer", prompt: "Review" },
          {
            id: "after",
            kind: "agentTask",
            role: "reviewer",
            dependsOn: ["review"],
            variables: [{ name: "summary", source: "loop.current.output.summary" }],
            prompt: "After ${summary}"
          }
        ]
      },
      continueWhen: { source: "loop.current.output.data.needsAnotherRound", op: "eq", value: true },
      onExhausted: "blocked"
    }]
  });
}

type RuntimeStep =
  | { kind: "text"; text: string }
  | { kind: "throw"; message: string; errorCode?: string }
  | { kind: "failed"; message: string; errorCode?: string; errorDetailCode?: string; retryable?: boolean };

class ScriptedRuntime implements OrchestratorAgentRuntime {
  readonly requests: AgentTurnRequest[] = [];
  private index = 0;

  constructor(private readonly steps: RuntimeStep[]) {}

  async runTurn(input: AgentTurnRequest, onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void): Promise<AgentTurnResult> {
    this.requests.push(input);
    const step = this.steps[this.index] ?? this.steps.at(-1) ?? { kind: "text", text: plainJsonOutput(baseOutput()) };
    this.index += 1;
    if (step.kind === "throw") {
      const error = new Error(step.message) as Error & { code?: string };
      if (step.errorCode) error.code = step.errorCode;
      throw error;
    }
    if (step.kind === "failed") {
      return {
        handle: fakeHandle(input),
        rawText: "",
        events: [],
        status: "failed",
        error: step.message,
        errorCode: step.errorCode,
        errorDetailCode: step.errorDetailCode,
        retryable: step.retryable
      };
    }
    const event: AcpRuntimeEvent = { type: "text_delta", text: step.text, stream: "output" };
    await onEvent?.(event);
    return {
      handle: fakeHandle(input),
      rawText: step.text,
      events: [event],
      status: "completed"
    };
  }
}

class TransientFanoutRuntime implements OrchestratorAgentRuntime {
  readonly requests: AgentTurnRequest[] = [];
  private readonly failures = new Set<string>();

  constructor(private readonly failingItemId: string) {}

  async runTurn(input: AgentTurnRequest, onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void): Promise<AgentTurnResult> {
    this.requests.push(input);
    if (itemIdFromSessionKey(input.sessionKey) === this.failingItemId && !this.failures.has(input.sessionKey)) {
      this.failures.add(input.sessionKey);
      throw new Error("queue rejected item turn");
    }
    const rawText = plainJsonOutput(baseOutput({ summary: input.sessionKey }));
    const event: AcpRuntimeEvent = { type: "text_delta", text: rawText, stream: "output" };
    await onEvent?.(event);
    return {
      handle: fakeHandle(input),
      rawText,
      events: [event],
      status: "completed"
    };
  }
}

class SelectiveFanoutRuntime implements OrchestratorAgentRuntime {
  readonly requests: AgentTurnRequest[] = [];

  constructor(private readonly failingItemId: string) {}

  async runTurn(input: AgentTurnRequest, onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void): Promise<AgentTurnResult> {
    this.requests.push(input);
    if (itemIdFromSessionKey(input.sessionKey) === this.failingItemId) {
      throw new Error("backend queue rejected item turn");
    }
    const rawText = plainJsonOutput(baseOutput({ summary: input.sessionKey }));
    const event: AcpRuntimeEvent = { type: "text_delta", text: rawText, stream: "output" };
    await onEvent?.(event);
    return {
      handle: fakeHandle(input),
      rawText,
      events: [event],
      status: "completed"
    };
  }
}

class CancelledRuntime implements OrchestratorAgentRuntime {
  async runTurn(input: AgentTurnRequest): Promise<AgentTurnResult> {
    return {
      handle: fakeHandle(input),
      rawText: "partial cancelled text",
      events: [],
      status: "cancelled",
      stopReason: "cancelled"
    };
  }
}

class GateVerdictRuntime implements OrchestratorAgentRuntime {
  constructor(private readonly verdict: "blocked" | "failed" | "unknown") {}

  async runTurn(input: AgentTurnRequest, onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void): Promise<AgentTurnResult> {
    const rawText = plainJsonOutput(gateOutput({ status: "blocked", verdict: this.verdict }));
    const event: AcpRuntimeEvent = { type: "text_delta", text: rawText, stream: "output" };
    await onEvent?.(event);
    return {
      handle: fakeHandle(input),
      rawText,
      events: [event],
      status: "completed"
    };
  }
}

class StaticRuntime implements OrchestratorAgentRuntime {
  async runTurn(input: AgentTurnRequest, onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void): Promise<AgentTurnResult> {
    const rawText = plainJsonOutput(baseOutput({ summary: input.sessionKey }));
    const event: AcpRuntimeEvent = { type: "text_delta", text: rawText, stream: "output" };
    await onEvent?.(event);
    return {
      handle: fakeHandle(input),
      rawText,
      events: [event],
      status: "completed"
    };
  }
}

class DelayedFanoutRuntime implements OrchestratorAgentRuntime {
  readonly requests: AgentTurnRequest[] = [];
  onStart?: (itemId: string) => Promise<void> | void;
  private active = 0;
  maxActive = 0;
  private readonly failingItems: Set<string>;

  constructor(private readonly delays: Record<string, number>, failingItems: string[] = []) {
    this.failingItems = new Set(failingItems);
  }

  async runTurn(input: AgentTurnRequest, onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void): Promise<AgentTurnResult> {
    this.requests.push(input);
    const itemId = itemIdFromSessionKey(input.sessionKey);
    await this.onStart?.(itemId);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await sleep(this.delays[itemId] ?? 1);
      if (this.failingItems.has(itemId)) throw new Error(`failed ${itemId}`);
      const rawText = plainJsonOutput(baseOutput({ summary: input.sessionKey }));
      const event: AcpRuntimeEvent = { type: "text_delta", text: rawText, stream: "output" };
      await onEvent?.(event);
      return {
        handle: fakeHandle(input),
        rawText,
        events: [event],
        status: "completed"
      };
    } finally {
      this.active -= 1;
    }
  }
}

function itemIdFromSessionKey(sessionKey: string): string {
  return (sessionKey.split(":item:").at(-1) ?? sessionKey).split(":group:")[0];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeHandle(input: AgentTurnRequest): AcpRuntimeHandle {
  return {
    sessionKey: input.sessionKey,
    backend: "fake",
    runtimeSessionName: input.sessionKey,
    cwd: input.cwd,
    acpxRecordId: `record-${input.sessionKey}`,
    backendSessionId: `backend-${input.sessionKey}`,
    agentSessionId: `agent-${input.sessionKey}`
  };
}
