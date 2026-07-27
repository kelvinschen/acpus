import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import { openRuntimeStore } from "../src/store/store.js";
import {
  runtimeDatabasePath,
  runtimeRow,
  runtimeRows,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";

const observedAt = "2026-07-26T00:00:00.000Z";

describe("Agent observation recovery", () => {
  it("recovers terminal-run evidence without touching a started attempt", async () => {
    await withRuntimeWorkspace("agent-observation-terminal-recovery", async workspace => {
      const store = await openRuntimeStore(workspace);
      const runId = "20260726000000AAAAAAAAAAAAAAAAAAAA";
      const completedAttemptId = "attempt_completed";
      const startedAttemptId = "attempt_started";
      const layout = resolveRuntimeLayout(workspace);
      const runDir = join(layout.runsRoot, runId);
      const completedRelativePath = `evidence/agents/${completedAttemptId}/turn-001.evidence.jsonl.partial`;
      const startedRelativePath = `evidence/agents/${startedAttemptId}/turn-001.evidence.jsonl.partial`;
      const orphanRelativePath = "evidence/agents/attempt_orphan/turn-001.evidence.jsonl.partial";
      const journal = observationJournal(runId);

      try {
        await Promise.all([
          writeJournal(runDir, completedRelativePath, journal),
          writeJournal(runDir, startedRelativePath, journal),
          writeJournal(runDir, orphanRelativePath, journal),
        ]);
        const db = new DatabaseSync(runtimeDatabasePath(workspace));
        try {
          db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
          db.prepare(`
            INSERT INTO runs (
              id, name, status, workflow_entry, source_graph_digest, created_at, updated_at
            )
            VALUES (?, 'terminal recovery', 'canceled', 'workflow.ts', 'sha256:test', ?, ?)
          `).run(runId, observedAt, observedAt);
          db.prepare(`
            INSERT INTO node_attempts (
              run_id, attempt_id, node_key, node_id, attempt_no, owner_epoch,
              status, started_at, finished_at
            )
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
          `).run(runId, completedAttemptId, "completed~1", "completed", 1, "completed", observedAt, observedAt);
          db.prepare(`
            INSERT INTO node_attempts (
              run_id, attempt_id, node_key, node_id, attempt_no, owner_epoch,
              status, started_at
            )
            VALUES (?, ?, ?, ?, ?, 1, 'started', ?)
          `).run(runId, startedAttemptId, "started~1", "started", 2, observedAt);
          insertObservationTurn(db, {
            runId,
            attemptId: completedAttemptId,
            nodeKey: "completed~1",
            nodeId: "completed",
            attemptNo: 1,
            relativePath: completedRelativePath,
          });
          insertObservationTurn(db, {
            runId,
            attemptId: startedAttemptId,
            nodeKey: "started~1",
            nodeId: "started",
            attemptNo: 2,
            relativePath: startedRelativePath,
          });
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        } finally {
          db.close();
        }

        await store.observationLog.recoverTerminalPartialTurns();

        expect(runtimeRows(
          workspace,
          `SELECT attempt_id, relative_path, state, provider_status, final_response_bytes
           FROM agent_observation_turns
           WHERE run_id = ?
           ORDER BY attempt_no`,
          runId,
        )).toEqual([
          {
            attempt_id: completedAttemptId,
            relative_path: completedRelativePath.replace(/\.partial$/, ""),
            state: "sealed",
            provider_status: "completed",
            final_response_bytes: Buffer.byteLength("finished"),
          },
          {
            attempt_id: startedAttemptId,
            relative_path: startedRelativePath,
            state: "recording",
            provider_status: null,
            final_response_bytes: null,
          },
        ]);
        expect(runtimeRows(
          workspace,
          `SELECT attempt_id, latest_observation_version, retention_omitted_count
           FROM agent_observation_attempts
           WHERE run_id = ?`,
          runId,
        )).toEqual([{
          attempt_id: completedAttemptId,
          latest_observation_version: 1,
          retention_omitted_count: 0,
        }]);
        expect(runtimeRows(
          workspace,
          "SELECT entry_id FROM agent_observation_entries WHERE run_id = ?",
          runId,
        )).toEqual([]);
        expect(runtimeRow(
          workspace,
          "SELECT observation_version FROM runs WHERE id = ?",
          runId,
        )).toEqual({ observation_version: 1 });
        await store.observationLog.recoverTerminalPartialTurns();
        expect(runtimeRow(
          workspace,
          "SELECT observation_version FROM runs WHERE id = ?",
          runId,
        )).toEqual({ observation_version: 1 });
        await expect(readFile(
          join(runDir, completedRelativePath.replace(/\.partial$/, "")),
          "utf8",
        )).resolves.toContain("\"type\":\"turn_end\"");
        await expect(access(join(runDir, completedRelativePath))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(access(join(runDir, orphanRelativePath))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(join(runDir, startedRelativePath), "utf8")).resolves.toBe(journal);
      } finally {
        store.close();
      }
    });
  });

  it("recovers a missing durable steer fence once without persisting its instruction", async () => {
    await withRuntimeWorkspace("agent-observation-durable-fence-recovery", async workspace => {
      const store = await openRuntimeStore(workspace);
      const runId = "20260726000000CCCCCCCCCCCCCCCCCCCC";
      const attemptId = "attempt_steered";
      const layout = resolveRuntimeLayout(workspace);
      const runDir = join(layout.runsRoot, runId);
      const relativePath = `evidence/agents/${attemptId}/turn-001.evidence.jsonl`;
      const journal = observationJournal(runId);
      const current = startingCurrent(attemptId);
      try {
        await writeJournal(runDir, relativePath, journal);
        const db = new DatabaseSync(runtimeDatabasePath(workspace));
        try {
          db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
          insertRun(db, runId);
          db.prepare(`
            INSERT INTO node_attempts (
              run_id, attempt_id, node_key, node_id, attempt_no, owner_epoch,
              status, started_at, finished_at, cancel_reason
            )
            VALUES (?, ?, 'agent~1', 'agent', 1, 1, 'superseded', ?, ?, 'operator_steered')
          `).run(runId, attemptId, observedAt, observedAt);
          insertObservationTurn(db, {
            runId,
            attemptId,
            nodeKey: "agent~1",
            nodeId: "agent",
            attemptNo: 1,
            relativePath,
          });
          db.prepare(`
            UPDATE agent_observation_turns
            SET state = 'sealed', indexed_bytes = ?, last_record_sequence = 1,
                provider_status = 'completed', finished_at = ?,
                current_json = ?, current_bytes = ?
            WHERE run_id = ? AND attempt_id = ?
          `).run(
            Buffer.byteLength(journal),
            observedAt,
            current,
            Buffer.byteLength(current),
            runId,
            attemptId,
          );
          db.prepare(`
            INSERT INTO run_events (
              run_id, sequence, type, node_key, payload_json, created_at, idempotency_key
            )
            VALUES (?, 5, 'control.agent_steer_requested', 'agent~1', ?, ?, 'steer-recovery')
          `).run(runId, JSON.stringify({
            steerId: "internal-steer",
            requestedTarget: attemptId,
            nodeKey: "agent~1",
            fencedAttemptId: attemptId,
            instruction: "private recovery instruction",
          }), observedAt);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        } finally {
          db.close();
        }

        await store.observationLog.recoverPartialTurns(runId);
        expect(runtimeRow(
          workspace,
          `SELECT state, degraded, gap_count, fence_event_sequence,
                  response_at_fence_bytes
           FROM agent_observation_turns
           WHERE run_id = ? AND attempt_id = ?`,
          runId,
          attemptId,
        )).toEqual({
          state: "sealed",
          degraded: 1,
          gap_count: 0,
          fence_event_sequence: 5,
          response_at_fence_bytes: null,
        });
        const recovered = await readFile(join(runDir, relativePath), "utf8");
        expect(recovered.trim().split("\n").map(line => JSON.parse(line).type)).toEqual([
          "turn_start",
          "turn_end",
          "fence",
        ]);
        expect(recovered).not.toContain("private recovery instruction");
        expect(runtimeRows(
          workspace,
          `SELECT entry_id
           FROM agent_observation_entries
           WHERE run_id = ? AND attempt_id = ?`,
          runId,
          attemptId,
        )).toEqual([]);
        expect(runtimeRow(workspace, "SELECT observation_version FROM runs WHERE id = ?", runId))
          .toEqual({ observation_version: 1 });

        await rm(join(runDir, relativePath));
        await store.observationLog.recoverPartialTurns(runId);
        expect(runtimeRow(workspace, "SELECT observation_version FROM runs WHERE id = ?", runId))
          .toEqual({ observation_version: 1 });
      } finally {
        store.close();
      }
    });
  });

  it("finishes trace publication after an artifact-register crash window", async () => {
    await withRuntimeWorkspace("agent-observation-trace-publication-recovery", async workspace => {
      const store = await openRuntimeStore(workspace);
      const runId = "20260726000000DDDDDDDDDDDDDDDDDDDD";
      const attemptId = "attempt_trace";
      const layout = resolveRuntimeLayout(workspace);
      const runDir = join(layout.runsRoot, runId);
      const traceRelativePath = `evidence/agents/${attemptId}/turn-001.trace.jsonl`;
      const artifactRelativePath = `artifacts/agent~1/attempt-1/${attemptId}/agent/turn-001.trace.jsonl`;
      const trace = `${JSON.stringify({ schemaVersion: 1, sequence: 0, type: "turn_start" })}\n`;
      const digest = `sha256:${createHash("sha256").update(trace).digest("hex")}`;
      try {
        await Promise.all([
          writeJournal(runDir, traceRelativePath, trace),
          writeJournal(runDir, artifactRelativePath, trace),
        ]);
        const db = new DatabaseSync(runtimeDatabasePath(workspace));
        try {
          db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
          insertRun(db, runId);
          db.prepare(`
            INSERT INTO node_attempts (
              run_id, attempt_id, node_key, node_id, attempt_no, owner_epoch,
              status, started_at, finished_at
            )
            VALUES (?, ?, 'agent~1', 'agent', 1, 1, 'superseded', ?, ?)
          `).run(runId, attemptId, observedAt, observedAt);
          insertObservationTurn(db, {
            runId,
            attemptId,
            nodeKey: "agent~1",
            nodeId: "agent",
            attemptNo: 1,
            relativePath: `evidence/agents/${attemptId}/turn-001.evidence.jsonl`,
          });
          db.prepare(`
            UPDATE agent_observation_turns
            SET state = 'sealed', trace_enabled = 1, trace_state = 'sealed',
                trace_relative_path = ?, trace_artifact_relative_path = ?,
                trace_bytes = ?, trace_digest = ?
            WHERE run_id = ? AND attempt_id = ?
          `).run(
            traceRelativePath,
            artifactRelativePath,
            Buffer.byteLength(trace),
            digest,
            runId,
            attemptId,
          );
          db.prepare(`
            INSERT INTO artifacts (
              id, run_id, node_key, attempt, media_type, digest, size, relative_path, created_at
            )
            VALUES ('artifact_trace', ?, 'agent~1', 1, 'application/x-ndjson', ?, ?, ?, ?)
          `).run(runId, digest, Buffer.byteLength(trace), artifactRelativePath, observedAt);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        } finally {
          db.close();
        }

        await store.observationLog.recoverPartialTurns(runId);
        expect(runtimeRow(
          workspace,
          `SELECT trace_state, trace_artifact_relative_path
           FROM agent_observation_turns
           WHERE run_id = ? AND attempt_id = ?`,
          runId,
          attemptId,
        )).toEqual({
          trace_state: "published",
          trace_artifact_relative_path: artifactRelativePath,
        });
        await expect(access(join(runDir, traceRelativePath))).rejects.toMatchObject({ code: "ENOENT" });
        expect(runtimeRow(workspace, "SELECT observation_version FROM runs WHERE id = ?", runId))
          .toEqual({ observation_version: 1 });

        await store.observationLog.recoverPartialTurns(runId);
        expect(runtimeRow(workspace, "SELECT observation_version FROM runs WHERE id = ?", runId))
          .toEqual({ observation_version: 1 });
      } finally {
        store.close();
      }
    });
  });

  it("rejects a symlinked Trace artifact component without mutating its target", async () => {
    await withRuntimeWorkspace("agent-observation-trace-parent-symlink", async workspace => {
      const store = await openRuntimeStore(workspace);
      const runId = "20260726000000EEEEEEEEEEEEEEEEEEEE";
      const attemptId = "attempt_trace_parent";
      const runDir = join(resolveRuntimeLayout(workspace).runsRoot, runId);
      const traceRelativePath = `evidence/agents/${attemptId}/turn-001.trace.jsonl`;
      const artifactRelativePath = `artifacts/agent~1/attempt-1/${attemptId}/agent/turn-001.trace.jsonl`;
      const trace = `${JSON.stringify({ schemaVersion: 1, sequence: 0, type: "turn_start" })}\n`;
      const outside = join(workspace, "outside-trace-artifacts");
      let registered = false;
      try {
        await Promise.all([
          writeJournal(runDir, traceRelativePath, trace),
          mkdir(join(runDir, "artifacts", "agent~1"), { recursive: true }),
          mkdir(join(outside, attemptId), { recursive: true }),
        ]);
        await symlink(
          outside,
          join(runDir, "artifacts", "agent~1", "attempt-1"),
          process.platform === "win32" ? "junction" : "dir",
        );
        const db = new DatabaseSync(runtimeDatabasePath(workspace));
        try {
          db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
          insertRun(db, runId);
          db.prepare(`
            INSERT INTO node_attempts (
              run_id, attempt_id, node_key, node_id, attempt_no, owner_epoch,
              status, started_at
            )
            VALUES (?, ?, 'agent~1', 'agent', 1, 1, 'started', ?)
          `).run(runId, attemptId, observedAt);
          insertObservationTurn(db, {
            runId,
            attemptId,
            nodeKey: "agent~1",
            nodeId: "agent",
            attemptNo: 1,
            relativePath: `evidence/agents/${attemptId}/turn-001.evidence.jsonl`,
          });
          db.prepare(`
            UPDATE agent_observation_turns
            SET state = 'sealed', trace_enabled = 1, trace_state = 'sealed',
                trace_relative_path = ?
            WHERE run_id = ? AND attempt_id = ?
          `).run(traceRelativePath, runId, attemptId);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        } finally {
          db.close();
        }

        await expect(store.observationLog.publishTrace({
          runId,
          attemptId,
          turn: 1,
          destinationRelativePath: artifactRelativePath,
          register: async () => {
            registered = true;
          },
        })).rejects.toThrow();

        expect(registered).toBe(false);
        await expect(readdir(join(outside, attemptId))).resolves.toEqual([]);
        await expect(readFile(join(runDir, traceRelativePath), "utf8")).resolves.toBe(trace);
        expect(runtimeRow(
          workspace,
          `SELECT trace_state, trace_artifact_relative_path
           FROM agent_observation_turns
           WHERE run_id = ? AND attempt_id = ?`,
          runId,
          attemptId,
        )).toEqual({
          trace_state: "sealed",
          trace_artifact_relative_path: null,
        });
      } finally {
        store.close();
      }
    });
  });
});

async function writeJournal(runDir: string, relativePath: string, journal: string): Promise<void> {
  const path = join(runDir, relativePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, journal, { mode: 0o600 });
}

function insertObservationTurn(db: DatabaseSync, input: {
  runId: string;
  attemptId: string;
  nodeKey: string;
  nodeId: string;
  attemptNo: number;
  relativePath: string;
}): void {
  db.prepare(`
    INSERT INTO agent_observation_turns (
      run_id, attempt_id, node_key, node_id, attempt_no, turn_no,
      prompt_kind, relative_path, state, degraded,
      gap_count, provider_event_count, unknown_event_count, last_record_sequence, indexed_bytes,
      prompt_bytes, prompt_digest, last_response_bytes, last_response_digest,
      started_at
    )
    VALUES (?, ?, ?, ?, ?, 1, 'task', ?, 'recording', 0,
            0, 0, 0, 0, 0, 6, 'sha256:prompt', 0, 'sha256:response', ?)
  `).run(
    input.runId,
    input.attemptId,
    input.nodeKey,
    input.nodeId,
    input.attemptNo,
    input.relativePath,
    observedAt,
  );
}

function insertRun(db: DatabaseSync, runId: string): void {
  db.prepare(`
    INSERT INTO runs (
      id, name, status, workflow_entry, source_graph_digest, created_at, updated_at
    )
    VALUES (?, 'observation recovery', 'canceled', 'workflow.ts', 'sha256:test', ?, ?)
  `).run(runId, observedAt, observedAt);
}

function observationJournal(runId: string): string {
  return [
    {
      schemaVersion: 1,
      type: "turn_start",
      sequence: 0,
      observedAt,
      runId,
      nodeId: "agent",
      nodeKey: "agent~1",
      attemptId: "attempt",
      attemptNo: 1,
      turn: 1,
      agentKey: "agent",
      sessionName: "session",
      cwd: "/workspace",
      promptKind: "task",
      prompt: "prompt",
      traceEnabled: false,
    },
    {
      schemaVersion: 1,
      type: "turn_end",
      sequence: 1,
      observedAt,
      providerStatus: "completed",
      finalObservedResponse: "finished",
      summary: {
        eventCount: 0,
        availability: { context: "unavailable", tokenUsage: "unavailable" },
        tools: { totalToolCallCount: 0, calls: [] },
      },
      timing: {
        startedAt: observedAt,
        finishedAt: observedAt,
        elapsedMs: 0,
      },
    },
  ].map(record => JSON.stringify(record)).join("\n") + "\n";
}

function startingCurrent(attemptId: string): string {
  return JSON.stringify({
    attemptId,
    turn: 1,
    promptKind: "task",
    phase: "starting",
    updatedAt: observedAt,
    state: "recording",
    completeness: "complete",
    gaps: 0,
  });
}
