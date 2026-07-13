import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@acpus/expression/ir";
import { getRun, getRunInspection, getRunVisualizationSnapshot, listRuns, normalizeForkInput } from "@acpus/runtime";
import { advanceRuntimeRun } from "../src/runs/advance-runtime.js";
import type { RunControlIntent } from "../src/scheduler/control.js";
import { stableJson } from "../src/stable-json.js";
import { openExistingWritableRuntimeStore, type PreparedRunWorkflow, type RunDetails } from "../src/store/store.js";
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
  scalarWorkflow,
  signalWorkflow,
  taskArtifactWorkflow,
  timedSignalWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";
import { applySchedulerControlIntent } from "./support/scheduler.js";

describe.concurrent("runtime controls and recovery", () => {
  it("pauses, resumes, and applies retries to durable runs", async () => {
    await withRuntimeWorkspace("runtime-controls", async workspace => {
      const missingProvider = await admitSyntheticWorkflow(workspace, missingProviderWorkflow());
      expect(missingProvider.status).toBe("failed");
      expect(missingProvider.run).toMatchObject({ status: "failed" });

      const awaiting = await admitSyntheticWorkflow(workspace, signalWorkflow());
      expect(awaiting.status).toBe("awaiting");
      const runId = awaiting.run.id;

      await expect(controlRun(workspace, runId, "pause")).resolves.toMatchObject({ status: "paused" });
      await expect(controlRun(workspace, runId, "resume")).resolves.toMatchObject({ status: "awaiting" });
      await expect(controlRun(workspace, runId, "pause")).resolves.toMatchObject({ status: "paused" });

      const failed = await admitSyntheticWorkflow(workspace, failingPureWorkflow());
      expect(failed.status).toBe("failed");
      const failedId = failed.run.id;
      await expect(controlRun(workspace, failedId, "retry")).resolves.toMatchObject({ status: "failed" });
      expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'control.run_retry_requested'", failedId)).toMatchObject({ count: 1 });
      expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'run.failed'", failedId)).toMatchObject({ count: 2 });

      const failOnce = await admitSyntheticWorkflow(workspace, failOnceTaskWorkflow(), { workDir: workspace });
      expect(failOnce.status).toBe("failed");
      await expect(controlRun(workspace, failOnce.run.id, "retry")).resolves.toMatchObject({ status: "completed", output: { ok: true } });
      expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'control.run_retry_requested'", failOnce.run.id)).toMatchObject({ count: 1 });
      expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'run.failed'", failOnce.run.id)).toMatchObject({ count: 1 });
      expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'run.completed'", failOnce.run.id)).toMatchObject({ count: 1 });

      const rerun = await admitSyntheticWorkflow(workspace, failingPureWorkflow());
      expect(rerun.status).toBe("failed");
      await expect(controlRun(workspace, rerun.run.id, "retry")).resolves.toMatchObject({ status: "failed" });
      expect(runtimeRows(workspace, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'commands'")).toEqual([]);
    });
  });

  it("does not apply controls when another owner holds the run lease", async () => {
    await withRuntimeWorkspace("runtime-control-lease-conflict", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, signalWorkflow());
      const store = await openExistingWritableRuntimeStore(workspace);
      expect(store).toBeDefined();
      const claim = store!.scheduler.claimRun(awaiting.run.id, "other-owner", 30_000);
      expect(claim).toBeDefined();
      try {
        const result = await applySchedulerControlIntent(workspace, store!, {
          requestId: "lease-conflict",
          runId: awaiting.run.id,
          type: "cancel",
        }, { ownerId: "test-control-owner" });
        expect(result.advanced).toMatchObject({ status: "lease_lost" });
        expect(store!.getRun(awaiting.run.id)).toMatchObject({ status: "awaiting" });
      } finally {
        if (claim) store!.scheduler.releaseRun(claim);
        store?.close();
      }
    });
  });

  it("forks completed runs with inherited outputs and artifact refs", async () => {
    await withRuntimeWorkspace("runtime-fork-completed", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      expect(source.status).toBe("completed");

      const fork = await forkRun(workspace, source.run.id);

      expect(fork?.run.status).toBe("completed");
      expect(fork?.run.id).not.toBe(source.run.id);
      const sourceArtifacts = runtimeRows(workspace, "SELECT id, media_type, digest, size, relative_path FROM artifacts WHERE run_id = ? ORDER BY id", source.run.id);
      const forkArtifacts = runtimeRows(workspace, "SELECT id, media_type, digest, size, relative_path FROM artifacts WHERE run_id = ? ORDER BY id", fork!.run.id);
      expect(forkArtifacts).toHaveLength(sourceArtifacts.length);
      expect(forkArtifacts.map(row => row.id)).not.toEqual(sourceArtifacts.map(row => row.id));
      expect(forkArtifacts.map(({ id: _id, ...row }) => row)).toEqual(sourceArtifacts.map(({ id: _id, ...row }) => row));
      await expect(getRun(workspace, fork!.run.id)).resolves.toMatchObject({ output: { ok: true } });
    });
  });

  it("preserves scalar workflow output across completed forks", async () => {
    await withRuntimeWorkspace("runtime-fork-scalar-output", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, scalarWorkflow());
      expect(source.run).toMatchObject({ status: "completed", output: "ready" });

      const fork = await forkRun(workspace, source.run.id);

      expect(fork?.run).toMatchObject({ status: "completed", output: "ready" });
      await expect(getRun(workspace, fork!.run.id)).resolves.toMatchObject({ output: "ready" });
    });
  });

  it("rejects forks when the frozen workflow lock digest does not match", async () => {
    await withRuntimeWorkspace("runtime-fork-lock-digest", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, metaWorkflow());
      await writeFile(join(workspace, ".acpus", ".local", "runs", source.run.id, "lock.json"), "{}\n");

      await expect(forkRun(workspace, source.run.id)).rejects.toThrow("Frozen workflow lock digest mismatch.");
      expect(runtimeRows(workspace, "SELECT id FROM runs WHERE id != ?", source.run.id)).toEqual([]);
    });
  });

  it("reuses the fork run when a fork control request is replayed", async () => {
    await withRuntimeWorkspace("runtime-fork-idempotent-request", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());

      const first = await forkRun(workspace, source.run.id, { requestId: "fork-request-1" });
      const second = await forkRun(workspace, source.run.id, { requestId: "fork-request-1" });
      const third = await forkRun(workspace, source.run.id, { requestId: "fork-request-2" });
      const forkId = first.run.id;

      expect(second.run.id).toBe(forkId);
      expect(third.run.id).toBe(forkId);
      expect(runtimeRows(workspace, "SELECT id FROM runs WHERE id <> ? ORDER BY id", source.run.id)).toEqual([{ id: forkId }]);
      const event = runtimeRow(workspace, "SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'run.forked'", forkId);
      const payload = JSON.parse(String(event?.payload_json)) as { requestFingerprint: string };
      expect(payload.requestFingerprint).toBe(`${stableJson({ runId: source.run.id })}\n`);
    });
  });

  it("rejects a reused fork request id with different input", async () => {
    await withRuntimeWorkspace("runtime-fork-idempotent-conflict", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, inputEchoWorkflow(), { value: "old" });
      const firstInput = await normalizeForkInput(workspace, source.run.id, { value: "first" });
      const secondInput = await normalizeForkInput(workspace, source.run.id, { value: "second" });
      if (firstInput === undefined || secondInput === undefined) throw new Error("expected fork input to normalize");

      await expect(forkRun(workspace, source.run.id, { requestId: "fork-request-1", input: firstInput })).resolves.toMatchObject({
        run: { id: expect.any(String) },
      });
      await expect(forkRun(workspace, source.run.id, { requestId: "fork-request-1", input: secondInput })).rejects.toThrow("conflicts with a different fork input");
    });
  });

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
      await mkdir(join(workspace, ".acpus", ".local", "runs", source.run.id, "artifacts", nodeKey, "attempt-98"), { recursive: true });
      await mkdir(join(workspace, ".acpus", ".local", "runs", source.run.id, "artifacts", nodeKey, "attempt-99"), { recursive: true });
      await writeFile(join(workspace, ".acpus", ".local", "runs", source.run.id, failedRelativePath), failedBytes);
      await writeFile(join(workspace, ".acpus", ".local", "runs", source.run.id, supersededRelativePath), supersededBytes);
      const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"));
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

      const fork = await forkRun(workspace, source.run.id);
      const forkArtifacts = runtimeRows(workspace, "SELECT relative_path FROM artifacts WHERE run_id = ? ORDER BY relative_path", fork!.run.id);
      expect(forkArtifacts).toHaveLength(1);
      expect(forkArtifacts.map(row => row.relative_path)).not.toContain(failedRelativePath);
      expect(forkArtifacts.map(row => row.relative_path)).not.toContain(supersededRelativePath);
      await expect(access(join(workspace, ".acpus", ".local", "runs", fork!.run.id, failedRelativePath))).rejects.toThrow();
      await expect(access(join(workspace, ".acpus", ".local", "runs", fork!.run.id, supersededRelativePath))).rejects.toThrow();
    });
  });

  it("forks completed runs with fork-local meta outputs", async () => {
    await withRuntimeWorkspace("runtime-fork-meta", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, metaWorkflow());
      expect(source.status).toBe("completed");

      const fork = await forkRun(workspace, source.run.id);

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
    });
  });

  it("forks with replacement workflow and input override without inheriting stale output", async () => {
    await withRuntimeWorkspace("runtime-fork-replacement", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      expect(source.status).toBe("completed");
      const replacement = await prepareSyntheticWorkflow(workspace, replacementTaskWorkflow());

      const fork = await forkRun(workspace, source.run.id, { prepared: replacement });

      expect(fork?.run).toMatchObject({ name: "cli-task-replacement", status: "running" });
      const store = await openExistingWritableRuntimeStore(workspace);
      expect(store).toBeDefined();
      try {
        await advanceRuntimeRun(workspace, store!, fork!.run.id, `test:${fork!.run.id}`);
      } finally {
        store?.close();
      }
      await expect(getRun(workspace, fork!.run.id)).resolves.toMatchObject({ status: "completed", output: { ok: true, extra: true } });
      const inspection = await getRunInspection(workspace, { runId: fork!.run.id, mode: "overview" });
      expect(inspection.isOk() ? inspection.value : undefined).toMatchObject({
        run: { id: fork!.run.id, name: "cli-task-replacement" },
      });
      expect(runtimeRows(workspace, "SELECT relative_path FROM artifacts WHERE run_id = ? ORDER BY relative_path", fork!.run.id)).toHaveLength(1);

      const inputSource = await admitSyntheticWorkflow(workspace, inputEchoWorkflow(), { value: "old" });
      const input = await normalizeForkInput(workspace, inputSource.run.id, { value: "new" });
      if (input === undefined) throw new Error("expected fork input to normalize");
      const inputFork = await forkRun(workspace, inputSource.run.id, { input });
      const store2 = await openExistingWritableRuntimeStore(workspace);
      expect(store2).toBeDefined();
      try {
        await advanceRuntimeRun(workspace, store2!, inputFork!.run.id, `test:${inputFork!.run.id}`);
      } finally {
        store2?.close();
      }
      await expect(getRun(workspace, inputFork!.run.id)).resolves.toMatchObject({ status: "completed", output: { value: "new" } });
    });
  }, 20_000);

  it("reports targeted fork seed failures from the store boundary", async () => {
    await withRuntimeWorkspace("runtime-fork-seed-typed-error", async workspace => {
      const completed = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());

      await expect(forkRun(workspace, completed.run.id, { target: "missing~abc" })).rejects.toMatchObject({
        failure: {
          type: "target-resolution-failure",
          target: "missing~abc",
        },
      });
    });
  });

  it("signals awaiting runs and rejects invalid signals without mutation", async () => {
    await withRuntimeWorkspace("runtime-signal", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, signalWorkflow());
      expect(awaiting.status).toBe("awaiting");
      const runId = awaiting.run.id;
      await expect(listRuns(workspace)).resolves.toEqual([
        expect.objectContaining({ id: runId, status: "awaiting" }),
      ]);

      await expect(signalRun(workspace, runId, "approve", { ok: "yes" })).rejects.toThrow("Signal payload does not match schema");

      await expect(controlRun(workspace, runId, "resume")).resolves.toMatchObject({ status: "awaiting" });

      const eventCountBeforeMissingSignal = runtimeRows(workspace, "SELECT type FROM run_events WHERE run_id = ?", runId).length;
      await expect(signalRun(workspace, runId, "missing", { ok: true })).rejects.toThrow("Signal node 'missing' was not found.");
      expect(runtimeRows(workspace, "SELECT type FROM run_events WHERE run_id = ?", runId)).toHaveLength(eventCountBeforeMissingSignal);
      expect(runtimeRows(workspace, "SELECT status FROM signal_waits WHERE run_id = ?", runId)).toEqual([{ status: "awaiting" }]);

      const signalPayload = { ok: true };
      await expect(signalRun(workspace, runId, "approve", signalPayload)).resolves.toMatchObject({
        run: { status: "completed", output: { ok: true } },
      });
      await expect(signalRun(workspace, runId, "approve", signalPayload)).resolves.toMatchObject({
        run: { status: "completed", output: { ok: true } },
      });
      expect(runtimeRows(workspace, "SELECT status FROM signal_waits WHERE run_id = ?", runId)).toEqual([{ status: "consumed" }]);
      const completedRun = await getRun(workspace, runId);
      expect(completedRun).toMatchObject({ status: "completed", output: { ok: true } });
      const consumedWait = completedRun?.dynamic?.signalWaits[0];
      expect(consumedWait).toMatchObject({
        status: "consumed",
        payload: signalPayload,
      });
      expect(consumedWait?.consumedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/));
    });
  });

  it("settles expired signal timeouts before validating late signal payloads", async () => {
    await withRuntimeWorkspace("runtime-signal-timeout-before-invalid-payload", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, timedSignalWorkflow());
      expect(awaiting.status).toBe("awaiting");
      const runId = awaiting.run.id;
      await waitUntil(() => {
        const row = runtimeRow(workspace, "SELECT deadline_at FROM signal_waits WHERE run_id = ?", runId) as { deadline_at?: string } | undefined;
        return typeof row?.deadline_at === "string" && Date.now() > Date.parse(row.deadline_at);
      });

      await expect(signalRun(workspace, runId, "approve", { ok: "yes" })).rejects.toThrow();
      await expect(getRun(workspace, runId)).resolves.toMatchObject({ status: "failed" });
      expect(runtimeRows(workspace, "SELECT status, terminal_reason FROM signal_waits WHERE run_id = ?", runId)).toEqual([
        { status: "timed_out", terminal_reason: "signal_timeout" },
      ]);
    });
  });

  it("signals dynamic fanout nodeKeys through scheduler control", async () => {
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
      const snapshot = await getRunVisualizationSnapshot(workspace, awaiting.run.id);
      expect(snapshot?.overlay.workflow).toMatchObject({ name: "cli-fanout-signal", runId: awaiting.run.id, status: "awaiting" });
      expect(snapshot?.overlay.nodes.find(node => node.nodeId === "approve")).toMatchObject({
        kind: "signal",
        status: "awaiting",
        instances: expect.arrayContaining([
          expect.objectContaining({ nodeId: "approve", status: "awaiting" }),
          expect.objectContaining({ nodeId: "approve", status: "awaiting" }),
        ]),
      });
      expect(snapshot?.overlay.groups).toEqual([
        expect.objectContaining({
          nodeId: "approvals",
          kind: "fanout",
          status: "running",
          strategy: "all",
          members: expect.arrayContaining([
            expect.objectContaining({ memberKind: "fanout_item", status: "running" }),
            expect.objectContaining({ memberKind: "fanout_item", status: "running" }),
          ]),
        }),
      ]);

      await expect(signalRun(workspace, awaiting.run.id, "approve", { ok: true })).rejects.toThrow("ambiguous");
      await expect(signalRun(workspace, awaiting.run.id, String(waits[0]!.node_key), { ok: true })).resolves.toMatchObject({
        run: { status: "awaiting" },
      });
      await expect(signalRun(workspace, awaiting.run.id, "approve", { ok: true })).resolves.toMatchObject({
        run: { status: "completed" },
      });
    });
  });

  it("signals parallel all and race branches through scheduler control", async () => {
    await withRuntimeWorkspace("runtime-signal-parallel", async workspace => {
      const all = await admitSyntheticWorkflow(workspace, parallelSignalAllWorkflow());
      expect(all.status).toBe("awaiting");
      await expect(signalRun(workspace, all.run.id, "left_approve", { ok: true })).resolves.toMatchObject({
        run: { status: "awaiting" },
      });
      await expect(signalRun(workspace, all.run.id, "right_approve", { ok: true })).resolves.toMatchObject({
        run: {
          status: "completed",
          output: { approvals: { left: { ok: true }, right: { ok: true } } },
        },
      });
      const fork = await forkRun(workspace, all.run.id);
      expect(fork).toMatchObject({
        run: {
          status: "completed",
          output: { approvals: { left: { ok: true }, right: { ok: true } } },
        },
      });

      const race = await admitSyntheticWorkflow(workspace, parallelSignalRaceWorkflow());
      expect(race.status).toBe("awaiting");
      await expect(signalRun(workspace, race.run.id, "left_approve", { ok: true })).resolves.toMatchObject({
        run: {
          status: "completed",
          output: { approval: { winner: "left", result: { ok: true } } },
        },
      });
      await expect(signalRun(workspace, race.run.id, "right_approve", { ok: true })).rejects.toThrow("target 'right_approve' was not found");
      const loser = runtimeRow(workspace, "SELECT node_key FROM signal_waits WHERE run_id = ? AND node_id = 'right_approve'", race.run.id);
      expect(runtimeRows(workspace, "SELECT node_id, status FROM signal_waits WHERE run_id = ? ORDER BY node_id", race.run.id)).toEqual([
        { node_id: "left_approve", status: "consumed" },
        { node_id: "right_approve", status: "cancelled" },
      ]);
      await expect(signalRun(workspace, race.run.id, String(loser!.node_key), { ok: true })).rejects.toThrow(`target '${String(loser!.node_key)}' was not found`);
    });
  });

});

type ForkOptions = {
  requestId?: string;
  target?: string;
  prepared?: PreparedRunWorkflow;
  input?: JsonValue;
  unsafeReuse?: boolean;
};

async function controlRun(
  workspace: string,
  runId: string,
  type: "pause" | "resume" | "retry" | "cancel",
  target?: string,
): Promise<RunDetails> {
  const intent: RunControlIntent = type === "retry" || type === "cancel"
    ? { requestId: `${type}:${randomUUID()}`, runId, type, ...(target === undefined ? {} : { target }) }
    : { requestId: `${type}:${randomUUID()}`, runId, type };
  return await applyControl(workspace, intent);
}

async function signalRun(workspace: string, runId: string, node: string, payload: JsonValue): Promise<{ run: RunDetails }> {
  const requestId = `signal:${randomUUID()}`;
  return {
    run: await applyControl(workspace, {
      requestId,
      runId,
      type: "signal",
      node,
      payload,
      commandIdempotencyKey: requestId,
    }),
  };
}

async function applyControl(workspace: string, intent: RunControlIntent): Promise<RunDetails> {
  const store = await openExistingWritableRuntimeStore(workspace);
  if (!store) throw new Error("Expected runtime store.");
  try {
    const result = await applySchedulerControlIntent(workspace, store, intent, { ownerId: `test:${intent.requestId}` });
    if (result.advanced?.status === "lease_lost") throw new Error(`Run '${intent.runId}' is controlled by another owner.`);
    const run = store.getRun(intent.runId);
    if (!run) throw new Error(`Run '${intent.runId}' was not found.`);
    return run;
  } finally {
    store.close();
  }
}

async function forkRun(workspace: string, runId: string, options: ForkOptions = {}): Promise<{ run: RunDetails }> {
  const store = await openExistingWritableRuntimeStore(workspace);
  if (!store) throw new Error("Expected runtime store.");
  try {
    const fork = await store.forkRun(runId, options);
    const run = store.getRun(fork.id);
    if (!run) throw new Error(`Fork run '${fork.id}' was not found.`);
    return { run };
  } finally {
    store.close();
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}
