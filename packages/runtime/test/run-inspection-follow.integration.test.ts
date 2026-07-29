import { defineWorkflow } from "@acpus/core";
import { DatabaseSync } from "node:sqlite";
import type { Result } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchInspection } from "../src/inspection/use-cases.js";
import { deriveOccurrenceRef } from "../src/scheduler/occurrence-ref.js";
import type { SchedulerEvent } from "../src/scheduler/events.js";
import type { RunOwnerClaim } from "../src/scheduler/store-port.js";
import { openRuntimeStore, type RuntimeStore } from "../src/store/store.js";
import type { RunInspectionError, WatchInspectionEmission } from "../src/inspection/types.js";
import { admitRunForTest } from "./support/runtime-store.js";
import { prepareSyntheticWorkflow, runtimeDatabasePath, signalWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { awaitingSignal } from "./support/store-port-fixtures.js";

vi.mock("@acpus/agent-executor", async importOriginal => {
  const actual = await importOriginal<typeof import("@acpus/agent-executor")>();
  return {
    ...actual,
    executeAgentTurn: vi.fn(async (request: import("@acpus/agent-executor").AgentTurnRequest) => {
      const observedAt = new Date().toISOString();
      request.onObservation?.({
        event: {
          schemaVersion: 1,
          sequence: 0,
          observedAt,
          elapsedMs: 1,
          type: "message",
          channel: "assistant",
          content: "durable observation",
        },
        progress: {
          responseText: "durable observation",
          summary: {
            eventCount: 1,
            availability: { context: "unavailable", tokenUsage: "unavailable" },
            tools: { totalToolCallCount: 0, calls: [] },
          },
          updatedAt: observedAt,
        },
      });
      return {
        status: "completed" as const,
        responseText: "durable observation",
        stderr: "",
        summary: {
          eventCount: 1,
          availability: { context: "unavailable" as const, tokenUsage: "unavailable" as const },
          tools: { totalToolCallCount: 0, calls: [] },
        },
        timing: { startedAt: observedAt, finishedAt: observedAt, elapsedMs: 1 },
      };
    }),
  };
});

describe("run inspection follow", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns one terminal overview boundary view with the exact workflow output", async () => {
    await withRuntimeWorkspace("run-inspection-follow-terminal", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      try {
        const claim = store.scheduler.claimRun(run.id, "follow-terminal", 60_000)!;
        append(store, run.id, claim, "terminal", [
          { type: "frame.started", payload: { runId: run.id, frameKey: "root", frameKind: "root" } },
          { type: "frame.completed", payload: { frameKey: "root", result: { ok: true }, terminalReason: "root_completed" } },
        ]);

        const emissions = await collect(watchInspection(workspace, { view: { kind: "run", runId: run.id } }));
        expect(emissions).toEqual([{
          schemaVersion: 2,
          kind: "view",
          document: expect.objectContaining({
            kind: "snapshot",
            run: expect.objectContaining({ id: run.id, status: "completed" }),
            output: { ok: true },
          }),
        }]);
      } finally {
        store.close();
      }
    });
  });

  it("ends overview at a hard Attention while an unrelated sibling remains running", async () => {
    await withRuntimeWorkspace("run-inspection-follow-hard-attention", async workspace => {
      const store = await admittedTwoAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const claim = store.scheduler.claimRun(run.id, "follow-attention", 60_000)!;
      const left = startAgent(store, run.id, claim, "left", 1);
      const right = startAgent(store, run.id, claim, "right", 2);
      const controller = new AbortController();
      const iterator = watchInspection(workspace, {
        view: { kind: "run", runId: run.id },
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        expect(await nextEmission(iterator)).toMatchObject({ kind: "view", document: { kind: "snapshot" } });
        append(store, run.id, claim, "left-failed", [
          { type: "attempt.failed", payload: { attemptId: left.attemptId, error: { reason: "boom" }, terminalReason: "boom" } },
          { type: "instance.failed", payload: { nodeKey: left.nodeKey, attemptId: left.attemptId, error: { reason: "boom" }, statusReason: "boom" } },
        ]);

        const boundary = await nextPolledEmission(iterator);
        expect(boundary).toMatchObject({
          kind: "view",
          document: {
            kind: "snapshot",
            run: { status: "running" },
            items: expect.arrayContaining([
              expect.objectContaining({ nodeId: "left", status: "failed" }),
              expect.objectContaining({ nodeId: "right", status: "running" }),
            ]),
          },
        });
        expect((await iterator.next()).done).toBe(true);
        expect(right.attemptNo).toBe(1);
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("ends a target follow when that target completes even while a sibling runs", async () => {
    await withRuntimeWorkspace("run-inspection-follow-target-boundary", async workspace => {
      const store = await admittedTwoAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const claim = store.scheduler.claimRun(run.id, "follow-target", 60_000)!;
      const left = startAgent(store, run.id, claim, "left", 1);
      startAgent(store, run.id, claim, "right", 2);
      const controller = new AbortController();
      const iterator = watchInspection(workspace, {
        view: { kind: "target", runId: run.id, target: left.nodeKey },
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        expect(await nextEmission(iterator)).toMatchObject({ kind: "view", document: { kind: "target", state: { status: "running" } } });
        completeAgent(store, run.id, claim, left);

        expect(await nextPolledEmission(iterator)).toMatchObject({
          kind: "view",
          document: {
            kind: "target",
            run: { status: "running" },
            state: { status: "completed" },
          },
        });
        expect((await iterator.next()).done).toBe(true);
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("retains scoped topology and controls across a target follow poll", async () => {
    await withRuntimeWorkspace("run-inspection-follow-target-topology", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, signalWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "follow-target-topology", 60_000)!;
        const ref = deriveOccurrenceRef([{ kind: "node", nodeId: "approve" }]);
        const controller = new AbortController();
        const iterator = watchInspection(workspace, {
          view: {
            kind: "target",
            runId: run.id,
            target: "approve",
            includeAllTopology: true,
            includeControls: true,
          },
          signal: controller.signal,
        })[Symbol.asyncIterator]();
        try {
          const initial = await nextEmission(iterator);
          if (initial.kind !== "view" || initial.document.kind !== "snapshot") {
            throw new Error("expected scoped topology instead of a target summary");
          }
          expect(initial.document.all).toBe(true);

          awaitingSignal(store, run.id, claim, "awaiting");
          const boundary = await nextPolledEmission(iterator);
          if (boundary.kind !== "view" || boundary.document.kind !== "snapshot") {
            throw new Error("expected scoped topology boundary view");
          }
          expect(boundary.document).toMatchObject({
            all: true,
            scope: { ref },
            availableActions: expect.arrayContaining([
              expect.objectContaining({ kind: "signal", target: ref }),
              expect.objectContaining({ kind: "cancel", target: ref }),
            ]),
          });
          expect(boundary.document.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ nodeId: "approve", ref }),
          ]));
          expect(boundary.document.items).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ nodeId: "before" }),
            expect.objectContaining({ nodeId: "after" }),
          ]));
          expect((await iterator.next()).done).toBe(true);
        } finally {
          controller.abort();
          await iterator.return?.();
        }
      } finally {
        store.close();
      }
    });
  });

  it("keeps a logical occurrence attached across an automatic replacement", async () => {
    await withRuntimeWorkspace("run-inspection-follow-logical-replacement", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const claim = store.scheduler.claimRun(run.id, "follow-logical", 60_000)!;
      const first = startAgent(store, run.id, claim, "observe", 1);
      const ref = deriveOccurrenceRef([{ kind: "node", nodeId: "observe" }]);
      const controller = new AbortController();
      const iterator = watchInspection(workspace, {
        view: { kind: "target", runId: run.id, target: ref },
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        expect(await nextEmission(iterator)).toMatchObject({ kind: "view", document: { kind: "target", state: { status: "running" } } });
        const replacement = replaceAttempt(store, run.id, claim, first);

        const waiting = iterator.next();
        let settled = false;
        void waiting.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(250);
        expect(settled).toBe(false);

        completeAgent(store, run.id, claim, replacement);
        await vi.advanceTimersByTimeAsync(250);
        const boundary = await waiting;
        if (boundary.done || boundary.value.isErr()) throw new Error("expected logical occurrence boundary");
        expect(boundary.value.value).toMatchObject({
          kind: "view",
          document: { kind: "target", subject: { ref }, state: { status: "completed" } },
        });
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("pins exact-attempt follow to the fenced attempt instead of its successor", async () => {
    await withRuntimeWorkspace("run-inspection-follow-exact-fence", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const claim = store.scheduler.claimRun(run.id, "follow-exact", 60_000)!;
      const first = startAgent(store, run.id, claim, "observe", 1);
      const ref = deriveOccurrenceRef([{ kind: "node", nodeId: "observe" }]);
      const controller = new AbortController();
      const iterator = watchInspection(workspace, {
        view: { kind: "target", runId: run.id, target: `${ref}#${first.attemptNo}` },
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        expect(await nextEmission(iterator)).toMatchObject({ kind: "view", document: { kind: "target", state: { status: "running" } } });
        const replacement = replaceAttempt(store, run.id, claim, first);

        expect(await nextPolledEmission(iterator)).toMatchObject({
          kind: "view",
          document: {
            kind: "target",
            subject: { ref: `${ref}#${first.attemptNo}` },
            state: { status: "cancelled" },
          },
        });
        expect(replacement.attemptNo).toBe(first.attemptNo + 1);
        expect((await iterator.next()).done).toBe(true);
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("returns one view immediately for an actionable Signal wait", async () => {
    await withRuntimeWorkspace("run-inspection-follow-signal-boundary", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, signalWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        const claim = store.scheduler.claimRun(run.id, "follow-signal", 60_000)!;
        awaitingSignal(store, run.id, claim, "awaiting");

        const emissions = await collect(watchInspection(workspace, {
          view: { kind: "target", runId: run.id, target: "approve" },
        }));
        expect(emissions).toHaveLength(1);
        const emission = emissions[0]!;
        expect(emission.kind).toBe("view");
        if (emission.kind !== "view" || emission.document.kind !== "target") throw new Error("expected target boundary view");
        expect(emission.document.state.status).toBe("awaiting");
        expect(emission.document.availableActions.some(action => action.kind === "signal")).toBe(true);
      } finally {
        store.close();
      }
    });
  });

  it("emits Timeline semantic entries before its final boundary view", async () => {
    await withRuntimeWorkspace("run-inspection-follow-timeline-semantics", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const claim = store.scheduler.claimRun(run.id, "follow-timeline", 60_000)!;
      const attempt = startAgent(store, run.id, claim, "observe", 1);
      const controller = new AbortController();
      const iterator = watchInspection(workspace, {
        view: { kind: "timeline", runId: run.id, target: attempt.attemptId },
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        expect(await nextEmission(iterator)).toMatchObject({ kind: "view", document: { kind: "timeline" } });
        await captureTurn(store, workspace, run.id, attempt);

        const first = await nextPolledEmission(iterator);
        const second = await nextEmission(iterator);
        expect([first, second]).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "timeline-entry", entry: expect.objectContaining({ kind: "activity", channel: "response" }) }),
          expect.objectContaining({ kind: "timeline-entry", entry: expect.objectContaining({ kind: "phase" }) }),
        ]));

        completeAgent(store, run.id, claim, attempt);
        const terminal = await nextPolledEmission(iterator);
        expect(terminal).toMatchObject({ kind: "timeline-entry", entry: expect.objectContaining({ kind: "transition", action: "completed" }) });
        expect(await nextEmission(iterator)).toMatchObject({ kind: "view", document: { kind: "timeline", state: { status: "completed" } } });
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("emits degraded and restored visibility as standalone Timeline entries", async () => {
    await withRuntimeWorkspace("run-inspection-follow-visibility", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const claim = store.scheduler.claimRun(run.id, "follow-visibility", 60_000)!;
      const attempt = startAgent(store, run.id, claim, "observe", 1);
      await captureTurn(store, workspace, run.id, attempt);
      const controller = new AbortController();
      const iterator = watchInspection(workspace, {
        view: { kind: "timeline", runId: run.id, target: attempt.attemptId },
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        expect(await nextEmission(iterator)).toMatchObject({ kind: "view", document: { kind: "timeline" } });
        setObservationGap(workspace, run.id, attempt.attemptId, true);
        expect(await nextPolledEmission(iterator)).toMatchObject({
          kind: "timeline-entry",
          entry: { kind: "visibility", state: "degraded", reason: "observation-gap" },
        });
        setObservationGap(workspace, run.id, attempt.attemptId, false);
        expect(await nextPolledEmission(iterator)).toMatchObject({
          kind: "timeline-entry",
          entry: { kind: "visibility", state: "restored" },
        });
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });

  it("reports a durable event sequence discontinuity as a tagged inspection error", async () => {
    await withRuntimeWorkspace("run-inspection-follow-sequence-gap", async workspace => {
      const store = await admittedAgentStore(workspace);
      const run = store.listRuns()[0]!;
      const controller = new AbortController();
      const iterator = watchInspection(workspace, {
        view: { kind: "run", runId: run.id },
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        expect(await nextEmission(iterator)).toMatchObject({ kind: "view", document: { kind: "snapshot" } });
        const previous = store.getLastRunEventSequence(run.id);
        const db = new DatabaseSync(runtimeDatabasePath(workspace));
        try {
          db.prepare(`
            INSERT INTO run_events (run_id, sequence, type, node_key, payload_json, created_at, idempotency_key)
            VALUES (?, ?, 'run.paused', NULL, '{}', ?, ?)
          `).run(run.id, previous + 2, new Date().toISOString(), `follow-gap:${run.id}`);
        } finally {
          db.close();
        }

        const result = await nextPolledResult(iterator);
        expect(result.done).toBe(false);
        if (result.done || result.value.isOk()) throw new Error("expected discontinuity error");
        expect(result.value.error).toMatchObject({
          type: "inspection-sequence-discontinuity",
          runId: run.id,
          expected: previous + 1,
          actual: previous + 2,
        });
      } finally {
        controller.abort();
        await iterator.return?.();
        store.close();
      }
    });
  });
});

async function admittedAgentStore(workspace: string): Promise<RuntimeStore> {
  const prepared = await prepareSyntheticWorkflow(workspace, defineWorkflow({
    name: "inspection-follow-agent",
    agents: { observer: { use: "claude" } },
  }).build(({ agents, step }) => {
    const observed = step("observe").agent({ agent: agents.observer, prompt: "Inspect" });
    return { observed: observed.output };
  }));
  const store = await openRuntimeStore(workspace);
  await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
  return store;
}

async function admittedTwoAgentStore(workspace: string): Promise<RuntimeStore> {
  const prepared = await prepareSyntheticWorkflow(workspace, defineWorkflow({
    name: "inspection-follow-two-agents",
    agents: { observer: { use: "claude" } },
  }).build(({ agents, step }) => {
    const left = step("left").agent({ agent: agents.observer, prompt: "Left" });
    const right = step("right").agent({ agent: agents.observer, prompt: "Right" });
    return { left: left.output, right: right.output };
  }));
  const store = await openRuntimeStore(workspace);
  await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
  return store;
}

function startAgent(
  store: RuntimeStore,
  runId: string,
  claim: RunOwnerClaim,
  nodeId: string,
  readinessSequence: number,
) {
  const nodeKey = `${nodeId}~1`;
  append(store, runId, claim, `${nodeId}:ready:${readinessSequence}`, [{
    type: "instance.ready",
    payload: {
      runId,
      nodeKey,
      nodeId,
      instancePath: [{ kind: "node", nodeId }],
      readinessSequence,
    },
  }]);
  const attempt = throwingSchedulerStore(store.scheduler).startAttempt({
    runId,
    nodeKey,
    nodeId,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: `${nodeId}:attempt:${readinessSequence}`,
  });
  return { ...attempt, nodeKey, ownerEpoch: claim.ownerEpoch };
}

function replaceAttempt(
  store: RuntimeStore,
  runId: string,
  claim: RunOwnerClaim,
  attempt: ReturnType<typeof startAgent>,
) {
  append(store, runId, claim, `${attempt.attemptId}:replace`, [
    { type: "attempt.superseded", payload: { attemptId: attempt.attemptId, cancelReason: "superseded" } },
    { type: "instance.requeued", payload: { nodeKey: attempt.nodeKey, reason: "superseded" } },
  ]);
  const replacement = throwingSchedulerStore(store.scheduler).startAttempt({
    runId,
    nodeKey: attempt.nodeKey,
    nodeId: "observe",
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey: `${attempt.attemptId}:replacement-attempt`,
  });
  return { ...replacement, nodeKey: attempt.nodeKey, ownerEpoch: claim.ownerEpoch };
}

function completeAgent(
  store: RuntimeStore,
  runId: string,
  claim: RunOwnerClaim,
  attempt: ReturnType<typeof startAgent>,
): void {
  append(store, runId, claim, `${attempt.attemptId}:complete`, [
    { type: "attempt.completed", payload: { attemptId: attempt.attemptId, result: { ok: true } } },
    { type: "instance.completed", payload: { nodeKey: attempt.nodeKey, attemptId: attempt.attemptId, acceptedAttemptId: attempt.attemptId, output: { ok: true } } },
  ]);
}

function append(
  store: RuntimeStore,
  runId: string,
  claim: RunOwnerClaim,
  idempotencyKey: string,
  events: SchedulerEvent[],
): void {
  const scheduler = throwingSchedulerStore(store.scheduler);
  scheduler.appendSchedulerEvents({
    runId,
    expectedVersion: scheduler.loadRunSnapshot(runId).version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey,
    events,
  });
}

async function captureTurn(
  store: RuntimeStore,
  workspace: string,
  runId: string,
  attempt: ReturnType<typeof startAgent>,
): Promise<void> {
  await store.observationLog.captureTurn({
    runId,
    nodeId: "observe",
    nodeKey: attempt.nodeKey,
    attemptId: attempt.attemptId,
    attemptNo: attempt.attemptNo,
    turn: 1,
    promptKind: "task",
    agentKey: "observer",
    sessionName: "follow-test",
    cwd: workspace,
    trace: false,
  }, {
    agent: { kind: "named", name: "claude" },
    prompt: "Inspect",
    cwd: workspace,
    env: {},
    sessionName: "follow-test",
    permissionMode: "deny-all",
  });
}

function setObservationGap(workspace: string, runId: string, attemptId: string, degraded: boolean): void {
  const db = new DatabaseSync(runtimeDatabasePath(workspace));
  try {
    db.prepare(`
      UPDATE agent_observation_turns
      SET degraded = ?, gap_count = ?
      WHERE run_id = ? AND attempt_id = ?
    `).run(degraded ? 1 : 0, degraded ? 1 : 0, runId, attemptId);
  } finally {
    db.close();
  }
}

async function collect(iterable: AsyncIterable<Result<WatchInspectionEmission, RunInspectionError>>): Promise<WatchInspectionEmission[]> {
  const emissions: WatchInspectionEmission[] = [];
  for await (const result of iterable) {
    if (result.isErr()) throw result.error;
    emissions.push(result.value);
  }
  return emissions;
}

async function nextEmission(iterator: AsyncIterator<Result<WatchInspectionEmission, RunInspectionError>>): Promise<WatchInspectionEmission> {
  const next = await iterator.next();
  if (next.done) throw new Error("follow ended before the expected emission");
  if (next.value.isErr()) throw next.value.error;
  return next.value.value;
}

async function nextPolledResult(
  iterator: AsyncIterator<Result<WatchInspectionEmission, RunInspectionError>>,
): Promise<IteratorResult<Result<WatchInspectionEmission, RunInspectionError>>> {
  const pending = iterator.next();
  await vi.advanceTimersByTimeAsync(250);
  return pending;
}

async function nextPolledEmission(iterator: AsyncIterator<Result<WatchInspectionEmission, RunInspectionError>>): Promise<WatchInspectionEmission> {
  const result = await nextPolledResult(iterator);
  if (result.done) throw new Error("follow ended before the expected emission");
  if (result.value.isErr()) throw result.value.error;
  return result.value.value;
}
