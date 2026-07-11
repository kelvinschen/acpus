import { defineWorkflow } from "@acpus/core";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Result } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followRunInspection } from "../src/inspection/use-cases.js";
import type { RunInspectionEmission, RunInspectionError } from "../src/inspection/types.js";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

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
        expect((await nextEmission(iterator)).kind).toBe("snapshot");
        const attempt = startAgent(store, run.id);
        store.writeNodeProgress({
          runId: run.id,
          nodeKey: "observe~1",
          nodeId: "observe",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
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
            expect.objectContaining({ action: "progress", progressVersion: 1, itemKey: "instance:observe~1" }),
          ]),
          patch: {
            upsertItems: expect.arrayContaining([
              expect.objectContaining({
                nodeKey: "observe~1",
                agent: expect.objectContaining({
                  key: "observer",
                  tools: { totalCallCount: 1, recent: [{ command: "Read", status: "running" }] },
                }),
              }),
            ]),
          },
        });

        store.writeNodeProgress({
          runId: run.id,
          nodeKey: "observe~1",
          nodeId: "observe",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
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

  it("summarizes Agent progress outside the compact context budget without inlining items", async () => {
    await withRuntimeWorkspace("run-inspection-follow-omitted-progress", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      readyAgents(store, run.id, 21);
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
        const hiddenNodeKey = Array.from({ length: 21 }, (_, index) => `observe~${index}`).find(nodeKey => !visible.has(nodeKey));
        expect(hiddenNodeKey).toBeDefined();
        store.writeNodeProgress({
          runId: run.id,
          nodeKey: hiddenNodeKey!,
          nodeId: "observe",
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
        const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"));
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
    const observed = step("observe").agent({ run: { agent: agents.observer, prompt: "Inspect" } });
    return { observed: observed.output };
  }));
  const store = await openRuntimeStore(workspace);
  await store.admitRun({ prepared, input: {}, cwd: workspace });
  return store;
}

function startAgent(store: RuntimeStore, runId: string) {
  const claim = store.scheduler.claimRun(runId, "inspection-test", 60_000)!;
  const snapshot = store.scheduler.loadRunSnapshot(runId);
  store.scheduler.appendSchedulerEvents({
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
  return store.scheduler.startAttempt({
    runId,
    nodeKey: "observe~1",
    nodeId: "observe",
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: "inspection-agent:attempt",
  });
}

function readyAgents(store: RuntimeStore, runId: string, count: number): void {
  const claim = store.scheduler.claimRun(runId, "inspection-budget-test", 60_000)!;
  const snapshot = store.scheduler.loadRunSnapshot(runId);
  store.scheduler.appendSchedulerEvents({
    runId,
    expectedVersion: snapshot.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: "inspection-agent:budget",
    events: Array.from({ length: count }, (_, index) => ({
      type: "instance.ready" as const,
      payload: {
        runId,
        nodeKey: `observe~${index}`,
        nodeId: "observe",
        instancePath: [{ kind: "node" as const, nodeId: "observe" }],
        readinessSequence: index + 1,
      },
    })),
  });
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
