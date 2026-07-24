import { admitRunForTest } from "./support/runtime-store.js";
import { defineWorkflow } from "@acpus/core";
import { DatabaseSync } from "node:sqlite";
import type { Result } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followRunInspection } from "../src/inspection/use-cases.js";
import type { RunInspectionEmission, RunInspectionError } from "../src/inspection/types.js";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeDatabasePath, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { appendFanoutItem, appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";

describe("run inspection follow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits rich Agent state once and coalesces rapid counter-only updates", async () => {
    await withRuntimeWorkspace("run-inspection-follow-progress", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const controller = new AbortController();
      const iterator = followRunInspection(workspace, {
        runId: run.id,
        mode: "overview",
        intervalMs: 250,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        const initial = await nextEmission(iterator);
        if (initial.kind !== "snapshot" || initial.document.kind !== "snapshot") throw new Error("expected snapshot");
        const stableItemKey = `node:${deriveInstanceKey(appendNode([], "observe"))}`;
        expect(initial.document.items).toContainEqual(expect.objectContaining({ key: stableItemKey, role: "static" }));
        const attempt = startAgent(store, run.id);
        store.writeNodeProgress({
          runId: run.id,
          nodeKey: "observe~1",
          nodeId: "observe",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch: attempt.ownerEpoch,
          kind: "agent",
          status: "running",
          context: { used: 1_000, size: 200_000 },
          tokenUsage: { inputTokens: 900, outputTokens: 100, totalTokens: 1_000 },
          tools: { turn: 1, totalToolCallCount: 1, lastCalls: [{ toolName: "Read", status: "running" }] },
        });

        const update = await nextPolledEmission(iterator);
        expect(update).toMatchObject({
          kind: "update",
          changes: expect.arrayContaining([
            expect.objectContaining({ action: "ready", status: "ready" }),
            expect.objectContaining({ action: "started", status: "running" }),
            expect.objectContaining({ action: "progress", progressVersion: 1, itemKey: stableItemKey }),
          ]),
          patch: {
            upsertItems: expect.arrayContaining([
              expect.objectContaining({
                key: stableItemKey,
                nodeKey: "observe~1",
                agent: expect.objectContaining({
                  key: "observer",
                  tools: { totalCallCount: 1, recent: [{ command: "Read", status: "running" }] },
                }),
              }),
            ]),
            removeItemKeys: [],
          },
        });

        store.writeNodeProgress({
          runId: run.id,
          nodeKey: "observe~1",
          nodeId: "observe",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch: attempt.ownerEpoch,
          kind: "agent",
          status: "running",
          context: { used: 1_100, size: 200_000 },
          tokenUsage: { inputTokens: 950, outputTokens: 150, totalTokens: 1_100 },
          tools: { turn: 1, totalToolCallCount: 1, lastCalls: [{ toolName: "Read", status: "running" }] },
        });
        const pending = iterator.next();
        let settled = false;
        void pending.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(250);
        expect(settled).toBe(false);
        controller.abort();
        expect((await pending).done).toBe(true);
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("uses sparse target updates for Agent tool progress instead of resync", async () => {
    await withRuntimeWorkspace("run-inspection-follow-target", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const attempt = startAgent(store, run.id);
      store.writeNodeProgress({
        runId: run.id,
        nodeKey: "observe~1",
        nodeId: "observe",
        attemptId: attempt.attemptId,
        attemptNo: attempt.attemptNo,
        ownerEpoch: attempt.ownerEpoch,
        kind: "agent",
        status: "running",
        tools: { turn: 1, totalToolCallCount: 1, lastCalls: [{ toolName: "Bash", status: "running", inputPreview: "{\"command\":\"rg -n TODO packages\"}" }] },
      });
      const controller = new AbortController();
      const iterator = followRunInspection(workspace, {
        runId: run.id,
        mode: "target",
        target: "observe",
        intervalMs: 250,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        const initial = await nextEmission(iterator);
        expect(initial).toMatchObject({ kind: "snapshot", document: { kind: "target" } });
        store.writeNodeProgress({
          runId: run.id,
          nodeKey: "observe~1",
          nodeId: "observe",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch: attempt.ownerEpoch,
          kind: "agent",
          status: "running",
          tools: { turn: 1, totalToolCallCount: 1, lastCalls: [{ toolName: "Bash", status: "completed", inputPreview: "{\"command\":\"rg -n TODO packages\"}" }] },
        });

        const update = await nextPolledEmission(iterator);
        expect(update).toMatchObject({
          kind: "update",
          changes: [expect.objectContaining({ action: "progress", itemKey: "instance:observe~1" })],
          patch: {
            upsertItems: [expect.objectContaining({
              nodeKey: "observe~1",
              agent: expect.objectContaining({ tools: { totalCallCount: 1, recent: [{ command: "Bash: rg", status: "completed" }] } }),
            })],
            removeItemKeys: [],
          },
        });
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("inserts a newly materialized fanout item with a sparse ordered patch", async () => {
    await withRuntimeWorkspace("run-inspection-follow-new-item", async workspace => {
      const store = await admittedRepeatedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const claim = store.scheduler.claimRun(run.id, "inspection-order-test", 60_000)!;
      const appendReady = (itemIndex: number): void => {
        const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
        const instancePath = appendNode(appendFanoutItem([], "batch", itemIndex), "observe");
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: `inspection-order-test:${itemIndex}`,
          events: [{
            type: "instance.ready",
            payload: {
              runId: run.id,
              nodeKey: deriveInstanceKey(instancePath),
              nodeId: "observe",
              instancePath,
              readinessSequence: itemIndex + 1,
            },
          }],
        });
      };
      appendReady(1);
      const controller = new AbortController();
      const iterator = followRunInspection(workspace, {
        runId: run.id,
        mode: "overview",
        intervalMs: 250,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        const initial = await nextEmission(iterator);
        if (initial.kind !== "snapshot" || initial.document.kind !== "snapshot") throw new Error("expected snapshot");
        const item0Path = appendFanoutItem([], "batch", 0);
        const node0Path = appendNode(item0Path, "observe");
        const item1Path = appendFanoutItem([], "batch", 1);
        const node1Path = appendNode(item1Path, "observe");
        const scope0Key = `scope:${deriveInstanceKey(item0Path)}`;
        const node0Key = `node:${deriveInstanceKey(node0Path)}`;
        const scope1Key = `scope:${deriveInstanceKey(item1Path)}`;
        const node1Key = `node:${deriveInstanceKey(node1Path)}`;
        expect(initial.document.items.map(item => item.key)).toEqual([
          `node:${deriveInstanceKey(appendNode([], "batch"))}`,
          scope1Key,
          node1Key,
        ]);

        appendReady(0);
        const update = await nextPolledEmission(iterator);
        expect(update).toMatchObject({
          kind: "update",
          changes: [expect.objectContaining({ action: "ready", itemKey: node0Key })],
          patch: {
            upsertItems: expect.arrayContaining([
              expect.objectContaining({ key: scope0Key, scope: { kind: "fanout_item", itemIndex: 0, empty: false } }),
              expect.objectContaining({ key: node0Key, nodeId: "observe" }),
            ]),
            removeItemKeys: [],
            itemOrder: [
              `node:${deriveInstanceKey(appendNode([], "batch"))}`,
              scope0Key,
              node0Key,
              scope1Key,
              node1Key,
            ],
          },
        });
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("summarizes Agent progress outside the compact context budget without inlining items", async () => {
    await withRuntimeWorkspace("run-inspection-follow-omitted-progress", async workspace => {
      const store = await admittedRepeatedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const attempts = startAgents(store, run.id, 21);
      const controller = new AbortController();
      const iterator = followRunInspection(workspace, {
        runId: run.id,
        mode: "overview",
        intervalMs: 250,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        const initial = await nextEmission(iterator);
        if (initial.kind !== "snapshot" || initial.document.kind !== "snapshot") throw new Error("expected snapshot");
        const visible = new Set(initial.document.items.flatMap(item => item.nodeKey ? [item.nodeKey] : []));
        const hiddenNodeKey = [...attempts.keys()].find(nodeKey => !visible.has(nodeKey));
        expect(hiddenNodeKey).toBeDefined();
        const attempt = attempts.get(hiddenNodeKey!);
        if (!attempt) throw new Error(`expected attempt for '${hiddenNodeKey}'`);
        store.writeNodeProgress({
          runId: run.id,
          nodeKey: hiddenNodeKey!,
          nodeId: "observe",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch: attempt.ownerEpoch,
          kind: "agent",
          status: "running",
          context: { used: 1_000, size: 200_000 },
          tools: { turn: 1, totalToolCallCount: 1, lastCalls: [{ toolName: "Read", status: "running" }] },
        });

        const update = await nextPolledEmission(iterator);
        expect(update).toMatchObject({
          kind: "update",
          changes: [{
            entity: { kind: "progress", id: "omitted-agents" },
            action: "progress",
            progressVersion: 1,
            summary: { kind: "omitted-agent-progress", changed: 1, tracked: 1 },
          }],
          patch: { upsertItems: [], removeItemKeys: [] },
        });
        if (update.kind !== "update") throw new Error("expected update");
        expect(update.changes[0]).not.toHaveProperty("itemKey");
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("does not emit when only wall-clock liveness changes", async () => {
    vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
    await withRuntimeWorkspace("run-inspection-follow-clock-only", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      vi.setSystemTime(new Date("2026-07-11T00:00:06.000Z"));
      store.claimDaemon({
        workspaceRealpath: workspace,
        pid: process.pid,
        protocolVersion: 1,
        packageVersion: "test",
        nodeVersion: process.version,
        execPath: process.execPath,
        idleStopMs: 30_000,
      });
      const controller = new AbortController();
      const iterator = followRunInspection(workspace, {
        runId: run.id,
        mode: "overview",
        intervalMs: 250,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        const initial = await nextEmission(iterator);
        expect(initial).toMatchObject({ kind: "snapshot", document: { run: { execution: { state: "inactive", reason: "daemon_alive" } } } });
        const pending = iterator.next();
        let settled = false;
        void pending.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(250);
        expect(settled).toBe(false);
        controller.abort();
        expect((await pending).done).toBe(true);
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("resynchronizes when the durable event cursor contains a gap", async () => {
    await withRuntimeWorkspace("run-inspection-follow-cursor-gap", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const controller = new AbortController();
      const iterator = followRunInspection(workspace, {
        runId: run.id,
        mode: "overview",
        intervalMs: 250,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        const initial = await nextEmission(iterator);
        const previousSequence = initial.cursor.eventSequence;
        const db = new DatabaseSync(runtimeDatabasePath(workspace));
        try {
          db.prepare(`
            INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
            VALUES (?, ?, 'run.paused', NULL, '{}', ?, ?)
          `).run(run.id, previousSequence + 2, new Date().toISOString(), `inspection-gap:${run.id}`);
        } finally {
          db.close();
        }

        expect(await nextPolledEmission(iterator)).toMatchObject({ kind: "resync", reason: "cursor-gap" });
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });
});

async function admittedAgentStore(workspace: string): Promise<RuntimeStore> {
  const prepared = await prepareSyntheticWorkflow(workspace, defineWorkflow({
    name: "inspection-agent",
    agents: { observer: { use: "claude" } },
  }).build(({ agents, step }) => {
    const observed = step("observe").agent({ agent: agents.observer, prompt: "Inspect" });
    return { observed: observed.output };
  }));
  const store = await openRuntimeStore(workspace);
  await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
  return store;
}

async function admittedRepeatedAgentStore(workspace: string): Promise<RuntimeStore> {
  const prepared = await prepareSyntheticWorkflow(workspace, defineWorkflow({
    name: "inspection-repeated-agent",
    agents: { observer: { use: "claude" } },
  }).build(({ agents, step }) => {
    const observed = step("batch").fanout({
      over: Array.from({ length: 21 }, (_, index) => index),
      do() {
        const item = step("observe").agent({ agent: agents.observer, prompt: "Inspect" });
        return item.output;
      },
    });
    return { observed: observed.output };
  }));
  const store = await openRuntimeStore(workspace);
  await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
  return store;
}

function startAgent(store: RuntimeStore, runId: string) {
  const claim = store.scheduler.claimRun(runId, "inspection-test", 60_000)!;
  const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
  throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
    runId,
    expectedVersion: snapshot.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: "inspection-agent:ready",
    events: [{
      type: "instance.ready",
      payload: {
        runId,
        nodeKey: "observe~1",
        nodeId: "observe",
        instancePath: [{ kind: "node", nodeId: "observe" }],
        readinessSequence: 1,
      },
    }],
  });
  const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
    runId,
    nodeKey: "observe~1",
    nodeId: "observe",
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: "inspection-agent:attempt",
  });
  return { ...attempt, ownerEpoch: claim.ownerEpoch };
}

function startAgents(store: RuntimeStore, runId: string, count: number) {
  const claim = store.scheduler.claimRun(runId, "inspection-budget-test", 60_000)!;
  const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
  throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
    runId,
    expectedVersion: snapshot.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: "inspection-agent:budget",
    events: Array.from({ length: count }, (_, index) => {
      const instancePath = appendNode(appendFanoutItem([], "batch", index), "observe");
      return {
        type: "instance.ready" as const,
        payload: {
          runId,
          nodeKey: deriveInstanceKey(instancePath),
          nodeId: "observe",
          instancePath,
          readinessSequence: index + 1,
        },
      };
    }),
  });
  return new Map(Array.from({ length: count }, (_, index) => {
    const nodeKey = deriveInstanceKey(appendNode(appendFanoutItem([], "batch", index), "observe"));
    const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
      runId,
      nodeKey,
      nodeId: "observe",
      ownerEpoch: claim.ownerEpoch,
      idempotencyKey: `inspection-agent:budget:attempt:${index}`,
    });
    return [nodeKey, { ...attempt, ownerEpoch: claim.ownerEpoch }] as const;
  }));
}

async function nextEmission(iterator: AsyncIterator<Result<RunInspectionEmission, RunInspectionError>>): Promise<RunInspectionEmission> {
  const next = await iterator.next();
  if (next.done) throw new Error("follow ended before the expected emission");
  if (next.value.isErr()) throw new Error(next.value.error.message);
  return next.value.value;
}

async function nextPolledEmission(
  iterator: AsyncIterator<Result<RunInspectionEmission, RunInspectionError>>,
): Promise<RunInspectionEmission> {
  const pending = nextEmission(iterator);
  await vi.advanceTimersByTimeAsync(250);
  return pending;
}
