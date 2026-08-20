import { defineWorkflow } from "@acpus/core";
import { sha256Digest } from "@acpus/core/content-identity";
import { describe, expect, it } from "vitest";
import { admitRunForTest } from "./support/runtime-store.js";
import { agentSessionIdForScope, agentSessionScopeDigest } from "../src/execution/agent-session.js";
import type { AgentSessionCheckpointValue } from "../src/execution/agent-operation-plan.js";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import type { RunOwnerClaim } from "../src/scheduler/store-port.js";
import { prepareSyntheticWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";

describe("Scheduler generic Agent Retry", () => {
  it("neutralizes and abandons S1 atomically, then admits S2 with an authored Start", async () => {
    await withRuntimeWorkspace("scheduler-agent-retry-generation", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, agentWorkflow(false));
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        readyAgent(store, run.id, claim);
        const first = materializeAgent(store, run.id, claim, false);
        failAgent(store, run.id, claim, first);

        const plan = store.scheduler.tryPlanRetry({
          runId: run.id,
          target: "review~1",
          idempotencyKey: "retry:agent",
        })._unsafeUnwrap();
        expect(plan.sessions).toEqual([{ runId: run.id, agentSessionId: first.agentSessionId }]);

        expect(store.scheduler.tryCommitRetry({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          expectedVersion: plan.snapshot.version,
          target: "review~1",
          idempotencyKey: "retry:agent",
          neutralizedAgentSessionIds: [],
        })._unsafeUnwrapErr()).toMatchObject({ type: "retry-neutralization-mismatch" });

        const retried = store.scheduler.tryCommitRetry({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          expectedVersion: plan.snapshot.version,
          target: "review~1",
          idempotencyKey: "retry:agent",
          neutralizedAgentSessionIds: [first.agentSessionId],
        })._unsafeUnwrap();
        expect(retried.projection.instances["review~1"]).toMatchObject({ status: "ready" });
        expect(store.scheduler.readAgentControlInspection(run.id).agentSessions)
          .toEqual([expect.objectContaining({ agentSessionId: first.agentSessionId, generation: 1, lifecycle: "abandoned" })]);

        const secondAttempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "review~1",
          nodeId: "review",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "retry:agent:s2",
        });
        const authored = { promptOrigin: "authored" as const, inputDigest: sha256Digest("prompt:s2") };
        const admission = store.scheduler.planAgentAttemptAdmission({
          runId: run.id,
          attemptId: secondAttempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          target: "review~1",
          scopeDigest: first.scopeDigest,
          explicitShared: false,
          authored,
        })._unsafeUnwrap();
        expect(admission).toMatchObject({
          operation: "start",
          session: { generation: 2 },
          predecessorAttemptId: first.attemptId,
          promptOrigin: "authored",
        });
        store.scheduler.tryBindAgentAttemptSession({
          runId: run.id,
          attemptId: secondAttempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          agentSessionId: admission.session.agentSessionId,
          scopeDigest: admission.session.scopeDigest,
          generation: admission.session.generation,
          explicitShared: false,
          operation: admission.operation,
          sessionOpenMode: admission.sessionOpenMode,
          ...(admission.predecessorAttemptId === undefined ? {} : { predecessorAttemptId: admission.predecessorAttemptId }),
          promptOrigin: admission.promptOrigin,
          inputDigest: admission.inputDigest,
          ...(admission.admittedFromCheckpoint === undefined ? {} : { admittedFromCheckpoint: admission.admittedFromCheckpoint }),
        })._unsafeUnwrap();
        expect(store.scheduler.readAgentControlInspection(run.id).agentSessions)
          .toEqual(expect.arrayContaining([
            expect.objectContaining({ generation: 1, lifecycle: "abandoned" }),
            expect.objectContaining({ generation: 2, lifecycle: "active", currentBinding: { operation: "start", attemptId: secondAttempt.attemptId, promptOrigin: "authored" } }),
          ]));
      } finally {
        store.close();
      }
    });
  });

  it("rejects explicit shared Session Retry without writing", async () => {
    await withRuntimeWorkspace("scheduler-shared-agent-retry", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, agentWorkflow(true));
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        readyAgent(store, run.id, claim);
        const first = materializeAgent(store, run.id, claim, true);
        failAgent(store, run.id, claim, first);
        const before = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
        const rejected = store.scheduler.tryPlanRetry({
          runId: run.id,
          target: "review~1",
          idempotencyKey: "retry:shared",
        })._unsafeUnwrapErr();
        expect(rejected).toMatchObject({ type: "shared-session-retry-requires-fork" });
        expect(rejected.message).toContain(`acpus runs fork ${run.id} --target review~1`);
        expect(throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id).version).toBe(before.version);
      } finally {
        store.close();
      }
    });
  });

  it("creates S1 after a pre-identity failure", async () => {
    await withRuntimeWorkspace("scheduler-agent-retry-pre-identity", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, agentWorkflow(false));
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "owner-a", 60_000)!;
        readyAgent(store, run.id, claim);
        const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "review~1",
          nodeId: "review",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "pre-identity:start",
        });
        throwingSchedulerStore(store.scheduler).commitAttemptResult({
          runId: run.id,
          attemptId: attempt.attemptId,
          ownerEpoch: claim.ownerEpoch,
          result: { status: "failed", reason: "spawn failed" },
          idempotencyKey: "pre-identity:failed",
        });
        const plan = store.scheduler.tryPlanRetry({ runId: run.id, target: "review~1", idempotencyKey: "pre-identity:retry" })._unsafeUnwrap();
        expect(plan.sessions).toEqual([]);
        store.scheduler.tryCommitRetry({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          expectedVersion: plan.snapshot.version,
          target: "review~1",
          idempotencyKey: "pre-identity:retry",
          neutralizedAgentSessionIds: [],
        })._unsafeUnwrap();
        const next = throwingSchedulerStore(store.scheduler).startAttempt({
          runId: run.id,
          nodeKey: "review~1",
          nodeId: "review",
          ownerEpoch: claim.ownerEpoch,
          idempotencyKey: "pre-identity:s1",
        });
        const admission = store.scheduler.planAgentAttemptAdmission({
          runId: run.id,
          attemptId: next.attemptId,
          ownerEpoch: claim.ownerEpoch,
          target: "review~1",
          scopeDigest: agentSessionScopeDigest(run.id, "node", "review~1"),
          explicitShared: false,
          authored: { promptOrigin: "authored", inputDigest: sha256Digest("prompt") },
        })._unsafeUnwrap();
        expect(admission).toMatchObject({ operation: "start", session: { generation: 1 } });
      } finally {
        store.close();
      }
    });
  });
});

type Materialized = {
  attemptId: string;
  agentSessionId: string;
  scopeDigest: ReturnType<typeof agentSessionScopeDigest>;
  inputDigest: ReturnType<typeof sha256Digest>;
};

function readyAgent(store: RuntimeStore, runId: string, claim: RunOwnerClaim): void {
  const current = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
  throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
    runId,
    ownerEpoch: claim.ownerEpoch,
    expectedVersion: current.version,
    idempotencyKey: "agent:ready",
    events: [
      { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root" } },
      { type: "instance.ready", payload: { runId, nodeKey: "review~1", nodeId: "review", parentFrameKey: "root", instancePath: [{ kind: "node", nodeId: "review" }] } },
    ],
  });
}

function materializeAgent(store: RuntimeStore, runId: string, claim: RunOwnerClaim, shared: boolean): Materialized {
  const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
    runId,
    nodeKey: "review~1",
    nodeId: "review",
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: "agent:s1",
  });
  const scopeDigest = agentSessionScopeDigest(runId, shared ? "key" : "node", shared ? "shared" : "review~1");
  const agentSessionId = agentSessionIdForScope(runId, scopeDigest, 1);
  const inputDigest = sha256Digest("prompt:s1");
  store.scheduler.tryBindAgentAttemptSession({
    runId,
    attemptId: attempt.attemptId,
    ownerEpoch: claim.ownerEpoch,
    agentSessionId,
    scopeDigest,
    generation: 1,
    explicitShared: shared,
    operation: "start",
    sessionOpenMode: "new_or_empty",
    promptOrigin: "authored",
    inputDigest,
  })._unsafeUnwrap();
  return { attemptId: attempt.attemptId, agentSessionId, scopeDigest, inputDigest };
}

function failAgent(store: RuntimeStore, runId: string, claim: RunOwnerClaim, session: Materialized): void {
  store.scheduler.tryRecordAgentSessionBinding({
    runId,
    ownerEpoch: claim.ownerEpoch,
    attemptId: session.attemptId,
    agentSessionId: session.agentSessionId,
    bindingDigest: sha256Digest(`binding:${session.agentSessionId}`),
  })._unsafeUnwrap();
  const intent = store.scheduler.tryCommitAgentTurnDispatch({
    runId,
    ownerEpoch: claim.ownerEpoch,
    agentSessionId: session.agentSessionId,
    attemptId: session.attemptId,
    turnId: "turn-1",
    sessionLeaseId: "lease-1",
    expected: { checkpoint: "not_dispatched", attemptId: session.attemptId, promptOrigin: "authored", inputDigest: session.inputDigest },
    invocationMetadata: {},
  })._unsafeUnwrap() as Exclude<AgentSessionCheckpointValue, { checkpoint: "not_dispatched" }>;
  store.scheduler.tryAdvanceAgentSessionCheckpoint({
    runId,
    ownerEpoch: claim.ownerEpoch,
    agentSessionId: session.agentSessionId,
    attemptId: session.attemptId,
    expected: intent,
    next: { ...intent, checkpoint: "terminal_observed" },
    cause: "provider_terminal",
  })._unsafeUnwrap();
  throwingSchedulerStore(store.scheduler).commitAttemptResult({
    runId,
    attemptId: session.attemptId,
    ownerEpoch: claim.ownerEpoch,
    result: { status: "failed", reason: "provider failed" },
    idempotencyKey: "agent:failed",
  });
}

function agentWorkflow(shared: boolean) {
  return defineWorkflow({
    name: shared ? "shared-agent-retry" : "local-agent-retry",
    agents: { reviewer: { use: "codex" } },
  }).build(({ agents, step }) => {
    step("review").agent({
      agent: agents.reviewer,
      prompt: "Review.",
      ...(shared ? { sessionKey: "shared" } : {}),
    });
    return {};
  });
}
