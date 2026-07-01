import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getRun, getRunVisualizationOverlay, listRuns, mutateRun, normalizeForkInput, replayRun, signalRun } from "@acpus/runtime";
import { runSupervisorTick } from "../src/supervisor/tick.js";
import { openExistingWritableRuntimeStore } from "../src/store/store.js";
import {
  admitSyntheticWorkflow,
  failOnceTaskWorkflow,
  failingPureWorkflow,
  fanoutSignalWorkflow,
  inputEchoWorkflow,
  metaWorkflow,
  missingProviderWorkflow,
  parallelSignalAllWorkflow,
  parallelSignalRaceWorkflow,
  prepareSyntheticWorkflow,
  replacementTaskWorkflow,
  runtimeRow,
  runtimeRows,
  signalWorkflow,
  taskArtifactWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";

describe.concurrent("runtime controls and recovery use cases", () => {
  it("pauses, resumes, and applies retry commands to durable runs", async () => {
    await withRuntimeWorkspace("runtime-controls", async workspace => {
      const missingProvider = await admitSyntheticWorkflow(workspace, missingProviderWorkflow());
      expect(missingProvider.status).toBe("failed");
      expect(missingProvider.run).toMatchObject({ status: "failed" });

      const awaiting = await admitSyntheticWorkflow(workspace, signalWorkflow());
      expect(awaiting.status).toBe("awaiting");
      const runId = awaiting.run.id;

      await expect(mutateRun(workspace, runId, "pause")).resolves.toMatchObject({
        run: { status: "paused" },
        command: { status: "applied" },
      });
      await expect(mutateRun(workspace, runId, "resume")).resolves.toMatchObject({
        run: { status: "awaiting" },
        command: { status: "applied" },
      });
      await expect(mutateRun(workspace, runId, "pause")).resolves.toMatchObject({
        run: { status: "paused" },
        command: { status: "applied" },
      });
      expect(runtimeRows(workspace, "SELECT type, status FROM commands WHERE run_id = ? ORDER BY created_at", runId)).toEqual([
        { type: "pause", status: "applied" },
        { type: "resume", status: "applied" },
        { type: "pause", status: "applied" },
      ]);

      const failed = await admitSyntheticWorkflow(workspace, failingPureWorkflow());
      expect(failed.status).toBe("failed");
      const failedId = failed.run.id;
      await expect(mutateRun(workspace, failedId, "retry")).resolves.toMatchObject({
        run: { status: "failed" },
        advanced: { status: "failed" },
        command: { status: "applied" },
      });
      expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'control.run_retry_requested'", failedId)).toMatchObject({ count: 1 });
      expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'run.failed'", failedId)).toMatchObject({ count: 2 });
      await expect(replayRun(workspace, failedId)).resolves.toMatchObject({ projection: { issues: [] } });

      const failOnce = await admitSyntheticWorkflow(workspace, failOnceTaskWorkflow(), { workDir: workspace });
      expect(failOnce.status).toBe("failed");
      await expect(mutateRun(workspace, failOnce.run.id, "retry")).resolves.toMatchObject({
        run: { status: "completed", output: { ok: true } },
        advanced: { status: "completed" },
        command: { status: "applied" },
      });
      expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'control.run_retry_requested'", failOnce.run.id)).toMatchObject({ count: 1 });
      expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'run.failed'", failOnce.run.id)).toMatchObject({ count: 1 });
      expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'run.completed'", failOnce.run.id)).toMatchObject({ count: 1 });
      await expect(replayRun(workspace, failOnce.run.id)).resolves.toMatchObject({ ok: true, actual: { ok: true }, projection: { issues: [] } });

      const rerun = await admitSyntheticWorkflow(workspace, failingPureWorkflow());
      expect(rerun.status).toBe("failed");
      await expect(mutateRun(workspace, rerun.run.id, "retry")).resolves.toMatchObject({
        run: { status: "failed" },
        advanced: { status: "failed" },
      });
      expect(runtimeRow(workspace, "SELECT type, status FROM commands WHERE run_id = ? AND type = 'retry'", rerun.run.id)).toMatchObject({ type: "retry", status: "applied" });
    });
  }, 15_000);

  it("forks completed runs with inherited outputs and artifact refs", async () => {
    await withRuntimeWorkspace("runtime-fork-completed", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      expect(source.status).toBe("completed");

      const fork = await mutateRun(workspace, source.run.id, "fork");

      expect(fork?.run.status).toBe("completed");
      expect(fork?.run.id).not.toBe(source.run.id);
      const sourceArtifacts = runtimeRows(workspace, "SELECT id, media_type, digest, size, relative_path FROM artifacts WHERE run_id = ? ORDER BY id", source.run.id);
      const forkArtifacts = runtimeRows(workspace, "SELECT id, media_type, digest, size, relative_path FROM artifacts WHERE run_id = ? ORDER BY id", fork!.run.id);
      expect(forkArtifacts).toHaveLength(sourceArtifacts.length);
      expect(forkArtifacts.map(row => row.id)).not.toEqual(sourceArtifacts.map(row => row.id));
      expect(forkArtifacts.map(({ id: _id, ...row }) => row)).toEqual(sourceArtifacts.map(({ id: _id, ...row }) => row));
      await expect(getRun(workspace, fork!.run.id)).resolves.toMatchObject({ output: { ok: true } });
      await expect(replayRun(workspace, fork!.run.id)).resolves.toMatchObject({ ok: true, actual: { ok: true } });
    });
  }, 15_000);

  it("forks only reachable artifacts from inherited accepted outputs", async () => {
    await withRuntimeWorkspace("runtime-fork-reachable-artifacts", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const inherited = runtimeRow(workspace, "SELECT node_key FROM artifacts WHERE run_id = ?", source.run.id);
      const nodeKey = String(inherited?.node_key);
      const node = runtimeRow(workspace, "SELECT node_id FROM node_instances WHERE run_id = ? AND node_key = ?", source.run.id, nodeKey);
      const failedRelativePath = join("artifacts", nodeKey, "attempt-98", "failed.txt");
      const supersededRelativePath = join("artifacts", nodeKey, "attempt-99", "superseded.txt");
      const failedBytes = Buffer.from("failed attempt artifact\n");
      const supersededBytes = Buffer.from("superseded attempt artifact\n");
      await mkdir(join(workspace, ".acpus", "runs", source.run.id, "artifacts", nodeKey, "attempt-98"), { recursive: true });
      await mkdir(join(workspace, ".acpus", "runs", source.run.id, "artifacts", nodeKey, "attempt-99"), { recursive: true });
      await writeFile(join(workspace, ".acpus", "runs", source.run.id, failedRelativePath), failedBytes);
      await writeFile(join(workspace, ".acpus", "runs", source.run.id, supersededRelativePath), supersededBytes);
      const db = new DatabaseSync(join(workspace, ".acpus", "state", "runtime.db"));
      try {
        db.prepare(`
          INSERT INTO node_attempts (
            run_id, attempt_id, node_key, node_id, attempt_no, owner_epoch, status,
            started_at, finished_at, error_json, terminal_reason
          )
          VALUES (?, 'attempt_failed_98', ?, ?, 98, 1, 'failed', datetime('now'), datetime('now'), ?, 'failed_attempt')
        `).run(source.run.id, nodeKey, String(node?.node_id), JSON.stringify({ reason: "failed_attempt" }));
        db.prepare(`
          INSERT INTO node_attempts (
            run_id, attempt_id, node_key, node_id, attempt_no, owner_epoch, status,
            started_at, finished_at, cancel_reason
          )
          VALUES (?, 'attempt_superseded_99', ?, ?, 99, 1, 'superseded', datetime('now'), datetime('now'), 'superseded')
        `).run(source.run.id, nodeKey, String(node?.node_id));
        db.prepare(`
          INSERT INTO artifacts (id, run_id, node_key, attempt, media_type, digest, size, relative_path, created_at)
          VALUES (?, ?, ?, 99, 'text/plain', ?, ?, ?, datetime('now'))
        `).run(
          "artifact_superseded_attempt",
          source.run.id,
          nodeKey,
          `sha256:${createHash("sha256").update(supersededBytes).digest("hex")}`,
          supersededBytes.byteLength,
          supersededRelativePath,
        );
        db.prepare(`
          INSERT INTO artifacts (id, run_id, node_key, attempt, media_type, digest, size, relative_path, created_at)
          VALUES (?, ?, ?, 98, 'text/plain', ?, ?, ?, datetime('now'))
        `).run(
          "artifact_failed_attempt",
          source.run.id,
          nodeKey,
          `sha256:${createHash("sha256").update(failedBytes).digest("hex")}`,
          failedBytes.byteLength,
          failedRelativePath,
        );
      } finally {
        db.close();
      }

      const fork = await mutateRun(workspace, source.run.id, "fork");
      const forkArtifacts = runtimeRows(workspace, "SELECT relative_path FROM artifacts WHERE run_id = ? ORDER BY relative_path", fork!.run.id);
      expect(forkArtifacts).toHaveLength(1);
      expect(forkArtifacts.map(row => row.relative_path)).not.toContain(failedRelativePath);
      expect(forkArtifacts.map(row => row.relative_path)).not.toContain(supersededRelativePath);
      await expect(access(join(workspace, ".acpus", "runs", fork!.run.id, failedRelativePath))).rejects.toThrow();
      await expect(access(join(workspace, ".acpus", "runs", fork!.run.id, supersededRelativePath))).rejects.toThrow();
      await expect(replayRun(workspace, fork!.run.id)).resolves.toMatchObject({ ok: true, actual: { ok: true } });
    });
  }, 15_000);

  it("forks completed runs with fork-local meta outputs", async () => {
    await withRuntimeWorkspace("runtime-fork-meta", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, metaWorkflow());
      expect(source.status).toBe("completed");

      const fork = await mutateRun(workspace, source.run.id, "fork");

      expect(fork?.run.status).toBe("completed");
      expect(fork?.run.id).not.toBe(source.run.id);
      await expect(getRun(workspace, fork!.run.id)).resolves.toMatchObject({
        output: {
          runId: fork!.run.id,
          workflowPath: "cli-meta.workflow.ts",
          workflowName: "cli-meta",
          workspaceDir: workspace,
        },
      });
      await expect(replayRun(workspace, fork!.run.id)).resolves.toMatchObject({
        ok: true,
        actual: {
          runId: fork!.run.id,
          workflowPath: "cli-meta.workflow.ts",
          workflowName: "cli-meta",
          workspaceDir: workspace,
        },
      });
    });
  }, 15_000);

  it("forks with replacement workflow and input override without inheriting stale output", async () => {
    await withRuntimeWorkspace("runtime-fork-replacement", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      expect(source.status).toBe("completed");
      const replacement = await prepareSyntheticWorkflow(workspace, replacementTaskWorkflow());

      const fork = await mutateRun(workspace, source.run.id, "fork", { prepared: replacement });

      expect(fork?.run).toMatchObject({ name: "cli-task-replacement", status: "pending" });
      const store = await openExistingWritableRuntimeStore(workspace);
      expect(store).toBeDefined();
      try {
        await runSupervisorTick(workspace, store!);
      } finally {
        store?.close();
      }
      await expect(getRun(workspace, fork!.run.id)).resolves.toMatchObject({ status: "completed", output: { ok: true, extra: true } });
      expect(runtimeRows(workspace, "SELECT relative_path FROM artifacts WHERE run_id = ? ORDER BY relative_path", fork!.run.id)).toHaveLength(1);

      const inputSource = await admitSyntheticWorkflow(workspace, inputEchoWorkflow(), { value: "old" });
      const input = await normalizeForkInput(workspace, inputSource.run.id, { value: "new" });
      if (input === undefined) throw new Error("expected fork input to normalize");
      const inputFork = await mutateRun(workspace, inputSource.run.id, "fork", { input });
      expect(inputFork?.run.status).toBe("pending");
      const store2 = await openExistingWritableRuntimeStore(workspace);
      expect(store2).toBeDefined();
      try {
        await runSupervisorTick(workspace, store2!);
      } finally {
        store2?.close();
      }
      await expect(getRun(workspace, inputFork!.run.id)).resolves.toMatchObject({ status: "completed", output: { value: "new" } });
    });
  }, 20_000);

  it("signals awaiting runs and rejects invalid signals without mutation", async () => {
    await withRuntimeWorkspace("runtime-signal", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, signalWorkflow());
      expect(awaiting.status).toBe("awaiting");
      const runId = awaiting.run.id;
      await expect(listRuns(workspace)).resolves.toEqual([
        expect.objectContaining({ id: runId, status: "awaiting" }),
      ]);

      await expect(signalRun(workspace, runId, "approve", { ok: "yes" })).rejects.toThrow("Signal payload does not match schema");
      await expect(signalRun(workspace, runId, "missing", { ok: true })).rejects.toThrow("Signal node 'missing' was not found.");
      expect(runtimeRows(workspace, "SELECT type FROM run_events WHERE run_id = ? ORDER BY sequence", runId).map(row => row.type)).toEqual([
        "run.admitted",
        "frame.started",
        "frame.started",
        "frame.completed",
        "instance.ready",
        "instance.awaiting",
        "signal.awaiting",
      ]);

      await expect(signalRun(workspace, runId, "approve", { ok: true })).resolves.toMatchObject({
        run: { status: "completed", output: { ok: true } },
        command: { status: "applied" },
      });
      await expect(getRun(workspace, runId)).resolves.toMatchObject({ status: "completed", output: { ok: true } });
    });
  });

  it("signals dynamic fanout nodeKeys through the public signal API", async () => {
    await withRuntimeWorkspace("runtime-signal-dynamic", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, fanoutSignalWorkflow(), { items: ["a", "b"] });
      expect(awaiting.status).toBe("awaiting");
      const waits = runtimeRows(workspace, "SELECT node_key, node_id, status FROM signal_waits WHERE run_id = ? ORDER BY node_key", awaiting.run.id);
      expect(waits).toHaveLength(2);
      expect(waits).toEqual([
        expect.objectContaining({ node_id: "approve", status: "awaiting" }),
        expect.objectContaining({ node_id: "approve", status: "awaiting" }),
      ]);
      const run = await getRun(workspace, awaiting.run.id);
      expect(run?.dynamic?.nodeInstances.filter(instance => instance.nodeId === "approve" && instance.status === "awaiting")).toHaveLength(2);
      expect(run?.dynamic?.signalWaits.filter(wait => wait.nodeId === "approve" && wait.status === "awaiting")).toHaveLength(2);
      const overlay = await getRunVisualizationOverlay(workspace, awaiting.run.id);
      expect(overlay?.workflow).toMatchObject({ name: "cli-fanout-signal", runId: awaiting.run.id, status: "awaiting" });
      expect(overlay?.nodes.find(node => node.nodeId === "approve")).toMatchObject({
        kind: "signal",
        status: "awaiting",
        instances: expect.arrayContaining([
          expect.objectContaining({ nodeId: "approve", status: "awaiting" }),
          expect.objectContaining({ nodeId: "approve", status: "awaiting" }),
        ]),
      });
      expect(overlay?.groups).toEqual([
        expect.objectContaining({
          nodeId: "approvals",
          kind: "fanout",
          status: "running",
          strategy: "all",
          members: expect.arrayContaining([
            expect.objectContaining({ memberKind: "fanout_item", status: "ready" }),
            expect.objectContaining({ memberKind: "fanout_item", status: "ready" }),
          ]),
        }),
      ]);

      await expect(signalRun(workspace, awaiting.run.id, "approve", { ok: true })).rejects.toThrow("ambiguous");
      await expect(signalRun(workspace, awaiting.run.id, String(waits[0]!.node_key), { ok: true })).resolves.toMatchObject({
        run: { status: "awaiting" },
        command: { status: "applied" },
      });
      await expect(signalRun(workspace, awaiting.run.id, "approve", { ok: true })).resolves.toMatchObject({
        run: { status: "completed" },
        command: { status: "applied" },
      });
    });
  });

  it("signals parallel all and race branches through the public signal API", async () => {
    await withRuntimeWorkspace("runtime-signal-parallel", async workspace => {
      const all = await admitSyntheticWorkflow(workspace, parallelSignalAllWorkflow());
      expect(all.status).toBe("awaiting");
      await expect(signalRun(workspace, all.run.id, "left_approve", { ok: true })).resolves.toMatchObject({
        run: { status: "awaiting" },
        command: { status: "applied" },
      });
      await expect(signalRun(workspace, all.run.id, "right_approve", { ok: true })).resolves.toMatchObject({
        run: {
          status: "completed",
          output: { approvals: { left: { ok: true }, right: { ok: true } } },
        },
        command: { status: "applied" },
      });

      const race = await admitSyntheticWorkflow(workspace, parallelSignalRaceWorkflow());
      expect(race.status).toBe("awaiting");
      await expect(signalRun(workspace, race.run.id, "left_approve", { ok: true })).resolves.toMatchObject({
        run: {
          status: "completed",
          output: { approval: { winner: "left", result: { ok: true } } },
        },
        command: { status: "applied" },
      });
      await expect(signalRun(workspace, race.run.id, "right_approve", { ok: true })).rejects.toThrow("target 'right_approve' was not found");
      const loser = runtimeRow(workspace, "SELECT node_key FROM signal_waits WHERE run_id = ? AND node_id = 'right_approve'", race.run.id);
      await expect(signalRun(workspace, race.run.id, String(loser!.node_key), { ok: true })).rejects.toThrow(`target '${String(loser!.node_key)}' was not found`);
    });
  });

  it("detects replay artifact and projection drift without mutating state", async () => {
    await withRuntimeWorkspace("runtime-replay-drift", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const artifact = runtimeRow(workspace, "SELECT id, relative_path FROM artifacts WHERE run_id = ?", admitted.run.id);
      await writeFile(join(workspace, ".acpus", "runs", admitted.run.id, String(artifact?.relative_path)), "corrupted\n");
      await expect(replayRun(workspace, admitted.run.id)).resolves.toMatchObject({
        ok: false,
        artifacts: {
          mismatched: [expect.objectContaining({ id: artifact?.id })],
        },
      });
    });
  });

  it("detects scheduler projection drift from the scheduler event stream", async () => {
    await withRuntimeWorkspace("runtime-replay-scheduler-drift", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      expect(runtimeRows(workspace, "SELECT node_key FROM node_instances WHERE run_id = ?", admitted.run.id)).not.toHaveLength(0);

      const db = new DatabaseSync(join(workspace, ".acpus", "state", "runtime.db"));
      try {
        db.prepare("UPDATE node_instances SET status = 'failed' WHERE run_id = ?").run(admitted.run.id);
      } finally {
        db.close();
      }

      await expect(replayRun(workspace, admitted.run.id)).resolves.toMatchObject({
        ok: false,
        projection: {
          issues: expect.arrayContaining([
            "Scheduler projection table 'node_instances' does not match scheduler event stream.",
          ]),
        },
      });
      await expect(getRun(workspace, admitted.run.id)).resolves.toMatchObject({ status: "completed" });
    });
  });

  it("reports malformed scheduler projection JSON as a replay issue", async () => {
    await withRuntimeWorkspace("runtime-replay-scheduler-json-drift", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const db = new DatabaseSync(join(workspace, ".acpus", "state", "runtime.db"));
      try {
        db.prepare("UPDATE node_instances SET output_json = ? WHERE run_id = ?").run("{bad-json", admitted.run.id);
      } finally {
        db.close();
      }

      await expect(replayRun(workspace, admitted.run.id)).resolves.toMatchObject({
        ok: false,
        projection: {
          issues: expect.arrayContaining([
            expect.stringContaining("Scheduler projection table 'node_instances' could not be read"),
          ]),
        },
      });
      const run = await getRun(workspace, admitted.run.id);
      expect(run).toMatchObject({ status: "completed" });
      expect(run?.dynamic).toBeUndefined();
    });
  });

  it("reports malformed scheduler event envelopes without dropping them silently", async () => {
    await withRuntimeWorkspace("runtime-replay-scheduler-invalid-envelope", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const db = new DatabaseSync(join(workspace, ".acpus", "state", "runtime.db"));
      try {
        const nextSequence = db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_events WHERE run_id = ?")
          .get(admitted.run.id) as { sequence: number };
        db.prepare(`
          INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
          VALUES (?, ?, 'instance.ready', NULL, ?, datetime('now'), ?)
        `).run(
          admitted.run.id,
          nextSequence.sequence,
          JSON.stringify({ schedulerEventVersion: 1, payload: null }),
          `test:bad-envelope:${admitted.run.id}`,
        );
      } finally {
        db.close();
      }

      await expect(replayRun(workspace, admitted.run.id)).resolves.toMatchObject({
        ok: false,
        projection: {
          issues: expect.arrayContaining([
            expect.stringContaining("has an invalid scheduler envelope"),
          ]),
        },
      });
    });
  });

  it("detects orphaned scheduler projection tables when scheduler events are missing", async () => {
    await withRuntimeWorkspace("runtime-replay-scheduler-orphaned-projection", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const db = new DatabaseSync(join(workspace, ".acpus", "state", "runtime.db"));
      try {
        db.prepare("DELETE FROM run_events WHERE run_id = ? AND payload_json LIKE '%schedulerEventVersion%'").run(admitted.run.id);
      } finally {
        db.close();
      }

      await expect(replayRun(workspace, admitted.run.id)).resolves.toMatchObject({
        ok: false,
        projection: {
          issues: expect.arrayContaining([
            "Scheduler projection table 'scheduler_frames' does not match scheduler event stream.",
            "Scheduler projection table 'node_instances' does not match scheduler event stream.",
          ]),
        },
      });
    });
  });

  it("reports unreplayable scheduler terminal event streams", async () => {
    await withRuntimeWorkspace("runtime-replay-scheduler-terminal-conflict", async workspace => {
      const admitted = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const db = new DatabaseSync(join(workspace, ".acpus", "state", "runtime.db"));
      try {
        const nextSequence = db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_events WHERE run_id = ?")
          .get(admitted.run.id) as { sequence: number };
        db.prepare(`
          INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
          VALUES (?, ?, 'frame.failed', NULL, ?, datetime('now'), ?)
        `).run(
          admitted.run.id,
          nextSequence.sequence,
          JSON.stringify({ schedulerEventVersion: 1, payload: { frameKey: "root", error: { reason: "late" }, terminalReason: "late" } }),
          `test:late-frame:${admitted.run.id}`,
        );
      } finally {
        db.close();
      }

      await expect(replayRun(workspace, admitted.run.id)).resolves.toMatchObject({
        ok: false,
        projection: {
          issues: expect.arrayContaining([
            expect.stringContaining(`Scheduler event stream for run '${admitted.run.id}' is not replayable`),
          ]),
        },
      });
    });
  });
});
