import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AcpRuntimeEvent, AcpRuntimeHandle } from "acpx/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { buildRunReportView, ReportDiagnosticCodes } from "../../src/projections/run-report.js";
import { runDir } from "../../src/run-index/paths.js";
import { appendEvent, readRunIndex, RuntimeErrorCodes, writeRunIndex, type RunIndex } from "../../src/run-index/read-write.js";
import { setAgentRuntimeFactoryForTests, type AgentTurnRequest, type AgentTurnResult, type OrchestratorAgentRuntime } from "../../src/runtime/agent-runtime.js";
import { startDiagnosticRun } from "../../src/runtime/diagnose-run.js";
import { prepareRun, startPreparedRun } from "../../src/runtime/run-workflow.js";
import { syncRun } from "../../src/runtime/sync.js";
import { WorkflowSpecSchema, type WorkflowSpec } from "../../src/schema/workflow-spec.js";
import { baseOutput, summarizeOutput, validationOutput, plainJsonOutput } from "../helpers/fake-runtime.js";

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
    const failedOutput = JSON.parse(await fs.readFile(path.join(prepared.dir, "outputs", "fanout", "item-2.json"), "utf8")) as { blockedReason: string };
    const events = await fs.readFile(path.join(prepared.dir, "events.ndjson"), "utf8");

    expect(index.status).toBe("blocked");
    expect(itemStatuses).toEqual([
      ["item-1", "completed", undefined],
      ["item-2", "blocked", RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR],
      ["item-3", "completed", undefined]
    ]);
    expect(failedOutput.blockedReason).toBe(RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR);
    expect(stage?.fanout?.completedItems).toBe(2);
    expect(stage?.fanout?.blockedItems).toBe(1);
    expect(events).toContain("scheduler_batch_completed");
  });

  it("continues batched fanout after the first concurrency window completes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-batches-"));
    setAgentRuntimeFactoryForTests(() => new StaticRuntime());
    const spec = fanoutSpec(20, { allowPartial: false }, { maxAgents: 20, maxConcurrency: 10 });
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
    expect(await schedulerBatchStartedCount(prepared.dir)).toBeGreaterThanOrEqual(2);
    expect(hasStuckFanoutPendingBatch(secondTick)).toBe(false);
  });

  it("continues queued fanout items after a partial item runtime error", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-partial-batches-"));
    setAgentRuntimeFactoryForTests(() => new SelectiveFanoutRuntime("item-2"));
    const spec = fanoutSpec(20, { allowPartial: true }, { maxAgents: 21, maxConcurrency: 10 });
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
    expect(await schedulerBatchStartedCount(prepared.dir)).toBeGreaterThanOrEqual(2);
    expect(hasStuckFanoutPendingBatch(secondTick)).toBe(false);
  });

  it("recovers a running fanout item when its output file already exists", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-recover-"));
    const spec = fanoutSpec(1, { allowPartial: false });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }] }
    });
    const staleStartedAt = new Date(Date.now() - 60_000).toISOString();
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

    const recovered = await syncRun(cwd, prepared.logicalRunId, { startPending: false });
    const item = recovered.stages.fanout?.fanout?.items[0];

    expect(recovered.status).toBe("completed");
    expect(item).toMatchObject({
      id: "item-1",
      status: "completed",
      outputPath: path.join("outputs", "fanout", "item-1.json")
    });
    expect(recovered.attempts["fanout:item-1:attempt-1"]).toMatchObject({ status: "completed" });
    const report = await buildRunReportView(cwd, spec, recovered, { mode: "snapshot" });
    expect(report.metrics.attemptsRunning).toBe(0);
    await expect(fs.stat(path.join(prepared.dir, "outputs", "fanout.json"))).resolves.toBeTruthy();
  });

  it("cleans up a running fanout attempt when recovered output is blocked", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-recover-blocked-"));
    const spec = fanoutSpec(1, { allowPartial: true });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }] }
    });
    const staleStartedAt = new Date(Date.now() - 60_000).toISOString();
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

    const recovered = await syncRun(cwd, prepared.logicalRunId, { startPending: false });
    const report = await buildRunReportView(cwd, spec, recovered, { mode: "snapshot" });

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
    expect(report.metrics.attemptsRunning).toBe(0);
  });

  it("recovers a stale running fanout item and continues queued work", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-stale-queued-"));
    setAgentRuntimeFactoryForTests(() => new StaticRuntime());
    const spec = fanoutSpec(2, { allowPartial: true }, { maxAgents: 2, maxConcurrency: 1 });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: fanoutInputItems(2) }
    });
    const staleStartedAt = new Date(Date.now() - 60_000).toISOString();
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
      status: "completed",
      runtimeRetryOf: "fanout:item-1:attempt-1",
      runtimeRetryOrdinal: 1
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
      runtimeErrorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR
    });
    expect(recovered.attempts["fanout:item-1:attempt-1-runtime-retry-1"]).toMatchObject({
      status: "completed",
      runtimeRetryOf: "fanout:item-1:attempt-1",
      runtimeRetryOrdinal: 1
    });
    expect(hasStuckFanoutPendingBatch(recovered)).toBe(false);
  });

  it("continues a legacy fanout stage stuck running with queued items", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-legacy-stuck-"));
    setAgentRuntimeFactoryForTests(() => new StaticRuntime());
    const spec = fanoutSpec(2, { allowPartial: false }, { maxAgents: 2, maxConcurrency: 1 });
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
    expect(await schedulerBatchStartedCount(prepared.dir)).toBe(1);
    expect(hasStuckFanoutPendingBatch(synced)).toBe(false);
  });

  it("retries a transient agentTask runtime throw once and completes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-retry-stage-"));
    const runtime = new ScriptedRuntime([
      { kind: "throw", message: "transport reset while starting agent" },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "retried" })) }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = simpleTaskSpec(cwd, { maxAgents: 2 });
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
    const spec = fanoutSpec(2, { allowPartial: false }, { maxAgents: 3, maxConcurrency: 2 });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }, { id: "item-2" }] }
    });

    const index = await startPreparedRun(cwd, prepared);
    const report = await buildRunReportView(cwd, spec, index, { mode: "snapshot" });

    expect(index.status).toBe("completed");
    const retriedItem = index.stages.fanout?.fanout?.items.find((item) => item.id === "item-2");
    expect(retriedItem).toMatchObject({
      status: "completed",
      runtimeRetryOrdinal: 1
    });
    expect(retriedItem?.errorCode).toBeUndefined();
    expect(index.attempts["fanout:item-2:attempt-1"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.AGENT_RUNTIME_ERROR
    });
    expect(index.attempts["fanout:item-2:attempt-1-runtime-retry-1"]).toMatchObject({
      status: "completed",
      runtimeRetryOf: "fanout:item-2:attempt-1"
    });
    expect(report.diagnostics).not.toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      itemId: "item-2"
    }));
  });

  it("retries a transient fixLoop validator runtime throw and continues the loop", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-retry-fixloop-"));
    const runtime = new ScriptedRuntime([
      { kind: "throw", message: "agent process failed to start" },
      { kind: "text", text: plainJsonOutput(validationOutput({ verdict: "pass", summary: "passed" })) }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = fixLoopOnlySpec(cwd, { maxAgents: 3 });
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);

    expect(index.status).toBe("completed");
    expect(index.attempts["quality_loop:attempt-1"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.AGENT_RUNTIME_ERROR
    });
    expect(index.attempts["quality_loop:attempt-1-runtime-retry-1"]).toMatchObject({
      status: "completed",
      runtimeRetryOf: "quality_loop:attempt-1"
    });
  });

  it("retries a transient repair runtime throw and completes from repaired output", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-retry-repair-"));
    const runtime = new ScriptedRuntime([
      { kind: "text", text: plainJsonOutput({ status: "completed" }) },
      { kind: "throw", message: "queue rejected repair turn" },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "repaired" })) }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = simpleTaskSpec(cwd, { maxAgents: 3 });
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
    const retrySpec = simpleTaskSpec(retryCwd, { maxAgents: 2 });
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
    const blockedSpec = simpleTaskSpec(blockedCwd, { maxAgents: 2 });
    const blockedPrepared = await prepareRun(blockedSpec, { cwd: blockedCwd, input: { cwd: blockedCwd } });

    const blocked = await startPreparedRun(blockedCwd, blockedPrepared);

    expect(blocked.status).toBe("blocked");
    expect(blocked.stages.task?.blockedReason).toBe("AGENT_TURN_FAILED");
    expect(blockedRuntime.requests).toHaveLength(1);
  });

  it("blocks non-fanout stages with AGENT_RUNTIME_ERROR after retry exhaustion", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-retry-exhausted-"));
    const runtime = new ScriptedRuntime([
      { kind: "throw", message: "transport reset" },
      { kind: "throw", message: "transport reset again" }
    ]);
    setAgentRuntimeFactoryForTests(() => runtime);
    const spec = simpleTaskSpec(cwd, { maxAgents: 2 });
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);
    const report = await buildRunReportView(cwd, spec, index, { mode: "snapshot" });

    expect(index.status).toBe("blocked");
    expect(index.stages.task?.blockedReason).toBe(RuntimeErrorCodes.AGENT_RUNTIME_ERROR);
    expect(index.attempts["task:attempt-1-runtime-retry-1"]).toMatchObject({
      status: "failed",
      runtimeRetryOf: "task:attempt-1",
      runtimeRetryOrdinal: 1
    });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.AGENT_RUNTIME_ERROR,
      stageId: "task"
    }));
  });

  it("retries stale non-fanout running stages and blocks after stale retry exhaustion", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-runtime-stale-stage-"));
    setAgentRuntimeFactoryForTests(() => new StaticRuntime());
    const spec = simpleTaskSpec(cwd, { maxAgents: 2 });
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });
    const staleStartedAt = new Date(Date.now() - 60_000).toISOString();
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
      runtimeErrorCode: RuntimeErrorCodes.AGENT_RUNTIME_ERROR
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
          runtimeErrorCode: RuntimeErrorCodes.AGENT_RUNTIME_ERROR
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

    const exhausted = await syncRun(exhaustedCwd, exhaustedPrepared.logicalRunId, { startPending: false });

    expect(exhausted.status).toBe("blocked");
    expect(exhausted.stages.task?.blockedReason).toBe(RuntimeErrorCodes.AGENT_RUNTIME_ERROR);
    expect(exhausted.attempts["task:attempt-1-runtime-retry-1"]).toMatchObject({
      status: "failed",
      runtimeErrorCode: RuntimeErrorCodes.AGENT_RUNTIME_ERROR
    });
  });

  it("preserves cancelled turn diagnostics in output and attempt index", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cancelled-turn-"));
    setAgentRuntimeFactoryForTests(() => new CancelledRuntime());
    const spec = WorkflowSpecSchema.parse({
      schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
      name: "cancelled-turn",
      root: "task",
      inputs: { cwd: { type: "path", default: cwd } },
      roles: { worker: { category: "coordination", agent: "fake", mode: "readOnly" } },
      limits: { maxAgents: 1, maxConcurrency: 1, maxFanoutItems: 1, maxFixRounds: 0, stageTimeoutMinutes: 1 },
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
      runtimeErrorCode: "AGENT_TURN_CANCELLED"
    });
  });

  it("surfaces item runtime errors in detailed report diagnostics", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-report-"));
    setAgentRuntimeFactoryForTests(() => new SelectiveFanoutRuntime("item-2"));
    const spec = fanoutSpec(2, { allowPartial: false });
    const prepared = await prepareRun(spec, {
      cwd,
      input: { cwd, items: [{ id: "item-1" }, { id: "item-2" }] }
    });
    const index = await startPreparedRun(cwd, prepared);

    const report = await buildRunReportView(cwd, spec, index, { mode: "snapshot" });
    const fanout = report.stages.find((stage) => stage.id === "fanout")?.fanout;

    expect(fanout?.items.find((item) => item.id === "item-2")).toMatchObject({
      status: "blocked",
      errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      blockedReason: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR
    });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
      stageId: "fanout",
      itemId: "item-2"
    }));
  });

  it("diagnoses a fanout stage stuck running with queued items", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fanout-stuck-report-"));
    const spec = fanoutSpec(2, { allowPartial: false }, { maxAgents: 2, maxConcurrency: 1 });
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

    const report = await buildRunReportView(cwd, spec, stuckIndex, { mode: "snapshot" });

    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.FANOUT_STAGE_STUCK_PENDING_BATCH,
      stageId: "fanout",
      itemId: undefined,
      summary: expect.stringContaining("queued item")
    }));
  });

  it("records a run-level blocked reason when the final verdict is unknown", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-final-verdict-"));
    setAgentRuntimeFactoryForTests(() => new FinalVerdictRuntime("unknown"));
    const spec = summarizeSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);
    const report = await buildRunReportView(cwd, spec, index, { mode: "snapshot" });

    expect(index.status).toBe("blocked");
    expect(index.blockedReason).toBe(RuntimeErrorCodes.FINAL_VERDICT_UNKNOWN);
    expect(report.run.blockedReason).toBe(RuntimeErrorCodes.FINAL_VERDICT_UNKNOWN);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.FINAL_VERDICT_UNKNOWN,
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
    const index: RunIndex = {
      ...prepared.index,
      status: "blocked",
      finalVerdict: "blocked",
      blockedReason: RuntimeErrorCodes.FINAL_VERDICT_BLOCKED,
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
              blockedReason: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
              errorCode: RuntimeErrorCodes.FANOUT_ITEM_RUNTIME_ERROR,
              completedAt: new Date().toISOString()
            }]
          }
        }
      }
    };

    const report = await buildRunReportView(cwd, spec, index, { mode: "snapshot" });

    expect(report.run.status).toBe("blocked");
    expect(report.run.blockedReason).toBe(RuntimeErrorCodes.FINAL_VERDICT_BLOCKED);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: ReportDiagnosticCodes.SCHEDULER_RECOVERY_SUCCEEDED_WITH_BLOCKED_VERDICT,
      status: "completed",
      summary: expect.stringContaining("Scheduler recovery completed")
    }));
  });

  it("reports output maxOutputChars diagnostics and includes them in diagnose prompts", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-output-size-diagnostics-"));
    const oversized = `${"x".repeat(32)} ${plainJsonOutput(baseOutput({ summary: "too long" }))}`;
    setAgentRuntimeFactoryForTests(() => new ScriptedRuntime([
      { kind: "text", text: oversized },
      { kind: "text", text: plainJsonOutput(baseOutput({ summary: "repair still too long" })) }
    ]));
    const spec = maxOutputSpec(cwd, 10);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const index = await startPreparedRun(cwd, prepared);
    const report = await buildRunReportView(cwd, spec, index, { mode: "snapshot" });
    await startDiagnosticRun(cwd, prepared.logicalRunId);
    const prompt = await fs.readFile(path.join(prepared.dir, "prompts", "diagnostic-1.md"), "utf8");

    const diagnostic = report.diagnostics.find((entry) => entry.code === ReportDiagnosticCodes.OUTPUT_MAX_CHARS_EXCEEDED);
    expect(index.status).toBe("blocked");
    expect(diagnostic).toMatchObject({
      stageId: "task",
      code: ReportDiagnosticCodes.OUTPUT_MAX_CHARS_EXCEEDED,
      raw: {
        effectiveMaxOutputChars: 10,
        attempts: expect.arrayContaining([
          expect.objectContaining({ id: "task:attempt-1", kind: "attempt", rawChars: oversized.length })
        ])
      }
    });
    expect(prompt).toContain("Output size diagnostics:");
    expect(prompt).toContain("maxOutputChars=10");
    expect(prompt).toContain(`rawChars=${oversized.length}`);
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
      stages: {
        ...blocked.stages,
        fanout: {
          ...blocked.stages.fanout,
          status: "running",
          blockedReason: undefined,
          completedAt: undefined
        }
      }
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

  it("terminates ready work as blocked when the agent budget is exhausted", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-agent-budget-"));
    setAgentRuntimeFactoryForTests(() => new StaticRuntime());
    const spec = budgetSpec(cwd);
    const prepared = await prepareRun(spec, { cwd, input: { cwd } });

    const firstTick = await startPreparedRun(cwd, prepared);
    const secondTick = await syncRun(cwd, prepared.logicalRunId);
    const report = await buildRunReportView(cwd, spec, secondTick, { mode: "snapshot" });

    expect(firstTick.status).toBe("running");
    expect(secondTick.status).toBe("blocked");
    expect(secondTick.blockedReason).toBe(RuntimeErrorCodes.LIMIT_AGENT_BUDGET_EXHAUSTED);
    expect(secondTick.stages.validate).toMatchObject({
      status: "blocked",
      blockedReason: RuntimeErrorCodes.LIMIT_AGENT_BUDGET_EXHAUSTED
    });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: RuntimeErrorCodes.LIMIT_AGENT_BUDGET_EXHAUSTED,
      stageId: undefined,
      itemId: undefined
    }));
  });
});

function fanoutSpec(
  count: number,
  policy: { allowPartial: boolean },
  limits: { maxAgents?: number; maxConcurrency?: number; maxFanoutItems?: number } = {}
): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
    name: "fanout-stability",
    root: "fanout",
    inputs: {
      cwd: { type: "path" },
      items: { type: "array<json>" }
    },
    roles: { worker: { category: "coordination", agent: "fake", mode: "readOnly" } },
    limits: {
      maxAgents: limits.maxAgents ?? count,
      maxConcurrency: limits.maxConcurrency ?? count,
      maxFanoutItems: limits.maxFanoutItems ?? count,
      maxFixRounds: 0,
      stageTimeoutMinutes: 1
    },
    stages: [{
      id: "fanout",
      kind: "fanout",
      items: { source: "input.items" },
      role: "worker",
      prompt: "Handle one item",
      fanoutPolicy: policy
    }]
  });
}

function fanoutInputItems(count: number): Array<{ id: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: `item-${index + 1}` }));
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

async function schedulerBatchStartedCount(dir: string): Promise<number> {
  const text = await fs.readFile(path.join(dir, "events.ndjson"), "utf8");
  return text.trim().split("\n").filter((line) => {
    if (!line) return false;
    const event = JSON.parse(line) as { type?: string };
    return event.type === "scheduler_batch_started";
  }).length;
}

function summarizeSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
    name: "final-verdict",
    root: "summarize",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: { summarizer: { category: "summarization", agent: "fake", mode: "readOnly" } },
    limits: { maxAgents: 1, maxConcurrency: 1, maxFanoutItems: 1, maxFixRounds: 0, stageTimeoutMinutes: 1 },
    stages: [{ id: "summarize", kind: "summarize", role: "summarizer", prompt: "Summarize" }]
  });
}

function budgetSpec(cwd: string): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
    name: "agent-budget",
    root: "plan",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      worker: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { maxAgents: 1, maxConcurrency: 1, maxFanoutItems: 1, maxFixRounds: 0, stageTimeoutMinutes: 1 },
    stages: [
      { id: "plan", kind: "agentTask", role: "worker", prompt: "Plan" },
      { id: "validate", kind: "agentTask", role: "worker", dependsOn: ["plan"], prompt: "Validate" }
    ]
  });
}

function simpleTaskSpec(cwd: string, limits: { maxAgents?: number } = {}): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
    name: "simple-task",
    root: "task",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      worker: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { maxAgents: limits.maxAgents ?? 1, maxConcurrency: 1, maxFanoutItems: 1, maxFixRounds: 0, stageTimeoutMinutes: 1 },
    stages: [{ id: "task", kind: "agentTask", role: "worker", prompt: "Do work" }]
  });
}

function maxOutputSpec(cwd: string, maxOutputChars: number): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
    name: "max-output",
    root: "task",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      worker: { category: "coordination", agent: "fake", mode: "readOnly" }
    },
    limits: { maxAgents: 2, maxConcurrency: 1, maxFanoutItems: 1, maxFixRounds: 0, stageTimeoutMinutes: 1, maxOutputChars },
    stages: [{ id: "task", kind: "agentTask", role: "worker", prompt: "Do work" }]
  });
}

function fixLoopOnlySpec(cwd: string, limits: { maxAgents?: number } = {}): WorkflowSpec {
  return WorkflowSpecSchema.parse({
    schemaVersion: "acpx-workflow-orchestrator.workflow/v1",
    name: "fix-loop-only",
    root: "quality_loop",
    inputs: { cwd: { type: "path", default: cwd } },
    roles: {
      validator: { category: "validation", agent: "fake", mode: "readOnly" },
      implementer: { category: "implementation", agent: "fake", mode: "edit" }
    },
    limits: { maxAgents: limits.maxAgents ?? 2, maxConcurrency: 1, maxFanoutItems: 1, maxFixRounds: 2, stageTimeoutMinutes: 1 },
    stages: [{
      id: "quality_loop",
      kind: "fixLoop",
      maxRounds: 2,
      validator: { role: "validator", prompt: "Validate" },
      fixer: { role: "implementer", prompt: "Fix" },
      routingPolicy: { fixOn: ["P0", "P1"], ignoreForRouting: ["P2", "P3"], unknown: "blocked" },
      onUnknown: "blocked",
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
    if (input.sessionKey.endsWith(`item:${this.failingItemId}`) && !this.failures.has(input.sessionKey)) {
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
    if (input.sessionKey.endsWith(`item:${this.failingItemId}`)) {
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

class FinalVerdictRuntime implements OrchestratorAgentRuntime {
  constructor(private readonly verdict: "blocked" | "failed" | "unknown") {}

  async runTurn(input: AgentTurnRequest, onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void): Promise<AgentTurnResult> {
    const rawText = plainJsonOutput(summarizeOutput({ finalVerdict: this.verdict }));
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
