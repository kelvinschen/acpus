import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { defineWorkflow, z } from "@acpus/core";
import type { WorkflowDefinition } from "@acpus/core/workflow";
import type {
  FixtureAgentTurnObservation as AgentTurnObservation,
  FixtureAgentTurnRequest as AgentTurnRequest,
  FixtureAgentTurnResult as AgentTurnResult,
} from "./support/agent-turn.js";
import { fixtureEvent, type FixtureObservationEvent } from "./support/agent-turn.js";
import type { JsonValue } from "@acpus/expression/ir";
import {
  observeInspection as observeInspectionStream,
  readInspection as readInspectionEffect,
} from "../src/inspection/use-cases.js";
import type { InspectionError, InspectionObservation } from "../src/inspection/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapRootEvents } from "../src/scheduler/materialize.js";
import { deriveOccurrenceRef } from "../src/scheduler/occurrence-ref.js";
import { frozenRunScope } from "../src/scheduler/settle.js";
import type { RunOwnerClaim } from "../src/scheduler/store-port.js";
import { openRuntimeStoreAdapter, type RuntimeStoreAdapter } from "../src/store/store.js";
import type { InspectionTreeEntry } from "../src/inspection/types.js";
import { dbRun } from "./support/store-port-fixtures.js";
import { parallelSignalRaceWorkflow, prepareSyntheticWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { admitRunForTest } from "./support/runtime-store.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";

type ObservationBase = "schemaVersion" | "sequence" | "observedAt" | "elapsedMs";
type ObservationEventInput = AgentTurnObservation["event"] extends infer Event
  ? Event extends unknown ? Omit<Event, ObservationBase> : never
  : never;

function readInspection(...args: Parameters<typeof readInspectionEffect>) {
  return Effect.runPromise(Effect.result(readInspectionEffect(...args)));
}

function observeInspection(...args: Parameters<typeof observeInspectionStream>) {
  return Stream.toAsyncIterable(Stream.result(observeInspectionStream(...args)));
}

describe("coherent inspection observation boundaries", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a logical occurrence attached through automatic replacement and closes at its successor", async () => {
    vi.useFakeTimers();
    await withRuntimeWorkspace("inspection-observation-logical-replacement", async workspace => {
      const started = await startedAgent(workspace);
      try {
        const selector = deriveOccurrenceRef(instance(started.store, started.runId, "review").instancePath);
        const iterator = observeInspection(workspace, {
          view: { kind: "target", runId: started.runId, target: selector, detail: "summary" },
          until: "subject-terminal",
        })[Symbol.asyncIterator]();

        expect(observation(await iterator.next())).toMatchObject({
          kind: "attached",
          view: { subject: { selector }, state: { status: "running" } },
        });

        const next = iterator.next();
        await vi.advanceTimersByTimeAsync(0);
        const replacement = automaticallyReplaceAndComplete(workspace, started);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(observation(await next)).toMatchObject({
          kind: "closed",
          reason: "subject-terminal",
          view: {
            subject: { selector },
            state: { status: "completed" },
          },
        });
        expect(replacement.attemptNo).toBe(2);
      } finally {
        started.store.close();
      }
    });
  });

  it("shows ACP silence only on a running Agent target summary", async () => {
    await withRuntimeWorkspace("inspection-observation-acp-silence", async workspace => {
      const started = await startedAgent(workspace);
      try {
        const review = instance(started.store, started.runId, "review");
        const attempt = Object.values(throwingSchedulerStore(started.store.scheduler).loadRunSnapshot(started.runId).projection.attempts)
          .find(candidate => candidate.nodeKey === review.nodeKey && candidate.status === "started");
        if (!attempt) throw new Error("Expected started Agent attempt.");
        started.store.writeNodeProgress({
          runId: started.runId,
          nodeKey: review.nodeKey,
          nodeId: review.nodeId,
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          ownerEpoch: attempt.ownerEpoch,
          kind: "agent",
          status: "running",
          acpActivityAt: new Date(Date.now() - 14 * 60_000).toISOString(),
        });
        const selector = deriveOccurrenceRef(review.instancePath);

        const summary = await readInspection(workspace, {
          kind: "target", runId: started.runId, target: selector, detail: "summary",
        });
        expect(Result.isSuccess(summary) ? summary.success : undefined).toMatchObject({
          kind: "target",
          detail: "summary",
          acp: { silentForMs: expect.any(Number) },
        });
        const summaryView = Result.isSuccess(summary) && summary.success.kind === "target" && summary.success.detail === "summary"
          ? summary.success
          : undefined;
        expect(summaryView?.acp?.silentForMs).toBeGreaterThanOrEqual(14 * 60_000);

        const timeline = await readInspection(workspace, {
          kind: "target", runId: started.runId, target: selector, detail: "timeline",
        });
        expect(Result.isSuccess(timeline) ? timeline.success : undefined).not.toHaveProperty("acp");
        const root = await readInspection(workspace, {
          kind: "target", runId: started.runId, target: "root", detail: "summary",
        });
        expect(Result.isSuccess(root) ? root.success : undefined).not.toHaveProperty("acp");

        throwingSchedulerStore(started.store.scheduler).commitAttemptResult({
          runId: started.runId,
          attemptId: attempt.attemptId,
          ownerEpoch: started.claim.ownerEpoch,
          result: { status: "completed", output: { accepted: true } },
          idempotencyKey: "inspection-observation:acp-silence:complete",
        });
        const completed = await readInspection(workspace, {
          kind: "target", runId: started.runId, target: selector, detail: "summary",
        });
        expect(Result.isSuccess(completed) ? completed.success : undefined).toMatchObject({
          state: { status: "completed" },
          result: { status: "accepted", value: { accepted: true } },
        });
        expect(Result.isSuccess(completed) ? completed.success : undefined).not.toHaveProperty("pulse");
        expect(Result.isSuccess(completed) ? completed.success : undefined).not.toHaveProperty("acp");
      } finally {
        started.store.close();
      }
    });
  });

  it("projects one Agent activity truth across run, Summary, and Timeline views", async () => {
    vi.useFakeTimers();
    await withRuntimeWorkspace("inspection-observation-agent-activity", async workspace => {
      const started = await startedAgent(workspace);
      let releaseProvider!: () => void;
      const providerRelease = new Promise<void>(resolve => {
        releaseProvider = resolve;
      });
      let request!: AgentTurnRequest;
      let requestReady!: () => void;
      const ready = new Promise<void>(resolve => {
        requestReady = resolve;
      });
      type CaptureTerminal = { status: "completed" | "cancelled"; finalResponse?: string; snapshot: { responses: readonly string[]; summary: AgentTurnResult["summary"]; timing: AgentTurnResult["timing"] } };
      let capture: Promise<CaptureTerminal> | undefined;
      try {
        const review = instance(started.store, started.runId, "review");
        const attempt = Object.values(throwingSchedulerStore(started.store.scheduler).loadRunSnapshot(started.runId).projection.attempts)
          .find(candidate => candidate.nodeKey === review.nodeKey && candidate.status === "started");
        if (!attempt) throw new Error("Expected started Agent attempt.");
        const summary: AgentTurnResult["summary"] = {
          eventCount: 2,
          availability: { context: "unavailable", tokenUsage: "unavailable" },
          tools: { totalToolCallCount: 1, calls: [] },
        };
        capture = Effect.runPromise(started.store.observationLog.captureTurn({
          runId: started.runId,
          nodeId: review.nodeId,
          nodeKey: review.nodeKey,
          attemptId: attempt.attemptId,
          attemptNo: attempt.attemptNo,
          turn: 1,
          promptKind: "task",
        }, {
          agent: { kind: "named" as const, name: "mock" },
          prompt: "Review.",
          cwd: workspace,
          env: {},
          agentSessionId: attempt.attemptId,
          permissionMode: "deny-all" as const,
        }, value => Effect.promise(async (): Promise<CaptureTerminal> => {
          request = value;
          requestReady();
          await providerRelease;
          return {
            status: "completed",
            finalResponse: "done",
            snapshot: {
              responses: ["done"],
              summary,
              timing: {
                startedAt: "2026-08-03T00:00:00.000Z",
                finishedAt: "2026-08-03T00:00:03.000Z",
                elapsedMs: 3_000,
              },
            },
          };
        }), () => ({
          status: "cancelled",
          snapshot: {
            responses: [],
            summary,
            timing: {
              startedAt: "2026-08-03T00:00:00.000Z",
              finishedAt: "2026-08-03T00:00:00.000Z",
              elapsedMs: 0,
            },
          },
        })));
        await ready;
        const selector = deriveOccurrenceRef(review.instancePath);
        const observe = (
          sequence: number,
          payload: ObservationEventInput,
        ) => {
          const observedAt = `2026-08-03T00:00:0${sequence + 1}.000Z`;
          const projected = fixtureEvent({
            schemaVersion: 1,
            sequence,
            observedAt,
            elapsedMs: (sequence + 1) * 1_000,
            ...payload,
          } as FixtureObservationEvent);
          if (projected) request.onEvent?.({ sequence, observedAt, elapsedMs: (sequence + 1) * 1_000, event: projected });
        };

        const controller = new AbortController();
        const iterator = observeInspection(workspace, {
          view: { kind: "target", runId: started.runId, target: selector, detail: "timeline" },
          until: "subject-terminal",
          signal: controller.signal,
        })[Symbol.asyncIterator]();
        expect(observation(await iterator.next())).toMatchObject({
          kind: "attached",
          view: { detail: "timeline", current: { kind: "agent", phase: "starting" } },
        });
        const next = iterator.next();
        const activityController = new AbortController();
        const activityIterator = observeInspection(workspace, {
          view: { kind: "run", runId: started.runId },
          until: "subject-terminal",
          updates: "activity",
          signal: activityController.signal,
        })[Symbol.asyncIterator]();
        expect(observation(await activityIterator.next())).toMatchObject({ kind: "attached" });
        const activityNext = activityIterator.next();
        await vi.advanceTimersByTimeAsync(0);

        observe(0, { type: "message", channel: "thought", content: "Inspect the evidence." });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(observation(await activityNext)).toEqual({
          kind: "update",
          changes: [],
          activity: true,
        });
        activityController.abort();
        await expect(activityIterator.next()).resolves.toMatchObject({ done: true });
        let emitted = false;
        void next.then(() => { emitted = true; });
        await Promise.resolve();
        expect(emitted).toBe(false);

        const thoughtRead = await readInspection(workspace, { kind: "run", runId: started.runId });
        const thoughtView = Result.isSuccess(thoughtRead) && thoughtRead.success.kind === "run" ? thoughtRead.success : undefined;
        expect(inspectionTreeItem(thoughtView?.tree ?? [], selector)?.pulse).toEqual({
          phase: "reported-thought",
          turn: 1,
        });

        observe(1, {
          type: "tool",
          action: "update",
          toolCallId: "tool-1",
          toolName: "Bash",
          title: "Run focused checks",
          status: "completed",
          rawOutput: "passed",
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(observation(await next)).toMatchObject({
          kind: "update",
          changes: [],
          timeline: [
            { kind: "activity", channel: "reported-thought", summary: "Inspect the evidence." },
            { kind: "activity", channel: "tool", summary: "Bash" },
          ],
        });
        controller.abort();
        await expect(iterator.next()).resolves.toMatchObject({ done: true });

        const runRead = await readInspection(workspace, { kind: "run", runId: started.runId });
        const runView = Result.isSuccess(runRead) && runRead.success.kind === "run" ? runRead.success : undefined;
        expect(inspectionTreeItem(runView?.tree ?? [], selector)?.pulse).toEqual({
          phase: "tool",
          turn: 1,
          tool: { name: "Bash", title: "Run focused checks", state: "completed" },
        });

        const summaryRead = await readInspection(workspace, {
          kind: "target", runId: started.runId, target: selector, detail: "summary",
        });
        const summaryView = Result.isSuccess(summaryRead) && summaryRead.success.kind === "target" && summaryRead.success.detail === "summary"
          ? summaryRead.success
          : undefined;
        expect(summaryView).not.toHaveProperty("pulse");

        const timelineRead = await readInspection(workspace, {
          kind: "target", runId: started.runId, target: selector, detail: "timeline",
        });
        const timelineView = Result.isSuccess(timelineRead) && timelineRead.success.kind === "target" && timelineRead.success.detail === "timeline"
          ? timelineRead.success
          : undefined;
        expect(timelineView).not.toHaveProperty("current");
        expect(timelineView?.recent).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "activity", channel: "tool", summary: "Bash" }),
        ]));
      } finally {
        releaseProvider?.();
        await capture?.catch(() => {});
        started.store.close();
      }
    });
  });

  it("closes an exact attempt at its fence instead of migrating to the replacement", async () => {
    vi.useFakeTimers();
    await withRuntimeWorkspace("inspection-observation-exact-attempt-fence", async workspace => {
      const started = await startedAgent(workspace);
      try {
        const ref = deriveOccurrenceRef(instance(started.store, started.runId, "review").instancePath);
        const selector = `${ref}#1`;
        const iterator = observeInspection(workspace, {
          view: { kind: "target", runId: started.runId, target: selector, detail: "summary" },
          until: "subject-terminal",
        })[Symbol.asyncIterator]();

        expect(observation(await iterator.next())).toMatchObject({
          kind: "attached",
          view: { subject: { selector }, state: { status: "running" } },
        });

        const next = iterator.next();
        await vi.advanceTimersByTimeAsync(0);
        const replacedAttemptId = Object.values(throwingSchedulerStore(started.store.scheduler).loadRunSnapshot(started.runId).projection.attempts)
          .find(candidate => candidate.status === "started")?.attemptId;
        if (!replacedAttemptId) throw new Error("Expected started inspection observation Agent attempt.");
        const replacement = automaticallyReplaceAndComplete(workspace, started);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(observation(await next)).toMatchObject({
          kind: "closed",
          reason: "subject-terminal",
          view: {
            subject: { selector },
            state: { status: "cancelled" },
          },
        });
        expect(replacement.attemptNo).toBe(2);
        expect(replacement.attemptId).not.toBe(replacedAttemptId);
      } finally {
        started.store.close();
      }
    });
  });

  it("does not close a target decision boundary for an unrelated Signal", async () => {
    vi.useFakeTimers();
    await withRuntimeWorkspace("inspection-observation-unrelated-signal", async workspace => {
      const prepared = await bootstrappedRun(workspace, agentAndSignalWorkflow(), {});
      try {
        const review = instance(prepared.store, prepared.runId, "review");
        const approval = instance(prepared.store, prepared.runId, "approve");
        throwingSchedulerStore(prepared.store.scheduler).startAttempt({
          runId: prepared.runId,
          nodeKey: review.nodeKey,
          nodeId: review.nodeId,
          ownerEpoch: prepared.claim.ownerEpoch,
          idempotencyKey: "inspection-observation:review:start",
        });
        const controller = new AbortController();
        const iterator = observeInspection(workspace, {
          view: {
            kind: "target",
            runId: prepared.runId,
            target: deriveOccurrenceRef(review.instancePath),
            detail: "summary",
          },
          until: "decision-boundary",
          signal: controller.signal,
        })[Symbol.asyncIterator]();

        expect(observation(await iterator.next())).toMatchObject({ kind: "attached" });
        const next = iterator.next();
        await vi.advanceTimersByTimeAsync(0);
        awaitSignal(prepared.store, prepared.runId, prepared.claim, approval.nodeKey, approval.nodeId, "inspection-observation:approval:awaiting");
        await vi.advanceTimersByTimeAsync(1_000);

        let emitted = false;
        void next.then(() => { emitted = true; });
        await Promise.resolve();
        expect(emitted).toBe(false);

        controller.abort();
        await expect(next).resolves.toMatchObject({ done: true });
      } finally {
        prepared.store.close();
      }
    });
  });

  it("emits Agent completion while the observed run remains non-terminal", async () => {
    vi.useFakeTimers();
    await withRuntimeWorkspace("inspection-observation-agent-completion", async workspace => {
      const prepared = await bootstrappedRun(workspace, agentAndSignalWorkflow(), {});
      try {
        const scheduler = throwingSchedulerStore(prepared.store.scheduler);
        const review = instance(prepared.store, prepared.runId, "review");
        const approval = instance(prepared.store, prepared.runId, "approve");
        const attempt = scheduler.startAttempt({
          runId: prepared.runId,
          nodeKey: review.nodeKey,
          nodeId: review.nodeId,
          ownerEpoch: prepared.claim.ownerEpoch,
          idempotencyKey: "inspection-observation:completion:start",
        });
        awaitSignal(prepared.store, prepared.runId, prepared.claim, approval.nodeKey, approval.nodeId, "inspection-observation:completion:awaiting");
        const controller = new AbortController();
        const iterator = observeInspection(workspace, {
          view: { kind: "run", runId: prepared.runId },
          until: "subject-terminal",
          signal: controller.signal,
        })[Symbol.asyncIterator]();
        expect(observation(await iterator.next())).toMatchObject({ kind: "attached" });
        const next = iterator.next();
        await vi.advanceTimersByTimeAsync(0);

        scheduler.commitAttemptResult({
          runId: prepared.runId,
          attemptId: attempt.attemptId,
          ownerEpoch: prepared.claim.ownerEpoch,
          result: { status: "completed", output: { ok: true } },
          idempotencyKey: "inspection-observation:completion:complete",
        });
        await vi.advanceTimersByTimeAsync(1_000);

        const update = observation(await next);
        expect(update).toMatchObject({ kind: "update" });
        expect(update.kind === "update" ? update.changes : []).toEqual(expect.arrayContaining([
          expect.objectContaining({
            subject: { label: "review", kind: "agent", selector: expect.any(String) },
            state: expect.objectContaining({ status: "completed" }),
          }),
        ]));
        controller.abort();
        await expect(iterator.next()).resolves.toMatchObject({ done: true });
      } finally {
        prepared.store.close();
      }
    });
  });

  it.each(["race", "quorum"] as const)("does not close a %s target Signal while a sibling can still advance", async strategy => {
    await withRuntimeWorkspace(`inspection-observation-${strategy}-sibling`, async workspace => {
      const prepared = await bootstrappedRun(
        workspace,
        strategy === "race" ? parallelSignalRaceWorkflow() : quorumSignalWorkflow(),
        strategy === "race" ? {} : { items: ["first", "second"] },
      );
      try {
        const target = strategy === "race"
          ? instance(prepared.store, prepared.runId, "left_approve")
          : fanoutInstance(prepared.store, prepared.runId, "approve", 0);
        awaitSignal(prepared.store, prepared.runId, prepared.claim, target.nodeKey, target.nodeId, `inspection-observation:${strategy}:awaiting`);
        const selector = deriveOccurrenceRef(target.instancePath);
        const runView = await readInspection(workspace, {
          kind: "run", runId: prepared.runId,
        });
        const awaiting = Result.isSuccess(runView) && runView.success.kind === "run"
          ? inspectionTreeItem(runView.success.tree, selector)
          : undefined;
        expect(awaiting).toMatchObject({ state: { status: "awaiting" } });
        expect(awaiting?.attention).toBeUndefined();

        const targetSummary = await readInspection(workspace, {
          kind: "target", runId: prepared.runId, target: selector, detail: "summary",
        });
        const summaryView = Result.isSuccess(targetSummary) && targetSummary.success.kind === "target"
          ? targetSummary.success
          : undefined;
        expect(summaryView).toMatchObject({ state: { status: "awaiting" } });
        expect(summaryView?.detail === "summary" ? summaryView.attention : undefined).toBeUndefined();

        const targetTimeline = await readInspection(workspace, {
          kind: "target", runId: prepared.runId, target: selector, detail: "timeline",
        });
        const timelineView = Result.isSuccess(targetTimeline) && targetTimeline.success.kind === "target"
          ? targetTimeline.success
          : undefined;
        expect(timelineView).toMatchObject({ state: { status: "awaiting" } });
        expect(timelineView?.detail === "timeline" ? timelineView.current : undefined).toBeUndefined();

        const runController = new AbortController();
        const runIterator = observeInspection(workspace, {
          view: { kind: "run", runId: prepared.runId },
          until: "decision-boundary",
          signal: runController.signal,
        })[Symbol.asyncIterator]();
        expect(observation(await runIterator.next())).toMatchObject({ kind: "attached" });
        runController.abort();
        await expect(runIterator.next()).resolves.toMatchObject({ done: true });

        const rootController = new AbortController();
        const rootIterator = observeInspection(workspace, {
          view: { kind: "target", runId: prepared.runId, target: "root", detail: "summary" },
          until: "decision-boundary",
          signal: rootController.signal,
        })[Symbol.asyncIterator]();
        expect(observation(await rootIterator.next())).toMatchObject({
          kind: "attached",
          view: { subject: { label: "root" } },
        });
        rootController.abort();
        await expect(rootIterator.next()).resolves.toMatchObject({ done: true });

        const controller = new AbortController();
        const iterator = observeInspection(workspace, {
          view: {
            kind: "target",
            runId: prepared.runId,
            target: selector,
            detail: "summary",
          },
          until: "decision-boundary",
          signal: controller.signal,
        })[Symbol.asyncIterator]();

        expect(observation(await iterator.next())).toMatchObject({
          kind: "attached",
          view: { state: { status: "awaiting" } },
        });

        controller.abort();
        await expect(iterator.next()).resolves.toMatchObject({ done: true });
      } finally {
        prepared.store.close();
      }
    });
  });
});

type ObservedRun = {
  store: RuntimeStoreAdapter;
  runId: string;
  claim: RunOwnerClaim;
};

async function startedAgent(workspace: string): Promise<ObservedRun> {
  const prepared = await bootstrappedRun(workspace, agentWorkflow(), {});
  const review = instance(prepared.store, prepared.runId, "review");
  throwingSchedulerStore(prepared.store.scheduler).startAttempt({
    runId: prepared.runId,
    nodeKey: review.nodeKey,
    nodeId: review.nodeId,
    ownerEpoch: prepared.claim.ownerEpoch,
    idempotencyKey: "inspection-observation:agent:start",
  });
  return prepared;
}

async function bootstrappedRun(
  workspace: string,
  workflow: WorkflowDefinition<any, any>,
  input: JsonValue,
): Promise<ObservedRun> {
  const prepared = await prepareSyntheticWorkflow(workspace, workflow);
  const store = await openRuntimeStoreAdapter(workspace);
  try {
    const run = await admitRunForTest(store, { prepared, input, cwd: workspace });
    const claim = store.scheduler.claimRun(run.id, "inspection-observation", 60_000);
    if (!claim) throw new Error("Expected inspection observation test run claim.");
    const frozen = store.getFrozenRun(run.id);
    if (!frozen) throw new Error("Expected frozen inspection observation workflow.");
    const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(run.id);
    throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
      runId: run.id,
      expectedVersion: snapshot.version,
      ownerEpoch: claim.ownerEpoch,
      idempotencyKey: "inspection-observation:bootstrap",
      events: bootstrapRootEvents(run.id, frozen.ir, frozenRunScope(frozen)),
    });
    return { store, runId: run.id, claim };
  } catch (error) {
    store.close();
    throw error;
  }
}

function automaticallyReplaceAndComplete(workspace: string, started: ObservedRun) {
  dbRun(workspace, "UPDATE run_leases SET lease_expires_at = ? WHERE run_id = ?", new Date(Date.now() - 1_000).toISOString(), started.runId);
  const recovered = started.store.scheduler.claimRun(started.runId, "inspection-observation-recovery", 60_000);
  if (!recovered) throw new Error("Expected recovered inspection observation test run claim.");
  const scheduler = throwingSchedulerStore(started.store.scheduler);
  scheduler.markExpiredOwnerAttemptsSuperseded({
    runId: started.runId,
    currentOwnerEpoch: recovered.ownerEpoch,
    expiredOwnerEpoch: started.claim.ownerEpoch,
    expectedVersion: scheduler.loadRunSnapshot(started.runId).version,
  });
  const review = instance(started.store, started.runId, "review");
  const replacement = scheduler.startAttempt({
    runId: started.runId,
    nodeKey: review.nodeKey,
    nodeId: review.nodeId,
    ownerEpoch: recovered.ownerEpoch,
    idempotencyKey: "inspection-observation:replacement:start",
  });
  scheduler.commitAttemptResult({
    runId: started.runId,
    attemptId: replacement.attemptId,
    ownerEpoch: recovered.ownerEpoch,
    result: { status: "completed", output: { ok: true } },
    idempotencyKey: "inspection-observation:replacement:complete",
  });
  return replacement;
}

function awaitSignal(
  store: RuntimeStoreAdapter,
  runId: string,
  claim: RunOwnerClaim,
  nodeKey: string,
  nodeId: string,
  idempotencyKey: string,
): void {
  const scheduler = throwingSchedulerStore(store.scheduler);
  scheduler.appendSchedulerEvents({
    runId,
    expectedVersion: scheduler.loadRunSnapshot(runId).version,
    ownerEpoch: claim.ownerEpoch,
    idempotencyKey,
    events: [
      { type: "instance.awaiting", payload: { nodeKey, statusReason: "signal" } },
      { type: "signal.awaiting", payload: { runId, nodeKey, nodeId } },
    ],
  });
}

function instance(store: RuntimeStoreAdapter, runId: string, nodeId: string) {
  const value = Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).projection.instances)
    .find(candidate => candidate.nodeId === nodeId);
  if (!value) throw new Error(`Expected '${nodeId}' inspection observation instance.`);
  return value;
}

function fanoutInstance(store: RuntimeStoreAdapter, runId: string, nodeId: string, itemIndex: number) {
  const value = Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).projection.instances)
    .find(candidate => candidate.nodeId === nodeId
      && candidate.instancePath.some(segment => segment.kind === "fanout" && segment.itemIndex === itemIndex));
  if (!value) throw new Error(`Expected '${nodeId}' fanout item ${itemIndex} inspection observation instance.`);
  return value;
}

function inspectionTreeItem(
  entries: readonly InspectionTreeEntry[],
  selector: string,
): Extract<InspectionTreeEntry, { type: "item" }> | undefined {
  for (const entry of entries) {
    if (entry.type === "item" && entry.subject.selector === selector) return entry;
    const nested = inspectionTreeItem(entry.children, selector);
    if (nested) return nested;
  }
  return undefined;
}

function observation(result: IteratorResult<Result.Result<InspectionObservation, InspectionError>>): InspectionObservation {
  if (result.done || Result.isFailure(result.value)) throw new Error("Expected inspection observation to succeed.");
  return result.value.success;
}

function agentWorkflow() {
  return defineWorkflow({
    name: "inspection-observation-agent",
    agents: { reviewer: { use: "codex" } },
  }).build(({ agents, step }) => {
    step("review").agent({ agent: agents.reviewer, prompt: "Review." });
    return {};
  });
}

function agentAndSignalWorkflow() {
  return defineWorkflow({
    name: "inspection-observation-unrelated-signal",
    agents: { reviewer: { use: "codex" } },
  }).build(({ agents, step }) => {
    const branches = step("branches").parallel({
      strategy: "all",
      branches: {
        review() {
          step("review").agent({ agent: agents.reviewer, prompt: "Review." });
          return {};
        },
        approval() {
          const approval = step("approve").signal({
            outputSchema: z.object({ ok: z.boolean() }),
            prompt: "Approve.",
          });
          return { ok: approval.output.ok };
        },
      },
    });
    return { branches: branches.output };
  });
}

function quorumSignalWorkflow() {
  return defineWorkflow({
    name: "inspection-observation-quorum-signal",
    inputSchema: z.object({ items: z.array(z.string()) }),
  }).build(({ input, step }) => {
    const approvals = step("approvals").fanout({
      over: input.items,
      strategy: "quorum",
      count: 1,
      do() {
        const approval = step("approve").signal({
          outputSchema: z.object({ ok: z.boolean() }),
          prompt: "Approve.",
        });
        return { ok: approval.output.ok };
      },
    });
    return { approvals: approvals.output };
  });
}
