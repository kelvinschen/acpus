import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { AttemptStartInput, SchedulerSnapshot, SchedulerStorePort, SchedulerStoreResult } from "../src/scheduler/store-port.js";
import { throwSchedulerStoreResult } from "../src/scheduler/store-port.js";
import { openRuntimeStore, type RegisterArtifactInput, type RuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

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
        const first = artifactInput(run.id, attempt.attemptId, claim.ownerEpoch, "artifact_first");

        expect(store.registerArtifact(first).isOk()).toBe(true);
        unwrap(store.scheduler.tryCommitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "completed", output: { ok: true } },
          idempotencyKey: "artifact-fence:complete",
        }));

        const late = artifactInput(run.id, attempt.attemptId, claim.ownerEpoch, "artifact_late");
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
        const acceptedArtifact = artifactInput(run.id, attempt.attemptId, expiredOwner.ownerEpoch, "artifact_current");
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

        expect(store.registerArtifact(acceptedArtifact).isOk()).toBe(true);
        store.writeNodeProgress(currentProgress);
        const progressVersion = store.getRun(run.id)!.progressVersion;

        expireRunLease(workspace, run.id);
        expect(store.scheduler.claimRun(run.id, "owner-b", 60_000)).toMatchObject({ ownerEpoch: expiredOwner.ownerEpoch + 1 });

        const staleArtifact = artifactInput(run.id, attempt.attemptId, expiredOwner.ownerEpoch, "artifact_stale");
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
  return store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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

function artifactInput(runId: string, attemptId: string, ownerEpoch: number, id: string): RegisterArtifactInput {
  return {
    id,
    runId,
    nodeKey: "leaf",
    attempt: 1,
    attemptId,
    ownerEpoch,
    digest: "sha256:test",
    size: 1,
    relativePath: `artifacts/leaf/attempt-1/${id}.txt`,
  };
}

function expireRunLease(workspace: string, runId: string): void {
  const db = new DatabaseSync(`${workspace}/.acpus/.local/state/runtime.db`);
  try {
    db.prepare("UPDATE run_leases SET lease_expires_at = ? WHERE run_id = ?").run("2000-01-01T00:00:00.000Z", runId);
  } finally {
    db.close();
  }
}

function unwrap<T>(result: SchedulerStoreResult<T>): T {
  return throwSchedulerStoreResult(result);
}
