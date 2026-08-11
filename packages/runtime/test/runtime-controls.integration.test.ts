import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@acpus/expression/ir";
import { getRun, getRunVisualizationSnapshot, inspectNode, listRuns, tryNormalizeForkInput, type PreparedRunWorkflow } from "@acpus/runtime";
import type { RunControlIntent } from "../src/scheduler/control.js";
import { deriveOccurrenceRef } from "../src/scheduler/occurrence-ref.js";
import { openExistingWritableRuntimeStore, openRuntimeStore, type RunDetails } from "../src/store/store.js";
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
  runtimeDatabasePath,
  runtimeRunDir,
  runtimeRow,
  runtimeRows,
  runtimeRunsRoot,
  scalarWorkflow,
  signalWorkflow,
  taskArtifactWorkflow,
  timedSignalWorkflow,
  validWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";
import { advanceRuntimeRun, applySchedulerControlIntent } from "./support/scheduler.js";
import { admitRunForTest } from "./support/runtime-store.js";

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

    });
  });

  it("cancels a paused run before its root frame materializes", async () => {
    await withRuntimeWorkspace("runtime-cancel-paused-before-root", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, scalarWorkflow());
      const store = await openRuntimeStore(workspace);
      const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace })
        .finally(() => store.close());

      await expect(controlRun(workspace, run.id, "pause")).resolves.toMatchObject({ status: "paused" });
      expect((await getRunVisualizationSnapshot(workspace, run.id))._unsafeUnwrap()).toMatchObject({
        controls: { canCancelRun: true },
      });
      await expect(controlRun(workspace, run.id, "cancel")).resolves.toMatchObject({ status: "canceled" });
      expect(runtimeRows(
        workspace,
        "SELECT type FROM run_events WHERE run_id = ? AND type LIKE 'frame.%' ORDER BY sequence",
        run.id,
      )).toEqual([
        { type: "frame.started" },
        { type: "frame.cancelled" },
      ]);
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

      expect(fork.run.status).toBe("pending");
      expect(fork?.run.id).not.toBe(source.run.id);
      expect(source.run.fork).toBeUndefined();
      expect(fork?.run.fork).toEqual({ sourceRunId: source.run.id });
      const sourceArtifacts = runtimeRows(workspace, "SELECT id, media_type, digest, size, relative_path FROM artifacts WHERE run_id = ? ORDER BY id", source.run.id);
      expect(runtimeRows(workspace, "SELECT id FROM artifacts WHERE run_id = ?", fork.run.id)).toEqual([]);

      await advanceRun(workspace, fork.run.id);

      const forkArtifacts = runtimeRows(workspace, "SELECT id, media_type, digest, size, relative_path FROM artifacts WHERE run_id = ? ORDER BY id", fork.run.id);
      expect(forkArtifacts).toHaveLength(sourceArtifacts.length);
      expect(forkArtifacts.map(row => row.id)).not.toEqual(sourceArtifacts.map(row => row.id));
      expect(forkArtifacts.map(({ id: _id, relative_path: _path, ...row }) => row))
        .toEqual(sourceArtifacts.map(({ id: _id, relative_path: _path, ...row }) => row));
      expect(forkArtifacts.map(row => String(row.relative_path))).toEqual([
        expect.stringContaining(join("artifacts", ".fork-replay")),
      ]);
      expect((await getRun(workspace, fork.run.id))._unsafeUnwrap()).toMatchObject({ status: "completed", output: { ok: true }, fork: { sourceRunId: source.run.id } });
      expect((await getRun(workspace, fork.run.id))._unsafeUnwrap()).toMatchObject({ fork: {
        sourceRunId: source.run.id,
      } });

      const forkOfFork = await forkRun(workspace, fork.run.id);
      expect(forkOfFork.run).toMatchObject({ status: "pending", fork: { sourceRunId: fork.run.id } });
      await advanceRun(workspace, forkOfFork.run.id);
      expect((await getRun(workspace, forkOfFork.run.id))._unsafeUnwrap()).toMatchObject({ status: "completed", output: { ok: true } });
    });
  });

  it("materializes only frozen files and reachable registered artifacts in a fork", async () => {
    await withRuntimeWorkspace("runtime-fork-files-whitelist", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const sourceRunDir = runtimeRunDir(workspace, source.run.id);
      await mkdir(join(sourceRunDir, "outputs", "stale"), { recursive: true });
      await mkdir(join(sourceRunDir, "work"), { recursive: true });
      await writeFile(join(sourceRunDir, "outputs", "stale", "result.txt"), "unowned output");
      await writeFile(join(sourceRunDir, "work", "scratch.txt"), "unowned work");
      await writeFile(join(sourceRunDir, "artifacts", "unregistered.txt"), "unregistered artifact");
      await writeFile(join(sourceRunDir, "unknown.txt"), "unregistered");
      const outside = join(workspace, "outside.txt");
      await writeFile(outside, "outside");
      await symlink(outside, join(sourceRunDir, "unknown-link"));

      const fork = await forkRun(workspace, source.run.id);
      const forkRunDir = runtimeRunDir(workspace, fork.run.id);

      expect((await readdir(sourceRunDir)).sort()).toEqual([
        "artifacts",
        "lock.json",
        "outputs",
        "unknown-link",
        "unknown.txt",
        "work",
        "workflow.ir.json",
      ]);
      expect((await readdir(forkRunDir)).sort()).toEqual(["artifacts", "lock.json", "workflow.ir.json"]);
      await expect(access(join(sourceRunDir, "artifacts", "unregistered.txt"))).resolves.toBeUndefined();
      await expect(access(join(forkRunDir, "artifacts", "unregistered.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rolls back fork publication when an inherited artifact fails verification", async () => {
    await withRuntimeWorkspace("runtime-fork-artifact-verification", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const artifact = runtimeRow(workspace, "SELECT id, relative_path FROM artifacts WHERE run_id = ?", source.run.id);
      const runsDir = runtimeRunsRoot(workspace);
      const runEntriesBefore = (await readdir(runsDir)).sort();
      await writeFile(join(runsDir, source.run.id, String(artifact?.relative_path)), "tampered\n");

      await expect(forkRun(workspace, source.run.id)).rejects.toThrow(
        `Fork artifact '${String(artifact?.id)}' failed source verification.`,
      );

      expect((await readdir(runsDir)).sort()).toEqual(runEntriesBefore);
      expect(runtimeRows(workspace, "SELECT id FROM runs ORDER BY id")).toEqual([{ id: source.run.id }]);
    });
  });

  it("rejects inherited artifact records outside the physical artifacts tree", async () => {
    await withRuntimeWorkspace("runtime-fork-artifact-path", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const artifact = runtimeRow(workspace, "SELECT id, relative_path FROM artifacts WHERE run_id = ?", source.run.id);
      const sourceRunDir = runtimeRunDir(workspace, source.run.id);
      const artifactBytes = await readFile(join(sourceRunDir, String(artifact?.relative_path)));
      const db = new DatabaseSync(runtimeDatabasePath(workspace));
      try {
        db.prepare("UPDATE artifacts SET relative_path = 'workflow.ir.json' WHERE id = ?").run(String(artifact?.id));
      } finally {
        db.close();
      }
      const runsDir = runtimeRunsRoot(workspace);
      const runEntriesBefore = (await readdir(runsDir)).sort();

      await expect(forkRun(workspace, source.run.id)).rejects.toThrow(
        `Fork artifact '${String(artifact?.id)}' has invalid relative path.`,
      );

      expect((await readdir(runsDir)).sort()).toEqual(runEntriesBefore);
      expect(runtimeRows(workspace, "SELECT id FROM runs ORDER BY id")).toEqual([{ id: source.run.id }]);

      await mkdir(join(sourceRunDir, "work"), { recursive: true });
      await writeFile(join(sourceRunDir, "work", "linked-artifact"), artifactBytes);
      await symlink("../work", join(sourceRunDir, "artifacts", "linked"));
      const linkedDb = new DatabaseSync(runtimeDatabasePath(workspace));
      try {
        linkedDb.prepare("UPDATE artifacts SET relative_path = 'artifacts/linked/linked-artifact' WHERE id = ?").run(String(artifact?.id));
      } finally {
        linkedDb.close();
      }

      await expect(forkRun(workspace, source.run.id)).rejects.toThrow(
        `Fork artifact '${String(artifact?.id)}' has invalid relative path.`,
      );
      expect((await readdir(runsDir)).sort()).toEqual(runEntriesBefore);
      expect(runtimeRows(workspace, "SELECT id FROM runs ORDER BY id")).toEqual([{ id: source.run.id }]);
    });
  });

  it("preserves scalar workflow output across completed forks", async () => {
    await withRuntimeWorkspace("runtime-fork-scalar-output", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, scalarWorkflow());
      expect(source.run).toMatchObject({ status: "completed", output: "ready" });

      const fork = await forkRun(workspace, source.run.id);

      expect(fork.run.status).toBe("pending");
      expect(fork.run.output).toBeUndefined();
      await advanceRun(workspace, fork.run.id);
      expect((await getRun(workspace, fork.run.id))._unsafeUnwrap()).toMatchObject({ status: "completed", output: "ready" });
    });
  });

  it("rejects forks when the frozen workflow lock digest does not match", async () => {
    await withRuntimeWorkspace("runtime-fork-lock-digest", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, metaWorkflow());
      await writeFile(join(runtimeRunDir(workspace, source.run.id), "lock.json"), "{}\n");

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
      expect((await listRuns(workspace))._unsafeUnwrap().map(run => run.id).sort())
        .toEqual([source.run.id, forkId].sort());
    });
  });

  it("keeps fork identity independent of package-lock metadata", async () => {
    await withRuntimeWorkspace("runtime-fork-package-lock-independent", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, validWorkflow(), { ready: true });
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const firstPackageLock = `sha256:${"a".repeat(64)}` as const;
      const secondPackageLock = `sha256:${"b".repeat(64)}` as const;
      const firstPrepared: PreparedRunWorkflow = {
        ...prepared,
        packageLockDigest: firstPackageLock,
        lock: { ...prepared.lock, packageLockDigest: firstPackageLock },
      };
      const secondPrepared: PreparedRunWorkflow = {
        ...prepared,
        packageLockDigest: secondPackageLock,
        lock: { ...prepared.lock, packageLockDigest: secondPackageLock },
      };

      const first = await forkRun(workspace, source.run.id, {
        requestId: "package-lock-independent",
        prepared: firstPrepared,
      });
      const replay = await forkRun(workspace, source.run.id, {
        requestId: "package-lock-independent",
        prepared: secondPrepared,
      });

      expect(replay.run.id).toBe(first.run.id);
      expect((await listRuns(workspace))._unsafeUnwrap().map(run => run.id).sort())
        .toEqual([source.run.id, first.run.id].sort());
    });
  });

  it("rejects a reused fork request id with different input", async () => {
    await withRuntimeWorkspace("runtime-fork-idempotent-conflict", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, inputEchoWorkflow(), { value: "old" });
      const firstInput = (await tryNormalizeForkInput(workspace, source.run.id, { value: "first" }))._unsafeUnwrap();
      const secondInput = (await tryNormalizeForkInput(workspace, source.run.id, { value: "second" }))._unsafeUnwrap();
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
      const sourceRunDir = runtimeRunDir(workspace, source.run.id);
      await mkdir(join(sourceRunDir, "artifacts", nodeKey, "attempt-98"), { recursive: true });
      await mkdir(join(sourceRunDir, "artifacts", nodeKey, "attempt-99"), { recursive: true });
      await writeFile(join(sourceRunDir, failedRelativePath), failedBytes);
      await writeFile(join(sourceRunDir, supersededRelativePath), supersededBytes);
      const db = new DatabaseSync(runtimeDatabasePath(workspace));
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
      expect(runtimeRows(workspace, "SELECT relative_path FROM artifacts WHERE run_id = ?", fork.run.id)).toEqual([]);

      await advanceRun(workspace, fork.run.id);

      const forkArtifacts = runtimeRows(workspace, "SELECT relative_path FROM artifacts WHERE run_id = ? ORDER BY relative_path", fork.run.id);
      expect(forkArtifacts).toHaveLength(1);
      expect(forkArtifacts.map(row => row.relative_path)).not.toContain(failedRelativePath);
      expect(forkArtifacts.map(row => row.relative_path)).not.toContain(supersededRelativePath);
      await expect(access(join(runtimeRunDir(workspace, fork.run.id), failedRelativePath))).rejects.toThrow();
      await expect(access(join(runtimeRunDir(workspace, fork.run.id), supersededRelativePath))).rejects.toThrow();
    });
  });

  it("forks completed runs with fork-local meta outputs", async () => {
    await withRuntimeWorkspace("runtime-fork-meta", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, metaWorkflow());
      expect(source.status).toBe("completed");

      const fork = await forkRun(workspace, source.run.id);

      expect(fork.run.status).toBe("pending");
      expect(fork?.run.id).not.toBe(source.run.id);
      await advanceRun(workspace, fork.run.id);
      expect((await getRun(workspace, fork.run.id))._unsafeUnwrap()).toMatchObject({
        status: "completed",
        output: {
          runId: fork.run.id,
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

      expect(fork?.run).toMatchObject({ name: "cli-task-replacement", status: "pending" });
      const store = await openExistingWritableRuntimeStore(workspace);
      expect(store).toBeDefined();
      try {
        await advanceRuntimeRun(workspace, store!, fork!.run.id, `test:${fork!.run.id}`);
      } finally {
        store?.close();
      }
      expect((await getRun(workspace, fork!.run.id))._unsafeUnwrap()).toMatchObject({ status: "completed", output: { ok: true, extra: true } });
      expect((await getRun(workspace, fork!.run.id))._unsafeUnwrap()).toMatchObject({
        id: fork!.run.id,
        name: "cli-task-replacement",
      });
      const replacementArtifacts = runtimeRows(workspace, "SELECT relative_path FROM artifacts WHERE run_id = ? ORDER BY relative_path", fork!.run.id);
      expect(replacementArtifacts).toHaveLength(1);
      expect(String(replacementArtifacts[0]!.relative_path)).not.toContain(".fork-replay");
      await expect(readFile(join(runtimeRunDir(workspace, fork.run.id), String(replacementArtifacts[0]!.relative_path)), "utf8"))
        .resolves.toBe("replacement\n");

      const inputSource = await admitSyntheticWorkflow(workspace, inputEchoWorkflow(), { value: "old" });
      const input = (await tryNormalizeForkInput(workspace, inputSource.run.id, { value: "new" }))._unsafeUnwrap();
      if (input === undefined) throw new Error("expected fork input to normalize");
      const inputFork = await forkRun(workspace, inputSource.run.id, { input });
      const store2 = await openExistingWritableRuntimeStore(workspace);
      expect(store2).toBeDefined();
      try {
        await advanceRuntimeRun(workspace, store2!, inputFork!.run.id, `test:${inputFork!.run.id}`);
      } finally {
        store2?.close();
      }
      expect((await getRun(workspace, inputFork!.run.id))._unsafeUnwrap()).toMatchObject({ status: "completed", output: { value: "new" } });
    });
  }, 20_000);

  it("reports targeted fork checkpoint failures from the store boundary", async () => {
    await withRuntimeWorkspace("runtime-fork-checkpoint-typed-error", async workspace => {
      const completed = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());

      await expect(forkRun(workspace, completed.run.id, { target: "missing~abc" })).rejects.toMatchObject({
        failure: {
          type: "target-resolution-failure",
          target: "missing~abc",
        },
      });

      const instancePath = completed.run.dynamic?.nodeInstances
        .find(instance => instance.nodeId === "local_task")?.instancePath;
      if (!instancePath) throw new Error("Expected local_task to have a materialized instance path.");
      const occurrenceTarget = deriveOccurrenceRef(instancePath);
      const attemptTarget = `${occurrenceTarget}#1`;
      const message = `Fork target '${attemptTarget}' selects attempt 1; use occurrence target '${occurrenceTarget}' without the attempt suffix.`;

      await expect(forkRun(workspace, completed.run.id, { target: attemptTarget })).rejects.toMatchObject({
        message,
        failure: {
          type: "target-resolution-failure",
          target: attemptTarget,
          message,
        },
      });
      expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM runs")).toEqual({ count: 1 });

      await expect(forkRun(workspace, completed.run.id, { target: occurrenceTarget })).resolves.toMatchObject({
        run: { fork: { sourceRunId: completed.run.id, target: occurrenceTarget } },
      });
    });
  });

  it("signals awaiting runs and rejects invalid signals without mutation", async () => {
    await withRuntimeWorkspace("runtime-signal", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, signalWorkflow());
      expect(awaiting.status).toBe("awaiting");
      const runId = awaiting.run.id;
      expect((await listRuns(workspace))._unsafeUnwrap()).toEqual([
        expect.objectContaining({ id: runId, status: "awaiting" }),
      ]);

      await expect(signalRun(workspace, runId, "approve", { ok: "yes" })).rejects.toMatchObject({
        failure: { type: "signal-payload-invalid", runId, target: "approve" },
      });

      await expect(controlRun(workspace, runId, "resume")).resolves.toMatchObject({ status: "awaiting" });

      const beforeMissingSignal = (await getRun(workspace, runId))._unsafeUnwrap();
      await expect(signalRun(workspace, runId, "missing", { ok: true })).rejects.toMatchObject({
        failure: { type: "signal-target-not-found", runId, target: "missing" },
      });
      const afterMissingSignal = (await getRun(workspace, runId))._unsafeUnwrap();
      expect(afterMissingSignal?.eventCount).toBe(beforeMissingSignal?.eventCount);
      expect(afterMissingSignal?.dynamic?.signalWaits).toEqual([
        expect.objectContaining({ status: "awaiting" }),
      ]);

      const signalPayload = { ok: true };
      const signalCommandIdempotencyKey = "signal:approve-command";
      await expect(signalRun(workspace, runId, "approve", signalPayload, signalCommandIdempotencyKey)).resolves.toMatchObject({
        run: { status: "completed", output: { ok: true } },
      });
      await expect(signalRun(workspace, runId, "approve", signalPayload, signalCommandIdempotencyKey)).resolves.toMatchObject({
        run: { status: "completed", output: { ok: true } },
      });
      const completedRun = (await getRun(workspace, runId))._unsafeUnwrap();
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
      expect((await getRun(workspace, runId))._unsafeUnwrap()).toMatchObject({ status: "failed" });
      expect(runtimeRows(workspace, "SELECT status, terminal_reason FROM signal_waits WHERE run_id = ?", runId)).toEqual([
        { status: "timed_out", terminal_reason: "signal_timeout" },
      ]);
    });
  });

  it("projects selected cancel only while the exact dynamic target is controllable", async () => {
    await withRuntimeWorkspace("runtime-selected-cancel-projection", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, signalWorkflow());
      const before = await inspectNode(workspace, {
        runId: awaiting.run.id,
        target: "approve",
      });
      expect(before.isOk()
        ? before.value.availableControls
        : undefined).toEqual([
        { type: "cancel", target: expect.any(String) },
      ]);
      const cancelTarget = before.isOk()
        ? before.value.availableControls[0]?.target
        : undefined;
      expect(cancelTarget).toEqual(
        before.isOk()
          ? before.value.summary.nodeKey
          : undefined,
      );

      await signalRun(workspace, awaiting.run.id, "approve", { ok: true });
      const after = await inspectNode(workspace, {
        runId: awaiting.run.id,
        target: "approve",
      });
      expect(after.isOk()
        ? after.value.availableControls
        : undefined).toEqual([]);
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
      const run = (await getRun(workspace, awaiting.run.id))._unsafeUnwrap();
      expect(run?.dynamic?.nodeInstances.filter(instance => instance.nodeId === "approve" && instance.status === "awaiting")).toHaveLength(2);
      expect(run?.dynamic?.signalWaits.filter(wait => wait.nodeId === "approve" && wait.status === "awaiting")).toHaveLength(2);
      const snapshot = (await getRunVisualizationSnapshot(workspace, awaiting.run.id))._unsafeUnwrap();
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

  it("replays only completed members when forking an active fanout-all", async () => {
    await withRuntimeWorkspace("runtime-fork-active-fanout", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, fanoutSignalWorkflow(), { items: ["a", "b", "c"] });
      const sourceWaits = runtimeRows(workspace, "SELECT node_key FROM signal_waits WHERE run_id = ? ORDER BY node_key", source.run.id);
      await signalRun(workspace, source.run.id, String(sourceWaits[0]!.node_key), { ok: true });

      const fork = await forkRun(workspace, source.run.id);
      await advanceRun(workspace, fork.run.id);

      const child = (await getRun(workspace, fork.run.id))._unsafeUnwrap();
      expect(child?.status).toBe("awaiting");
      expect(child?.dynamic?.nodeInstances.filter(instance => instance.nodeId === "approve" && instance.reusedFromRunId === source.run.id)).toHaveLength(1);
      const childWaits = runtimeRows(workspace, "SELECT node_key FROM signal_waits WHERE run_id = ? AND status = 'awaiting' ORDER BY node_key", fork.run.id);
      expect(childWaits).toHaveLength(2);
      await signalRun(workspace, fork.run.id, String(childWaits[0]!.node_key), { ok: true });
      await expect(signalRun(workspace, fork.run.id, String(childWaits[1]!.node_key), { ok: true })).resolves.toMatchObject({
        run: { status: "completed" },
      });
    });
  });

  it("replays consumed signals by default and re-asks a targeted signal", async () => {
    await withRuntimeWorkspace("runtime-fork-signal-replay", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, signalWorkflow());
      await signalRun(workspace, source.run.id, "approve", { ok: true });

      const replayed = await forkRun(workspace, source.run.id);
      await advanceRun(workspace, replayed.run.id);
      expect((await getRun(workspace, replayed.run.id))._unsafeUnwrap()).toMatchObject({
        status: "completed",
        output: { ok: true },
      });
      expect(runtimeRows(workspace, "SELECT status FROM signal_waits WHERE run_id = ?", replayed.run.id)).toEqual([]);
      expect((await getRun(workspace, replayed.run.id))._unsafeUnwrap()?.dynamic?.nodeInstances).toEqual([
        expect.objectContaining({ reusedFromRunId: source.run.id }),
      ]);

      const targeted = await forkRun(workspace, source.run.id, { target: "approve" });
      await advanceRun(workspace, targeted.run.id);
      expect((await getRun(workspace, targeted.run.id))._unsafeUnwrap()).toMatchObject({ status: "awaiting" });
      await expect(signalRun(workspace, targeted.run.id, "approve", { ok: true })).resolves.toMatchObject({
        run: { status: "completed", output: { ok: true } },
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
      expect(fork.run.status).toBe("pending");
      expect(fork.run.output).toBeUndefined();
      await advanceRun(workspace, fork.run.id);
      expect((await getRun(workspace, fork.run.id))._unsafeUnwrap()).toMatchObject({
        status: "completed",
        output: { approvals: { left: { ok: true }, right: { ok: true } } },
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

      const raceFork = await forkRun(workspace, race.run.id);
      await advanceRun(workspace, raceFork.run.id);
      expect((await getRun(workspace, raceFork.run.id))._unsafeUnwrap()).toMatchObject({
        status: "completed",
        output: { approval: { winner: "left", result: { ok: true } } },
      });
      expect(runtimeRows(workspace, "SELECT node_id FROM signal_waits WHERE run_id = ?", raceFork.run.id)).toEqual([]);
    });
  });

});

type ForkOptions = {
  requestId?: string;
  target?: string;
  prepared?: PreparedRunWorkflow;
  input?: JsonValue;
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

async function signalRun(
  workspace: string,
  runId: string,
  node: string,
  payload: JsonValue,
  commandIdempotencyKey?: string,
): Promise<{ run: RunDetails }> {
  const requestId = `signal:${randomUUID()}`;
  return {
    run: await applyControl(workspace, {
      requestId,
      runId,
      type: "signal",
      node,
      payload,
      commandIdempotencyKey: commandIdempotencyKey ?? requestId,
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
    const forkResult = await store.forkRun(runId, options);
    if (forkResult.isErr()) throw Object.assign(new Error(forkResult.error.message), { failure: forkResult.error });
    const fork = forkResult.value;
    const run = store.getRun(fork.id);
    if (!run) throw new Error(`Fork run '${fork.id}' was not found.`);
    return { run };
  } finally {
    store.close();
  }
}

async function advanceRun(workspace: string, runId: string): Promise<void> {
  const store = await openExistingWritableRuntimeStore(workspace);
  if (!store) throw new Error("Expected runtime store.");
  try {
    await advanceRuntimeRun(workspace, store, runId, `test:${runId}`);
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
