import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AcpRuntimeEvent, AcpRuntimeHandle } from "acpx/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunDiagnosticsView, RunDiagnosticCodes } from "../../src/projections/run-diagnostics.js";
import { buildRunMonitorView } from "../../src/projections/run-monitor.js";
import { runDir } from "../../src/run-index/paths.js";
import { appendEvent, readRunIndex, RuntimeErrorCodes, writeRunIndex, type RunIndex } from "../../src/run-index/read-write.js";
import { isAcpTransportStatusText, setAgentRuntimeFactoryForTests, type AgentTurnRequest, type AgentTurnResult, type OrchestratorAgentRuntime } from "../../src/runtime/agent-runtime.js";
import { setAgentTaskRetryDelayForTests } from "../../src/runtime/agent-task-retry.js";
import { prepareRun, startPreparedRun } from "../../src/runtime/run-workflow.js";
import { syncRun } from "../../src/runtime/sync.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "../../src/schema/workflow-spec.js";
import { baseOutput, gateOutput, plainJsonOutput } from "../helpers/fake-runtime.js";

describe("fanout runtime stability", () => {
  beforeEach(() => setAgentTaskRetryDelayForTests(0));
  afterEach(() => {
    setAgentRuntimeFactoryForTests(undefined);
    setAgentTaskRetryDelayForTests(undefined);
  });

  it("identifies ACP transport retry status text without treating JSON output as status", () => {
    expect(isAcpTransportStatusText("Retrying (attempt 1/3, waiting 2s)...")).toBe(true);
    expect(isAcpTransportStatusText("Retry finished, resuming.")).toBe(true);
    expect(isAcpTransportStatusText("{\"summary\":\"Retry finished, resuming.\",\"data\":[]}")).toBe(false);
    expect(isAcpTransportStatusText("Retrying a review finding is not a transport status.")).toBe(false);
  });

  it("blocks obvious mutating program commands unless mutation is allowed", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-program-safety-"));
    const marker = path.join(cwd, "marker.txt");
    const prepared = await prepareRun(programTouchSpec(cwd, false), { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "touch_file.json"), "utf8")) as Record<string, unknown>;

    expect(index.status).toBe("blocked");
    expect(index.stages.touch_file?.blockedReason).toBe(RuntimeErrorCodes.PROGRAM_COMMAND_SAFETY_VIOLATION);
    expect(output.blockedReason).toBe(RuntimeErrorCodes.PROGRAM_COMMAND_SAFETY_VIOLATION);
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it("runs mutating program commands when mutation is explicitly allowed", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-program-mutation-"));
    const marker = path.join(cwd, "marker.txt");
    const prepared = await prepareRun(programTouchSpec(cwd, true), { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);

    expect(index.status).toBe("completed");
    await expect(fs.stat(marker)).resolves.toBeTruthy();
  });

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
      ["item-2", "blocked", RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED],
      ["item-3", "completed", undefined]
    ]);
    expect(failedOutput.blockedReason).toBe(RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED);
    expect(stage?.fanout?.completedItems).toBe(2);
    expect(stage?.fanout?.blockedItems).toBe(1);
    expect(events).toContain("fanout_pool_completed");
    expect(events).not.toContain("scheduler_batch_completed");
  });

  it("expands heterogeneous lanes into lane outputs", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-heterogeneous-fanout-"));
    const runtime = new StaticRuntime();
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpus.workflow/v1",
      name: "heterogeneous-fanout",
      root: "review",
      input: { schema: "{cwd:string,items:[{id:string,area?:string}]}" },
      stages: [
        {
          id: "review",
          kind: "fanout",
          items: { source: "input.items" },
          limits: { maxConcurrency: 3, maxFanoutItems: 2 },
          prompt: "Review one item",
          lanes: [
            { id: "pi", actor: { agent: "fake", mode: "readOnly", label: "pi" } },
            { id: "aiden", actor: { agent: "fake", mode: "readOnly", label: "aiden" } },
            { id: "claude_schema", actor: { agent: "fake", mode: "readOnly", label: "claude" }, when: { source: "item.area", op: "eq", value: "schema" } },
            { id: "pi_runtime", actor: { agent: "fake", mode: "readOnly", label: "pi" }, when: { source: "item.area", op: "eq", value: "runtime" } }
          ],
          fanin: { mode: "program", operation: "mergeArrays" }
        },
        { id: "gate", kind: "gate", mode: "program", dependsOn: ["review"] }
      ]
    });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1", area: "schema" }, { id: "item-2", area: "runtime" }] }
    });

    const index = await startPreparedRun(cwd, prepared, { drainFanoutPool: true });
    const laneOutputs = index.stages.review?.fanout?.items.flatMap((item) =>
      item.lanes.map((lane) => ({ itemId: item.id, laneId: lane.id, status: lane.status }))
    ) ?? [];

    expect(index.status).toBe("completed");
    expect(index.stages.review?.fanout?.workUnits).toBe(6);
    expect(laneOutputs.map((lane) => [lane.itemId, lane.laneId, lane.status])).toEqual([
      ["item-1", "pi", "completed"],
      ["item-1", "aiden", "completed"],
      ["item-1", "claude_schema", "completed"],
      ["item-1", "pi_runtime", "skipped"],
      ["item-2", "pi", "completed"],
      ["item-2", "aiden", "completed"],
      ["item-2", "claude_schema", "skipped"],
      ["item-2", "pi_runtime", "completed"]
    ]);
  });

  it("merges only completed lane outputs and keeps skipped lane aggregates", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-skipped-merge-"));
    const runtime = new ScriptedRuntime([
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "selected", data: [{ id: "selected" }] })) }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = fanoutLaneFilterSpec("fanout-skipped-merge", [
      { id: "selected", actor: { agent: "fake", mode: "readOnly", label: "selected" }, when: { source: "item.kind", op: "eq", value: "run" } },
      { id: "skipped", actor: { agent: "fake", mode: "readOnly", label: "skipped" }, when: { source: "item.kind", op: "eq", value: "skip" } }
    ]);
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: [{ id: "item-1", kind: "run" }] } });

    const index = await startPreparedRun(cwd, prepared, { drainFanoutPool: true });
    const faninOutput = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "fanout.json"), "utf8")) as { data?: unknown[] };
    const itemOutput = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "fanout", "item-1.json"), "utf8")) as { laneOutputs?: unknown[]; skippedLanes?: unknown[] };

    expect(index.status).toBe("completed");
    expect(faninOutput.data).toEqual([{ id: "selected" }]);
    expect(itemOutput.laneOutputs).toHaveLength(1);
    expect(itemOutput.skippedLanes).toEqual([expect.objectContaining({ laneId: "skipped", skippedReason: RuntimeErrorCodes.NO_SELECTED_LANES })]);
    expect(index.stages.fanout?.fanout).toMatchObject({ completedItems: 1, skippedItems: 0, workUnits: 1 });
    expect(index.stages.fanout?.fanout?.items[0]?.lanes.map((lane) => [lane.id, lane.status])).toEqual([["selected", "completed"], ["skipped", "skipped"]]);
  });

  it("runs program fanin with empty data when every lane is skipped", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-all-skipped-"));
    const runtime = new ScriptedRuntime([{ kind: "text", text: plainJsonOutput(baseOutput({ summary: "should not run" })) }]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = fanoutLaneFilterSpec("fanout-all-skipped", [
      { id: "missing", actor: { agent: "fake", mode: "readOnly", label: "missing" }, when: { source: "item.missing", op: "eq", value: "run" } }
    ]);
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: [{ id: "item-1", kind: "skip" }] } });

    const index = await startPreparedRun(cwd, prepared, { drainFanoutPool: true });
    const faninOutput = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "fanout.json"), "utf8")) as { status?: string; data?: unknown[] };
    const itemOutput = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "fanout", "item-1.json"), "utf8")) as { status?: string; skippedLanes?: unknown[] };

    expect(index.status).toBe("completed");
    expect(runtime.requests).toHaveLength(0);
    expect(faninOutput).toMatchObject({ status: "completed", data: [] });
    expect(itemOutput).toMatchObject({ status: "skipped", skippedLanes: [expect.objectContaining({ laneId: "missing" })] });
    expect(index.stages.fanout?.fanout).toMatchObject({ completedItems: 1, skippedItems: 1, workUnits: 0 });
  });

  it("does not resolve item-scoped stage variables while rendering top-level agent fanin", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-agent-fanin-item-scope-"));
    const runtime = new ScriptedRuntime([
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "lane", data: [{ id: "item-1" }] })) },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "fanin", data: [{ id: "deduped" }] })) }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpus.workflow/v1",
      name: "agent-fanin-item-scope",
      root: "fanout",
      input: { schema: "{cwd:string,items:[{id:string}]}" },
      limits: { stageTimeoutMinutes: 1 },
      stages: [
        {
          id: "fanout",
          kind: "fanout",
          items: { source: "input.items" },
          variables: [{ name: "sliceId", source: "item.id" }],
          prompt: "Handle ${sliceId}",
          limits: { maxConcurrency: 1, maxFanoutItems: 1 },
          lanes: [{ id: "worker", actor: { agent: "fake", mode: "readOnly", label: "worker" } }],
          fanin: {
            mode: "agent",
            actor: { agent: "fake", mode: "readOnly", label: "fanin_agent" },
            prompt: "Deduplicate ${results}",
            output: { schema: "{summary:string,data:[unknown]}" }
          },
          fanoutPolicy: { allowPartial: false }
        },
        { id: "gate", kind: "gate", mode: "program", dependsOn: ["fanout"] }
      ]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: [{ id: "item-1" }] } });

    const index = await startPreparedRun(cwd, prepared, { drainFanoutPool: true });
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "fanout.json"), "utf8")) as { summary?: string };

    expect(index.status).toBe("completed");
    expect(output.summary).toBe("fanin");
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests[0]?.prompt).toContain("Handle item-1");
    expect(runtime.requests[1]?.prompt).toContain("\"laneOutputs\"");
    expect(runtime.requests[1]?.prompt).not.toContain("VARIABLE_RESOLUTION_FAILED");
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
    expect(runtime.maxActive).toBe(2);
    expect(index.stages.fanout?.fanout?.completedItems).toBe(3);
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
      outputPath: expect.stringContaining("outputs/review_loop/round-1/body_fanout/item-1/worker.json")
    });
  });

  it("persists loop body fanout lane settlement before the whole fanout pool finishes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-fanout-realtime-settle-"));
    const runtime = new DelayedFanoutRuntime({ "item-1": 1, "item-2": 400 });
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopFanoutSpec(cwd, {
      maxConcurrency: 2,
      lanes: [{ id: "worker", actor: { agent: "fake", mode: "readOnly", label: "worker" } }]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: fanoutInputItems(2) } });

    const running = syncRun(cwd, prepared.logicalRunId, { drainFanoutPool: true });
    const settledLane = await waitForLoopFanoutLane(cwd, prepared.logicalRunId, spec, "item-1", (unit) => unit.status === "completed");
    const concurrentLane = await waitForLoopFanoutLane(cwd, prepared.logicalRunId, spec, "item-2", (unit) => unit.status === "running");
    const finalIndex = await running;

    expect(settledLane).toMatchObject({
      kind: "loopFanoutLane",
      status: "completed",
      outputPath: expect.stringContaining("outputs/quality_loop/round-1/review_items/item-1/worker.json")
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
      lanes: [{ id: "worker", actor: { agent: "fake", mode: "readOnly", label: "worker" } }]
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
    const spec = fanoutSpec(4, { allowPartial: false }, { maxConcurrency: 1 });
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
    expect(index.blockedReason).toBe(RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED);
    expect(index.stages.fanout?.blockedReason).toBe(RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED);
    expect(items.map((item) => [item.id, item.status, item.errorCode])).toEqual([
      ["item-1", "completed", undefined],
      ["item-2", "blocked", RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED],
      ["item-3", "blocked", RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED],
      ["item-4", "blocked", RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED]
    ]);
    expect(requested.sort()).toEqual(["item-1", "item-2", "item-2", "item-2"]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "fanout_pool_item_settled",
      itemId: "item-3",
      cascade: true
    }));
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED,
      stageId: "fanout",
      itemId: "item-2"
    }));
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED,
      stageId: "fanout",
      itemId: "item-3"
    }));
  });

  it("recovers a running fanout item when its lane output file already exists", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-recover-"));
    const spec = fanoutSpec(1, { allowPartial: false });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }] }
    });
    const staleStartedAt = staleRecoveryStartedAt();
    const outputPath = path.join(prepared.dir, "outputs", "fanout", "item-1", "worker.json");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(baseOutput({ summary: "already done", data: ["item-1"] }), null, 2)}\n`, "utf8");
    await writeRunIndex(cwd, {
      ...prepared.index,
      status: "running",
      attempts: {
        "fanout:item-1:worker:attempt-1": {
          id: "fanout:item-1:worker:attempt-1",
          stageId: "fanout",
          itemId: "item-1",
          laneId: "worker",
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
          attempts: ["fanout:item-1:worker:attempt-1"],
          startedAt: staleStartedAt,
          fanout: {
            totalItems: 1,
            completedItems: 0,
            blockedItems: 0,
            allowPartial: false,
            items: [{
              id: "item-1",
              index: 0,
              status: "running",
              startedAt: staleStartedAt,
              lanes: [{ id: "worker", actorLabel: "worker", status: "running", attemptId: "fanout:item-1:worker:attempt-1", startedAt: staleStartedAt }]
            }]
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
    expect(recovered.attempts["fanout:item-1:worker:attempt-1"]).toMatchObject({ status: "completed" });
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
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      runtimeDiagnostics: { errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR }
    }, null, 2)}\n`, "utf8");
    await writeRunIndex(cwd, {
      ...prepared.index,
      status: "running",
      attempts: {
        "fanout:item-1:worker:attempt-1": {
          id: "fanout:item-1:worker:attempt-1",
          stageId: "fanout",
          itemId: "item-1",
          laneId: "worker",
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
          attempts: ["fanout:item-1:worker:attempt-1"],
          startedAt: staleStartedAt,
          fanout: {
            totalItems: 1,
            completedItems: 0,
            blockedItems: 0,
            allowPartial: true,
            items: [{ id: "item-1", index: 0, status: "running", startedAt: staleStartedAt, lanes: singleLaneLanes("running", "fanout:item-1:worker:attempt-1", staleStartedAt) }]
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
    expect(recovered.attempts["fanout:item-1:worker:attempt-1"]).toMatchObject({
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
              {
                id: "item-1",
                index: 0,
                status: "running",
                startedAt: staleStartedAt,
                lanes: [{ id: "worker", actorLabel: "worker", status: "running", attemptId: "fanout:item-1:worker:attempt-1", startedAt: staleStartedAt }]
              },
              {
                id: "item-2",
                index: 1,
                status: "pending",
                lanes: [{ id: "worker", actorLabel: "worker", status: "pending" }]
              }
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
    expect(recovered.attempts["fanout:item-1:worker:attempt-1"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY
    });
    expect(recovered.attempts["fanout:item-1:worker:attempt-2"]).toMatchObject({
      status: "completed",
      retryOf: "fanout:item-1:worker:attempt-1",
      retryOrdinal: 1,
      retryReason: "stale"
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
          attempts: ["fanout:item-1:worker:attempt-1"],
          startedAt: staleStartedAt,
          fanout: {
            totalItems: 1,
            completedItems: 0,
            blockedItems: 0,
            allowPartial: true,
            items: [{ id: "item-1", index: 0, status: "running", startedAt: staleStartedAt, lanes: singleLaneLanes("running", "fanout:item-1:worker:attempt-1", staleStartedAt) }]
          }
        }
      },
      attempts: {
        "fanout:item-1:worker:attempt-1": {
          id: "fanout:item-1:worker:attempt-1",
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
      lanes: [expect.objectContaining({ attemptId: "fanout:item-1:worker:attempt-1" })]
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
          attempts: ["fanout:item-1:worker:attempt-1"],
          startedAt: staleStartedAt,
          fanout: {
            totalItems: 1,
            completedItems: 0,
            blockedItems: 0,
            allowPartial: true,
            items: [{ id: "item-1", index: 0, status: "running", startedAt: staleStartedAt, lanes: singleLaneLanes("running", "fanout:item-1:worker:attempt-1", staleStartedAt) }]
          }
        }
      },
      attempts: {
        "fanout:item-1:worker:attempt-1": {
          id: "fanout:item-1:worker:attempt-1",
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
      attemptId: "fanout:item-1:worker:attempt-1",
      event: { type: "text_delta", stream: "output", text: "still running" }
    });

    const observed = await syncRun(cwd, prepared.logicalRunId);

    expect(observed.status).toBe("running");
    expect(observed.stages.fanout?.fanout?.items[0]).toMatchObject({
      status: "running",
      lanes: [expect.objectContaining({ attemptId: "fanout:item-1:worker:attempt-1" })]
    });
    expect(observed.attempts["fanout:item-1:worker:attempt-1"]).toMatchObject({ status: "running" });
    expect(observed.attempts["fanout:item-1:worker:attempt-2"]).toBeUndefined();
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
          attempts: ["fanout:item-1:worker:attempt-1", "fanout:item-1:worker:attempt-2"],
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
              retryOf: "fanout:item-1:worker:attempt-1",
              retryOrdinal: 1,
              lanes: singleLaneLanes("running", "fanout:item-1:worker:attempt-2", staleStartedAt, {
                retryOf: "fanout:item-1:worker:attempt-1",
                retryOrdinal: 1
              })
            }]
          }
        }
      },
      attempts: {
        "fanout:item-1:worker:attempt-1": {
          id: "fanout:item-1:worker:attempt-1",
          stageId: "fanout",
          itemId: "item-1",
          kind: "attempt",
          status: "failed",
          path: path.join("attempts", "fanout", "item-item-1", "attempt-1"),
          startedAt: staleStartedAt,
          endedAt: staleStartedAt,
          runtimeErrorCode: RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY
        },
        "fanout:item-1:worker:attempt-2": {
          id: "fanout:item-1:worker:attempt-2",
          stageId: "fanout",
          itemId: "item-1",
          laneId: "worker",
          kind: "attempt",
          status: "running",
          path: path.join("attempts", "fanout", "item-item-1", "attempt-2"),
          startedAt: staleStartedAt,
          retryOf: "fanout:item-1:worker:attempt-1",
          retryOrdinal: 1
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
      blockedReason: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED,
      errorCode: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED
    });
    expect(recovered.attempts["fanout:item-1:worker:attempt-3"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.AGENT_RUNTIME_ERROR
    });
    expect(output.blockedReason).toBe(RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED);
    const events = await readEvents(prepared.dir);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent_task_retry_exhausted",
      itemId: "item-1",
      errorCode: RuntimeErrorCodes.AGENT_RUNTIME_ERROR
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "fanout_item_recovered",
      itemId: "item-1",
      errorCode: RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY
    }));
  });

  it("directly blocks scheduler-exhausted stale fanout retries with the unified retry code", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-stale-direct-exhausted-"));
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
          attempts: ["fanout:item-1:worker:attempt-1", "fanout:item-1:worker:attempt-2", "fanout:item-1:worker:attempt-3"],
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
              retryOf: "fanout:item-1:worker:attempt-2",
              retryOrdinal: 2,
              retryReason: "stale",
              lanes: singleLaneLanes("running", "fanout:item-1:worker:attempt-3", staleStartedAt, {
                retryOf: "fanout:item-1:worker:attempt-2",
                retryOrdinal: 2,
                retryReason: "stale"
              })
            }]
          }
        }
      },
      attempts: {
        "fanout:item-1:worker:attempt-1": {
          id: "fanout:item-1:worker:attempt-1",
          stageId: "fanout",
          itemId: "item-1",
          laneId: "worker",
          kind: "attempt",
          status: "failed",
          path: path.join("attempts", "fanout", "item-item-1", "attempt-1"),
          startedAt: staleStartedAt,
          endedAt: staleStartedAt,
          runtimeErrorCode: RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY
        },
        "fanout:item-1:worker:attempt-2": {
          id: "fanout:item-1:worker:attempt-2",
          stageId: "fanout",
          itemId: "item-1",
          laneId: "worker",
          kind: "attempt",
          status: "failed",
          path: path.join("attempts", "fanout", "item-item-1", "lane-worker", "attempt-2"),
          startedAt: staleStartedAt,
          endedAt: staleStartedAt,
          retryOf: "fanout:item-1:worker:attempt-1",
          retryOrdinal: 1,
          retryReason: "stale",
          runtimeErrorCode: RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY
        },
        "fanout:item-1:worker:attempt-3": {
          id: "fanout:item-1:worker:attempt-3",
          stageId: "fanout",
          itemId: "item-1",
          laneId: "worker",
          kind: "attempt",
          status: "running",
          path: path.join("attempts", "fanout", "item-item-1", "lane-worker", "attempt-3"),
          startedAt: staleStartedAt,
          requestId: "fanout:item-1:worker:attempt-3",
          retryOf: "fanout:item-1:worker:attempt-2",
          retryOrdinal: 2,
          retryReason: "stale",
          retryBudgetUsed: 2,
          retryBudgetLimit: 2
        }
      }
    });

    const recovered = await syncRun(cwd, prepared.logicalRunId);
    const item = recovered.stages.fanout?.fanout?.items[0];
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "fanout", "item-1.json"), "utf8")) as { blockedReason: string; lastFailureCode?: string };

    expect(recovered.status).toBe("completed");
    expect(item).toMatchObject({
      status: "blocked",
      blockedReason: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED,
      errorCode: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED,
      lanes: [expect.objectContaining({
        attemptId: "fanout:item-1:worker:attempt-3",
        blockedReason: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED,
        errorCode: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED
      })]
    });
    expect(output).toMatchObject({
      blockedReason: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED
    });
    expect(recovered.attempts["fanout:item-1:worker:attempt-3"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.FANOUT_ITEM_STALE_RECOVERY,
      retryReason: "stale",
      retryOrdinal: 2
    });
  });

  it("retries a transient task runtime throw once and completes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-agent-task-retry-runtime-stage-"));
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
    expect(index.attempts["task:attempt-2"]).toMatchObject({
      status: "completed",
      retryOf: "task:attempt-1",
      retryOrdinal: 1,
      retryReason: "runtime",
      retryBudgetUsed: 1,
      retryBudgetLimit: 2
    });
  });

  it("retries one transient fanout item runtime throw without surfacing an item error", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-agent-task-retry-runtime-fanout-"));
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
      retryOrdinal: 1,
      retryReason: "runtime"
    });
    expect(retriedItem?.lanes.find((lane) => lane.id === "worker")).toMatchObject({
      status: "completed",
      attemptId: "fanout:item-2:worker:attempt-2",
      retryReason: "runtime",
      retryOrdinal: 1
    });
    expect(retriedItem?.errorCode).toBeUndefined();
    expect(index.attempts["fanout:item-2:worker:attempt-1"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.AGENT_RUNTIME_ERROR
    });
    expect(index.attempts["fanout:item-2:worker:attempt-2"]).toMatchObject({
      status: "completed",
      retryOf: "fanout:item-2:worker:attempt-1"
    });
    expect(diagnostics.diagnostics).not.toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      itemId: "item-2"
    }));
  });

  it("points a running fanout lane at the active continuation attempt", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-agent-task-retry-fanout-running-pointer-"));
    let runId = "";
    let observedAttemptId: string | undefined;
    const runtime: OrchestratorAgentRuntime = {
      async runTurn(input, onEvent) {
        if (input.requestId.endsWith(":attempt-2")) {
          const index = await readRunIndex(cwd, runId);
          observedAttemptId = index.stages.fanout?.fanout?.items
            .find((item) => item.id === "item-1")?.lanes
            .find((lane) => lane.id === "worker")?.attemptId;
        }
        const rawText = input.requestId.endsWith(":attempt-1")
          ? plainJsonOutput({ unexpected: true })
          : plainJsonOutput(baseOutput({ summary: "continued", data: [] }));
        await onEvent?.({ type: "text_delta", text: rawText, stream: "output" });
        return {
          handle: fakeHandle(input),
          rawText,
          events: [{ type: "text_delta", text: rawText, stream: "output" }],
          status: "completed"
        };
      }
    };
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = fanoutSpec(1, { allowPartial: false }, { maxConcurrency: 1 });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }] }
    });
    runId = prepared.logicalRunId;

    const index = await startPreparedRun(cwd, prepared);

    expect(index.status).toBe("completed");
    expect(observedAttemptId).toBe("fanout:item-1:worker:attempt-2");
    expect(index.stages.fanout?.fanout?.items[0]?.lanes[0]).toMatchObject({
      status: "completed",
      attemptId: "fanout:item-1:worker:attempt-2",
      retryReason: "continuation",
      retryOrdinal: 1
    });
  });

  it("retries a transient loop body runtime throw and completes the loop", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-agent-task-retry-runtime-loop-"));
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
    expect(index.attempts["quality_loop:round-1__stage-review:attempt-2"]).toMatchObject({
      status: "completed",
      retryOf: "quality_loop:round-1__stage-review:attempt-1"
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
      "loop:quality_loop:round:1:stage:review:agent:reviewer",
      "loop:quality_loop:round:2:stage:review:agent:reviewer"
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
    expect(runtime.requests.map((request) => request.sessionKey)).toEqual(["loop:quality_loop:round:1:stage:review:agent:reviewer"]);
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
      "loop:quality_loop:round:1:stage:review:agent:reviewer",
      "loop:quality_loop:round:2:stage:review:agent:reviewer"
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
      lanes: [{ id: "worker", actor: { agent: "fake", mode: "readOnly", label: "worker" } }]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: fanoutInputItems(2) } });

    const index = await startPreparedRun(cwd, prepared);

    expect(index.status).toBe("completed");
    expect(runtime.maxActive).toBe(2);
    expect(runtime.requests.map((request) => request.sessionKey)).toEqual(expect.arrayContaining([
      "loop:quality_loop:round:1:stage:review_items:item:item-1:lane:worker:agent:worker",
      "loop:quality_loop:round:1:stage:review_items:item:item-2:lane:worker:agent:worker"
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
      lanes: [{ id: "worker", actor: { agent: "fake", mode: "readOnly", label: "worker" } }]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: fanoutInputItems(2) } });

    const index = await startPreparedRun(cwd, prepared);
    const items = index.stages.quality_loop?.loop?.rounds[0]?.stages.review_items.fanout?.items ?? [];
    const itemSummaries = items.map((item) => {
      const lane = item.lanes[0] as ({ output?: { summary?: string } } | undefined);
      const laneOutput = lane?.output;
      return [item.id, item.status, laneOutput?.summary];
    });

    expect(index.status).toBe("completed");
    expect(runtime.requests.map((request) => itemIdFromSessionKey(request.sessionKey)).sort()).toEqual(["item-1", "item-2"]);
    expect(itemSummaries).toEqual([
      ["item-1", "completed", expect.stringContaining("item:item-1:lane:worker")],
      ["item-2", "completed", expect.stringContaining("item:item-2:lane:worker")]
    ]);
  });

  it("runs loop body agent fanin after all fanout lanes finish", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-agent-fanin-"));
    const runtime = new ScriptedRuntime([
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "lane one", data: [{ id: "one" }] })) },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "lane two", data: [{ id: "two" }] })) },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "agent fanin", data: { needsAnotherRound: false, merged: ["one", "two"] } })) }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopFanoutSpec(cwd, {
      maxConcurrency: 2,
      fanin: {
        mode: "agent",
        actor: { agent: "fake", mode: "readOnly", label: "fanin_agent" },
        prompt: "Merge ${results}"
      },
      lanes: [{ id: "worker", actor: { agent: "fake", mode: "readOnly", label: "worker" } }]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: fanoutInputItems(2) } });

    const index = await startPreparedRun(cwd, prepared);
    const output = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "quality_loop.json"), "utf8")) as { summary?: string; data?: unknown };
    const round = index.stages.quality_loop?.loop?.rounds[0];
    const faninAttempt = index.attempts["quality_loop:round-1__fanin-review_items:attempt-1"];

    expect(index.status).toBe("completed");
    expect(runtime.requests.map((request) => request.sessionKey)).toContain("loop:quality_loop:round:1:fanin:review_items");
    expect(runtime.requests.at(-1)?.prompt).toContain("\"laneOutputs\"");
    expect(runtime.requests.at(-1)?.prompt).toContain("\"skippedItems\"");
    expect(faninAttempt).toMatchObject({
      status: "completed",
      itemId: "round-1__fanin-review_items",
      sessionKey: "loop:quality_loop:round:1:fanin:review_items"
    });
    expect(round?.bodyOutput).toMatchObject({
      summary: "agent fanin",
      data: { needsAnotherRound: false, merged: ["one", "two"] }
    });
    expect(output).toMatchObject({ summary: "agent fanin" });
  });

  it("aggregates same-item loop body fanout lanes after concurrent execution", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-fanout-lanes-"));
    const runtime = new DelayedFanoutRuntime({ "item-1": 10 });
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopFanoutSpec(cwd, {
      maxConcurrency: 2,
      lanes: [
        { id: "static", actor: { agent: "fake", mode: "readOnly", label: "worker" } },
        { id: "semantic", actor: { agent: "fake", mode: "readOnly", label: "worker" } }
      ]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: fanoutInputItems(1) } });

    const index = await startPreparedRun(cwd, prepared);
    const lanes = index.stages.quality_loop?.loop?.rounds[0]?.stages.review_items.fanout?.items[0]?.lanes;

    expect(index.status).toBe("completed");
    expect(runtime.maxActive).toBe(2);
    expect(lanes?.map((lane) => {
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
      lanes: [{ id: "worker", actor: { agent: "fake", mode: "readOnly", label: "worker" } }],
      allowPartial: false
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: fanoutInputItems(4) } });

    const index = await startPreparedRun(cwd, prepared);
    const fanout = index.stages.quality_loop?.loop?.rounds[0]?.stages.review_items.fanout;
    const requested = runtime.requests.map((request) => itemIdFromSessionKey(request.sessionKey)).sort();

    expect(index.status).toBe("blocked");
    expect(requested).toEqual(["item-1", "item-2", "item-2", "item-2"]);
    expect(fanout?.items.map((item) => [item.id, item.status, item.errorCode])).toEqual([
      ["item-1", "completed", undefined],
      ["item-2", "blocked", RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED],
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

  it("runs every loop body fanout lane whose condition is true", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-fanout-multi-match-"));
    const runtime = new StaticRuntime();
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopFanoutSpec(cwd, {
      lanes: [
        { id: "a", actor: { agent: "fake", mode: "readOnly", label: "worker" }, when: { source: "item.kind", op: "eq", value: "both" } },
        { id: "b", actor: { agent: "fake", mode: "readOnly", label: "worker" }, when: { source: "item.kind", op: "eq", value: "both" } }
      ]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: [{ id: "item-1", kind: "both" }] } });

    const index = await startPreparedRun(cwd, prepared);
    const lanes = index.stages.quality_loop?.loop?.rounds[0]?.stages.review_items.fanout?.items[0]?.lanes;

    expect(index.status).toBe("completed");
    expect(lanes?.map((lane) => [lane.id, lane.status])).toEqual([["a", "completed"], ["b", "completed"]]);
  });

  it("skips loop body fanout items with no matching lanes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-loop-fanout-skipped-"));
    const runtime = new StaticRuntime();
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = loopFanoutSpec(cwd, {
      lanes: [{ id: "worker", actor: { agent: "fake", mode: "readOnly", label: "worker" }, when: { source: "item.kind", op: "eq", value: "run" } }]
    });
    const prepared = await prepareRun(spec, { cwd, input: { cwd, items: [{ id: "item-1", kind: "skip" }] } });

    const index = await startPreparedRun(cwd, prepared);
    expect(index.status).toBe("completed");
    expect(index.stages.quality_loop?.loop?.rounds[0]?.stages.review_items.fanout?.items[0]?.skippedReason).toBe(RuntimeErrorCodes.NO_SELECTED_LANES);
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

  it("retries a transient continuation runtime throw and completes from continuation output", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-agent-task-retry-continuation-"));
    const runtime = new ScriptedRuntime([
      { kind: "text", text: plainJsonOutput({ status: "completed" }) },
      { kind: "throw", message: "queue rejected continuation turn" },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "continued" })) }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = simpleTaskSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);

    expect(index.status).toBe("completed");
    expect(index.agentUsage.actual).toBe(3);
    expect(index.agentUsage.retryCalls).toBe(2);
    expect(index.agentUsage.retries.continuation).toBe(1);
    expect(index.agentUsage.retries.runtime).toBe(1);
    expect(index.attempts["task:attempt-2"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.AGENT_RUNTIME_ERROR,
      retryReason: "continuation",
      retryOf: "task:attempt-1"
    });
    expect(index.attempts["task:attempt-3"]).toMatchObject({
      status: "completed",
      retryReason: "runtime",
      retryOf: "task:attempt-2"
    });
  });

  it("retries failed retryable turns but not non-retryable failed turns", async () => {
    const retryCwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-agent-task-retry-failed-turn-"));
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
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-agent-task-retry-exhausted-"));
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
    expect(index.stages.task?.blockedReason).toBe(RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED);
    expect(index.attempts["task:attempt-2"]).toMatchObject({
      status: "failed",
      retryOf: "task:attempt-1",
      retryOrdinal: 1
    });
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED,
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
    expect(recovered.attempts["task:attempt-2"]).toMatchObject({
      status: "completed",
      retryOf: "task:attempt-1",
      retryReason: "stale",
      retryOrdinal: 1
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
          attempts: ["task:attempt-1", "task:attempt-2", "task:attempt-3"],
          startedAt: staleStartedAt,
          retryOf: "task:attempt-2",
          retryOrdinal: 2
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
        "task:attempt-2": {
          id: "task:attempt-2",
          stageId: "task",
          kind: "attempt",
          status: "failed",
          path: path.join("attempts", "task", "attempt-2"),
          startedAt: staleStartedAt,
          endedAt: staleStartedAt,
          requestId: "task:attempt-2",
          retryOf: "task:attempt-1",
          retryOrdinal: 1,
          runtimeErrorCode: RuntimeErrorCodes.AGENT_STAGE_STALE_RECOVERY
        },
        "task:attempt-3": {
          id: "task:attempt-3",
          stageId: "task",
          kind: "attempt",
          status: "running",
          path: path.join("attempts", "task", "attempt-3"),
          startedAt: staleStartedAt,
          requestId: "task:attempt-3",
          retryOf: "task:attempt-2",
          retryOrdinal: 2
        }
      }
    });

    const exhausted = await syncRun(exhaustedCwd, exhaustedPrepared.logicalRunId);
    const exhaustedOutput = JSON.parse(await fs.readFile(path.join(exhaustedPrepared.dir, "outputs", "task.json"), "utf8")) as { blockedReason: string; lastFailureCode?: string };
    const reconciledAgain = await syncRun(exhaustedCwd, exhaustedPrepared.logicalRunId);

    expect(exhausted.status).toBe("blocked");
    expect(exhausted.stages.task?.blockedReason).toBe(RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED);
    expect(exhaustedOutput).toMatchObject({
      blockedReason: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED,
      lastFailureCode: RuntimeErrorCodes.AGENT_STAGE_STALE_RECOVERY
    });
    expect(reconciledAgain.stages.task?.blockedReason).toBe(RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED);
    expect(exhausted.attempts["task:attempt-3"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.AGENT_STAGE_STALE_RECOVERY,
      retryReason: "stale",
      retryOrdinal: 2,
      retryBudgetUsed: 2,
      retryBudgetLimit: 2
    });
  });

  it("preserves cancelled turn diagnostics in output and attempt index", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cancelled-turn-"));
    setAgentRuntimeFactoryForTests(() => new CancelledRuntime());
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpus.workflow/v1",
      name: "cancelled-turn",
      root: "task",
      input: { schema: "{cwd:string}", default: { cwd } },
      limits: { stageTimeoutMinutes: 1 },
      stages: [{ id: "task", kind: "task", mode: "agent", actor: { agent: "fake", mode: "readOnly", label: "worker" }, prompt: "Do work" }]
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
      sessionKey: "agent:worker",
      agent: "fake",
      actorMode: "readOnly",
      runtimeDisposeInvoked: false,
      rawTextPreview: "partial cancelled text"
    });
    expect(attempt).toMatchObject({
      stopReason: "cancelled",
      requestId: "task:attempt-1",
      sessionKey: "agent:worker",
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
      errorCode: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED,
      blockedReason: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED
    });
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED,
      stageId: "fanout",
      itemId: "item-2"
    }));
  });

  it("reports a fanout stage stuck running with queued items", async () => {
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
              { id: "item-1", index: 0, status: "completed", completedAt: new Date().toISOString(), lanes: singleLaneLanes("completed") },
              { id: "item-2", index: 1, status: "pending", lanes: singleLaneLanes("pending") }
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
    for (const itemCode of [RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED, RuntimeErrorCodes.FANOUT_ITEM_CASCADE_BLOCKED]) {
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
                completedAt: new Date().toISOString(),
                lanes: singleLaneLanes("blocked", undefined, undefined, { blockedReason: itemCode, errorCode: itemCode })
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
    expect(resumed.stages.fanout?.blockedReason).toBe(RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED);
    expect(resumed.stages.fanout?.fanout).toMatchObject({
      completedItems: 2,
      blockedItems: 1,
      allowPartial: true
    });
  });

  it("blocks fanout aggregation when a blocked retry-exhausted item has no output artifact", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-missing-output-"));
    const spec = fanoutSpec(2, { allowPartial: false });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: fanoutInputItems(2) }
    });
    const firstOutputPath = path.join(prepared.dir, "outputs", "fanout", "item-1", "worker.json");
    await fs.mkdir(path.dirname(firstOutputPath), { recursive: true });
    await fs.writeFile(firstOutputPath, `${JSON.stringify({ status: "completed", ...baseOutput({ summary: "done" }) }, null, 2)}\n`, "utf8");
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
              { id: "item-1", index: 0, status: "completed", outputPath: path.join("outputs", "fanout", "item-1.json"), completedAt: new Date().toISOString(), lanes: singleLaneLanes("completed") },
              {
                id: "item-2",
                index: 1,
                status: "blocked",
                completedAt: new Date().toISOString(),
                blockedReason: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED,
                errorCode: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED,
                lanes: singleLaneLanes("blocked", undefined, undefined, {
                  blockedReason: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED,
                  errorCode: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED
                })
              }
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
    expect(aggregated.blockedReason).toBe(RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED);
    expect(aggregated.stages.fanout?.blockedReason).toBe(RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED);
    expect(aggregate.blockedItems).toContainEqual(expect.objectContaining({
      blockedReason: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED
    }));
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.AGENT_TASK_RETRY_EXHAUSTED
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
              { id: "item-1", index: 0, status: "pending", lanes: singleLaneLanes("pending") },
              { id: "item-2", index: 1, status: "running", startedAt, lanes: singleLaneLanes("running", "fanout:item-2:worker:attempt-1", startedAt) },
              { id: "item-3", index: 2, status: "pending", lanes: singleLaneLanes("pending") }
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
        retryCalls: 2
      }
    });

    const persisted = await readRunIndex(cwd, prepared.logicalRunId);
    expect(persisted.agentUsage.retryCalls).toBe(2);
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
    input: { schema: "{cwd:string,items:[{id:string,path?:string,area?:string,kind?:string}]}" },
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
      lanes: [{ id: "worker", actor: { agent: "fake", mode: "readOnly", label: "worker" } }],
      fanin: { mode: "program", operation: "mergeArrays" },
      fanoutPolicy: policy
    }]
  });
}

function fanoutLaneFilterSpec(name: string, lanes: Array<{
  id: string;
  actor: { agent: string; mode: "denyAll" | "readOnly" | "edit"; label?: string };
  when?: { source: string; op: "eq"; value: unknown };
}>): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name,
    root: "fanout",
    input: { schema: "{cwd:string,items:[{id:string,path?:string,area?:string,kind?:string}]}" },
    limits: { stageTimeoutMinutes: 1 },
    stages: [{
      id: "fanout",
      kind: "fanout",
      items: { source: "input.items" },
      limits: { maxConcurrency: 2, maxFanoutItems: 10 },
      prompt: "Handle one item",
      lanes,
      fanin: { mode: "program", operation: "mergeArrays" },
      fanoutPolicy: { allowPartial: false }
    }]
  });
}

function fanoutInputItems(count: number): Array<{ id: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: `item-${index + 1}` }));
}

function singleLaneLanes(
  status: RunIndex["stages"][string]["status"],
  attemptId?: string,
  startedAt?: string,
  extra: Record<string, unknown> = {}
): NonNullable<NonNullable<RunIndex["stages"][string]["fanout"]>["items"][number]["lanes"]> {
  return [{
    id: "worker",
    actorLabel: "worker",
    status,
    attemptId,
    startedAt,
    ...extra
  }];
}

function loopFanoutRealtimeSpec(): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "loop-fanout-realtime",
    root: "review_loop",
    input: { schema: "{cwd:string,items:[{id:string,path?:string,area?:string,kind?:string}]}" },
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
          lanes: [{ id: "worker", actor: { agent: "fake", mode: "readOnly", label: "worker" } }],
          fanin: { mode: "program", operation: "mergeArrays" },
          fanoutPolicy: { allowPartial: false }
        }]
      },
      continueWhen: { source: "loop.round", op: "eq", value: 0 },
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
    input: { schema: "{cwd:string}", default: { cwd } },
    limits: { stageTimeoutMinutes: 1 },
    stages: [{ id: "gate", kind: "gate", mode: "agent", actor: { agent: "fake", mode: "readOnly", label: "gater" }, prompt: "Gate" }]
  });
}

function usageAccountingSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "agent-usage-not-budget",
    root: "plan",
    input: { schema: "{cwd:string}", default: { cwd } },
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      { id: "plan", kind: "task", mode: "agent", actor: { agent: "fake", mode: "readOnly", label: "worker" }, prompt: "Plan" },
      { id: "validate", kind: "task", mode: "agent", actor: { agent: "fake", mode: "readOnly", label: "worker" }, dependsOn: ["plan"], prompt: "Validate" }
    ]
  });
}

function simpleTaskSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "simple-task",
    root: "task",
    input: { schema: "{cwd:string}", default: { cwd } },
    limits: { stageTimeoutMinutes: 1 },
    stages: [{ id: "task", kind: "task", mode: "agent", actor: { agent: "fake", mode: "readOnly", label: "worker" }, prompt: "Do work" }]
  });
}

function programTouchSpec(cwd: string, allowMutation: boolean): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "program-touch",
    root: "touch_file",
    input: { schema: "{cwd:string}", default: { cwd } },
    limits: { stageTimeoutMinutes: 1 },
    stages: [
      {
        id: "touch_file",
        kind: "task",
        mode: "program",
        operation: "command",
        command: "touch",
        args: ["marker.txt"],
        allowMutation
      },
      { id: "gate", kind: "gate", mode: "program", dependsOn: ["touch_file"] }
    ]
  });
}

function loopOnlySpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "loop-only",
    root: "quality_loop",
    input: { schema: "{cwd:string}", default: { cwd } },
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
          kind: "task", mode: "agent", actor: { agent: "fake", mode: "readOnly", label: "reviewer" },
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
    input: { schema: "{cwd:string}", default: { cwd } },
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
          kind: "task", mode: "agent", actor: { agent: "fake", mode: "readOnly", label: "reviewer" },
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
    input: { schema: "{cwd:string}", default: { cwd } },
    limits: { stageTimeoutMinutes: 1 },
    stages: [{
      id: "task",
      kind: "task", mode: "agent", actor: { agent: "fake", mode: "readOnly", label: "worker" },
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
    input: { schema: "{cwd:string}", default: { cwd } },
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
          kind: "task", mode: "agent", actor: { agent: "fake", mode: "readOnly", label: "reviewer" },
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
    input: { schema: "{cwd:string,items:[{id:string,path?:string,area?:string,kind?:string}]}", default: { cwd } },
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
          lanes: [{ id: "worker", actor: { agent: "fake", mode: "readOnly", label: "worker" } }],
          fanin: { mode: "program", operation: "mergeArrays" },
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
  lanes: Array<{
    id: string;
    actor: { agent: string; mode: "denyAll" | "readOnly" | "edit"; label?: string };
    when?: { source: string; op: "eq"; value: unknown };
  }>;
  allowPartial?: boolean;
  fanin?: {
    mode: "agent";
    actor: { agent: string; mode: "denyAll" | "readOnly" | "edit"; label?: string };
    prompt: string;
  };
}): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpus.workflow/v1",
    name: "loop-fanout",
    root: "quality_loop",
    input: { schema: "{cwd:string,items:[{id:string,path?:string,area?:string,kind?:string}]}", default: { cwd } },
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
          lanes: options.lanes,
          fanin: options.fanin ?? { mode: "program", operation: "mergeArrays" },
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
    input: { schema: "{cwd:string}", default: { cwd } },
    limits: { stageTimeoutMinutes: 1 },
    stages: [{
      id: "quality_loop",
      kind: "loop",
      maxRounds: 1,
      body: {
        root: "review",
        output: "review",
        stages: [
          { id: "review", kind: "task", mode: "agent", actor: { agent: "fake", mode: "readOnly", label: "reviewer" }, prompt: "Review" },
          {
            id: "after",
            kind: "task", mode: "agent", actor: { agent: "fake", mode: "readOnly", label: "reviewer" },
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
    const rawText = plainJsonOutput(gateOutput({ verdict: this.verdict }));
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
  return (sessionKey.split(":item:").at(-1) ?? sessionKey).split(":lane:")[0];
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
