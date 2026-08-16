import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { defineWorkflow, z } from "@acpus/core";
import { getRun, listRuns, tryNormalizeForkInput, type PreparedRunWorkflow } from "@acpus/runtime";
import { deriveOccurrenceRef } from "../src/scheduler/occurrence-ref.js";
import { openExistingWritableRuntimeStore } from "../src/store/store.js";
import {
  admitSyntheticWorkflow,
  inputEchoWorkflow,
  metaWorkflow,
  prepareSyntheticWorkflow,
  replacementTaskWorkflow,
  runtimeDatabasePath,
  runtimeRunDir,
  runtimeRow,
  runtimeRows,
  runtimeRunsRoot,
  scalarWorkflow,
  taskArtifactWorkflow,
  validWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";
import { advanceRuntimeRun } from "./support/scheduler.js";
import { advanceRun, forkRun } from "./support/runtime-controls.js";

describe.concurrent("runtime controls and recovery", () => {

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

  it("preserves an explicit null fork input instead of inheriting the source input", async () => {
    await withRuntimeWorkspace("runtime-fork-null-input", async workspace => {
      const workflow = defineWorkflow({
        name: "runtime-fork-null-input",
        inputSchema: z.union([z.string(), z.null()]),
      }).build(({ input, step }) => {
        step("accept_input").assert({ condition: true });
        return { value: input };
      });
      const source = await admitSyntheticWorkflow(workspace, workflow, "source");

      const fork = await forkRun(workspace, source.run.id, { input: null });
      await advanceRun(workspace, fork.run.id);

      expect((await getRun(workspace, fork.run.id))._unsafeUnwrap()).toMatchObject({
        status: "completed",
        output: { value: null },
      });
    });
  });

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

});
