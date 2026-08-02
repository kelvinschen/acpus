import { admitRunForTest } from "./support/runtime-store.js";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { readArtifact, resolveArtifact } from "../src/runs/use-cases.js";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import type { AttemptStartInput, SchedulerSnapshot, SchedulerStorePort, SchedulerStoreResult } from "../src/scheduler/store-port.js";
import { throwSchedulerStoreResult } from "../src/scheduler/store-port.js";
import { openRuntimeStore, type RegisterArtifactInput, type RuntimeStore } from "../src/store/store.js";
import { tryCaptureRunFile } from "../src/store/run-file.js";
import { prepareSyntheticWorkflow, runtimeDatabasePath, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

describe("scheduler store attempt fences", () => {
  it("starts against one snapshot version and binds replay identity to that admission version", async () => {
    await withRuntimeWorkspace("scheduler-store-start-version-fence", async workspace => {
      const store = await openedStore(workspace);
      try {
        const run = await admittedRun(store, workspace);
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const ready = appendReadyInstances(store.scheduler, run.id, claim.ownerEpoch, ["first", "second"]);
        const input = startInput(run.id, "first", claim.ownerEpoch, ready.version);

        const started = unwrap(store.scheduler.tryStartAttempt(input));
        expect(started).toMatchObject({ disposition: "started", attemptNo: 1 });
        expect(started.snapshot.projection.instances.first).toMatchObject({ status: "running" });

        const replayed = unwrap(store.scheduler.tryStartAttempt(input));
        expect(replayed).toMatchObject({
          disposition: "existing",
          attemptId: started.attemptId,
          attemptNo: started.attemptNo,
        });
        expect(replayed.snapshot.version).toBe(started.snapshot.version);

        const rebound = store.scheduler.tryStartAttempt({
          ...input,
          expectedVersion: started.snapshot.version,
        });
        expect(rebound.isErr()).toBe(true);
        if (rebound.isOk()) throw new Error("expected admission-version rebound to fail");
        expect(rebound.error).toMatchObject({
          type: "idempotency-conflict",
          idempotencyKey: input.idempotencyKey,
          runId: run.id,
        });

        const stale = store.scheduler.tryStartAttempt(startInput(run.id, "second", claim.ownerEpoch, ready.version));
        expect(stale.isErr()).toBe(true);
        if (stale.isOk()) throw new Error("expected stale attempt start to fail");
        expect(stale.error).toMatchObject({ type: "version-mismatch", expectedVersion: ready.version, actualVersion: started.snapshot.version });
        expect(unwrap(store.scheduler.tryLoadRunSnapshot(run.id)).projection.instances.second).toMatchObject({ status: "ready" });
      } finally {
        store.close();
      }
    });
  });

  it("requires a ready instance and an active owner even when the start identity already exists", async () => {
    await withRuntimeWorkspace("scheduler-store-start-state-fence", async workspace => {
      const store = await openedStore(workspace);
      try {
        const run = await admittedRun(store, workspace);
        const firstOwner = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const ready = appendReadyInstances(store.scheduler, run.id, firstOwner.ownerEpoch, ["leaf"]);
        const input = startInput(run.id, "leaf", firstOwner.ownerEpoch, ready.version);
        const started = unwrap(store.scheduler.tryStartAttempt(input));

        const secondIdentity = store.scheduler.tryStartAttempt({
          ...input,
          expectedVersion: started.snapshot.version,
          idempotencyKey: `${input.idempotencyKey}:second`,
        });
        expect(secondIdentity.isErr()).toBe(true);
        if (secondIdentity.isOk()) throw new Error("expected running instance start to fail");
        expect(secondIdentity.error).toMatchObject({ type: "instance-not-ready", runId: run.id, nodeKey: "leaf", status: "running" });

        expect(store.scheduler.releaseRun(firstOwner)).toBe(true);
        expect(store.scheduler.claimRun(run.id, "owner-b", 60_000)).toMatchObject({ ownerEpoch: firstOwner.ownerEpoch + 1 });
        const staleReplay = store.scheduler.tryStartAttempt(input);
        expect(staleReplay.isErr()).toBe(true);
        if (staleReplay.isOk()) throw new Error("expected stale owner replay to fail");
        expect(staleReplay.error).toMatchObject({ type: "owner-epoch-inactive", runId: run.id, ownerEpoch: firstOwner.ownerEpoch });
      } finally {
        store.close();
      }
    });
  });

  it("requires the original owner to remain active when replaying an accepted result", async () => {
    await withRuntimeWorkspace("scheduler-store-result-replay-owner-fence", async workspace => {
      const store = await openedStore(workspace);
      try {
        const run = await admittedRun(store, workspace);
        const firstOwner = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const ready = appendReadyInstances(store.scheduler, run.id, firstOwner.ownerEpoch, ["leaf"]);
        const attempt = unwrap(store.scheduler.tryStartAttempt(startInput(run.id, "leaf", firstOwner.ownerEpoch, ready.version)));
        const commit = {
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: firstOwner.ownerEpoch,
          result: { status: "completed" as const, output: { ok: true } },
          idempotencyKey: "result-replay:complete",
        };
        unwrap(store.scheduler.tryCommitAttemptResult(commit));

        expireRunLease(workspace, run.id);
        expect(store.scheduler.claimRun(run.id, "owner-b", 60_000)).toMatchObject({ ownerEpoch: firstOwner.ownerEpoch + 1 });
        const replay = store.scheduler.tryCommitAttemptResult(commit);

        expect(replay.isErr()).toBe(true);
        if (replay.isOk()) throw new Error("expected stale result replay to fail");
        expect(replay.error).toMatchObject({ type: "owner-epoch-inactive", runId: run.id, ownerEpoch: firstOwner.ownerEpoch });
      } finally {
        store.close();
      }
    });
  });

  it("requeues a paused leaf without releasing its live group member", async () => {
    await withRuntimeWorkspace("scheduler-store-pause-member-slot", async workspace => {
      const store = await openedStore(workspace);
      try {
        const run = await admittedRun(store, workspace);
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const ready = appendReadyGroupLeaf(store.scheduler, run.id, claim.ownerEpoch, "leaf");
        const attempt = unwrap(store.scheduler.tryStartAttempt(startInput(run.id, "leaf", claim.ownerEpoch, ready.version)));

        const paused = unwrap(store.scheduler.tryPauseRun({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "pause:member-slot",
        }));

        expect(paused.projection.attempts[attempt.attemptId]).toMatchObject({ status: "cancelled", cancelReason: "paused" });
        expect(paused.projection.instances.leaf).toMatchObject({ status: "ready", statusReason: "paused" });
        expect(paused.projection.groupMembers.leaf).toMatchObject({ status: "running" });
      } finally {
        store.close();
      }
    });
  });

  it("fences recovery by the current owner and keeps live group members occupied", async () => {
    await withRuntimeWorkspace("scheduler-store-recovery-owner-fence", async workspace => {
      const store = await openedStore(workspace);
      try {
        const run = await admittedRun(store, workspace);
        const expiredOwner = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const ready = appendReadyGroupLeaf(store.scheduler, run.id, expiredOwner.ownerEpoch, "leaf");
        const attempt = unwrap(store.scheduler.tryStartAttempt(startInput(run.id, "leaf", expiredOwner.ownerEpoch, ready.version)));
        expireRunLease(workspace, run.id);
        const currentOwner = store.scheduler.claimRun(run.id, "owner-b", 60_000)!;
        const beforeRecovery = unwrap(store.scheduler.tryLoadRunSnapshot(run.id));

        const staleVersion = store.scheduler.tryMarkExpiredOwnerAttemptsSuperseded({
          runId: run.id,
          currentOwnerEpoch: currentOwner.ownerEpoch,
          expiredOwnerEpoch: expiredOwner.ownerEpoch,
          expectedVersion: beforeRecovery.version - 1,
        });
        expect(staleVersion.isErr()).toBe(true);
        if (staleVersion.isOk()) throw new Error("expected recovery version fence to fail");
        expect(staleVersion.error).toMatchObject({
          type: "version-mismatch",
          expectedVersion: beforeRecovery.version - 1,
          actualVersion: beforeRecovery.version,
        });

        const wrongOwner = store.scheduler.tryMarkExpiredOwnerAttemptsSuperseded({
          runId: run.id,
          currentOwnerEpoch: currentOwner.ownerEpoch + 1,
          expiredOwnerEpoch: expiredOwner.ownerEpoch,
          expectedVersion: beforeRecovery.version,
        });
        expect(wrongOwner.isErr()).toBe(true);
        if (wrongOwner.isOk()) throw new Error("expected current owner fence to fail");
        expect(wrongOwner.error).toMatchObject({ type: "owner-epoch-inactive", ownerEpoch: currentOwner.ownerEpoch + 1 });

        const recovered = unwrap(store.scheduler.tryMarkExpiredOwnerAttemptsSuperseded({
          runId: run.id,
          currentOwnerEpoch: currentOwner.ownerEpoch,
          expiredOwnerEpoch: expiredOwner.ownerEpoch,
          expectedVersion: beforeRecovery.version,
        }));
        expect(recovered.projection.attempts[attempt.attemptId]).toMatchObject({ status: "superseded" });
        expect(recovered.projection.instances.leaf).toMatchObject({ status: "ready", statusReason: "superseded" });
        expect(recovered.projection.groupMembers.leaf).toMatchObject({ status: "running" });
      } finally {
        store.close();
      }
    });
  });

  it("returns tagged artifact fences and never records terminal-attempt artifacts", async () => {
    await withRuntimeWorkspace("scheduler-store-artifact-fence", async workspace => {
      const store = await openedStore(workspace);
      try {
        const run = await admittedRun(store, workspace);
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const ready = appendReadyInstances(store.scheduler, run.id, claim.ownerEpoch, ["leaf"]);
        const attempt = unwrap(store.scheduler.tryStartAttempt(startInput(run.id, "leaf", claim.ownerEpoch, ready.version)));
        const first = artifactInput(store, run.id, attempt.attemptId, claim.ownerEpoch, "artifact_first");

        await materializeArtifact(store, first);
        expect(store.registerArtifact(first).isOk()).toBe(true);
        unwrap(store.scheduler.tryCommitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "completed", output: { ok: true } },
          idempotencyKey: "artifact-fence:complete",
        }));

        const late = artifactInput(store, run.id, attempt.attemptId, claim.ownerEpoch, "artifact_late");
        const rejected = store.registerArtifact(late);
        expect(rejected.isErr()).toBe(true);
        if (rejected.isOk()) throw new Error("expected terminal artifact registration to fail");
        expect(rejected.error).toMatchObject({ type: "terminal-attempt", attemptId: attempt.attemptId, status: "completed" });
        expect(store.listArtifacts(run.id).map(artifact => artifact.id)).toEqual([first.id]);
      } finally {
        store.close();
      }
    });
  });

  it("rejects artifacts from a superseded attempt", async () => {
    await withRuntimeWorkspace("scheduler-store-superseded-artifact-fence", async workspace => {
      const store = await openedStore(workspace);
      try {
        const run = await admittedRun(store, workspace);
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const ready = appendReadyInstances(store.scheduler, run.id, claim.ownerEpoch, ["leaf"]);
        const attempt = unwrap(store.scheduler.tryStartAttempt(startInput(run.id, "leaf", claim.ownerEpoch, ready.version)));
        const current = unwrap(store.scheduler.tryLoadRunSnapshot(run.id));
        unwrap(store.scheduler.tryAppendSchedulerEvents({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          expectedVersion: current.version,
          idempotencyKey: "artifact-fence:supersede",
          events: [{ type: "attempt.superseded", payload: { attemptId: attempt.attemptId, cancelReason: "operator_steered" } }],
        }));

        const late = store.registerArtifact(artifactInput(
          store,
          run.id,
          attempt.attemptId,
          claim.ownerEpoch,
          "artifact_late",
        ));
        expect(late.isErr()).toBe(true);
        if (late.isOk()) throw new Error("expected superseded artifact registration to fail");
        expect(late.error).toMatchObject({ type: "terminal-attempt", attemptId: attempt.attemptId, status: "superseded" });
        expect(store.listArtifacts(run.id)).toEqual([]);
      } finally {
        store.close();
      }
    });
  });

  it("rejects artifact registry paths outside the owning attempt directory", async () => {
    await withRuntimeWorkspace("scheduler-store-artifact-path", async workspace => {
      const store = await openedStore(workspace);
      try {
        const run = await admittedRun(store, workspace);
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const ready = appendReadyInstances(store.scheduler, run.id, claim.ownerEpoch, ["leaf"]);
        const attempt = unwrap(store.scheduler.tryStartAttempt(startInput(run.id, "leaf", claim.ownerEpoch, ready.version)));
        const artifact = artifactInput(store, run.id, attempt.attemptId, claim.ownerEpoch, "artifact_escape");

        expect(() => store.registerArtifact({
          ...artifact,
          relativePath: "workflow.ir.json",
        })).toThrow("inside its attempt artifact directory");
        expect(store.listArtifacts(run.id)).toEqual([]);
      } finally {
        store.close();
      }
    });
  });

  it("registers and publicly reads only the exact regular file with valid metadata", async () => {
    await withRuntimeWorkspace("scheduler-store-artifact-file-verification", async workspace => {
      const absentShard = resolveRuntimeLayout(workspace).workspaceRoot;
      await expect(resolveArtifact(workspace, "artifact://run_missing/artifact_missing")).resolves.toMatchObject({
        error: { type: "artifact-not-found", runId: "run_missing", artifactId: "artifact_missing" },
      });
      await expect(lstat(absentShard)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readArtifact(workspace, "run_missing", "artifact_missing")).resolves.toBeUndefined();
      const store = await openedStore(workspace);
      try {
        const run = await admittedRun(store, workspace);
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const ready = appendReadyInstances(store.scheduler, run.id, claim.ownerEpoch, ["leaf"]);
        const attempt = unwrap(store.scheduler.tryStartAttempt(startInput(run.id, "leaf", claim.ownerEpoch, ready.version)));
        const artifact = artifactInput(store, run.id, attempt.attemptId, claim.ownerEpoch, "artifact_verified");

        expect(() => store.registerArtifact(artifact)).toThrow(/ENOENT/);
        const path = await materializeArtifact(store, artifact);
        expect(() => store.registerArtifact({ ...artifact, digest: "invalid" })).toThrow();
        expect(() => store.registerArtifact({ ...artifact, size: artifact.size + 1 })).toThrow();
        await rm(path);
        await mkdir(path);
        expect(() => store.registerArtifact(artifact)).toThrow();
        expect(store.listArtifacts(run.id)).toEqual([]);
        await rm(path, { recursive: true });
        await materializeArtifact(store, artifact);
        expect(store.registerArtifact(artifact).isOk()).toBe(true);
        const expected = store.getArtifact(run.id, artifact.id);
        if (!expected) throw new Error("expected registered artifact");

        await expect(readArtifact(workspace, run.id, artifact.id)).resolves.toEqual({
          artifact: expected,
          bytes: Buffer.from("x"),
        });
        await expect(resolveArtifact(workspace, `artifact://${run.id}/${artifact.id}`)).resolves.toMatchObject({
          value: {
            ...expected,
            uri: `artifact://${run.id}/${artifact.id}`,
          },
        });
        await expect(resolveArtifact(workspace, "artifact://missing")).resolves.toMatchObject({
          error: { type: "invalid-artifact-ref" },
        });
        await expect(resolveArtifact(workspace, `artifact://${run.id}/artifact_missing`)).resolves.toMatchObject({
          error: { type: "artifact-not-found", runId: run.id, artifactId: "artifact_missing" },
        });
        await expect(readArtifact(workspace, run.id, "artifact_missing")).resolves.toBeUndefined();
        await expect(readArtifact(workspace, "run_missing", artifact.id)).resolves.toBeUndefined();
        await writeFile(path, "y");
        await expect(resolveArtifact(workspace, `artifact://${run.id}/${artifact.id}`)).resolves.toMatchObject({
          value: {
            ...expected,
            uri: `artifact://${run.id}/${artifact.id}`,
          },
        });
        await expect(readArtifact(workspace, run.id, artifact.id)).rejects.toThrow("size/digest verification");
        await rm(path);
        await expect(resolveArtifact(workspace, `artifact://${run.id}/${artifact.id}`)).resolves.toMatchObject({
          error: { type: "artifact-path-invalid", runId: run.id, artifactId: artifact.id },
        });
      } finally {
        store.close();
      }
    });
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic-link artifact without registering or removing its target", async () => {
    await withRuntimeWorkspace("scheduler-store-artifact-symlink", async workspace => {
      const store = await openedStore(workspace);
      try {
        const run = await admittedRun(store, workspace);
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const ready = appendReadyInstances(store.scheduler, run.id, claim.ownerEpoch, ["leaf"]);
        const attempt = unwrap(store.scheduler.tryStartAttempt(startInput(run.id, "leaf", claim.ownerEpoch, ready.version)));
        const artifact = artifactInput(store, run.id, attempt.attemptId, claim.ownerEpoch, "artifact_symlink");
        const path = await materializeArtifact(store, artifact);
        const target = join(workspace, "outside-artifact.txt");
        await writeFile(target, "x");
        await rm(path);
        await symlink(target, path);

        expect(() => store.registerArtifact(artifact)).toThrow();
        expect(store.listArtifacts(run.id)).toEqual([]);
        await expect(readFile(target, "utf8")).resolves.toBe("x");
      } finally {
        store.close();
      }
    });
  });

  it("silently drops progress from the wrong owner and cannot overwrite current-attempt progress", async () => {
    await withRuntimeWorkspace("scheduler-store-progress-owner-fence", async workspace => {
      const store = await openedStore(workspace);
      try {
        const run = await admittedRun(store, workspace);
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const ready = appendReadyInstances(store.scheduler, run.id, claim.ownerEpoch, ["leaf"]);
        const attempt = unwrap(store.scheduler.tryStartAttempt(startInput(run.id, "leaf", claim.ownerEpoch, ready.version)));
        const current = {
          runId: run.id,
          nodeKey: "leaf",
          nodeId: "leaf",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch: claim.ownerEpoch,
          kind: "agent",
          status: "running",
          message: "current",
        };
        store.writeNodeProgress(current);
        const progressVersion = store.getRun(run.id)!.progressVersion;

        store.writeNodeProgress({ ...current, ownerEpoch: claim.ownerEpoch + 1, message: "stale" });

        expect(store.getRun(run.id)!.progressVersion).toBe(progressVersion);
        expect(store.getRun(run.id)!.dynamic?.progress).toEqual([
          expect.objectContaining({ attemptId: attempt.attemptId, message: "current" }),
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("fences artifacts and progress from an expired owner even when the attempt identity matches", async () => {
    await withRuntimeWorkspace("scheduler-store-output-expired-owner-fence", async workspace => {
      const store = await openedStore(workspace);
      try {
        const run = await admittedRun(store, workspace);
        const expiredOwner = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const ready = appendReadyInstances(store.scheduler, run.id, expiredOwner.ownerEpoch, ["leaf"]);
        const attempt = unwrap(store.scheduler.tryStartAttempt(startInput(run.id, "leaf", expiredOwner.ownerEpoch, ready.version)));
        const acceptedArtifact = artifactInput(
          store,
          run.id,
          attempt.attemptId,
          expiredOwner.ownerEpoch,
          "artifact_current",
        );
        const currentProgress = {
          runId: run.id,
          nodeKey: "leaf",
          nodeId: "leaf",
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch: expiredOwner.ownerEpoch,
          kind: "agent",
          status: "running",
          message: "current",
        };

        await materializeArtifact(store, acceptedArtifact);
        expect(store.registerArtifact(acceptedArtifact).isOk()).toBe(true);
        store.writeNodeProgress(currentProgress);
        const progressVersion = store.getRun(run.id)!.progressVersion;

        expireRunLease(workspace, run.id);
        expect(store.scheduler.claimRun(run.id, "owner-b", 60_000)).toMatchObject({ ownerEpoch: expiredOwner.ownerEpoch + 1 });

        const staleArtifact = artifactInput(
          store,
          run.id,
          attempt.attemptId,
          expiredOwner.ownerEpoch,
          "artifact_stale",
        );
        const rejected = store.registerArtifact(staleArtifact);
        expect(rejected.isErr()).toBe(true);
        if (rejected.isOk()) throw new Error("expected expired-owner artifact registration to fail");
        expect(rejected.error).toMatchObject({
          type: "owner-epoch-inactive",
          runId: run.id,
          ownerEpoch: expiredOwner.ownerEpoch,
        });

        store.writeNodeProgress({ ...currentProgress, message: "stale" });

        expect(store.listArtifacts(run.id).map(artifact => artifact.id)).toEqual([acceptedArtifact.id]);
        expect(store.getRun(run.id)!.progressVersion).toBe(progressVersion);
        expect(store.getRun(run.id)!.dynamic?.progress).toEqual([
          expect.objectContaining({ attemptId: attempt.attemptId, message: "current" }),
        ]);
      } finally {
        store.close();
      }
    });
  });
});

async function openedStore(workspace: string): Promise<RuntimeStore> {
  return openRuntimeStore(workspace);
}

async function admittedRun(store: RuntimeStore, workspace: string) {
  const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
  return admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
}

function appendReadyInstances(store: SchedulerStorePort, runId: string, ownerEpoch: number, nodeKeys: string[]): SchedulerSnapshot {
  const current = unwrap(store.tryLoadRunSnapshot(runId));
  return unwrap(store.tryAppendSchedulerEvents({
    runId,
    ownerEpoch,
    expectedVersion: current.version,
    idempotencyKey: `setup:ready:${nodeKeys.join(":")}`,
    events: [
      { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root" } },
      ...nodeKeys.map((nodeKey, index) => ({
        type: "instance.ready" as const,
        payload: {
          runId,
          nodeKey,
          nodeId: nodeKey,
          instancePath: [{ kind: "node" as const, nodeId: nodeKey }],
          parentFrameKey: "root",
          readinessSequence: index + 1,
        },
      })),
    ],
  }));
}

function appendReadyGroupLeaf(store: SchedulerStorePort, runId: string, ownerEpoch: number, nodeKey: string): SchedulerSnapshot {
  const current = unwrap(store.tryLoadRunSnapshot(runId));
  return unwrap(store.tryAppendSchedulerEvents({
    runId,
    ownerEpoch,
    expectedVersion: current.version,
    idempotencyKey: `setup:group-leaf:${nodeKey}`,
    events: [
      { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root" } },
      { type: "group.started", payload: { runId, groupKey: "group", nodeKey: "group", nodeId: "group", kind: "parallel", strategy: "all", maxConcurrency: 1 } },
      { type: "group.member_ready", payload: { runId, groupKey: "group", memberKey: nodeKey, memberKind: "branch", branchId: nodeKey, readinessSequence: 1 } },
      { type: "instance.ready", payload: { runId, nodeKey, nodeId: nodeKey, instancePath: [{ kind: "node", nodeId: nodeKey }], parentFrameKey: "root", readinessSequence: 1 } },
    ],
  }));
}

function startInput(runId: string, nodeKey: string, ownerEpoch: number, expectedVersion: number): AttemptStartInput {
  return {
    runId,
    nodeKey,
    nodeId: nodeKey,
    ownerEpoch,
    expectedVersion,
    idempotencyKey: `start:${nodeKey}:v${expectedVersion}`,
  };
}

function artifactInput(
  store: RuntimeStore,
  runId: string,
  attemptId: string,
  ownerEpoch: number,
  id: string,
): RegisterArtifactInput {
  const bytes = Buffer.from("x");
  const runDir = store.getRunDir(runId);
  if (!runDir) throw new Error(`Run '${runId}' has no directory.`);
  const relativePath = `artifacts/leaf/attempt-1/${id}.txt`;
  return {
    id,
    runId,
    nodeKey: "leaf",
    attempt: 1,
    attemptId,
    ownerEpoch,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.byteLength,
    relativePath,
    file: {
      path: join(runDir, relativePath),
      filesystemIdentity: "not-materialized",
    },
  };
}

async function materializeArtifact(store: RuntimeStore, artifact: RegisterArtifactInput): Promise<string> {
  const runDir = store.getRunDir(artifact.runId);
  if (!runDir) throw new Error(`Run '${artifact.runId}' has no directory.`);
  const path = join(runDir, artifact.relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "x");
  artifact.file = tryCaptureRunFile(
    store.getRunDirectoryToken(artifact.runId)!,
    path,
    `Artifact '${artifact.id}'`,
  )._unsafeUnwrap();
  return path;
}

function expireRunLease(workspace: string, runId: string): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.prepare("UPDATE run_leases SET lease_expires_at = ? WHERE run_id = ?").run("2000-01-01T00:00:00.000Z", runId);
  } finally {
    db.close();
  }
}

function unwrap<T>(result: SchedulerStoreResult<T>): T {
  return throwSchedulerStoreResult(result);
}
