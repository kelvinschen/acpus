import { admitRunForTest } from "./support/runtime-store.js";
import { defineWorkflow } from "@acpus/core";
import { DatabaseSync } from "node:sqlite";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Result } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followRunInspection, getRunInspection } from "../src/inspection/use-cases.js";
import { AgentObservationLog } from "../src/observations/log.js";
import { decodeTimelinePageCursor } from "../src/inspection/timeline-cursor.js";
import type {
  RunInspectionEmission,
  RunInspectionError,
} from "../src/inspection/types.js";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeDatabasePath, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { appendFanoutItem, appendNode, deriveInstanceKey } from "../src/scheduler/identity.js";
import * as controlPlan from "../src/scheduler/control-plan.js";

vi.mock("@acpus/agent-executor", async importOriginal => {
  const actual = await importOriginal<typeof import("@acpus/agent-executor")>();
  return {
    ...actual,
    executeAgentTurn: vi.fn(async (request: import("@acpus/agent-executor").AgentTurnRequest) => {
      const observedAt = new Date().toISOString();
      request.onObservation?.({
        event: {
          schemaVersion: 1,
          sequence: 0,
          observedAt,
          elapsedMs: 1,
          type: "message",
          channel: "assistant",
          content: "durable observation",
        },
        progress: {
          responseText: "durable observation",
          summary: {
            eventCount: 1,
            availability: { context: "unavailable", tokenUsage: "unavailable" },
            tools: { totalToolCallCount: 0, calls: [] },
          },
          updatedAt: observedAt,
        },
      });
      return {
        status: "completed" as const,
        responseText: "durable observation",
        stderr: "",
        summary: {
          eventCount: 1,
          availability: { context: "unavailable" as const, tokenUsage: "unavailable" as const },
          tools: { totalToolCallCount: 0, calls: [] },
        },
        timing: { startedAt: observedAt, finishedAt: observedAt, elapsedMs: 1 },
      };
    }),
  };
});

describe("run inspection follow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a terminal follow with a fresh snapshot before done", async () => {
    await withRuntimeWorkspace("run-inspection-follow-done", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      try {
        const claim = store.scheduler.claimRun(run.id, "inspection-done", 60_000);
        if (!claim) throw new Error("expected run claim");
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "inspection:done",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "frame.completed", payload: { frameKey: "root", result: { ok: true }, terminalReason: "root_completed" } },
          ],
        });

        const emissions: RunInspectionEmission[] = [];
        for await (const result of followRunInspection(workspace, {
          runId: run.id,
          mode: "overview",
          intervalMs: 250,
        })) {
          if (result.isErr()) throw result.error;
          emissions.push(result.value);
        }

        expect(emissions).toEqual([
          expect.objectContaining({
            schemaVersion: 2,
            kind: "snapshot",
            document: expect.objectContaining({
              kind: "snapshot",
              run: expect.objectContaining({ id: run.id, status: "completed" }),
            }),
          }),
          {
            schemaVersion: 2,
            kind: "done",
            run: { id: run.id, status: "completed" },
            output: { ok: true },
          },
        ]);
        expect(emissions.some(emission => "revision" in emission)).toBe(false);
      } finally {
        store.close();
      }
    });
  });

  it("emits compact Agent activity once and coalesces rapid metric-only updates", async () => {
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
          kind: "delta",
          changes: [{
            kind: "overview",
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
                  agent: {
                    key: "observer",
                    turn: 1,
                    activeTool: { command: "Read", status: "running" },
                  },
                }),
              ]),
              removeItemKeys: [],
            },
          }],
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

  it("uses compact target deltas for Agent tool progress instead of resync", async () => {
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
          kind: "delta",
          changes: [{
            kind: "pulse",
            pulse: expect.objectContaining({ phase: "starting", headline: "starting", turn: 1 }),
          }],
        });
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("surfaces degraded evidence as visibility and emits its restoration", async () => {
    await withRuntimeWorkspace("run-inspection-target-evidence", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const attempt = startAgent(store, run.id);
      try {
        await store.observationLog.captureTurn({
          runId: run.id,
          nodeId: "observe",
          nodeKey: "observe~1",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          turn: 1,
          promptKind: "task",
          agentKey: "observer",
          sessionName: "inspection-target-evidence",
          cwd: workspace,
          trace: false,
        }, {
          agent: { kind: "named", name: "claude" },
          prompt: "Inspect",
          cwd: workspace,
          env: {},
          sessionName: "inspection-target-evidence",
          permissionMode: "deny-all",
        });
        const db = new DatabaseSync(runtimeDatabasePath(workspace));
        try {
          db.prepare(`
            UPDATE agent_observation_turns
            SET degraded = 1, gap_count = 1
            WHERE run_id = ? AND attempt_id = ?
          `).run(run.id, attempt.attemptId);
        } finally {
          db.close();
        }

        const inspected = await getRunInspection(workspace, {
          runId: run.id,
          mode: "target",
          target: "observe~1",
        });
        if (inspected.isErr() || inspected.value.kind !== "target") throw new Error("expected Target summary");
        expect(inspected.value.attention).toBeUndefined();
        expect(inspected.value.visibility).toEqual({
          state: "degraded",
          reason: "observation-gap",
        });
        expect(inspected.value.evidence).toBeUndefined();

        const controller = new AbortController();
        const iterator = followRunInspection(workspace, {
          runId: run.id,
          mode: "target",
          target: "observe~1",
          intervalMs: 250,
          signal: controller.signal,
        })[Symbol.asyncIterator]();
        try {
          expect(await nextEmission(iterator)).toMatchObject({
            kind: "snapshot",
            document: {
              kind: "target",
              visibility: { state: "degraded", reason: "observation-gap" },
            },
          });
          const restorationDb = new DatabaseSync(runtimeDatabasePath(workspace));
          try {
            const row = restorationDb.prepare("SELECT observation_version FROM runs WHERE id = ?")
              .get(run.id) as { observation_version: number };
            const version = row.observation_version + 1;
            restorationDb.exec("BEGIN IMMEDIATE");
            restorationDb.prepare(`
              UPDATE agent_observation_turns
              SET degraded = 0, gap_count = 0
              WHERE run_id = ? AND attempt_id = ?
            `).run(run.id, attempt.attemptId);
            restorationDb.prepare(`
              UPDATE agent_observation_attempts
              SET latest_observation_version = ?
              WHERE run_id = ? AND attempt_id = ?
            `).run(version, run.id, attempt.attemptId);
            restorationDb.prepare(`
              UPDATE runs
              SET observation_version = ?, observation_updated_at = ?
              WHERE id = ?
            `).run(version, new Date().toISOString(), run.id);
            restorationDb.exec("COMMIT");
          } catch (error) {
            restorationDb.exec("ROLLBACK");
            throw error;
          } finally {
            restorationDb.close();
          }

          expect(await nextPolledEmission(iterator)).toMatchObject({
            kind: "delta",
            changes: expect.arrayContaining([{ kind: "visibility", visibility: null }]),
          });
        } finally {
          controller.abort();
          await iterator.return?.();
        }
      } finally {
        store.close();
      }
    });
  });

  it("coalesces a small response headline update until the ten-second checkpoint", async () => {
    vi.setSystemTime(new Date("2026-07-25T00:00:00.000Z"));
    await withRuntimeWorkspace("run-inspection-follow-response-checkpoint", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const attempt = startAgent(store, run.id);
      const progress = (tail: string) => ({
        runId: run.id,
        nodeKey: "observe~1",
        nodeId: "observe",
        attemptId: attempt.attemptId,
        attemptNo: attempt.attemptNo,
        ownerEpoch: attempt.ownerEpoch,
        kind: "agent" as const,
        status: "running",
        output: { tail, totalBytes: Buffer.byteLength(tail), truncated: false },
      });
      store.writeNodeProgress(progress("a"));
      const controller = new AbortController();
      const iterator = followRunInspection(workspace, {
        runId: run.id,
        mode: "target",
        target: attempt.attemptId,
        intervalMs: 250,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        expect(await nextEmission(iterator)).toMatchObject({
          kind: "snapshot",
          document: {
            kind: "target",
            pulse: { phase: "responding", headline: "a" },
          },
        });
        store.writeNodeProgress(progress("ab"));
        const pending = iterator.next();
        let settled = false;
        void pending.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(9_750);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(250);
        const emission = await pending;
        if (emission.done || emission.value.isErr()) throw new Error("expected checkpoint delta");
        expect(emission.value.value).toMatchObject({
          kind: "delta",
          changes: [{
            kind: "pulse",
            pulse: { phase: "responding", headline: "ab" },
          }],
        });
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("emits only changed Agent current fields after the response threshold", async () => {
    await withRuntimeWorkspace("run-inspection-follow-current-patch", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const attempt = startAgent(store, run.id);
      const progress = (tail: string) => ({
        runId: run.id,
        nodeKey: "observe~1",
        nodeId: "observe",
        attemptId: attempt.attemptId,
        attemptNo: attempt.attemptNo,
        ownerEpoch: attempt.ownerEpoch,
        kind: "agent" as const,
        status: "running" as const,
        output: { tail, totalBytes: Buffer.byteLength(tail), truncated: false },
        context: { used: 10, size: 100 },
        tools: {
          turn: 1,
          totalToolCallCount: 1,
          lastCalls: [{ toolName: "Read", status: "running" }],
        },
      });
      store.writeNodeProgress(progress("a"));
      const controller = new AbortController();
      const iterator = followRunInspection(workspace, {
        runId: run.id,
        mode: "timeline",
        target: attempt.attemptId,
        intervalMs: 250,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        expect(await nextEmission(iterator)).toMatchObject({
          kind: "snapshot",
          document: { kind: "timeline", current: { kind: "agent" } },
        });
        store.writeNodeProgress(progress(`a${"b".repeat(512)}`));

        const update = await nextPolledEmission(iterator);
        if (update.kind !== "delta") throw new Error("expected current patch delta");
        const current = update.changes.find(change => change.kind === "current-patch");
        expect(current).toMatchObject({
          kind: "current-patch",
          patch: {
            kind: "agent",
            attemptId: attempt.attemptId,
            attemptNo: attempt.attemptNo,
            changes: {
              response: expect.objectContaining({ originalBytes: 513 }),
            },
          },
        });
        if (!current || current.kind !== "current-patch") throw new Error("expected current patch");
        expect(current.patch.changes).not.toHaveProperty("tools");
        expect(current.patch.changes).not.toHaveProperty("context");
        expect(current.patch.changes).not.toHaveProperty("observation");
        expect(current.patch.changes).not.toHaveProperty("intent");
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
          kind: "delta",
          changes: [{
            kind: "overview",
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
          }],
        });
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("does not inline or emit hidden Agent counter-only progress", async () => {
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

  it("does not emit a clock-only Timeline current patch at a forced semantic boundary", async () => {
    vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
    await withRuntimeWorkspace("run-inspection-follow-forced-clock-only", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const attempt = startAgent(store, run.id);
      const progress = () => ({
        runId: run.id,
        nodeKey: "observe~1",
        nodeId: "observe",
        attemptId: attempt.attemptId,
        attemptNo: attempt.attemptNo,
        ownerEpoch: attempt.ownerEpoch,
        kind: "agent" as const,
        status: "running" as const,
        output: { tail: "working", totalBytes: 7, truncated: false },
        tools: { turn: 1, totalToolCallCount: 0, lastCalls: [] },
      });
      store.writeNodeProgress(progress());
      const controller = new AbortController();
      const iterator = followRunInspection(workspace, {
        runId: run.id,
        mode: "timeline",
        target: attempt.attemptId,
        intervalMs: 250,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        expect(await nextEmission(iterator)).toMatchObject({
          kind: "snapshot",
          document: { kind: "timeline", current: { kind: "agent", phase: "responding" } },
        });
        vi.setSystemTime(new Date("2026-07-11T00:00:01.000Z"));
        store.writeNodeProgress(progress());
        const sequence = store.getLastRunEventSequence(run.id) + 1;
        const db = new DatabaseSync(runtimeDatabasePath(workspace));
        try {
          db.prepare(`
            INSERT INTO run_events (
              run_id, sequence, type, node_key, payload_json, created_at, idempotency_key
            )
            VALUES (?, ?, 'control.paused', NULL, ?, ?, ?)
          `).run(
            run.id,
            sequence,
            JSON.stringify({ schedulerEventVersion: 1, payload: {} }),
            new Date().toISOString(),
            `inspection-forced-clock-only:${run.id}`,
          );
        } finally {
          db.close();
        }

        const update = await nextPolledEmission(iterator);
        expect(update).toMatchObject({
          kind: "delta",
          changes: [{
            kind: "recent",
            upsert: [expect.objectContaining({ kind: "control", action: "paused" })],
          }],
        });
        if (update.kind !== "delta") throw new Error("expected Timeline delta");
        expect(update.changes.some(change =>
          change.kind === "current" || change.kind === "current-patch")).toBe(false);
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("does not emit a Target delta when only the deadline clock advances", async () => {
    const now = new Date("2026-07-11T00:00:00.000Z");
    vi.setSystemTime(now);
    await withRuntimeWorkspace("run-inspection-follow-deadline-clock-only", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const attempt = startAgent(store, run.id);
      const db = new DatabaseSync(runtimeDatabasePath(workspace));
      try {
        db.prepare("UPDATE node_attempts SET deadline_at = ? WHERE attempt_id = ?")
          .run(new Date(now.getTime() + 61_000).toISOString(), attempt.attemptId);
      } finally {
        db.close();
      }
      const controller = new AbortController();
      const iterator = followRunInspection(workspace, {
        runId: run.id,
        mode: "target",
        target: attempt.attemptId,
        intervalMs: 250,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        const initial = await nextEmission(iterator);
        expect(initial).toMatchObject({ kind: "snapshot", document: { kind: "target" } });
        if (initial.kind !== "snapshot" || initial.document.kind !== "target") {
          throw new Error("expected Target snapshot");
        }
        expect(initial.document.attention).toBeUndefined();

        const pending = iterator.next();
        let settled = false;
        void pending.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(2_000);
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

  it("emits a Timeline delta when only observation version advances", async () => {
    await withRuntimeWorkspace("run-inspection-follow-observation", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const attempt = startAgent(store, run.id);
      const before = store.readRunInspection(run.id).cursor;
      const controller = new AbortController();
      const iterator = followRunInspection(workspace, {
        runId: run.id,
        mode: "timeline",
        target: attempt.attemptId,
        intervalMs: 250,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        expect(await nextEmission(iterator)).toMatchObject({
          kind: "snapshot",
          document: { kind: "timeline" },
        });
        await store.observationLog.captureTurn({
          runId: run.id,
          nodeId: "observe",
          nodeKey: "observe~1",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          turn: 1,
          promptKind: "task",
          agentKey: "observer",
          sessionName: "inspection-observation",
          cwd: workspace,
          trace: false,
        }, {
          agent: { kind: "named", name: "claude" },
          prompt: "Inspect",
          cwd: workspace,
          env: {},
          sessionName: "inspection-observation",
          permissionMode: "deny-all",
        });
        const after = store.readRunInspection(run.id).cursor;
        expect(after).toEqual({
          eventSequence: before.eventSequence,
          progressVersion: before.progressVersion,
          observationVersion: expect.any(Number),
        });
        expect(after.observationVersion).toBeGreaterThan(before.observationVersion);

        const update = await nextPolledEmission(iterator);
        expect(update).toMatchObject({
          kind: "delta",
          changes: expect.arrayContaining([
            expect.objectContaining({
              kind: "recent",
              upsert: [expect.objectContaining({
                kind: "activity",
                channel: "response",
                summary: expect.objectContaining({ text: "durable observation" }),
              })],
            }),
          ]),
        });
        if (update.kind !== "delta") throw new Error("expected Timeline delta");
        const recentIndex = update.changes.findIndex(change => change.kind === "recent");
        const currentIndex = update.changes.findIndex(change =>
          change.kind === "current" || change.kind === "current-patch");
        expect(recentIndex).toBeGreaterThanOrEqual(0);
        expect(currentIndex).toBeGreaterThan(recentIndex);
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("reads Summary and Timeline from SQLite after the private evidence file is unavailable", async () => {
    await withRuntimeWorkspace("run-inspection-sqlite-only", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const attempt = startAgent(store, run.id);
      try {
        const captured = await store.observationLog.captureTurn({
          runId: run.id,
          nodeId: "observe",
          nodeKey: "observe~1",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          turn: 1,
          promptKind: "task",
          agentKey: "observer",
          sessionName: "inspection-sqlite-only",
          cwd: workspace,
          trace: false,
        }, {
          agent: { kind: "named", name: "claude" },
          prompt: "Inspect",
          cwd: workspace,
          env: {},
          sessionName: "inspection-sqlite-only",
          permissionMode: "deny-all",
        });
        const runDir = store.getRunDir(run.id);
        if (!runDir) throw new Error("expected run directory");
        await rm(join(runDir, captured.evidence.relativePath));

        const summary = await getRunInspection(workspace, {
          runId: run.id,
          mode: "target",
          target: attempt.attemptId,
        });
        const timeline = await getRunInspection(workspace, {
          runId: run.id,
          mode: "timeline",
          target: attempt.attemptId,
        });

        if (summary.isErr() || timeline.isErr()) throw new Error("expected SQLite inspection");
        expect(summary.value).toMatchObject({
          kind: "target",
          evidence: {
            records: [expect.objectContaining({
              file: "turn-001.evidence.jsonl",
            })],
          },
        });
        expect(timeline.value).toMatchObject({
          kind: "timeline",
          recent: {
            entries: expect.arrayContaining([expect.objectContaining({
              kind: "activity",
              channel: "response",
              summary: expect.objectContaining({ text: "durable observation" }),
            })]),
          },
        });
      } finally {
        store.close();
      }
    });
  });

  it("reads one bounded exact-attempt execution projection without control planning or private files", async () => {
    await withRuntimeWorkspace("run-inspection-execution-projection", async workspace => {
      const store = await admittedRepeatedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const attempts = startAgents(store, run.id, 2);
      const [nodeKey, first] = [...attempts.entries()].sort(([left], [right]) =>
        left.localeCompare(right))[0]!;
      const scheduler = throwingSchedulerStore(store.scheduler);
      const observationRead = vi.spyOn(
        AgentObservationLog.prototype,
        "readInspectionProjection",
      );
      let controlSettlement = vi.spyOn(
        controlPlan,
        "settleRetryControlSnapshot",
      ).mockImplementation(() => {
        throw new Error("execution inspection must not settle controls");
      });
      try {
        const ambiguous = await getRunInspection(workspace, {
          runId: run.id,
          mode: "execution",
          target: "observe",
        });
        expect(ambiguous).toMatchObject({
          isErr: expect.any(Function),
        });
        if (ambiguous.isOk()) throw new Error("expected static aggregate ambiguity");
        expect(ambiguous.error).toMatchObject({
          type: "target-ambiguous",
          candidateKeys: [...attempts.keys()].sort(),
        });
        expect(observationRead).not.toHaveBeenCalled();
        expect(controlSettlement).not.toHaveBeenCalled();
        controlSettlement.mockRestore();

        store.writeNodeProgress({
          runId: run.id,
          nodeKey,
          nodeId: "observe",
          attemptId: first.attemptId,
          attemptNo: first.attemptNo,
          ownerEpoch: first.ownerEpoch,
          kind: "agent",
          status: "running",
          message: "historical progress",
          tools: { turn: 1, totalToolCallCount: 0, lastCalls: [] },
        });
        store.writeExecutionMetadata({
          runId: run.id,
          attemptId: first.attemptId,
          kind: "agent_attempt",
          metadata: {
            sessionName: "historical-session",
            turnCount: 2,
            turns: [1, 2].map(turn => ({
              turn,
            })),
          },
        });
        const captured = [];
        for (const turn of [1, 2]) {
          captured.push(await store.observationLog.captureTurn({
            runId: run.id,
            nodeId: "observe",
            nodeKey,
            attemptId: first.attemptId,
            attemptNo: first.attemptNo,
            turn,
            promptKind: turn === 1 ? "task" : "continuation",
            agentKey: "observer",
            sessionName: "historical-session",
            cwd: workspace,
            trace: false,
          }, {
            agent: { kind: "named", name: "claude" },
            prompt: "Inspect",
            cwd: workspace,
            env: {},
            sessionName: "historical-session",
            permissionMode: "deny-all",
          }));
        }
        const db = new DatabaseSync(runtimeDatabasePath(workspace));
        try {
          db.prepare(`
            UPDATE agent_observation_turns
            SET degraded = 1, gap_count = 1
            WHERE run_id = ? AND attempt_id = ? AND turn_no = 1
          `).run(run.id, first.attemptId);
        } finally {
          db.close();
        }
        const boundedTurns = await store.observationLog.readInspectionProjection({
          runId: run.id,
          attemptIds: [first.attemptId],
          entryLimit: 50,
          latestTurnOnly: true,
        });
        if (boundedTurns.isErr()) throw boundedTurns.error;
        expect(boundedTurns.value.turns.map(turn => turn.turn)).toEqual([2]);
        expect(boundedTurns.value.omittedTurnEvidence).toBe(true);
        observationRead.mockClear();
        scheduler.commitAttemptResult({
          runId: run.id,
          attemptId: first.attemptId,
          ownerEpoch: first.ownerEpoch,
          result: { status: "failed", reason: "retryable" },
          idempotencyKey: "inspection-execution:first-failed",
        });
        scheduler.retry({
          runId: run.id,
          target: nodeKey,
          ownerEpoch: first.ownerEpoch,
          idempotencyKey: "inspection-execution:retry",
        });
        const second = scheduler.startAttempt({
          runId: run.id,
          nodeKey,
          nodeId: "observe",
          ownerEpoch: first.ownerEpoch,
          idempotencyKey: "inspection-execution:second",
        });
        store.writeNodeProgress({
          runId: run.id,
          nodeKey,
          nodeId: "observe",
          attemptId: second.attemptId,
          attemptNo: second.attemptNo,
          ownerEpoch: first.ownerEpoch,
          kind: "agent",
          status: "running",
          message: "later progress",
          tools: { turn: 9, totalToolCallCount: 0, lastCalls: [] },
        });
        store.writeExecutionMetadata({
          runId: run.id,
          attemptId: second.attemptId,
          kind: "agent_attempt",
          metadata: {
            sessionName: "later-session",
            turnCount: 9,
            turns: [],
          },
        });
        const runDir = store.getRunDir(run.id);
        if (!runDir) throw new Error("expected run directory");
        for (const turn of captured) await rm(join(runDir, turn.evidence.relativePath));

        controlSettlement = vi.spyOn(
          controlPlan,
          "settleRetryControlSnapshot",
        ).mockImplementation(() => {
          throw new Error("execution inspection must not settle controls");
        });
        const execution = await getRunInspection(workspace, {
          runId: run.id,
          mode: "execution",
          target: first.attemptId,
        });
        if (execution.isErr()) throw new Error(execution.error.message);
        expect(execution.value).toMatchObject({
          kind: "execution",
          available: true,
          summary: {
            status: "failed",
            sessionName: "historical-session",
            turnCount: 2,
          },
          recentToolsIncomplete: true,
        });
        expect(execution.value).not.toEqual(expect.objectContaining({
          summary: expect.objectContaining({
            sessionName: "later-session",
          }),
        }));
        expect(observationRead).toHaveBeenCalledTimes(1);
        expect(observationRead).toHaveBeenCalledWith({
          runId: run.id,
          attemptIds: [first.attemptId],
          entryLimit: 50,
          latestTurnOnly: true,
        });
        expect(controlSettlement).not.toHaveBeenCalled();
      } finally {
        observationRead.mockRestore();
        controlSettlement.mockRestore();
        store.close();
      }
    });
  });

  it("emits Timeline semantic observation deltas within one follow connection", async () => {
    await withRuntimeWorkspace("run-inspection-follow-observation-delta", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const attempt = startAgent(store, run.id);
      const controller = new AbortController();
      const iterator = followRunInspection(workspace, {
        runId: run.id,
        mode: "timeline",
        target: attempt.attemptId,
        intervalMs: 250,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        expect(await nextEmission(iterator)).toMatchObject({
          kind: "snapshot",
          document: { kind: "timeline" },
        });

        await store.observationLog.captureTurn({
          runId: run.id,
          nodeId: "observe",
          nodeKey: "observe~1",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          turn: 1,
          promptKind: "task",
          agentKey: "observer",
          sessionName: "inspection-observation-delta",
          cwd: workspace,
          trace: false,
        }, {
          agent: { kind: "named", name: "claude" },
          prompt: "Inspect",
          cwd: workspace,
          env: {},
          sessionName: "inspection-observation-delta",
          permissionMode: "deny-all",
        });

        const delta = await nextPolledEmission(iterator);
        expect(delta).toMatchObject({
          kind: "delta",
          changes: expect.arrayContaining([
            expect.objectContaining({
              kind: "recent",
              upsert: [expect.objectContaining({
                kind: "activity",
                channel: "response",
                summary: expect.objectContaining({ text: "durable observation" }),
              })],
            }),
          ]),
        });
        if (delta.kind !== "delta") throw new Error("expected Timeline delta");
        const recentIndex = delta.changes.findIndex(change => change.kind === "recent");
        const currentIndex = delta.changes.findIndex(change =>
          change.kind === "current" || change.kind === "current-patch");
        expect(recentIndex).toBeGreaterThanOrEqual(0);
        expect(currentIndex).toBeGreaterThan(recentIndex);
        expect(delta.changes.some(change => change.kind === "visibility")).toBe(false);
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("accepts Timeline limits at 1 and 50 and rejects values outside that range", async () => {
    await withRuntimeWorkspace("run-inspection-timeline-limit", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const attempt = startAgent(store, run.id);
      try {
        for (const limit of [1, 50]) {
          const result = await getRunInspection(workspace, {
            runId: run.id,
            mode: "timeline",
            target: attempt.attemptId,
            page: { limit },
          });
          expect(result.isOk()).toBe(true);
        }
        for (const limit of [0, 51]) {
          const result = await getRunInspection(workspace, {
            runId: run.id,
            mode: "timeline",
            target: attempt.attemptId,
            page: { limit },
          });
          expect(result.isErr() && result.error.type).toBe("invalid-query");
        }
      } finally {
        store.close();
      }
    });
  });

  it("rejects a Timeline page cursor whose semantic boundary expired", async () => {
    await withRuntimeWorkspace("run-inspection-timeline-expired-page", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const attempt = startAgent(store, run.id);
      try {
        for (let turn = 1; turn <= 13; turn += 1) {
          await store.observationLog.captureTurn({
            runId: run.id,
            nodeId: "observe",
            nodeKey: "observe~1",
            attemptId: attempt.attemptId,
            attemptNo: attempt.attemptNo,
            turn,
            promptKind: "task",
            agentKey: "observer",
            sessionName: "inspection-expired-page",
            cwd: workspace,
            trace: false,
          }, {
            agent: { kind: "named", name: "claude" },
            prompt: "Inspect",
            cwd: workspace,
            env: {},
            sessionName: "inspection-expired-page",
            permissionMode: "deny-all",
          });
        }

        const first = await getRunInspection(workspace, {
          runId: run.id,
          mode: "timeline",
          target: attempt.attemptId,
        });
        if (first.isErr() || first.value.kind !== "timeline") throw new Error("expected Timeline page");
        const pageCursor = first.value.recent.olderCursor;
        const boundary = pageCursor ? decodeTimelinePageCursor(pageCursor)?.beforeEntry : undefined;
        if (!pageCursor || !boundary) throw new Error("expected semantic page boundary");

        const db = new DatabaseSync(runtimeDatabasePath(workspace));
        try {
          db.exec("BEGIN IMMEDIATE");
          db.prepare(`
            INSERT INTO agent_observation_entries (
              run_id, attempt_id, turn_no, entry_id, observation_version,
              source_sequence, observed_at, kind, payload_json, payload_bytes
            )
            SELECT run_id, attempt_id, turn_no, ?, observation_version,
                   source_sequence + 1000, observed_at, kind, payload_json, payload_bytes
            FROM agent_observation_entries
            WHERE run_id = ? AND attempt_id = ? AND entry_id = ?
          `).run(
            `${boundary.id}:retained-sibling`,
            run.id,
            attempt.attemptId,
            boundary.id,
          );
          db.prepare(`
            DELETE FROM agent_observation_entries
            WHERE run_id = ? AND attempt_id = ? AND entry_id = ?
          `).run(run.id, attempt.attemptId, boundary.id);
          db.prepare(`
            UPDATE agent_observation_attempts
            SET retention_omitted_count = 1, retention_floor_version = ?
            WHERE run_id = ? AND attempt_id = ?
          `).run(boundary.observationVersion, run.id, attempt.attemptId);
          db.exec("COMMIT");
          expect((db.prepare(`
            SELECT COUNT(*) AS count
            FROM agent_observation_entries
            WHERE run_id = ? AND attempt_id = ? AND observation_version = ?
          `).get(run.id, attempt.attemptId, boundary.observationVersion) as { count: number }).count)
            .toBeGreaterThan(0);
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        } finally {
          db.close();
        }

        const expired = await getRunInspection(workspace, {
          runId: run.id,
          mode: "timeline",
          target: attempt.attemptId,
          page: { before: pageCursor },
        });
        expect(expired.isErr() && expired.error).toMatchObject({
          type: "invalid-cursor",
          runId: run.id,
          target: attempt.attemptId,
        });
      } finally {
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
        expect(initial.kind).toBe("snapshot");
        const previousSequence = store.getLastRunEventSequence(run.id);
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
