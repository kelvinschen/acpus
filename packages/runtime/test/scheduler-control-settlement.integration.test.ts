import { admitRunForTest } from "./support/runtime-store.js";
import { defineWorkflow } from "@acpus/core";
import type { WorkflowIR } from "@acpus/core/ir";
import { describe, expect, it, vi } from "vitest";
import type { SchedulerEvent } from "../src/scheduler/events.js";
import { applySchedulerControlIntent } from "../src/scheduler/control.js";
import { settleFrozenRunTransitions } from "../src/scheduler/runtime-runner.js";
import type { SchedulerProjection } from "../src/scheduler/types.js";
import { throwSchedulerStoreResult } from "../src/scheduler/store-port.js";
import { openRuntimeStore } from "../src/store/store.js";
import { prepareSyntheticWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

const materializeMocks = vi.hoisted(() => ({
  continueRootEvents: vi.fn(),
}));

vi.mock("../src/scheduler/materialize.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/scheduler/materialize.js")>(),
  continueRootEvents: materializeMocks.continueRootEvents,
}));

describe("scheduler control settlement", () => {
  it.each([
    { type: "pause", status: "paused", versionDelta: 1 },
    { type: "cancel", status: "canceled", versionDelta: 3 },
  ] as const)(
    "$type durably fences the run before a long derived chain",
    async ({ type, status, versionDelta }) => {
      mockProgressingLoop();

      await withRuntimeWorkspace(`scheduler-control-${type}-before-derived`, async workspace => {
        const prepared = await prepareSyntheticWorkflow(workspace, trivialWorkflow());
        const store = await openRuntimeStore(workspace);
        let claim: ReturnType<typeof store.scheduler.claimRun> = undefined;
        try {
          const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
          claim = store.scheduler.claimRun(run.id, `${type}-owner`, 60_000);
          if (!claim) throw new Error("expected scheduler claim");
          const seeded = seedProgressingLoop(store, run.id, claim.ownerEpoch);

          const applied = applySchedulerControlIntent(store, {
            requestId: `${type}:${run.id}`,
            runId: run.id,
            type,
          }, claim.ownerEpoch)._unsafeUnwrap();

          expect(applied.snapshot.version).toBe(seeded.version + versionDelta);
          expect(applied.snapshot.projection.run.status).toBe(status);
          expect(applied.snapshot.projection.frames.loop?.loop?.iter).toBe(0);
          expect(materializeMocks.continueRootEvents).not.toHaveBeenCalled();
        } finally {
          if (claim) store.scheduler.releaseRun(claim);
          store.close();
        }
      });
    },
  );

  it("drains more than 1000 derived transitions after a due Signal before pause", async () => {
    mockProgressingLoop({ failRunAfterSignalTimeout: true });

    await withRuntimeWorkspace("scheduler-control-due-signal-large-progress", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, trivialWorkflow());
      const store = await openRuntimeStore(workspace);
      let claim: ReturnType<typeof store.scheduler.claimRun> = undefined;
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        claim = store.scheduler.claimRun(run.id, "signal-timeout-owner", 60_000);
        if (!claim) throw new Error("expected scheduler claim");
        const seeded = seedProgressingLoop(store, run.id, claim.ownerEpoch);
        const awaiting = throwSchedulerStoreResult(store.scheduler.tryAppendSchedulerEvents({
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
          expectedVersion: seeded.version,
          idempotencyKey: `test:signal-awaiting:${run.id}`,
          events: [
            {
              type: "instance.ready",
              payload: {
                runId: run.id,
                nodeKey: "approve",
                nodeId: "approve",
                instancePath: [{ kind: "node", nodeId: "approve" }],
                parentFrameKey: "root",
                readinessSequence: 1,
              },
            },
            { type: "instance.awaiting", payload: { nodeKey: "approve", statusReason: "signal" } },
            {
              type: "signal.awaiting",
              payload: { runId: run.id, nodeKey: "approve", nodeId: "approve", deadlineAt: "2026-07-01T00:00:00.000Z" },
            },
          ],
        }));

        expect(() => throwSchedulerStoreResult(store.scheduler.tryPauseRun({
          runId: run.id,
          ownerEpoch: claim!.ownerEpoch,
          idempotencyKey: `test:pause-after-signal-timeout:${run.id}`,
          now: new Date("2026-07-01T00:00:01.000Z"),
        }))).toThrow("Cannot pause failed run.");

        const settled = throwSchedulerStoreResult(store.scheduler.tryLoadRunSnapshot(run.id));
        expect(settled.version).toBeGreaterThan(awaiting.version + 1_000);
        expect(settled.projection.signalWaits.approve).toMatchObject({ status: "timed_out", terminalReason: "signal_timeout" });
        expect(settled.projection.frames.loop).toMatchObject({ status: "failed", loop: { iter: 1_001 } });
        expect(settled.projection.run.status).toBe("failed");
      } finally {
        if (claim) store.scheduler.releaseRun(claim);
        store.close();
      }
    });
  });

  it("settles more than 1000 progressing derived batches", async () => {
    mockProgressingLoop();

    await withRuntimeWorkspace("scheduler-control-settlement-large-progress", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, trivialWorkflow());
      const store = await openRuntimeStore(workspace);
      let claim: ReturnType<typeof store.scheduler.claimRun> = undefined;
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        claim = store.scheduler.claimRun(run.id, "control-owner", 60_000);
        if (!claim) throw new Error("expected scheduler claim");
        const seeded = seedProgressingLoop(store, run.id, claim.ownerEpoch);

        const settled = settleFrozenRunTransitions({ store, runId: run.id, ownerEpoch: claim.ownerEpoch });

        expect(settled.version).toBe(seeded.version + 1_001);
        expect(settled.projection.frames.loop?.loop?.iter).toBe(1_001);
      } finally {
        if (claim) store.scheduler.releaseRun(claim);
        store.close();
      }
    });
  });
});

function mockProgressingLoop(options: { failRunAfterSignalTimeout?: boolean } = {}): void {
  materializeMocks.continueRootEvents.mockClear();
  materializeMocks.continueRootEvents.mockImplementation((
    _ir: WorkflowIR,
    projection: SchedulerProjection,
  ): SchedulerEvent[] => {
    const iteration = projection.frames.loop?.loop?.iter;
    if (iteration === undefined || iteration >= 1_001) {
      if (options.failRunAfterSignalTimeout
        && iteration === 1_001
        && projection.signalWaits.approve?.status === "timed_out"
        && projection.frames.root?.status === "running") {
        const error = { reason: "signal_timeout" };
        return [
          { type: "frame.failed", payload: { frameKey: "loop", error, terminalReason: "signal_timeout" } },
          { type: "frame.failed", payload: { frameKey: "root", error, terminalReason: "signal_timeout" } },
        ];
      }
      return [];
    }
    const next = iteration + 1;
    return [{
      type: "frame.loop_advanced",
      payload: {
        frameKey: "loop",
        iter: next,
        state: next,
        transition: { state: next + 1, stop: false },
      },
    }];
  });
}

function seedProgressingLoop(
  store: Awaited<ReturnType<typeof openRuntimeStore>>,
  runId: string,
  ownerEpoch: number,
) {
  const initial = throwSchedulerStoreResult(store.scheduler.tryLoadRunSnapshot(runId));
  return throwSchedulerStoreResult(store.scheduler.tryAppendSchedulerEvents({
    runId,
    ownerEpoch,
    expectedVersion: initial.version,
    idempotencyKey: `test:seed:${runId}`,
    events: [
      { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root" } },
      { type: "frame.started", payload: { runId, frameKey: "loop", frameKind: "loop", parentFrameKey: "root" } },
      { type: "frame.loop_advanced", payload: { frameKey: "loop", iter: 0, state: 0, transition: { state: 1, stop: false } } },
    ],
  }));
}

function trivialWorkflow() {
  return defineWorkflow({ name: "scheduler-control-settlement-large-progress" }).build(({ step }) => {
    step("noop").assert({ condition: true });
    return {};
  });
}
