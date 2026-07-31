import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openRuntimeStore } from "../src/store/store.js";
import {
  runtimeDatabasePath,
  runtimeRow,
  runtimeRows,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";

const observedAt = "2026-07-26T00:00:00.000Z";
const finishedAt = "2026-07-26T00:00:05.000Z";

describe("Agent observation reconciliation", () => {
  it("closes terminal recording turns without touching a started attempt", async () => {
    await withRuntimeWorkspace("agent-observation-terminal-reconciliation", async workspace => {
      const store = await openRuntimeStore(workspace);
      const runId = "20260726000000AAAAAAAAAAAAAAAAAAAA";
      const completedAttemptId = "attempt_completed";
      const startedAttemptId = "attempt_started";
      try {
        seedRun(workspace, runId, "canceled");
        seedAttempt(workspace, {
          runId,
          attemptId: completedAttemptId,
          nodeKey: "completed~1",
          nodeId: "completed",
          attemptNo: 1,
          status: "completed",
          finishedAt,
        });
        seedAttempt(workspace, {
          runId,
          attemptId: startedAttemptId,
          nodeKey: "started~1",
          nodeId: "started",
          attemptNo: 2,
          status: "started",
        });
        seedObservationTurn(workspace, {
          runId,
          attemptId: completedAttemptId,
          nodeKey: "completed~1",
          nodeId: "completed",
          attemptNo: 1,
        });
        seedObservationTurn(workspace, {
          runId,
          attemptId: startedAttemptId,
          nodeKey: "started~1",
          nodeId: "started",
          attemptNo: 2,
        });

        await store.observationLog.reconcileTerminalTurns();

        expect(runtimeRows(
          workspace,
          `SELECT attempt_id, state, degraded, gap_count, provider_status,
                  current_json, finished_at
           FROM agent_observation_turns
           WHERE run_id = ?
           ORDER BY attempt_no`,
          runId,
        )).toEqual([
          {
            attempt_id: completedAttemptId,
            state: "incomplete",
            degraded: 1,
            gap_count: 1,
            provider_status: null,
            current_json: null,
            finished_at: finishedAt,
          },
          {
            attempt_id: startedAttemptId,
            state: "recording",
            degraded: 0,
            gap_count: 0,
            provider_status: null,
            current_json: startingCurrent(startedAttemptId),
            finished_at: null,
          },
        ]);
        expect(runtimeRows(
          workspace,
          `SELECT attempt_id, kind, payload_json
           FROM agent_observation_entries
           WHERE run_id = ?
           ORDER BY source_sequence`,
          runId,
        )).toEqual([
          {
            attempt_id: completedAttemptId,
            kind: "activity",
            payload_json: expect.stringContaining('"channel":"response"'),
          },
          {
            attempt_id: completedAttemptId,
            kind: "gap",
            payload_json: JSON.stringify({
              dropped: 1,
              reason: "provider_settlement_missing_recovery",
            }),
          },
        ]);
        const version = runtimeRow(
          workspace,
          "SELECT observation_version FROM runs WHERE id = ?",
          runId,
        );
        await store.observationLog.reconcileTerminalTurns();
        expect(runtimeRow(
          workspace,
          "SELECT observation_version FROM runs WHERE id = ?",
          runId,
        )).toEqual(version);
      } finally {
        store.close();
      }
    });
  });

  it("reconciles a superseded turn with its durable steer control but not its instruction", async () => {
    await withRuntimeWorkspace("agent-observation-steer-reconciliation", async workspace => {
      const store = await openRuntimeStore(workspace);
      const runId = "20260726000000BBBBBBBBBBBBBBBBBBBB";
      const attemptId = "attempt_steered";
      try {
        seedRun(workspace, runId, "running");
        seedAttempt(workspace, {
          runId,
          attemptId,
          nodeKey: "agent~1",
          nodeId: "agent",
          attemptNo: 1,
          status: "superseded",
          finishedAt,
        });
        seedObservationTurn(workspace, {
          runId,
          attemptId,
          nodeKey: "agent~1",
          nodeId: "agent",
          attemptNo: 1,
        });
        const db = new DatabaseSync(runtimeDatabasePath(workspace));
        try {
          db.prepare(`
            INSERT INTO run_events (
              run_id, sequence, type, node_key, payload_json, created_at, idempotency_key
            )
            VALUES (?, 5, 'control.agent_steer_requested', 'agent~1', ?, ?, 'steer-reconcile')
          `).run(runId, JSON.stringify({
            steerId: "internal-steer",
            requestedTarget: attemptId,
            nodeKey: "agent~1",
            fencedAttemptId: attemptId,
            instruction: "private steering instruction",
          }), finishedAt);
        } finally {
          db.close();
        }

        const reconciled = await store.observationLog.reconcileInterruptedTurns(runId);
        expect(reconciled.isOk()).toBe(true);
        expect(runtimeRow(
          workspace,
          `SELECT state, degraded, gap_count, fence_event_sequence,
                  fenced_at, fence_reason, provider_status
           FROM agent_observation_turns
           WHERE run_id = ? AND attempt_id = ?`,
          runId,
          attemptId,
        )).toEqual({
          state: "incomplete",
          degraded: 1,
          gap_count: 1,
          fence_event_sequence: 5,
          fenced_at: finishedAt,
          fence_reason: "operator_steered",
          provider_status: null,
        });
        const projection = await store.observationLog.readInspectionProjection({
          runId,
          attemptIds: [attemptId],
          entryLimit: 10,
        });
        expect(projection.isOk()).toBe(true);
        if (projection.isErr()) throw projection.error;
        expect(projection.value.entries.map(entry => entry.kind)).toEqual(["activity", "gap"]);
        expect(JSON.stringify(projection.value)).not.toContain("private steering instruction");

        const version = projection.value.version;
        const repeated = await store.observationLog.reconcileInterruptedTurns(runId);
        expect(repeated.isOk()).toBe(true);
        expect((await store.observationLog.readInspectionProjection({ runId }))._unsafeUnwrap().version)
          .toBe(version);
      } finally {
        store.close();
      }
    });
  });

  it("records one gap when a durable fence has no active writer", async () => {
    await withRuntimeWorkspace("agent-observation-unavailable-fence", async workspace => {
      const store = await openRuntimeStore(workspace);
      const runId = "20260726000000CCCCCCCCCCCCCCCCCCCC";
      const attemptId = "attempt_fenced";
      try {
        seedRun(workspace, runId, "running");
        seedAttempt(workspace, {
          runId,
          attemptId,
          nodeKey: "agent~1",
          nodeId: "agent",
          attemptNo: 1,
          status: "started",
        });
        seedObservationTurn(workspace, {
          runId,
          attemptId,
          nodeKey: "agent~1",
          nodeId: "agent",
          attemptNo: 1,
        });

        const fence = {
          runId,
          attemptId,
          eventSequence: 9,
          committedAt: finishedAt,
          reason: "operator_steered",
        };
        await store.observationLog.markFenced(fence);
        await store.observationLog.markFenced(fence);

        expect(runtimeRow(
          workspace,
          `SELECT state, degraded, gap_count, fence_event_sequence, current_json
           FROM agent_observation_turns
           WHERE run_id = ? AND attempt_id = ?`,
          runId,
          attemptId,
        )).toEqual({
          state: "incomplete",
          degraded: 1,
          gap_count: 1,
          fence_event_sequence: 9,
          current_json: null,
        });
        expect(runtimeRows(
          workspace,
          `SELECT kind, payload_json
           FROM agent_observation_entries
           WHERE run_id = ? AND attempt_id = ?
           ORDER BY source_sequence`,
          runId,
          attemptId,
        )).toEqual([
          {
            kind: "activity",
            payload_json: expect.stringContaining('"channel":"response"'),
          },
          {
            kind: "gap",
            payload_json: JSON.stringify({
              dropped: 1,
              reason: "observation_boundary_unavailable",
            }),
          },
        ]);
        await expect(store.observationLog.markFenced({
          ...fence,
          eventSequence: 10,
        })).rejects.toThrow("different durable fence");
      } finally {
        store.close();
      }
    });
  });
});

function seedRun(
  workspace: string,
  runId: string,
  status: "running" | "canceled",
): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.prepare(`
      INSERT INTO runs (
        id, name, status, workflow_entry, source_graph_digest, created_at, updated_at
      )
      VALUES (?, 'observation reconciliation', ?, 'workflow.ts', 'sha256:test', ?, ?)
    `).run(runId, status, observedAt, observedAt);
  } finally {
    db.close();
  }
}

function seedAttempt(workspace: string, input: {
  runId: string;
  attemptId: string;
  nodeKey: string;
  nodeId: string;
  attemptNo: number;
  status: string;
  finishedAt?: string;
}): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.prepare(`
      INSERT INTO node_attempts (
        run_id, attempt_id, node_key, node_id, attempt_no,
        owner_epoch, status, started_at, finished_at
      )
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      input.runId,
      input.attemptId,
      input.nodeKey,
      input.nodeId,
      input.attemptNo,
      input.status,
      observedAt,
      input.finishedAt ?? null,
    );
  } finally {
    db.close();
  }
}

function seedObservationTurn(workspace: string, input: {
  runId: string;
  attemptId: string;
  nodeKey: string;
  nodeId: string;
  attemptNo: number;
}): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  const current = startingCurrent(input.attemptId);
  try {
    db.prepare(`
      INSERT INTO agent_observation_turns (
        run_id, attempt_id, node_key, node_id, attempt_no, turn_no,
        prompt_kind, state, current_json, current_bytes, current_updated_at,
        started_at
      )
      VALUES (?, ?, ?, ?, ?, 1, 'task', 'recording', ?, ?, ?, ?)
    `).run(
      input.runId,
      input.attemptId,
      input.nodeKey,
      input.nodeId,
      input.attemptNo,
      current,
      Buffer.byteLength(current),
      observedAt,
      observedAt,
    );
  } finally {
    db.close();
  }
}

function startingCurrent(attemptId: string): string {
  return JSON.stringify({
    attemptId,
    turn: 1,
    promptKind: "task",
    phase: "responding",
    updatedAt: observedAt,
    response: {
      text: "partial response",
      originalBytes: 16,
      truncated: false,
    },
    state: "recording",
    completeness: "complete",
  });
}
