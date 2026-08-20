import { sha256Digest } from "@acpus/core/content-identity";
import { defineWorkflow } from "@acpus/core";
import { describe, expect, it } from "vitest";
import { agentSessionScopeDigest } from "../src/execution/agent-session.js";
import { readInspectionAtStore } from "../src/inspection/use-cases.js";
import { captureProcessIdentity } from "../src/process-liveness.js";
import type { SchedulerSteerProof } from "../src/scheduler/store-port.js";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import { admitRunForTest } from "./support/runtime-store.js";
import { prepareSyntheticWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";

describe("scheduler store Agent Steer", () => {
  it("projects Steer only when the live registry proves the exact durable Turn tuple", async () => {
    await withRuntimeWorkspace("scheduler-store-steer-inspection-proof", async workspace => {
      const store = await openRuntimeStore(workspace);
      try {
        const started = await startedAgentTurn(store, workspace);
        const query = { kind: "target", runId: started.runId, target: "review", detail: "summary" } as const;
        const offline = (await readInspectionAtStore(store, query))._unsafeUnwrap();
        expect(offline.kind === "target" && offline.detail === "summary" ? offline.availableControls ?? [] : [])
          .not.toContainEqual(expect.objectContaining({ type: "steer" }));

        let proved: unknown;
        const live = (await readInspectionAtStore(store, query, proof => {
          proved = proof;
          return proof.runId === started.runId
            && proof.nodeKey === started.nodeKey
            && proof.agentSessionId === started.proof.agentSessionId
            && proof.attemptId === started.proof.attemptId
            && proof.turnId === started.proof.turnId
            && proof.sessionLeaseId === started.proof.sessionLeaseId;
        }))._unsafeUnwrap();
        expect(proved).toEqual({ runId: started.runId, nodeKey: started.nodeKey, ...started.proof });
        expect(live.kind === "target" && live.detail === "summary" ? live.availableControls ?? [] : []).toContainEqual({
          type: "steer",
          target: started.attemptId,
          delivery: "interrupt_continue",
          effect: "cancel_drain_then_continue",
        });
      } finally {
        store.close();
      }
    });
  });

  it("requires the exact active Turn proof and commits only the durable drain fence", async () => {
    await withRuntimeWorkspace("scheduler-store-steer-proof", async workspace => {
      const store = await openRuntimeStore(workspace);
      try {
        const started = await startedAgentTurn(store, workspace);
        const before = store.getLastRunEventSequence(started.runId);
        expect(store.scheduler.trySteerAgent({
          runId: started.runId,
          ownerEpoch: started.ownerEpoch,
          idempotencyKey: "steer:missing-proof",
          steerId: "steer:missing-proof",
          target: started.attemptId,
          instruction: "Use the smaller fix.",
        })._unsafeUnwrapErr()).toMatchObject({ type: "steer-session-conflict" });
        expect(store.getLastRunEventSequence(started.runId)).toBe(before);

        const accepted = store.scheduler.trySteerAgent({
          runId: started.runId,
          ownerEpoch: started.ownerEpoch,
          idempotencyKey: "steer:accepted",
          steerId: "steer:accepted",
          target: started.attemptId,
          instruction: "Use the smaller fix.",
          proof: started.proof,
        })._unsafeUnwrap();

        expect(accepted.snapshot.projection.instances[started.nodeKey]).toMatchObject({
          status: "running",
          pendingSteerId: "steer:accepted",
        });
        expect(store.getCommittedRuntimeEventsAfter(started.runId, before).map(event => event.type)).toEqual([
          "control.agent_steer_requested",
          "attempt.superseded",
        ]);
        expect(store.scheduler.tryStartAttempt({
          runId: started.runId,
          nodeKey: started.nodeKey,
          nodeId: "review",
          ownerEpoch: started.ownerEpoch,
          expectedVersion: accepted.snapshot.version,
          idempotencyKey: "steer:premature-replacement",
        })._unsafeUnwrapErr()).toMatchObject({ type: "instance-not-ready" });

        const replay = store.scheduler.trySteerAgent({
          runId: started.runId,
          ownerEpoch: started.ownerEpoch,
          idempotencyKey: "steer:accepted",
          steerId: "steer:accepted",
          target: started.attemptId,
          instruction: "Use the smaller fix.",
        })._unsafeUnwrap();
        expect(replay).toMatchObject({ fencedAttemptId: started.attemptId, target: started.nodeKey });
        expect(store.getLastRunEventSequence(started.runId)).toBe(before + 2);
      } finally {
        store.close();
      }
    });
  });

  it("queues the replacement in the same transaction as terminal settlement", async () => {
    await withRuntimeWorkspace("scheduler-store-steer-settlement", async workspace => {
      const store = await openRuntimeStore(workspace);
      try {
        const started = await startedAgentTurn(store, workspace);
        const accepted = acceptSteer(store, started, "steer:settled");
        const authorityEpoch = claimRuntimeAuthority(store, workspace, started.runId);
        const settled = store.scheduler.trySettleFencedAgentSessionCheckpoint({
          runId: started.runId,
          runtimeOwnerEpoch: authorityEpoch,
          agentSessionId: started.proof.agentSessionId,
          attemptId: started.attemptId,
          turnId: started.proof.turnId,
          sessionLeaseId: started.proof.sessionLeaseId,
          expected: "owned_in_flight",
          next: "terminal_observed",
          cause: "provider_terminal",
          observedAt: new Date("2026-08-19T00:00:00.000Z"),
        })._unsafeUnwrap();
        expect(settled.checkpoint).toBe("terminal_observed");
        const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(started.runId);
        expect(snapshot.projection.instances[started.nodeKey]).toMatchObject({
          status: "ready",
          statusReason: "steered",
          pendingSteerId: "steer:settled",
        });
        const replacement = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: started.runId,
          nodeKey: started.nodeKey,
          nodeId: "review",
          ownerEpoch: started.ownerEpoch,
          expectedVersion: snapshot.version,
          idempotencyKey: "steer:settled:replacement",
        });
        expect(replacement.steer).toEqual({ steerId: "steer:settled", instruction: "Use the smaller fix." });
        expect(replacement.snapshot.projection.attempts[replacement.attemptId]).toMatchObject({
          steerEventSequence: accepted.fenceEventSequence,
        });
      } finally {
        store.close();
      }
    });
  });

  it("reconciles an accepted-but-unsignalled Steer to unknown and blocked", async () => {
    await withRuntimeWorkspace("scheduler-store-steer-reconcile", async workspace => {
      const store = await openRuntimeStore(workspace);
      try {
        const started = await startedAgentTurn(store, workspace);
        acceptSteer(store, started, "steer:crashed");
        const authorityEpoch = claimRuntimeAuthority(store, workspace, started.runId);

        expect(store.scheduler.tryReconcileAgentSteers({
          runId: started.runId,
          runtimeOwnerEpoch: authorityEpoch,
          now: new Date("2026-08-19T00:00:00.000Z"),
        })._unsafeUnwrap()).toBe(1);
        expect(store.scheduler.tryReconcileAgentSteers({
          runId: started.runId,
          runtimeOwnerEpoch: authorityEpoch,
        })._unsafeUnwrap()).toBe(0);

        const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(started.runId);
        expect(snapshot.projection.instances[started.nodeKey]).toMatchObject({
          status: "failed",
          statusReason: "session_checkpoint_unknown",
        });
        expect(store.getCommittedRuntimeEventsAfter(started.runId, 0).slice(-2).map(event => ({
          type: event.type,
          payload: event.payload,
        }))).toEqual([
          {
            type: "control.agent_steer_blocked",
            payload: {
              steerId: "steer:crashed",
              nodeKey: started.nodeKey,
              fencedAttemptId: started.attemptId,
              checkpoint: "acceptance_unknown",
            },
          },
          expect.objectContaining({ type: "instance.failed" }),
        ]);
      } finally {
        store.close();
      }
    });
  });
});

type StartedAgentTurn = Readonly<{
  runId: string;
  nodeKey: string;
  attemptId: string;
  ownerEpoch: number;
  proof: SchedulerSteerProof;
}>;

async function startedAgentTurn(store: RuntimeStore, workspace: string): Promise<StartedAgentTurn> {
  const prepared = await prepareSyntheticWorkflow(workspace, agentWorkflow());
  const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
  const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
  const nodeKey = "review~1";
  const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
  throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
    runId: run.id,
    expectedVersion: snapshot.version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: "steer:ready",
    events: [
      { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root", scope: { review: nodeKey } } },
      { type: "instance.ready", payload: { runId: run.id, nodeKey, nodeId: "review", parentFrameKey: "root", instancePath: [{ kind: "node", nodeId: "review" }], readinessSequence: 1 } },
    ],
  });
  const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
    runId: run.id,
    nodeKey,
    nodeId: "review",
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: "steer:attempt:start",
  });
  const scopeDigest = agentSessionScopeDigest(run.id, "node", nodeKey);
  const inputDigest = sha256Digest("Review.");
  const plan = store.scheduler.planAgentAttemptAdmission({
    runId: run.id,
    attemptId: attempt.attemptId,
    ownerEpoch: claim.ownerEpoch,
    target: nodeKey,
    scopeDigest,
    explicitShared: false,
    authored: { promptOrigin: "authored", inputDigest },
  })._unsafeUnwrap();
  store.scheduler.tryBindAgentAttemptSession({
    runId: run.id,
    attemptId: attempt.attemptId,
    ownerEpoch: claim.ownerEpoch,
    agentSessionId: plan.session.agentSessionId,
    scopeDigest,
    generation: 1,
    explicitShared: false,
    operation: "start",
    sessionOpenMode: "new_or_empty",
    promptOrigin: "authored",
    inputDigest,
  })._unsafeUnwrap();
  store.scheduler.tryRecordAgentSessionBinding({
    runId: run.id,
    attemptId: attempt.attemptId,
    ownerEpoch: claim.ownerEpoch,
    agentSessionId: plan.session.agentSessionId,
    bindingDigest: sha256Digest("steer-session-binding"),
  })._unsafeUnwrap();
  const turnId = "turn-active";
  const sessionLeaseId = "lease-active";
  const dispatch = store.scheduler.tryCommitAgentTurnDispatch({
    runId: run.id,
    ownerEpoch: claim.ownerEpoch,
    agentSessionId: plan.session.agentSessionId,
    attemptId: attempt.attemptId,
    turnId,
    sessionLeaseId,
    expected: { checkpoint: "not_dispatched", attemptId: attempt.attemptId, promptOrigin: "authored", inputDigest },
    invocationMetadata: { prompt: "Review." },
  })._unsafeUnwrap();
  store.scheduler.tryAdvanceAgentSessionCheckpoint({
    runId: run.id,
    ownerEpoch: claim.ownerEpoch,
    agentSessionId: plan.session.agentSessionId,
    attemptId: attempt.attemptId,
    expected: dispatch,
    next: {
      checkpoint: "owned_in_flight",
      attemptId: attempt.attemptId,
      turnId,
      sessionLeaseId,
      promptOrigin: "authored",
      inputDigest,
    },
    cause: "local_call_pending",
  })._unsafeUnwrap();
  return {
    runId: run.id,
    nodeKey,
    attemptId: attempt.attemptId,
    ownerEpoch: claim.ownerEpoch,
    proof: { agentSessionId: plan.session.agentSessionId, attemptId: attempt.attemptId, turnId, sessionLeaseId },
  };
}

function acceptSteer(store: RuntimeStore, started: StartedAgentTurn, steerId: string) {
  return store.scheduler.trySteerAgent({
    runId: started.runId,
    ownerEpoch: started.ownerEpoch,
    idempotencyKey: steerId,
    steerId,
    target: started.attemptId,
    instruction: "Use the smaller fix.",
    proof: started.proof,
  })._unsafeUnwrap();
}

function claimRuntimeAuthority(store: RuntimeStore, workspace: string, runId: string): number {
  const identity = captureProcessIdentity();
  return store.claimRuntimeAuthority({
    workspaceRealpath: workspace,
    ownerId: `runtime:${runId}`,
    pid: identity.pid,
    ...(identity.startToken === undefined ? {} : { processStartToken: identity.startToken }),
    protocolVersion: 1,
    packageVersion: "0.0.0-test",
    nodeVersion: process.version,
    execPath: process.execPath,
  })._unsafeUnwrap().epoch;
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
