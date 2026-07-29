import { defineWorkflow } from "@acpus/core";
import { describe, expect, it } from "vitest";
import { deriveOccurrenceRef } from "../src/scheduler/occurrence-ref.js";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import type { RunOwnerClaim } from "../src/scheduler/store-port.js";
import { prepareSyntheticWorkflow, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { dbRun, readyNode } from "./support/store-port-fixtures.js";
import { admitRunForTest } from "./support/runtime-store.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";

describe("scheduler store Agent steer", () => {
  it.each(["attemptId", "nodeKey", "nodeId", "occurrenceRef", "attemptRef"] as const)("atomically resolves an active Agent by %s", async targetKind => {
    await withRuntimeWorkspace(`scheduler-store-steer-${targetKind}`, async workspace => {
      const store = await openRuntimeStore(workspace);
      try {
        const { runId, claim, attemptId } = await startedAgent(store, workspace);
        const ref = deriveOccurrenceRef([{ kind: "node", nodeId: "review" }]);
        const target = targetKind === "attemptId"
          ? attemptId
          : targetKind === "nodeKey"
            ? "review~1"
            : targetKind === "nodeId"
              ? "review"
              : targetKind === "occurrenceRef"
                ? ref
                : `${ref}#1`;
        const before = durablePosition(store, runId);
        const result = store.scheduler.trySteerAgent({
          runId,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: `scheduler:control:steer-${targetKind}`,
          steerId: `steer-${targetKind}`,
          target,
          instruction: "Focus on the failing assertion.",
        })._unsafeUnwrap();

        expect(result).toMatchObject({
          steerId: `steer-${targetKind}`,
          requestedTarget: target,
          target: "review~1",
          fencedAttemptId: attemptId,
        });
        expect(result.snapshot.projection.attempts[attemptId]).toMatchObject({
          status: "superseded",
          cancelReason: "operator_steered",
        });
        expect(result.snapshot.projection.instances["review~1"]).toMatchObject({
          status: "ready",
          statusReason: "steered",
          pendingSteerId: `steer-${targetKind}`,
        });
        expect(store.getCommittedRuntimeEventsAfter(runId, before.version).map(event => ({
          type: event.type,
          nodeKey: event.nodeKey,
          payload: event.payload,
        }))).toEqual([
          {
            type: "control.agent_steer_requested",
            nodeKey: "review~1",
            payload: {
              steerId: `steer-${targetKind}`,
              requestedTarget: target,
              nodeKey: "review~1",
              fencedAttemptId: attemptId,
              instruction: "Focus on the failing assertion.",
            },
          },
          {
            type: "attempt.superseded",
            nodeKey: "review~1",
            payload: {
              attemptId,
              cancelReason: "operator_steered",
            },
          },
          {
            type: "instance.requeued",
            nodeKey: "review~1",
            payload: {
              nodeKey: "review~1",
              reason: "steered",
              steerId: `steer-${targetKind}`,
              readinessSequence: 1,
            },
          },
        ]);
        expect(durablePosition(store, runId)).toEqual({
          version: before.version + 3,
          eventCount: before.eventCount + 3,
        });
        expect(store.scheduler.tryCommitAttemptResult({
          runId,
          attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "completed", output: "late" },
          idempotencyKey: `steer:${targetKind}:late-result`,
        })._unsafeUnwrapErr()).toMatchObject({
          type: "terminal-attempt",
          attemptId,
          status: "superseded",
        });
      } finally {
        store.close();
      }
    });
  });

  it("hands the durable instruction to replacement attempts and preserves it across recovery", async () => {
    await withRuntimeWorkspace("scheduler-store-steer-recovery", async workspace => {
      const store = await openRuntimeStore(workspace);
      try {
        const { runId, claim, attemptId } = await startedAgent(store, workspace);
        const input = {
          runId,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "scheduler:control:steer-recovery",
          steerId: "steer-recovery",
          target: attemptId,
          instruction: "\nUse the existing test evidence.\n",
        };
        const applied = store.scheduler.trySteerAgent(input)._unsafeUnwrap();
        const replacementVersion = applied.snapshot.version;
        const replacement = throwingSchedulerStore(store.scheduler).startAttempt({
          runId,
          nodeKey: "review~1",
          nodeId: "review",
          ownerEpoch: claim.ownerEpoch,
          expectedVersion: replacementVersion,
          idempotencyKey: "steer:replacement:first",
        });
        expect(replacement.steer).toEqual({
          steerId: "steer-recovery",
          instruction: "\nUse the existing test evidence.\n",
        });
        expect(replacement.snapshot.projection.attempts[replacement.attemptId]).toMatchObject({
          status: "started",
          steerId: "steer-recovery",
        });
        expect(throwingSchedulerStore(store.scheduler).startAttempt({
          runId,
          nodeKey: "review~1",
          nodeId: "review",
          ownerEpoch: claim.ownerEpoch,
          expectedVersion: replacementVersion,
          idempotencyKey: "steer:replacement:first",
        }).steer).toEqual(replacement.steer);

        const beforeReplay = durablePosition(store, runId);
        expect(store.scheduler.trySteerAgent(input)._unsafeUnwrap()).toMatchObject({
          steerId: "steer-recovery",
          target: "review~1",
          fencedAttemptId: attemptId,
        });
        expect(durablePosition(store, runId)).toEqual(beforeReplay);
        expect(store.scheduler.trySteerAgent({
          ...input,
          instruction: "A different correction.",
        })._unsafeUnwrapErr()).toMatchObject({ type: "idempotency-conflict" });
        expect(durablePosition(store, runId)).toEqual(beforeReplay);

        dbRun(workspace, "UPDATE run_leases SET lease_expires_at = ? WHERE run_id = ?", new Date(Date.now() - 1_000).toISOString(), runId);
        const recoveredClaim = store.scheduler.claimRun(runId, "owner-b", 60_000)!;
        const recovered = throwingSchedulerStore(store.scheduler).markExpiredOwnerAttemptsSuperseded({
          runId,
          currentOwnerEpoch: recoveredClaim.ownerEpoch,
          expiredOwnerEpoch: claim.ownerEpoch,
          expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).version,
        });
        expect(recovered.projection.instances["review~1"]).toMatchObject({
          status: "ready",
          statusReason: "steered",
          pendingSteerId: "steer-recovery",
        });

        const recoveredAttempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId,
          nodeKey: "review~1",
          nodeId: "review",
          ownerEpoch: recoveredClaim.ownerEpoch,
          idempotencyKey: "steer:replacement:recovered",
        });
        expect(recoveredAttempt.steer).toEqual(replacement.steer);
        const paused = throwingSchedulerStore(store.scheduler).pauseRun({
          runId,
          ownerEpoch: recoveredClaim.ownerEpoch,
          idempotencyKey: "steer:pause",
        });
        expect(paused.projection.instances["review~1"]).toMatchObject({
          status: "ready",
          statusReason: "steered",
          pendingSteerId: "steer-recovery",
        });
        throwingSchedulerStore(store.scheduler).resumeRun({
          runId,
          ownerEpoch: recoveredClaim.ownerEpoch,
          idempotencyKey: "steer:resume",
        });
        const resumedAttempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId,
          nodeKey: "review~1",
          nodeId: "review",
          ownerEpoch: recoveredClaim.ownerEpoch,
          idempotencyKey: "steer:replacement:resumed",
        });
        expect(resumedAttempt.steer).toEqual(replacement.steer);
        throwingSchedulerStore(store.scheduler).commitAttemptResult({
          runId,
          attemptId: resumedAttempt.attemptId,
          ownerEpoch: recoveredClaim.ownerEpoch,
          result: { status: "failed", reason: "provider_failed" },
          idempotencyKey: "steer:replacement:failed",
        });
        throwingSchedulerStore(store.scheduler).retry({
          runId,
          ownerEpoch: recoveredClaim.ownerEpoch,
          target: "review~1",
          idempotencyKey: "steer:replacement:retry",
        });
        expect(throwingSchedulerStore(store.scheduler).startAttempt({
          runId,
          nodeKey: "review~1",
          nodeId: "review",
          ownerEpoch: recoveredClaim.ownerEpoch,
          idempotencyKey: "steer:replacement:ordinary-retry",
        }).steer).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });

  it("replaces an in-flight steer directive with the newest correction", async () => {
    await withRuntimeWorkspace("scheduler-store-steer-replace", async workspace => {
      const store = await openRuntimeStore(workspace);
      try {
        const { runId, claim, attemptId } = await startedAgent(store, workspace);
        const first = store.scheduler.trySteerAgent({
          runId,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:replace:first",
          steerId: "steer:replace:first",
          target: attemptId,
          instruction: "First correction.",
        })._unsafeUnwrap();
        const firstReplacement = throwingSchedulerStore(store.scheduler).startAttempt({
          runId,
          nodeKey: "review~1",
          nodeId: "review",
          ownerEpoch: claim.ownerEpoch,
          expectedVersion: first.snapshot.version,
          idempotencyKey: "steer:replace:first-attempt",
        });
        const second = store.scheduler.trySteerAgent({
          runId,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:replace:second",
          steerId: "steer:replace:second",
          target: firstReplacement.attemptId,
          instruction: "Second correction.",
        })._unsafeUnwrap();

        expect(throwingSchedulerStore(store.scheduler).startAttempt({
          runId,
          nodeKey: "review~1",
          nodeId: "review",
          ownerEpoch: claim.ownerEpoch,
          expectedVersion: second.snapshot.version,
          idempotencyKey: "steer:replace:second-attempt",
        }).steer).toEqual({
          steerId: "steer:replace:second",
          instruction: "Second correction.",
        });
      } finally {
        store.close();
      }
    });
  });

  it("rejects a shared active Agent session", async () => {
    await withRuntimeWorkspace("scheduler-store-steer-rejections", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, sharedSessionWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        appendReadyAgents(store, run.id, claim);
        const first = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "first~1",
          nodeId: "first",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:first:start",
        });
        throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "second~1",
          nodeId: "second",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:second:start",
        });

        const before = durablePosition(store, run.id);
        expect(store.scheduler.trySteerAgent({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:shared-session",
          steerId: "steer:shared-session",
          target: first.attemptId,
          instruction: "Correct course.",
        })._unsafeUnwrapErr()).toMatchObject({
          type: "steer-session-conflict",
          candidateKeys: ["second~1"],
        });
        expect(durablePosition(store, run.id)).toEqual(before);
      } finally {
        store.close();
      }
    });
  });

  it("rejects ambiguous static Agent aliases without mutating either attempt", async () => {
    await withRuntimeWorkspace("scheduler-store-steer-ambiguous", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, agentWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:ambiguous:ready",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "review~b", nodeId: "review", instancePath: [{ kind: "fanout", nodeId: "items", itemIndex: 1 }, { kind: "node", nodeId: "review" }] } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "review~a", nodeId: "review", instancePath: [{ kind: "fanout", nodeId: "items", itemIndex: 0 }, { kind: "node", nodeId: "review" }] } },
          ],
        });
        const second = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "review~b",
          nodeId: "review",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:ambiguous:second",
        });
        const first = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "review~a",
          nodeId: "review",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:ambiguous:first",
        });
        const before = durablePosition(store, run.id);

        expect(store.scheduler.trySteerAgent({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:ambiguous",
          steerId: "steer:ambiguous",
          target: "review",
          instruction: "Correct course.",
        })._unsafeUnwrapErr()).toMatchObject({
          type: "ambiguous-steer-target",
          candidateKeys: ["review~a", "review~b"],
        });
        const after = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
        expect(durablePosition(store, run.id)).toEqual(before);
        expect(after.projection.attempts[first.attemptId]?.status).toBe("started");
        expect(after.projection.attempts[second.attemptId]?.status).toBe("started");
      } finally {
        store.close();
      }
    });
  });

  it("rejects repeated static non-Agent aliases before occurrence ambiguity", async () => {
    await withRuntimeWorkspace("scheduler-store-steer-non-agent-alias", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, nonAgentWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
        throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
          runId: run.id,
          expectedVersion: snapshot.version,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:non-agent-alias:ready",
          events: [
            { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "check~b", nodeId: "check", instancePath: [{ kind: "fanout", nodeId: "items", itemIndex: 1 }, { kind: "node", nodeId: "check" }] } },
            { type: "instance.ready", payload: { runId: run.id, nodeKey: "check~a", nodeId: "check", instancePath: [{ kind: "fanout", nodeId: "items", itemIndex: 0 }, { kind: "node", nodeId: "check" }] } },
          ],
        });
        throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "check~b",
          nodeId: "check",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:non-agent-alias:second",
        });
        throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "check~a",
          nodeId: "check",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:non-agent-alias:first",
        });
        const before = durablePosition(store, run.id);

        expect(store.scheduler.trySteerAgent({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:non-agent-alias",
          steerId: "steer:non-agent-alias",
          target: "check",
          instruction: "Correct course.",
        })._unsafeUnwrapErr()).toMatchObject({
          type: "invalid-steer-target",
          status: "assert",
        });
        expect(durablePosition(store, run.id)).toEqual(before);
      } finally {
        store.close();
      }
    });
  });

  it("rejects non-Agent and not-started targets without durable control events", async () => {
    await withRuntimeWorkspace("scheduler-store-steer-invalid-targets", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        readyNode(store, run.id, claim, "steer:non-agent:ready");
        const beforeNotStarted = durablePosition(store, run.id);
        expect(store.scheduler.trySteerAgent({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:blank",
          steerId: "steer:blank",
          target: "require_ready~1",
          instruction: " \n ",
        })._unsafeUnwrapErr()).toMatchObject({ type: "invalid-steer-instruction" });
        expect(durablePosition(store, run.id)).toEqual(beforeNotStarted);
        expect(store.scheduler.trySteerAgent({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:not-started",
          steerId: "steer:not-started",
          target: "require_ready~1",
          instruction: "Correct course.",
        })._unsafeUnwrapErr()).toMatchObject({ type: "invalid-steer-target", status: "ready" });
        expect(durablePosition(store, run.id)).toEqual(beforeNotStarted);

        const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "require_ready~1",
          nodeId: "require_ready",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:non-agent:start",
        });
        const beforeNonAgent = durablePosition(store, run.id);
        expect(store.scheduler.trySteerAgent({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "steer:non-agent",
          steerId: "steer:non-agent",
          target: attempt.attemptId,
          instruction: "Correct course.",
        })._unsafeUnwrapErr()).toMatchObject({ type: "invalid-steer-target", status: "assert" });
        expect(durablePosition(store, run.id)).toEqual(beforeNonAgent);
      } finally {
        store.close();
      }
    });
  });
});

async function startedAgent(store: RuntimeStore, workspace: string) {
  const prepared = await prepareSyntheticWorkflow(workspace, agentWorkflow());
  const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
  const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
  const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
  throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
    runId: run.id,
    expectedVersion: snapshot.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: "steer:ready",
    events: [
      { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root", scope: { review: "review~1" } } },
      { type: "instance.ready", payload: { runId: run.id, nodeKey: "review~1", nodeId: "review", parentFrameKey: "root", instancePath: [{ kind: "node", nodeId: "review" }], readinessSequence: 1 } },
    ],
  });
  const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
    runId: run.id,
    nodeKey: "review~1",
    nodeId: "review",
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: "steer:attempt:start",
  });
  return { runId: run.id, claim, attemptId: attempt.attemptId };
}

function appendReadyAgents(store: RuntimeStore, runId: string, claim: RunOwnerClaim): void {
  const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
  throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
    runId,
    expectedVersion: snapshot.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: "steer:shared:ready",
    events: [
      { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root", scope: { first: "first~1", second: "second~1" } } },
      { type: "instance.ready", payload: { runId, nodeKey: "first~1", nodeId: "first", parentFrameKey: "root", instancePath: [{ kind: "node", nodeId: "first" }], readinessSequence: 1 } },
      { type: "instance.ready", payload: { runId, nodeKey: "second~1", nodeId: "second", parentFrameKey: "root", instancePath: [{ kind: "node", nodeId: "second" }], readinessSequence: 2 } },
    ],
  });
}

function agentWorkflow() {
  return defineWorkflow({
    name: "scheduler-store-steer",
    agents: { reviewer: { use: "codex" } },
  }).build(({ agents, step }) => {
    step("review").agent({ agent: agents.reviewer, prompt: "Review." });
    return {};
  });
}

function sharedSessionWorkflow() {
  return defineWorkflow({
    name: "scheduler-store-steer-shared-session",
    agents: { reviewer: { use: "codex" } },
  }).build(({ agents, step }) => {
    step("first").agent({ agent: agents.reviewer, prompt: "First.", sessionKey: "shared" });
    step("second").agent({ agent: agents.reviewer, prompt: "Second.", sessionKey: "shared" });
    return {};
  });
}

function nonAgentWorkflow() {
  return defineWorkflow({ name: "scheduler-store-steer-non-agent" }).build(({ step }) => {
    step("check").assert({ condition: true });
    return {};
  });
}

function durablePosition(store: RuntimeStore, runId: string): { version: number; eventCount: number } {
  return {
    version: throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).version,
    eventCount: store.getCommittedRuntimeEventsAfter(runId, 0).length,
  };
}
