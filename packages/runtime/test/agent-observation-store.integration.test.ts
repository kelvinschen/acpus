import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  FixtureAgentTurnObservation as AgentTurnObservation,
  FixtureAgentTurnRequest as AgentTurnRequest,
  FixtureAgentTurnResult as AgentTurnResult,
} from "./support/agent-turn.js";
import type { AgentTurnEvent, AgentTurnSnapshot } from "@acpus/agent-executor";
import { fixtureEvent } from "./support/agent-turn.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import { openRuntimeStoreAdapter } from "../src/store/store.js";
import { settle } from "./effect.js";
import {
  runtimeDatabasePath,
  runtimeRow,
  withRuntimeWorkspace,
} from "./support/runtime-harness.js";

const observedAt = "2026-07-26T00:00:00.000Z";
type ObservationBase = "schemaVersion" | "sequence" | "observedAt" | "elapsedMs";
type ObservationEventInput = AgentTurnObservation["event"] extends infer Event
  ? Event extends unknown ? Omit<Event, ObservationBase> : never
  : never;
const agentMocks = vi.hoisted(() => ({
  executeAgentTurn: vi.fn<(request: AgentTurnRequest) => Promise<ObservationTurnResult>>(),
}));
type ObservationTurnResult = AgentTurnResult & { snapshot: AgentTurnSnapshot };
beforeEach(() => {
  agentMocks.executeAgentTurn.mockReset();
});

describe("Agent observation store projection", () => {
  it("reads only the latest Turn for each requested attempt", async () => {
    await withRuntimeWorkspace("agent-observation-latest-turns", async workspace => {
      const store = await openRuntimeStoreAdapter(workspace);
      const runId = "20260726000000LLLLLLLLLLLLLLLLLLLL";
      const attempts = [
        { attemptId: "attempt_a", nodeKey: "agent-a~1", nodeId: "agent-a" },
        { attemptId: "attempt_b", nodeKey: "agent-b~1", nodeId: "agent-b" },
      ];
      try {
        seedCaptureAttempts(workspace, runId, attempts);
        agentMocks.executeAgentTurn.mockResolvedValue(completedTurn());
        for (const attempt of attempts) {
          await captureSettledTurn(store, workspace, runId, attempt.attemptId, attempt.nodeKey, attempt.nodeId, 1);
          await captureSettledTurn(store, workspace, runId, attempt.attemptId, attempt.nodeKey, attempt.nodeId, 2);
        }

        const latest = await settle(store.observationLog.readInspectionProjection({
          runId,
          attemptIds: attempts.map(attempt => attempt.attemptId),
          latestTurnPerAttempt: true,
        }));

        expect(Result.isSuccess(latest)).toBe(true);
        if (Result.isFailure(latest)) throw latest.failure;
        expect(latest.success.turns.map(value => [value.attemptId, value.turn])).toEqual([
          ["attempt_a", 2],
          ["attempt_b", 2],
        ]);
        expect(latest.success.currents.map(value => [value.attemptId, value.turn])).toEqual([
          ["attempt_a", 2],
          ["attempt_b", 2],
        ]);
        expect(latest.success.omittedTurns).toBe(true);
      } finally {
        store.close();
      }
    });
  });

  it("preserves a completed tool's between phase through a usage checkpoint", async () => {
    await withRuntimeWorkspace("agent-observation-usage-telemetry", async workspace => {
      const store = await openRuntimeStoreAdapter(workspace);
      const runId = "20260726000000AAAAAAAAAAAAAAAAAAAA";
      const attemptId = "attempt_usage";
      let releaseProvider!: () => void;
      const providerRelease = new Promise<void>(resolve => {
        releaseProvider = resolve;
      });
      let inspectionReady!: () => void;
      const ready = new Promise<void>(resolve => {
        inspectionReady = resolve;
      });
      let capture: Promise<AgentTurnResult> | undefined;
      let beforeUsage: SemanticCheckpointRow | undefined;
      let afterUsage: SemanticCheckpointRow | undefined;
      let afterResponse: SemanticCheckpointRow | undefined;
      const forwarded: AgentTurnEvent[] = [];
      try {
        await mkdir(join(resolveRuntimeLayout(workspace).runsRoot, runId));
        seedCaptureAttempt(workspace, runId, attemptId);
        const initialSummary = completedTurn().summary;
        const telemetrySummary = diagnosticSummary();
        agentMocks.executeAgentTurn.mockImplementation(async request => {
          observeTurn(request, turnObservation(0, {
            type: "message",
            channel: "thought",
            content: "Inspect the evidence.",
          }, initialSummary));
          observeTurn(request, turnObservation(1, {
            type: "tool",
            action: "call",
            toolCallId: "tool-1",
            toolName: "Bash",
            status: "running",
            rawInput: { cmd: "pnpm test" },
          }, initialSummary));
          observeTurn(request, turnObservation(2, {
            type: "tool",
            action: "update",
            toolCallId: "tool-1",
            toolName: "Bash",
            status: "completed",
            rawOutput: "passed",
          }, initialSummary));
          beforeUsage = semanticCheckpoint(workspace, runId, attemptId);
          observeTurn(request, turnObservation(3, {
            type: "usage",
            context: { used: 95, size: 100 },
            tokenUsage: { inputTokens: 90, outputTokens: 5, totalTokens: 95 },
          }, telemetrySummary));
          afterUsage = semanticCheckpoint(workspace, runId, attemptId);
          observeTurn(request, turnObservation(4, {
            type: "message",
            channel: "assistant",
            content: "x".repeat(512),
          }, telemetrySummary, ["x".repeat(512)]));
          afterResponse = semanticCheckpoint(workspace, runId, attemptId);
          inspectionReady();
          await providerRelease;
          observeTurn(request, turnObservation(5, {
            type: "turn_end",
            status: "completed",
          }, telemetrySummary, ["x".repeat(512)]));
          return completedTurn(telemetrySummary, "x".repeat(512), {
            startedAt: observedAt,
            finishedAt: "2026-07-26T00:00:25.000Z",
            elapsedMs: 25_000,
          });
        });

        capture = Effect.runPromise(store.observationLog.captureTurn({
          runId,
          nodeId: "agent",
          nodeKey: "agent~1",
          attemptId,
          attemptNo: 1,
          turn: 1,
          promptKind: "task",
        }, {
          agent: { kind: "named" as const, name: "mock" },
          prompt: "work",
          cwd: workspace,
          env: {},
          agentSessionId: attemptId,
          permissionMode: "deny-all" as const,
          onEvent: event => {
            forwarded.push(event);
          },
        }, request => Effect.promise(() => agentMocks.executeAgentTurn(request)), cancelledTurn));
        await ready;

        expect(JSON.parse(beforeUsage?.currentJson ?? "{}")).toMatchObject({
          phase: "between",
          tools: {
            active: [],
            recent: expect.objectContaining({ name: "Bash", status: "completed" }),
          },
        });
        expect(afterUsage?.observationVersion).toBe((beforeUsage?.observationVersion ?? 0) + 1);
        expect(afterUsage?.currentObservationVersion)
          .toBe((beforeUsage?.currentObservationVersion ?? 0) + 1);
        const usageCurrent = JSON.parse(afterUsage?.currentJson ?? "{}");
        expect(usageCurrent).toMatchObject({
          phase: "between",
          context: { used: 95, size: 100 },
          tokenUsage: { source: "usage_update", totalTokens: 95 },
        });
        expect(usageCurrent).not.toHaveProperty("response");
        expect(afterResponse?.observationVersion).toBe((afterUsage?.observationVersion ?? 0) + 1);
        expect(afterResponse?.currentObservationVersion)
          .toBe((afterUsage?.currentObservationVersion ?? 0) + 1);
        const current = JSON.parse(afterResponse?.currentJson ?? "{}");
        expect(current).toMatchObject({
          phase: "responding",
          response: { originalBytes: 512 },
          context: { used: 95, size: 100 },
          tokenUsage: { source: "usage_update", totalTokens: 95 },
        });
        expect(current).not.toHaveProperty("totalToolCalls");
        expect(forwarded.find(observation => observation.event.type === "usage")?.event).toMatchObject({
          context: { used: 95, size: 100 },
          tokens: { totalTokens: 95 },
        });

        releaseProvider();
        await capture;
        const runDir = store.getRunDir(runId);
        if (!runDir) throw new Error("expected run directory");
        await expect(readdir(runDir)).resolves.not.toContain("evidence");
        const settled = await settle(store.observationLog.readInspectionProjection({
          runId,
          attemptIds: [attemptId],
          latestTurnPerAttempt: true,
          entryLimit: 50,
        }));
        expect(Result.isSuccess(settled)).toBe(true);
        if (Result.isFailure(settled)) throw settled.failure;
        expect(settled.success.currents).toEqual([
          expect.objectContaining({
            state: "settled",
            phase: "settled",
            response: expect.objectContaining({ originalBytes: 512 }),
            context: expect.objectContaining({ used: 95, size: 100 }),
            tokenUsage: expect.objectContaining({ source: "usage_update", totalTokens: 95 }),
          }),
        ]);
        expect(settled.success.entries.map(entry => entry.kind === "activity" ? entry.channel : entry.kind))
          .toEqual(["reported-thought", "tool", "response"]);
      } finally {
        releaseProvider?.();
        await capture?.catch(() => {});
        store.close();
      }
    });
  });

  it("settles completed current activity from final response without partial fallback", async () => {
    await withRuntimeWorkspace("agent-observation-final-response", async workspace => {
      const store = await openRuntimeStoreAdapter(workspace);
      const runId = "20260726000000BBBBBBBBBBBBBBBBBBBB";
      const attemptId = "attempt_final";
      try {
        await mkdir(join(resolveRuntimeLayout(workspace).runsRoot, runId));
        seedCaptureAttempt(workspace, runId, attemptId);
        const summary = diagnosticSummary();
        agentMocks.executeAgentTurn.mockImplementation(async request => {
          observeTurn(request, {
            event: {
              schemaVersion: 1,
              sequence: 0,
              observedAt,
              elapsedMs: 0,
              type: "message",
              channel: "assistant",
              content: "intermediate",
            },
            progress: { responses: ["intermediate"], summary, updatedAt: observedAt },
          });
          observeTurn(request, {
            event: {
              schemaVersion: 1,
              sequence: 1,
              observedAt,
              elapsedMs: 0,
              type: "turn_end",
              status: "completed",
            },
            progress: { responses: ["intermediate"], summary, updatedAt: observedAt },
          });
          return completedTurn(summary, "", undefined, ["intermediate"]);
        });

        await Effect.runPromise(store.observationLog.captureTurn({
          runId,
          nodeId: "agent",
          nodeKey: "agent~1",
          attemptId,
          attemptNo: 1,
          turn: 1,
          promptKind: "task",
        }, {
          agent: { kind: "named" as const, name: "mock" },
          prompt: "work",
          cwd: workspace,
          env: {},
          agentSessionId: attemptId,
          permissionMode: "deny-all" as const,
        }, request => Effect.promise(() => agentMocks.executeAgentTurn(request)), cancelledTurn));
        const settled = await settle(store.observationLog.readInspectionProjection({
          runId,
          attemptIds: [attemptId],
          latestTurnPerAttempt: true,
          entryLimit: 50,
        }));
        expect(Result.isSuccess(settled)).toBe(true);
        if (Result.isFailure(settled)) throw settled.failure;
        expect(settled.success.currents[0]).toMatchObject({ state: "settled", phase: "settled" });
        expect(settled.success.currents[0]).not.toHaveProperty("response");
        expect(settled.success.entries).toEqual([
          expect.objectContaining({ kind: "activity", channel: "response" }),
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("persists post-fence attribution when late activity shares the fence timestamp", async () => {
    await withRuntimeWorkspace("agent-observation-post-fence-attribution", async workspace => {
      const store = await openRuntimeStoreAdapter(workspace);
      const runId = "20260726000000CCCCCCCCCCCCCCCCCCCC";
      const attemptId = "attempt_fenced";
      const fenceAt = "2026-07-26T00:00:30.000Z";
      let providerStarted!: () => void;
      const started = new Promise<void>(resolve => {
        providerStarted = resolve;
      });
      let releaseLate!: () => void;
      const lateRelease = new Promise<void>(resolve => {
        releaseLate = resolve;
      });
      let lateObserved!: () => void;
      const lateReady = new Promise<void>(resolve => {
        lateObserved = resolve;
      });
      let finishProvider!: () => void;
      const finishRelease = new Promise<void>(resolve => {
        finishProvider = resolve;
      });
      let capture: Promise<AgentTurnResult> | undefined;
      try {
        await mkdir(join(resolveRuntimeLayout(workspace).runsRoot, runId));
        seedCaptureAttempt(workspace, runId, attemptId);
        const summary = completedTurn().summary;
        agentMocks.executeAgentTurn.mockImplementation(async request => {
          observeTurn(request, {
            event: {
              schemaVersion: 1,
              sequence: 0,
              observedAt: fenceAt,
              elapsedMs: 30_000,
              type: "message",
              channel: "assistant",
              content: "before fence",
            },
            progress: {
              responses: ["before fence"],
              summary,
              updatedAt: fenceAt,
            },
          });
          providerStarted();
          await lateRelease;
          observeTurn(request, {
            event: {
              schemaVersion: 1,
              sequence: 1,
              observedAt: fenceAt,
              elapsedMs: 30_000,
              type: "message",
              channel: "assistant",
              content: " after fence",
            },
            progress: {
              responses: ["before fence after fence"],
              summary,
              updatedAt: fenceAt,
            },
          });
          lateObserved();
          await finishRelease;
          observeTurn(request, {
            event: {
              schemaVersion: 1,
              sequence: 2,
              observedAt: fenceAt,
              elapsedMs: 30_000,
              type: "turn_end",
              status: "completed",
            },
            progress: {
              responses: ["before fence after fence"],
              summary,
              updatedAt: fenceAt,
            },
          });
          return completedTurn(summary, "before fence after fence", {
            startedAt: fenceAt,
            finishedAt: fenceAt,
            elapsedMs: 0,
          });
        });

        capture = Effect.runPromise(store.observationLog.captureTurn({
          runId,
          nodeId: "agent",
          nodeKey: "agent~1",
          attemptId,
          attemptNo: 1,
          turn: 1,
          promptKind: "task",
        }, {
          agent: { kind: "named" as const, name: "mock" },
          prompt: "work",
          cwd: workspace,
          env: {},
          agentSessionId: attemptId,
          permissionMode: "deny-all" as const,
        }, request => Effect.promise(() => agentMocks.executeAgentTurn(request)), cancelledTurn));
        await started;
        await Effect.runPromise(store.observationLog.markFenced({
          runId,
          attemptId,
          eventSequence: 42,
          committedAt: fenceAt,
          reason: "operator_steered",
        }));
        releaseLate();
        await lateReady;

        const active = await settle(store.observationLog.readInspectionProjection({
          runId,
          attemptIds: [attemptId],
        }));
        expect(Result.isSuccess(active)).toBe(true);
        if (Result.isFailure(active)) throw active.failure;
        expect(active.success.currents).toEqual([
          expect.objectContaining({
            attemptId,
            updatedAt: fenceAt,
            postFence: true,
            response: expect.objectContaining({ text: " after fence" }),
          }),
        ]);

        finishProvider();
        await capture;
        const settled = await settle(store.observationLog.readInspectionProjection({
          runId,
          attemptIds: [attemptId],
          entryLimit: 2,
        }));
        expect(Result.isSuccess(settled)).toBe(true);
        if (Result.isFailure(settled)) throw settled.failure;
        expect(settled.success.entries
          .filter(entry => entry.kind === "activity")
          .sort((left, right) => left.sourceSequence - right.sourceSequence)
          .map(entry => ({
            at: entry.at,
            text: entry.summary.text,
            postFence: entry.postFence,
          }))).toEqual([
          { at: fenceAt, text: "before fence", postFence: undefined },
          { at: fenceAt, text: " after fence", postFence: true },
        ]);
      } finally {
        releaseLate?.();
        finishProvider?.();
        await capture?.catch(() => {});
        store.close();
      }
    });
  });

  it("enforces entry-count and payload-byte retention without recording a gap", async () => {
    await withRuntimeWorkspace("agent-observation-entry-retention", async workspace => {
      const store = await openRuntimeStoreAdapter(workspace);
      const runId = "20260726000000EEEEEEEEEEEEEEEEEEEE";
      const countAttemptId = "attempt_count";
      const byteAttemptId = "attempt_bytes";
      try {
        await mkdir(join(resolveRuntimeLayout(workspace).runsRoot, runId));
        seedRetentionAttempts(workspace, runId, countAttemptId, byteAttemptId);
        agentMocks.executeAgentTurn.mockResolvedValue(completedTurn());

        await captureSettledTurn(store, workspace, runId, countAttemptId, "count~1", "count");
        await captureSettledTurn(store, workspace, runId, byteAttemptId, "bytes~1", "bytes");

        expect(runtimeRow(
          workspace,
          `SELECT COUNT(*) AS count, SUM(payload_bytes) AS bytes
           FROM agent_observation_entries
           WHERE run_id = ? AND attempt_id = ?`,
          runId,
          countAttemptId,
        )).toEqual({ count: 128, bytes: expect.any(Number) });
        expect(runtimeRow(
          workspace,
          `SELECT retention_omitted_count, retention_floor_version
           FROM agent_observation_attempts
           WHERE run_id = ? AND attempt_id = ?`,
          runId,
          countAttemptId,
        )).toEqual({
          retention_omitted_count: 12,
          retention_floor_version: 12,
        });

        const byteStats = runtimeRow(
          workspace,
          `SELECT COUNT(*) AS count, SUM(payload_bytes) AS bytes
           FROM agent_observation_entries
           WHERE run_id = ? AND attempt_id = ?`,
          runId,
          byteAttemptId,
        ) as { count: number; bytes: number };
        expect(byteStats.count).toBeLessThan(100);
        expect(byteStats.bytes).toBeLessThanOrEqual(128 * 1024);
        const byteOmitted = 100 - byteStats.count;
        expect(runtimeRow(
          workspace,
          `SELECT retention_omitted_count, retention_floor_version
           FROM agent_observation_attempts
           WHERE run_id = ? AND attempt_id = ?`,
          runId,
          byteAttemptId,
        )).toEqual({
          retention_omitted_count: byteOmitted,
          retention_floor_version: 140 + byteOmitted,
        });
        expect(runtimeRow(
          workspace,
          `SELECT SUM(gap_count) AS gaps, MAX(degraded) AS degraded
           FROM agent_observation_turns
           WHERE run_id = ?`,
          runId,
        )).toEqual({ gaps: 0, degraded: 0 });
      } finally {
        store.close();
      }
    });
  });

  it("pages entries that share one observation version without skipping a sibling", async () => {
    await withRuntimeWorkspace("agent-observation-entry-cursor", async workspace => {
      const store = await openRuntimeStoreAdapter(workspace);
      const runId = "20260726000000BBBBBBBBBBBBBBBBBBBB";
      const attemptId = "attempt_page";
      try {
        seedObservationTurn(workspace, runId, attemptId);

        const first = await settle(store.observationLog.readInspectionProjection({
          runId,
          attemptIds: [attemptId],
          entryLimit: 1,
        }));
        expect(Result.isSuccess(first)).toBe(true);
        if (Result.isFailure(first)) throw first.failure;
        expect(first.success.entries.map(entry => entry.sourceSequence)).toEqual([2]);
        expect(first.success).toMatchObject({
          olderEntryCount: 1,
          hasOlderEntries: true,
        });

        const boundary = first.success.entries[0]!;
        const second = await settle(store.observationLog.readInspectionProjection({
          runId,
          attemptIds: [attemptId],
          entryLimit: 1,
          beforeEntry: {
            observationVersion: boundary.observationVersion,
            sourceSequence: boundary.sourceSequence,
            id: boundary.id,
          },
        }));
        expect(Result.isSuccess(second)).toBe(true);
        if (Result.isFailure(second)) throw second.failure;
        expect(second.success.entries.map(entry => entry.sourceSequence)).toEqual([1]);
        expect(second.success).toMatchObject({
          olderEntryCount: 0,
          hasOlderEntries: false,
        });
      } finally {
        store.close();
      }
    });
  });
});

async function captureSettledTurn(
  store: Awaited<ReturnType<typeof openRuntimeStoreAdapter>>,
  workspace: string,
  runId: string,
  attemptId: string,
  nodeKey: string,
  nodeId: string,
  turn = 2,
): Promise<void> {
  await Effect.runPromise(store.observationLog.captureTurn({
    runId,
    nodeId,
    nodeKey,
    attemptId,
    attemptNo: 1,
    turn,
    promptKind: "task",
  }, {
    agent: { kind: "named" as const, name: "mock" },
    prompt: "continue",
    cwd: workspace,
    env: {},
    agentSessionId: attemptId,
    permissionMode: "deny-all" as const,
  }, request => Effect.promise(() => agentMocks.executeAgentTurn(request)), cancelledTurn));
}

function completedTurn(
  summary: AgentTurnResult["summary"] = {
    eventCount: 0,
    availability: { context: "unavailable", tokenUsage: "unavailable" },
    tools: { totalToolCallCount: 0, calls: [] },
  },
  finalResponse = "done",
  timing: AgentTurnResult["timing"] = {
    startedAt: observedAt,
    finishedAt: observedAt,
    elapsedMs: 0,
  },
  responses: readonly string[] = finalResponse.length === 0 ? [] : [finalResponse],
): ObservationTurnResult {
  const snapshot = { responses, summary, timing };
  return {
    status: "completed",
    responses,
    finalResponse,
    stderr: "",
    summary,
    timing,
    snapshot,
  };
}

function diagnosticSummary(): AgentTurnResult["summary"] {
  return {
    eventCount: 3,
    availability: { context: "available", tokenUsage: "available" },
    context: {
      used: 95,
      size: 100,
      updatedAt: "2026-07-26T00:00:20.000Z",
    },
    tokenUsage: {
      source: "usage_update",
      inputTokens: 90,
      outputTokens: 5,
      totalTokens: 95,
    },
    tools: { totalToolCallCount: 12, calls: [] },
  };
}

function turnObservation(
  sequence: number,
  event: ObservationEventInput,
  summary: AgentTurnResult["summary"],
  responses: readonly string[] = [],
): AgentTurnObservation {
  const updatedAt = `2026-07-26T00:00:${20 + sequence}.000Z`;
  return {
    event: {
      schemaVersion: 1,
      sequence,
      observedAt: updatedAt,
      elapsedMs: (20 + sequence) * 1_000,
      ...event,
    } as AgentTurnObservation["event"],
    progress: { responses, summary, updatedAt },
  };
}

function observeTurn(request: AgentTurnRequest, observation: AgentTurnObservation): void {
  const projected = fixtureEvent(observation.event);
  if (!projected) return;
  request.onEvent?.({
    sequence: observation.event.sequence,
    observedAt: observation.event.observedAt,
    elapsedMs: observation.event.elapsedMs,
    event: projected,
  });
}

function cancelledTurn(): ObservationTurnResult {
  const summary = completedTurn().summary;
  const timing = { startedAt: observedAt, finishedAt: observedAt, elapsedMs: 0 };
  return {
    status: "cancelled",
    message: "fenced before provider dispatch",
    responses: [],
    stderr: "",
    summary,
    timing,
    snapshot: { responses: [], summary, timing },
  };
}

type SemanticCheckpointRow = {
  observationVersion: number;
  currentObservationVersion: number;
  currentUpdatedAt: string;
  currentJson: string;
};

function semanticCheckpoint(
  workspace: string,
  runId: string,
  attemptId: string,
): SemanticCheckpointRow {
  const row = runtimeRow(
    workspace,
    `SELECT r.observation_version,
            t.current_observation_version,
            t.current_updated_at,
            t.current_json
     FROM runs AS r
     JOIN agent_observation_turns AS t ON t.run_id = r.id
     WHERE r.id = ? AND t.attempt_id = ? AND t.turn_no = 1`,
    runId,
    attemptId,
  ) as {
    observation_version: number;
    current_observation_version: number;
    current_updated_at: string;
    current_json: string;
  };
  return {
    observationVersion: row.observation_version,
    currentObservationVersion: row.current_observation_version,
    currentUpdatedAt: row.current_updated_at,
    currentJson: row.current_json,
  };
}

function seedCaptureAttempt(workspace: string, runId: string, attemptId: string): void {
  seedCaptureAttempts(workspace, runId, [{ attemptId, nodeKey: "agent~1", nodeId: "agent" }]);
}

function seedCaptureAttempts(
  workspace: string,
  runId: string,
  attempts: readonly { attemptId: string; nodeKey: string; nodeId: string }[],
): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    db.prepare(`
      INSERT INTO runs (
        id, name, status, workflow_entry, source_graph_digest,
        created_at, updated_at
      )
      VALUES (?, 'usage telemetry', 'running', 'workflow.ts', 'sha256:test', ?, ?)
    `).run(runId, observedAt, observedAt);
    const insertAttempt = db.prepare(`
      INSERT INTO node_attempts (
        run_id, attempt_id, node_key, node_id, attempt_no,
        owner_epoch, status, started_at
      )
      VALUES (?, ?, ?, ?, 1, 1, 'started', ?)
    `);
    for (const attempt of attempts) {
      insertAttempt.run(runId, attempt.attemptId, attempt.nodeKey, attempt.nodeId, observedAt);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function seedRetentionAttempts(
  workspace: string,
  runId: string,
  countAttemptId: string,
  byteAttemptId: string,
): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    db.prepare(`
      INSERT INTO runs (
        id, name, status, workflow_entry, source_graph_digest,
        observation_version, observation_updated_at, created_at, updated_at
      )
      VALUES (?, 'observation retention', 'running', 'workflow.ts', 'sha256:test',
              240, ?, ?, ?)
    `).run(runId, observedAt, observedAt, observedAt);
    const insertAttempt = db.prepare(`
      INSERT INTO node_attempts (
        run_id, attempt_id, node_key, node_id, attempt_no,
        owner_epoch, status, started_at
      )
      VALUES (?, ?, ?, ?, 1, 1, 'started', ?)
    `);
    insertAttempt.run(runId, countAttemptId, "count~1", "count", observedAt);
    insertAttempt.run(runId, byteAttemptId, "bytes~1", "bytes", observedAt);
    const insertAttemptObservation = db.prepare(`
      INSERT INTO agent_observation_attempts (
        run_id, attempt_id, latest_observation_version
      )
      VALUES (?, ?, 240)
    `);
    insertAttemptObservation.run(runId, countAttemptId);
    insertAttemptObservation.run(runId, byteAttemptId);
    const insertTurn = db.prepare(`
      INSERT INTO agent_observation_turns (
        run_id, attempt_id, node_key, node_id, attempt_no, turn_no,
        prompt_kind, state, started_at, finished_at
      )
      VALUES (?, ?, ?, ?, 1, 1, 'task', 'settled', ?, ?)
    `);
    insertTurn.run(
      runId,
      countAttemptId,
      "count~1",
      "count",
      observedAt,
      observedAt,
    );
    insertTurn.run(
      runId,
      byteAttemptId,
      "bytes~1",
      "bytes",
      observedAt,
      observedAt,
    );
    const insertEntry = db.prepare(`
      INSERT INTO agent_observation_entries (
        run_id, attempt_id, turn_no, entry_id, observation_version,
        source_sequence, observed_at, kind, payload_json, payload_bytes
      )
      VALUES (?, ?, 1, ?, ?, ?, ?, 'activity', ?, ?)
    `);
    const smallPayload = entryPayload("x");
    for (let index = 1; index <= 140; index += 1) {
      insertEntry.run(
        runId,
        countAttemptId,
        `count-${index}`,
        index,
        index,
        observedAt,
        smallPayload,
        Buffer.byteLength(smallPayload),
      );
    }
    const largePayload = entryPayload("x".repeat(2048));
    for (let index = 1; index <= 100; index += 1) {
      insertEntry.run(
        runId,
        byteAttemptId,
        `bytes-${index}`,
        140 + index,
        index,
        observedAt,
        largePayload,
        Buffer.byteLength(largePayload),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function entryPayload(text: string): string {
  return JSON.stringify({
    channel: "response",
    summary: {
      text,
      originalBytes: Buffer.byteLength(text),
      truncated: false,
    },
  });
}

function seedObservationTurn(workspace: string, runId: string, attemptId: string): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    db.prepare(`
      INSERT INTO runs (
        id, name, status, workflow_entry, source_graph_digest,
        observation_version, observation_updated_at, created_at, updated_at
      )
      VALUES (?, 'observation paging', 'running', 'workflow.ts', 'sha256:test', 7, ?, ?, ?)
    `).run(runId, observedAt, observedAt, observedAt);
    db.prepare(`
      INSERT INTO node_attempts (
        run_id, attempt_id, node_key, node_id, attempt_no,
        owner_epoch, status, started_at
      )
      VALUES (?, ?, 'agent~1', 'agent', 1, 1, 'started', ?)
    `).run(runId, attemptId, observedAt);
    db.prepare(`
      INSERT INTO agent_observation_attempts (
        run_id, attempt_id, latest_observation_version
      )
      VALUES (?, ?, 7)
    `).run(runId, attemptId);
    db.prepare(`
      INSERT INTO agent_observation_turns (
        run_id, attempt_id, node_key, node_id, attempt_no, turn_no,
        prompt_kind, state, started_at
      )
      VALUES (?, ?, 'agent~1', 'agent', 1, 1, 'task', 'recording', ?)
    `).run(runId, attemptId, observedAt);
    const payload = JSON.stringify({
      channel: "response",
      summary: { text: "chunk", originalBytes: 5, truncated: false },
    });
    const insert = db.prepare(`
      INSERT INTO agent_observation_entries (
        run_id, attempt_id, turn_no, entry_id, observation_version,
        source_sequence, observed_at, kind, payload_json, payload_bytes
      )
      VALUES (?, ?, 1, ?, 7, ?, ?, 'activity', ?, ?)
    `);
    insert.run(runId, attemptId, "entry-1", 1, observedAt, payload, Buffer.byteLength(payload));
    insert.run(runId, attemptId, "entry-2", 2, observedAt, payload, Buffer.byteLength(payload));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}
