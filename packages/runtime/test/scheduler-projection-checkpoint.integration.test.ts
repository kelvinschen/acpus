import { admitRunForTest } from "./support/runtime-store.js";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { throwSchedulerStoreResult } from "../src/scheduler/store-port.js";
import { openExistingRuntimeStore, openRuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, runtimeDatabasePath, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

describe("scheduler projection checkpoint", () => {
  it("serves a hot snapshot below 100ms after bootstrapping 10,000 scheduler events", async () => {
    await withRuntimeWorkspace("scheduler-projection-checkpoint-10k", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        seedLargeSchedulerEventStream(workspace, run.id, 10_000);

        const first = throwSchedulerStoreResult(store.scheduler.tryLoadRunSnapshot(run.id));
        expect(Object.keys(first.projection.instances)).toHaveLength(3_333);

        const samples = Array.from({ length: 20 }, () => {
          const startedAt = performance.now();
          const snapshot = throwSchedulerStoreResult(store.scheduler.tryLoadRunSnapshot(run.id));
          return { snapshot, elapsedMs: performance.now() - startedAt };
        });

        expect(samples.at(-1)?.snapshot).toEqual(first);
        expect(p95(samples.map(sample => sample.elapsedMs))).toBeLessThan(100);
      } finally {
        store.close();
      }
    });
  }, 30_000);

  it("appends a small scheduler batch below 100ms after 10,000 events", async () => {
    await withRuntimeWorkspace("scheduler-projection-checkpoint-10k-append", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        seedLargeSchedulerEventStream(workspace, run.id, 10_000);
        const before = throwSchedulerStoreResult(store.scheduler.tryLoadRunSnapshot(run.id));
        const claim = store.scheduler.claimRun(run.id, "owner", 60_000)!;

        installProjectionWriteAudit(workspace);
        let snapshot = before;
        const elapsedMs: number[] = [];
        for (let index = 0; index < 20; index += 1) {
          const startedAt = performance.now();
          snapshot = throwSchedulerStoreResult(store.scheduler.tryAppendSchedulerEvents({
            runId: run.id,
            expectedVersion: snapshot.version,
            ownerEpoch: claim.ownerEpoch,
            idempotencyKey: `small-append:${index}`,
            events: [{ type: "signal.awaiting", payload: { runId: run.id, nodeKey: `signal_${index}`, nodeId: "signal" } }],
          }));
          elapsedMs.push(performance.now() - startedAt);
        }

        expect(Object.keys(snapshot.projection.signalWaits)).toHaveLength(20);
        expect(p95(elapsedMs)).toBeLessThan(100);
        expect(projectionWriteCounts(workspace)).toEqual({ signal_waits: 20 });
      } finally {
        store.close();
      }
    });
  }, 30_000);

  it("loads only events after a durable checkpoint on restart", async () => {
    await withRuntimeWorkspace("scheduler-projection-checkpoint-tail", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
      seedLargeSchedulerEventStream(workspace, run.id, 1_000);
      const before = throwSchedulerStoreResult(store.scheduler.tryLoadRunSnapshot(run.id));
      const claim = store.scheduler.claimRun(run.id, "owner", 60_000)!;
      const paused = throwSchedulerStoreResult(store.scheduler.tryAppendSchedulerEvents({
        runId: run.id,
        expectedVersion: before.version,
        ownerEpoch: claim.ownerEpoch,
        idempotencyKey: "checkpoint-before-tail",
        events: [{ type: "control.paused", payload: {} }],
      }));
      expect(store.scheduler.releaseRun(claim)).toBe(true);
      store.close();

      mutateDatabase(workspace, db => {
        db.prepare("UPDATE run_events SET payload_json = '{\"malformed\":true}' WHERE run_id = ? AND sequence = 2").run(run.id);
        db.prepare(`
          INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
          VALUES (?, ?, 'control.resumed', NULL, ?, ?, ?)
        `).run(run.id, paused.version + 1, envelope({}), new Date().toISOString(), "tail:resume");
      });

      const reopened = await openExistingRuntimeStore(workspace);
      try {
        const recovered = throwSchedulerStoreResult(reopened!.scheduler.tryLoadRunSnapshot(run.id));
        expect(recovered.version).toBe(paused.version + 1);
        expect(recovered.projection.run).toMatchObject({ paused: false });
        expect(Object.keys(recovered.projection.instances)).toHaveLength(333);
      } finally {
        reopened?.close();
      }
    });
  });

  it("reports malformed and ahead-of-log checkpoints as invariant failures", async () => {
    await withRuntimeWorkspace("scheduler-projection-checkpoint-corrupt", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
      store.close();

      mutateDatabase(workspace, db => db.prepare("UPDATE scheduler_projection_checkpoints SET projection_json = '{' WHERE run_id = ?").run(run.id));
      let reopened = await openExistingRuntimeStore(workspace);
      expect(() => throwSchedulerStoreResult(reopened!.scheduler.tryLoadRunSnapshot(run.id))).toThrow("checkpoint JSON is malformed");
      reopened?.close();

      mutateDatabase(workspace, db => db.prepare("UPDATE scheduler_projection_checkpoints SET projection_json = ?, event_sequence = 99 WHERE run_id = ?")
        .run(JSON.stringify(emptyProjection(run.id)), run.id));
      reopened = await openExistingRuntimeStore(workspace);
      try {
        expect(() => throwSchedulerStoreResult(reopened!.scheduler.tryLoadRunSnapshot(run.id))).toThrow("exceeds event sequence");
      } finally {
        reopened?.close();
      }
    });
  });

  it("checkpoints an uncheckpointed tail before explicitly releasing its owner", async () => {
    await withRuntimeWorkspace("scheduler-projection-checkpoint-release", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner", 60_000)!;
        const snapshot = throwSchedulerStoreResult(store.scheduler.tryAppendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "uncheckpointed-tail",
          events: [{ type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } }],
        }));
        expect(checkpointSequence(workspace, run.id)).toBe(1);

        expect(store.scheduler.releaseRun(claim)).toBe(true);
        expect(checkpointSequence(workspace, run.id)).toBe(snapshot.version);
      } finally {
        store.close();
      }
    });
  });

  it("drops completed checkpoints and recovers completed state from events", async () => {
    await withRuntimeWorkspace("scheduler-projection-checkpoint-completed", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      let runId = "";
      let completedVersion = 0;
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        runId = run.id;
        const claim = store.scheduler.claimRun(run.id, "owner", 60_000)!;
        const completed = throwSchedulerStoreResult(store.scheduler.tryAppendSchedulerEvents({
          runId: run.id,
          expectedVersion: 1,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "complete-without-checkpoint",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "frame.completed", payload: { frameKey: "root", result: { ok: true }, terminalReason: "root_completed" } },
          ],
        }));
        completedVersion = completed.version;

        expect(checkpointSequence(workspace, run.id)).toBeUndefined();
        expect(store.scheduler.releaseRun(claim)).toBe(true);
        expect(checkpointSequence(workspace, run.id)).toBeUndefined();
      } finally {
        store.close();
      }

      const reopened = await openExistingRuntimeStore(workspace);
      try {
        const recovered = throwSchedulerStoreResult(reopened!.scheduler.tryLoadRunSnapshot(runId));
        expect(recovered.version).toBe(completedVersion);
        expect(recovered.projection.run).toMatchObject({ status: "completed", paused: false });
        expect(recovered.projection.frames.root).toMatchObject({ status: "completed", result: { ok: true } });
        expect(reopened!.getRun(runId)).toMatchObject({ status: "completed", output: { ok: true } });
      } finally {
        reopened?.close();
      }
    });
  });

  it("rolls back events and projection rows when checkpoint persistence fails", async () => {
    await withRuntimeWorkspace("scheduler-projection-checkpoint-atomic", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const before = throwSchedulerStoreResult(store.scheduler.tryLoadRunSnapshot(run.id));
        const claim = store.scheduler.claimRun(run.id, "owner", 60_000)!;
        mutateDatabase(workspace, db => {
          db.prepare("DELETE FROM scheduler_projection_checkpoints WHERE run_id = ?").run(run.id);
          db.exec(`
            CREATE TRIGGER reject_scheduler_checkpoint
            BEFORE INSERT ON scheduler_projection_checkpoints
            BEGIN
              SELECT RAISE(ABORT, 'checkpoint-write-failed');
            END;
          `);
        });

        expect(() => throwSchedulerStoreResult(store.scheduler.tryAppendSchedulerEvents({
          runId: run.id,
          expectedVersion: before.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "must-rollback",
          events: [{ type: "instance.ready", payload: { runId: run.id, nodeKey: "new", nodeId: "new", instancePath: [{ kind: "node", nodeId: "new" }] } }],
        }))).toThrow("checkpoint-write-failed");

        expect(eventCount(workspace, run.id)).toBe(before.version);
        expect(rowCount(workspace, "node_instances", run.id)).toBe(0);
        expect(throwSchedulerStoreResult(store.scheduler.tryLoadRunSnapshot(run.id))).toEqual(before);
      } finally {
        store.close();
      }
    });
  });
});

function p95(samples: number[]): number {
  return [...samples].sort((left, right) => left - right)[Math.ceil(samples.length * 0.95) - 1]!;
}

function seedLargeSchedulerEventStream(workspace: string, runId: string, eventCount: number): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  const insert = db.prepare(`
    INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  let sequence = 2;
  db.exec("BEGIN IMMEDIATE");
  try {
    insert.run(runId, sequence, "frame.started", null, envelope({ runId, frameKey: "root", frameKind: "root", scope: {} }), now, `seed:${runId}:${sequence}`);
    sequence += 1;
    for (let index = 0; sequence <= eventCount + 1; index += 1) {
      const nodeKey = `node_${index}`;
      const events = [
        ["instance.ready", { runId, nodeKey, nodeId: "node", instancePath: [{ kind: "node", nodeId: "node" }], readinessSequence: index + 1 }],
        ["instance.started", { nodeKey }],
        ["instance.completed", { nodeKey }],
      ] as const;
      for (const [type, payload] of events) {
        if (sequence > eventCount + 1) break;
        insert.run(runId, sequence, type, nodeKey, envelope(payload), now, `seed:${runId}:${sequence}`);
        sequence += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function envelope(payload: object): string {
  return JSON.stringify({ schedulerEventVersion: 1, payload });
}

function installProjectionWriteAudit(workspace: string): void {
  mutateDatabase(workspace, db => {
    db.exec("CREATE TABLE projection_write_audit (table_name TEXT NOT NULL)");
    for (const table of ["scheduler_frames", "node_instances", "node_attempts", "group_members", "signal_waits"]) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        db.exec(`CREATE TRIGGER audit_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN INSERT INTO projection_write_audit VALUES ('${table}'); END;`);
      }
    }
  });
}

function projectionWriteCounts(workspace: string): Record<string, number> {
  const result: Record<string, number> = {};
  mutateDatabase(workspace, db => {
    const rows = db.prepare("SELECT table_name, COUNT(*) AS count FROM projection_write_audit GROUP BY table_name").all() as Array<{ table_name: string; count: number }>;
    for (const row of rows) result[row.table_name] = row.count;
  });
  return result;
}

function mutateDatabase(workspace: string, action: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    action(db);
  } finally {
    db.close();
  }
}

function checkpointSequence(workspace: string, runId: string): number | undefined {
  let sequence: number | undefined;
  mutateDatabase(workspace, db => {
    sequence = (db.prepare("SELECT event_sequence FROM scheduler_projection_checkpoints WHERE run_id = ?").get(runId) as { event_sequence: number } | undefined)?.event_sequence;
  });
  return sequence;
}

function eventCount(workspace: string, runId: string): number {
  let count = 0;
  mutateDatabase(workspace, db => {
    count = (db.prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?").get(runId) as { count: number }).count;
  });
  return count;
}

function rowCount(workspace: string, table: string, runId: string): number {
  let count = 0;
  mutateDatabase(workspace, db => {
    count = (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id = ?`).get(runId) as { count: number }).count;
  });
  return count;
}

function emptyProjection(runId: string) {
  return {
    run: { runId, status: "pending", paused: false },
    frames: {},
    instances: {},
    attempts: {},
    groups: {},
    groupMembers: {},
    signalWaits: {},
    branchDecisions: {},
  };
}
