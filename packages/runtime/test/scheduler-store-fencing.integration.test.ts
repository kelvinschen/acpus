import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { admitRunForTest } from "./support/runtime-store.js";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { defineWorkflow } from "@acpus/core";
import { sha256Digest } from "@acpus/core/content-identity";
import { agentSessionIdForScope, agentSessionScopeDigest } from "../src/execution/agent-session.js";
import type { AgentSessionCheckpointValue } from "../src/execution/agent-operation-plan.js";
import { readArtifact, resolveArtifact } from "../src/runs/use-cases.js";
import { resolveRuntimeLayout } from "../src/runtime-layout.js";
import type { AttemptStartInput, SchedulerSnapshot, SchedulerStorePort } from "../src/scheduler/store-port.js";
import type { RegisterArtifactInput } from "../src/artifacts/types.js";
import { openRuntimeStoreAdapter, type RuntimeStoreAdapter } from "../src/store/store.js";
import { tryCaptureRunFile } from "../src/store/run-file.js";
import { prepareSyntheticWorkflow, runtimeDatabasePath, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { dbRun } from "./support/store-port-fixtures.js";
import { captureSchedulerCall } from "./support/scheduler-store.js";

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

        const rebound = captureSchedulerCall(() => store.scheduler.tryStartAttempt({
          ...input,
          expectedVersion: started.snapshot.version,
        }));
        expect(Result.isFailure(rebound)).toBe(true);
        if (Result.isSuccess(rebound)) throw new Error("expected admission-version rebound to fail");
        expect(rebound.failure).toMatchObject({
          type: "idempotency-conflict",
          idempotencyKey: input.idempotencyKey,
          runId: run.id,
        });

        const stale = captureSchedulerCall(() => store.scheduler.tryStartAttempt(startInput(run.id, "second", claim.ownerEpoch, ready.version)));
        expect(Result.isFailure(stale)).toBe(true);
        if (Result.isSuccess(stale)) throw new Error("expected stale attempt start to fail");
        expect(stale.failure).toMatchObject({ type: "version-mismatch", expectedVersion: ready.version, actualVersion: started.snapshot.version });
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

        const secondIdentity = captureSchedulerCall(() => store.scheduler.tryStartAttempt({
          ...input,
          expectedVersion: started.snapshot.version,
          idempotencyKey: `${input.idempotencyKey}:second`,
        }));
        expect(Result.isFailure(secondIdentity)).toBe(true);
        if (Result.isSuccess(secondIdentity)) throw new Error("expected running instance start to fail");
        expect(secondIdentity.failure).toMatchObject({ type: "instance-not-ready", runId: run.id, nodeKey: "leaf", status: "running" });

        expect(store.scheduler.releaseRun(firstOwner)).toBe(true);
        expect(store.scheduler.claimRun(run.id, "owner-b", 60_000)).toMatchObject({ ownerEpoch: firstOwner.ownerEpoch + 1 });
        const staleReplay = captureSchedulerCall(() => store.scheduler.tryStartAttempt(input));
        expect(Result.isFailure(staleReplay)).toBe(true);
        if (Result.isSuccess(staleReplay)) throw new Error("expected stale owner replay to fail");
        expect(staleReplay.failure).toMatchObject({ type: "owner-epoch-inactive", runId: run.id, ownerEpoch: firstOwner.ownerEpoch });
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
        const replay = captureSchedulerCall(() => store.scheduler.tryCommitAttemptResult(commit));

        expect(Result.isFailure(replay)).toBe(true);
        if (Result.isSuccess(replay)) throw new Error("expected stale result replay to fail");
        expect(replay.failure).toMatchObject({ type: "owner-epoch-inactive", runId: run.id, ownerEpoch: firstOwner.ownerEpoch });
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

        const staleVersion = captureSchedulerCall(() => store.scheduler.tryMarkExpiredOwnerAttemptsSuperseded({
          runId: run.id,
          currentOwnerEpoch: currentOwner.ownerEpoch,
          expiredOwnerEpoch: expiredOwner.ownerEpoch,
          expectedVersion: beforeRecovery.version - 1,
        }));
        expect(Result.isFailure(staleVersion)).toBe(true);
        if (Result.isSuccess(staleVersion)) throw new Error("expected recovery version fence to fail");
        expect(staleVersion.failure).toMatchObject({
          type: "version-mismatch",
          expectedVersion: beforeRecovery.version - 1,
          actualVersion: beforeRecovery.version,
        });

        const wrongOwner = captureSchedulerCall(() => store.scheduler.tryMarkExpiredOwnerAttemptsSuperseded({
          runId: run.id,
          currentOwnerEpoch: currentOwner.ownerEpoch + 1,
          expiredOwnerEpoch: expiredOwner.ownerEpoch,
          expectedVersion: beforeRecovery.version,
        }));
        expect(Result.isFailure(wrongOwner)).toBe(true);
        if (Result.isSuccess(wrongOwner)) throw new Error("expected current owner fence to fail");
        expect(wrongOwner.failure).toMatchObject({ type: "owner-epoch-inactive", ownerEpoch: currentOwner.ownerEpoch + 1 });

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
        const second = artifactInput(store, run.id, attempt.attemptId, claim.ownerEpoch, "artifact_second");

        await materializeArtifact(store, first);
        await materializeArtifact(store, second);
        store.registerArtifact(first);
        store.registerArtifact(second);
        unwrap(store.scheduler.tryCommitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "completed", output: { ok: true } },
          idempotencyKey: "artifact-fence:complete",
        }));

        const late = artifactInput(store, run.id, attempt.attemptId, claim.ownerEpoch, "artifact_late");
        const rejected = captureSchedulerCall(() => store.registerArtifact(late));
        expect(Result.isFailure(rejected)).toBe(true);
        if (Result.isSuccess(rejected)) throw new Error("expected terminal artifact registration to fail");
        expect(rejected.failure).toMatchObject({ type: "terminal-attempt", attemptId: attempt.attemptId, status: "completed" });
        expect(store.listArtifacts(run.id).map(artifact => artifact.id)).toEqual([first.id, second.id]);
        expect(store.listArtifacts(run.id, 1).map(artifact => artifact.id)).toEqual([first.id]);
      } finally {
        store.close();
      }
    });
  });

  it("fences execution metadata by exact started Attempt and active owner lease", async () => {
    await withRuntimeWorkspace("scheduler-store-metadata-fence", async workspace => {
      const store = await openedStore(workspace);
      try {
        const run = await admittedRun(store, workspace);
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const ready = appendReadyInstances(store.scheduler, run.id, claim.ownerEpoch, ["leaf"]);
        const attempt = unwrap(store.scheduler.tryStartAttempt(startInput(run.id, "leaf", claim.ownerEpoch, ready.version)));
        const input = {
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          kind: "task_attempt",
          metadata: { accepted: true },
        } as const;

        store.writeExecutionMetadata(input);

        const wrongRun = captureSchedulerCall(() => store.writeExecutionMetadata({ ...input, runId: `${run.id}-other` }));
        expect(Result.isFailure(wrongRun) && wrongRun.failure).toMatchObject({
          type: "attempt-not-found",
          attemptId: attempt.attemptId,
        });

        const staleOwner = captureSchedulerCall(() => store.writeExecutionMetadata({ ...input, ownerEpoch: claim.ownerEpoch + 1 }));
        expect(Result.isFailure(staleOwner) && staleOwner.failure).toMatchObject({
          type: "owner-epoch-stale",
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch + 1,
        });

        unwrap(store.scheduler.tryCommitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "completed", output: { ok: true } },
          idempotencyKey: "metadata-fence:complete",
        }));
        const terminal = captureSchedulerCall(() => store.writeExecutionMetadata(input));
        expect(Result.isFailure(terminal) && terminal.failure).toMatchObject({
          type: "terminal-attempt",
          attemptId: attempt.attemptId,
          status: "completed",
        });

        expireRunLease(workspace, run.id);
        const expired = captureSchedulerCall(() => store.writeExecutionMetadata(input));
        expect(Result.isFailure(expired) && expired.failure).toMatchObject({
          type: "owner-epoch-inactive",
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
        });

        expect(store.getExecutionMetadata(run.id)).toEqual([
          expect.objectContaining({ attemptId: attempt.attemptId, kind: "task_attempt", metadata: { accepted: true } }),
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("atomically binds an Agent Attempt and commits invocation plus dispatch intent", async () => {
    await withRuntimeWorkspace("scheduler-store-agent-session-dispatch", async workspace => {
      const store = await openedStore(workspace);
      try {
        const run = await admittedAgentRun(store, workspace);
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const ready = appendReadyInstances(store.scheduler, run.id, claim.ownerEpoch, ["review"]);
        const attempt = unwrap(store.scheduler.tryStartAttempt(startInput(run.id, "review", claim.ownerEpoch, ready.version)));
        const scopeDigest = agentSessionScopeDigest(run.id, "node", "review");
        const agentSessionId = agentSessionIdForScope(scopeDigest, 1);
        const inputDigest = sha256Digest("prompt:authored");
        const binding = {
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          agentSessionId,
          scopeDigest,
          generation: 1,
          explicitShared: false,
          operation: "start" as const,
          sessionOpenMode: "new_or_empty" as const,
          promptOrigin: "authored" as const,
          inputDigest,
        };

        expect(Result.getOrThrow(Result.flip(captureSchedulerCall(() => store.scheduler.tryBindAgentAttemptSession({
          ...binding,
          agentSessionId: agentSessionIdForScope(scopeDigest, 2),
        }))))).toMatchObject({ type: "agent-session-binding-conflict" });
        expect(Result.getOrThrow(Result.flip(captureSchedulerCall(() => store.scheduler.tryBindAgentAttemptSession({
          ...binding,
          promptOrigin: "steering",
        }))))).toMatchObject({ type: "agent-session-binding-conflict" });
        expect(unwrap(store.scheduler.tryBindAgentAttemptSession(binding))).toMatchObject({
          attemptId: attempt.attemptId,
          agentSessionId,
          operation: "start",
        });
        expect(unwrap(store.scheduler.tryBindAgentAttemptSession(binding))).toMatchObject({ attemptId: attempt.attemptId });
        expect(Result.getOrThrow(Result.flip(captureSchedulerCall(() => store.scheduler.tryBindAgentAttemptSession({ ...binding, inputDigest: sha256Digest("different") })))))
          .toMatchObject({ type: "agent-session-binding-conflict" });

        const notDispatched = {
          checkpoint: "not_dispatched" as const,
          attemptId: attempt.attemptId,
          promptOrigin: "authored" as const,
          inputDigest,
        };
        const dispatchInput = {
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          agentSessionId,
          attemptId: attempt.attemptId,
          turnId: "turn-1",
          sessionLeaseId: "lease-1",
          expected: notDispatched,
          invocationMetadata: { promptOrigin: "authored", inputDigest },
        } as const;
        expect(Result.getOrThrow(Result.flip(captureSchedulerCall(() => store.scheduler.tryCommitAgentTurnDispatch(dispatchInput)))))
          .toMatchObject({ type: "agent-session-checkpoint-conflict" });
        expect(store.getExecutionMetadata(run.id)).toEqual([]);
        expect(unwrap(store.scheduler.tryRecordAgentSessionReady({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          agentSessionId,
          reportedVersion: "fixture-agent/1.2.3",
          now: new Date("2026-08-20T00:00:00.000Z"),
        }))).toBeUndefined();
        expect(store.scheduler.readAgentControlInspection(run.id).agentSessions)
          .toContainEqual(expect.objectContaining({
            agentSessionId,
            reportedVersion: "fixture-agent/1.2.3",
          }));
        expect(unwrap(store.scheduler.tryRecordAgentSessionReady({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          agentSessionId,
          reportedVersion: "fixture-agent/1.2.4",
          now: new Date("2026-08-20T00:00:01.000Z"),
        }))).toBeUndefined();
        expect(store.scheduler.readAgentControlInspection(run.id).agentSessions)
          .toContainEqual(expect.objectContaining({ reportedVersion: "fixture-agent/1.2.4" }));
        const readiness = new DatabaseSync(runtimeDatabasePath(workspace), { readOnly: true });
        expect(readiness.prepare("SELECT ready_at, reported_version FROM agent_sessions WHERE agent_session_id = ?")
          .get(agentSessionId)).toEqual({
            ready_at: "2026-08-20T00:00:00.000Z",
            reported_version: "fixture-agent/1.2.4",
          });
        readiness.close();
        expect(unwrap(store.scheduler.tryCommitAgentTurnDispatch({
          ...dispatchInput,
        }))).toMatchObject({ checkpoint: "dispatch_intent", turnId: "turn-1" });
        expect(store.getExecutionMetadata(run.id)).toEqual([
          expect.objectContaining({
            attemptId: attempt.attemptId,
            kind: "agent_invocation",
            metadata: { promptOrigin: "authored", inputDigest },
          }),
        ]);
        expect(Result.getOrThrow(Result.flip(captureSchedulerCall(() => store.scheduler.tryCommitAgentTurnDispatch({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          agentSessionId,
          attemptId: attempt.attemptId,
          turnId: "turn-2",
          sessionLeaseId: "lease-2",
          expected: notDispatched,
          invocationMetadata: { invalid: true },
        }))))).toMatchObject({ type: "agent-session-checkpoint-conflict" });
        expect(store.getExecutionMetadata(run.id)).toHaveLength(1);
      } finally {
        store.close();
      }
    });
  });

  it("enforces the closed checkpoint graph and exact post-fence settlement tuple", async () => {
    await withRuntimeWorkspace("scheduler-store-agent-session-checkpoint", async workspace => {
      const store = await openedStore(workspace);
      try {
        const run = await admittedAgentRun(store, workspace);
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const ready = appendReadyInstances(store.scheduler, run.id, claim.ownerEpoch, ["review"]);
        const attempt = unwrap(store.scheduler.tryStartAttempt(startInput(run.id, "review", claim.ownerEpoch, ready.version)));
        const scopeDigest = agentSessionScopeDigest(run.id, "node", "review");
        const agentSessionId = agentSessionIdForScope(scopeDigest, 1);
        const inputDigest = sha256Digest("prompt:checkpoint");
        unwrap(store.scheduler.tryBindAgentAttemptSession({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          agentSessionId,
          scopeDigest,
          generation: 1,
          explicitShared: false,
          operation: "start",
          sessionOpenMode: "new_or_empty",
          promptOrigin: "authored",
          inputDigest,
        }));
        unwrap(store.scheduler.tryRecordAgentSessionReady({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          agentSessionId,
        }));
        const intent = unwrap(store.scheduler.tryCommitAgentTurnDispatch({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          agentSessionId,
          attemptId: attempt.attemptId,
          turnId: "turn-1",
          sessionLeaseId: "lease-1",
          expected: { checkpoint: "not_dispatched", attemptId: attempt.attemptId, promptOrigin: "authored", inputDigest },
          invocationMetadata: { ok: true },
        })) as Exclude<AgentSessionCheckpointValue, { checkpoint: "not_dispatched" }>;
        const owned = { ...intent, checkpoint: "owned_in_flight" as const };
        expect(unwrap(store.scheduler.tryAdvanceAgentSessionCheckpoint({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          agentSessionId,
          attemptId: attempt.attemptId,
          expected: intent,
          next: owned,
          cause: "local_call_pending",
        }))).toEqual(owned);
        const wrongCause = captureSchedulerCall(() => store.scheduler.tryAdvanceAgentSessionCheckpoint({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          agentSessionId,
          attemptId: attempt.attemptId,
          expected: owned,
          next: { ...owned, checkpoint: "terminal_observed" },
          cause: "provider_activity",
        }));
        expect(Result.getOrThrow(Result.flip(wrongCause))).toMatchObject({ type: "agent-session-checkpoint-conflict" });
        const provider = { ...owned, checkpoint: "provider_observed" as const };
        unwrap(store.scheduler.tryAdvanceAgentSessionCheckpoint({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          agentSessionId,
          attemptId: attempt.attemptId,
          expected: owned,
          next: provider,
          cause: "provider_activity",
        }));
        expect(unwrap(store.scheduler.tryAdvanceAgentSessionCheckpoint({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          agentSessionId,
          attemptId: attempt.attemptId,
          expected: intent,
          next: owned,
          cause: "local_call_pending",
        }))).toEqual(provider);

        const current = unwrap(store.scheduler.tryLoadRunSnapshot(run.id));
        unwrap(store.scheduler.tryAppendSchedulerEvents({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          expectedVersion: current.version,
          idempotencyKey: "agent-session:supersede",
          events: [{ type: "attempt.superseded", payload: { attemptId: attempt.attemptId } }],
        }));
        dbRun(workspace, `
          INSERT INTO runtime_authority (workspace_realpath, epoch, updated_at)
          VALUES (?, 7, ?)
        `, workspace, new Date().toISOString());
        expect(Result.getOrThrow(Result.flip(captureSchedulerCall(() => store.scheduler.trySettleFencedAgentSessionCheckpoint({
          runId: run.id,
          runtimeOwnerEpoch: 7,
          agentSessionId,
          attemptId: attempt.attemptId,
          turnId: "wrong-turn",
          sessionLeaseId: "lease-1",
          expected: "provider_observed",
          next: "terminal_observed",
          cause: "provider_terminal",
          observedAt: new Date(),
        }))))).toMatchObject({ type: "agent-session-settlement-authority-mismatch" });
        expect(unwrap(store.scheduler.trySettleFencedAgentSessionCheckpoint({
          runId: run.id,
          runtimeOwnerEpoch: 7,
          agentSessionId,
          attemptId: attempt.attemptId,
          turnId: "turn-1",
          sessionLeaseId: "lease-1",
          expected: "provider_observed",
          next: "terminal_observed",
          cause: "provider_terminal",
          observedAt: new Date(),
        }))).toMatchObject({ checkpoint: "terminal_observed" });
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

        const late = captureSchedulerCall(() => store.registerArtifact(artifactInput(
          store,
          run.id,
          attempt.attemptId,
          claim.ownerEpoch,
          "artifact_late",
        )));
        expect(Result.isFailure(late)).toBe(true);
        if (Result.isSuccess(late)) throw new Error("expected superseded artifact registration to fail");
        expect(late.failure).toMatchObject({ type: "terminal-attempt", attemptId: attempt.attemptId, status: "superseded" });
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
      await expect(Effect.runPromise(Effect.result(resolveArtifact(workspace, "artifact://run_missing/artifact_missing")))).resolves.toMatchObject({
        failure: { type: "artifact-not-found", runId: "run_missing", artifactId: "artifact_missing" },
      });
      await expect(lstat(absentShard)).rejects.toMatchObject({ code: "ENOENT" });
      expect(Result.getOrThrow((await Effect.runPromise(Effect.result(readArtifact(workspace, "run_missing", "artifact_missing")))))).toBeUndefined();
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
        store.registerArtifact(artifact);
        const expected = store.getArtifact(run.id, artifact.id);
        if (!expected) throw new Error("expected registered artifact");

        expect(Result.getOrThrow((await Effect.runPromise(Effect.result(readArtifact(workspace, run.id, artifact.id)))))).toEqual({
          artifact: expected,
          bytes: Buffer.from("x"),
        });
        await expect(Effect.runPromise(Effect.result(resolveArtifact(workspace, `artifact://${run.id}/${artifact.id}`)))).resolves.toMatchObject({
          success: {
            ...expected,
            uri: `artifact://${run.id}/${artifact.id}`,
          },
        });
        await expect(Effect.runPromise(Effect.result(resolveArtifact(workspace, "artifact://missing")))).resolves.toMatchObject({
          failure: { type: "invalid-artifact-ref" },
        });
        await expect(Effect.runPromise(Effect.result(resolveArtifact(workspace, `artifact://${run.id}/artifact_missing`)))).resolves.toMatchObject({
          failure: { type: "artifact-not-found", runId: run.id, artifactId: "artifact_missing" },
        });
        expect(Result.getOrThrow((await Effect.runPromise(Effect.result(readArtifact(workspace, run.id, "artifact_missing")))))).toBeUndefined();
        expect(Result.getOrThrow((await Effect.runPromise(Effect.result(readArtifact(workspace, "run_missing", artifact.id)))))).toBeUndefined();
        await writeFile(path, "y");
        await expect(Effect.runPromise(Effect.result(resolveArtifact(workspace, `artifact://${run.id}/${artifact.id}`)))).resolves.toMatchObject({
          success: {
            ...expected,
            uri: `artifact://${run.id}/${artifact.id}`,
          },
        });
        expect(Result.getOrThrow(Result.flip((await Effect.runPromise(Effect.result(readArtifact(workspace, run.id, artifact.id))))))).toMatchObject({
          type: "runtime-store-unavailable",
          message: expect.stringContaining("size/digest verification"),
        });
        await rm(path);
        await expect(Effect.runPromise(Effect.result(resolveArtifact(workspace, `artifact://${run.id}/${artifact.id}`)))).resolves.toMatchObject({
          failure: { type: "artifact-path-invalid", runId: run.id, artifactId: artifact.id },
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
        store.registerArtifact(acceptedArtifact);
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
        const rejected = captureSchedulerCall(() => store.registerArtifact(staleArtifact));
        expect(Result.isFailure(rejected)).toBe(true);
        if (Result.isSuccess(rejected)) throw new Error("expected expired-owner artifact registration to fail");
        expect(rejected.failure).toMatchObject({
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

async function openedStore(workspace: string): Promise<RuntimeStoreAdapter> {
  return openRuntimeStoreAdapter(workspace);
}

async function admittedRun(store: RuntimeStoreAdapter, workspace: string) {
  const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
  return admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
}

async function admittedAgentRun(store: RuntimeStoreAdapter, workspace: string) {
  const workflow = defineWorkflow({
    name: "scheduler-store-fencing-agent",
    agents: { reviewer: { use: "codex" } },
  }).build(({ agents, step }) => {
    step("review").agent({ agent: agents.reviewer, prompt: "Review." });
    return {};
  });
  const prepared = await prepareSyntheticWorkflow(workspace, workflow);
  return admitRunForTest(store, { prepared, input: {}, cwd: workspace });
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
  store: RuntimeStoreAdapter,
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

async function materializeArtifact(store: RuntimeStoreAdapter, artifact: RegisterArtifactInput): Promise<string> {
  const runDir = store.getRunDir(artifact.runId);
  if (!runDir) throw new Error(`Run '${artifact.runId}' has no directory.`);
  const path = join(runDir, artifact.relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "x");
  artifact.file = Result.getOrThrow(tryCaptureRunFile(
    store.getRunDirectoryToken(artifact.runId)!,
    path,
    `Artifact '${artifact.id}'`,
  ));
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

function unwrap<Success>(value: Success): Success {
  return value;
}
