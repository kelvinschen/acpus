import { describe, expect, it } from "vitest";
import { getRun, getRunVisualizationSnapshot, inspectNode, listRuns } from "@acpus/runtime";
import { openExistingWritableRuntimeStore, openRuntimeStore } from "../src/store/store.js";
import {
  admitSyntheticWorkflow,
  failOnceTaskWorkflow,
  failingPureWorkflow,
  fanoutSignalWorkflow,
  missingProviderWorkflow,
  parallelSignalAllWorkflow,
  parallelSignalRaceWorkflow,
  prepareSyntheticWorkflow,
  runtimeRow,
  runtimeRows,
  scalarWorkflow,
  signalWorkflow,
  timedSignalWorkflow,
  withRuntimeWorkspace,
} from "./support/runtime-fixtures.js";
import { applySchedulerControlIntent } from "./support/scheduler.js";
import { admitRunForTest } from "./support/runtime-store.js";
import { advanceRun, controlRun, forkRun, signalRun, waitUntil } from "./support/runtime-controls.js";

describe.concurrent("runtime controls and recovery", () => {
  it("pauses, resumes, and applies retries to durable runs", async () => {
    await withRuntimeWorkspace("runtime-controls", async workspace => {
      const missingProvider = await admitSyntheticWorkflow(workspace, missingProviderWorkflow());
      expect(missingProvider.status).toBe("failed");
      expect(missingProvider.run).toMatchObject({ status: "failed" });

      const awaiting = await admitSyntheticWorkflow(workspace, signalWorkflow());
      expect(awaiting.status).toBe("awaiting");
      const runId = awaiting.run.id;

      await expect(controlRun(workspace, runId, "pause")).resolves.toMatchObject({ status: "paused" });
      await expect(controlRun(workspace, runId, "resume")).resolves.toMatchObject({ status: "awaiting" });
      await expect(controlRun(workspace, runId, "pause")).resolves.toMatchObject({ status: "paused" });

      const failed = await admitSyntheticWorkflow(workspace, failingPureWorkflow());
      expect(failed.status).toBe("failed");
      const failedId = failed.run.id;
      const failedRetry = await retryTarget(workspace, failedId);
      await expect(controlRun(workspace, failedId, "retry", failedRetry.target)).resolves.toMatchObject({ status: "failed" });
      expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = ?", failedId, retryEventType(failedRetry.kind))).toMatchObject({ count: 1 });
      expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'run.failed'", failedId)).toMatchObject({ count: 2 });

      const failOnce = await admitSyntheticWorkflow(workspace, failOnceTaskWorkflow(), { workDir: workspace });
      expect(failOnce.status).toBe("failed");
      const failOnceRetry = await retryTarget(workspace, failOnce.run.id);
      await expect(controlRun(workspace, failOnce.run.id, "retry", failOnceRetry.target)).resolves.toMatchObject({ status: "completed", output: { ok: true } });
      expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = ?", failOnce.run.id, retryEventType(failOnceRetry.kind))).toMatchObject({ count: 1 });
      expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'run.failed'", failOnce.run.id)).toMatchObject({ count: 1 });
      expect(runtimeRow(workspace, "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = 'run.completed'", failOnce.run.id)).toMatchObject({ count: 1 });

    });
  });


  it("signals parallel all and race branches through scheduler control", async () => {
    await withRuntimeWorkspace("runtime-signal-parallel", async workspace => {
      const all = await admitSyntheticWorkflow(workspace, parallelSignalAllWorkflow());
      expect(all.status).toBe("awaiting");
      await expect(signalRun(workspace, all.run.id, "left_approve", { ok: true })).resolves.toMatchObject({
        run: { status: "awaiting" },
      });
      await expect(signalRun(workspace, all.run.id, "right_approve", { ok: true })).resolves.toMatchObject({
        run: {
          status: "completed",
          output: { approvals: { left: { ok: true }, right: { ok: true } } },
        },
      });
      const fork = await forkRun(workspace, all.run.id);
      expect(fork.run.status).toBe("pending");
      expect(fork.run.output).toBeUndefined();
      await advanceRun(workspace, fork.run.id);
      expect((await getRun(workspace, fork.run.id))._unsafeUnwrap()).toMatchObject({
        status: "completed",
        output: { approvals: { left: { ok: true }, right: { ok: true } } },
      });

      const race = await admitSyntheticWorkflow(workspace, parallelSignalRaceWorkflow());
      expect(race.status).toBe("awaiting");
      await expect(signalRun(workspace, race.run.id, "left_approve", { ok: true })).resolves.toMatchObject({
        run: {
          status: "completed",
          output: { approval: { winner: "left", result: { ok: true } } },
        },
      });
      await expect(signalRun(workspace, race.run.id, "right_approve", { ok: true })).rejects.toThrow("target 'right_approve' was not found");
      const loser = runtimeRow(workspace, "SELECT node_key FROM signal_waits WHERE run_id = ? AND node_id = 'right_approve'", race.run.id);
      expect(runtimeRows(workspace, "SELECT node_id, status FROM signal_waits WHERE run_id = ? ORDER BY node_id", race.run.id)).toEqual([
        { node_id: "left_approve", status: "consumed" },
        { node_id: "right_approve", status: "cancelled" },
      ]);
      await expect(signalRun(workspace, race.run.id, String(loser!.node_key), { ok: true })).rejects.toThrow(`target '${String(loser!.node_key)}' was not found`);

      const raceFork = await forkRun(workspace, race.run.id);
      await advanceRun(workspace, raceFork.run.id);
      expect((await getRun(workspace, raceFork.run.id))._unsafeUnwrap()).toMatchObject({
        status: "completed",
        output: { approval: { winner: "left", result: { ok: true } } },
      });
      expect(runtimeRows(workspace, "SELECT node_id FROM signal_waits WHERE run_id = ?", raceFork.run.id)).toEqual([]);
    });
  });


  it("replays consumed signals by default and re-asks a targeted signal", async () => {
    await withRuntimeWorkspace("runtime-fork-signal-replay", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, signalWorkflow());
      await signalRun(workspace, source.run.id, "approve", { ok: true });

      const replayed = await forkRun(workspace, source.run.id);
      await advanceRun(workspace, replayed.run.id);
      expect((await getRun(workspace, replayed.run.id))._unsafeUnwrap()).toMatchObject({
        status: "completed",
        output: { ok: true },
      });
      expect(runtimeRows(workspace, "SELECT status FROM signal_waits WHERE run_id = ?", replayed.run.id)).toEqual([]);
      expect((await getRun(workspace, replayed.run.id))._unsafeUnwrap()?.dynamic?.nodeInstances).toEqual([
        expect.objectContaining({ reusedFromRunId: source.run.id }),
      ]);

      const targeted = await forkRun(workspace, source.run.id, { target: "approve" });
      await advanceRun(workspace, targeted.run.id);
      expect((await getRun(workspace, targeted.run.id))._unsafeUnwrap()).toMatchObject({ status: "awaiting" });
      await expect(signalRun(workspace, targeted.run.id, "approve", { ok: true })).resolves.toMatchObject({
        run: { status: "completed", output: { ok: true } },
      });
    });
  });


  it("replays only completed members when forking an active fanout-all", async () => {
    await withRuntimeWorkspace("runtime-fork-active-fanout", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, fanoutSignalWorkflow(), { items: ["a", "b", "c"] });
      const sourceWaits = runtimeRows(workspace, "SELECT node_key FROM signal_waits WHERE run_id = ? ORDER BY node_key", source.run.id);
      await signalRun(workspace, source.run.id, String(sourceWaits[0]!.node_key), { ok: true });

      const fork = await forkRun(workspace, source.run.id);
      await advanceRun(workspace, fork.run.id);

      const child = (await getRun(workspace, fork.run.id))._unsafeUnwrap();
      expect(child?.status).toBe("awaiting");
      expect(child?.dynamic?.nodeInstances.filter(instance => instance.nodeId === "approve" && instance.reusedFromRunId === source.run.id)).toHaveLength(1);
      const childWaits = runtimeRows(workspace, "SELECT node_key FROM signal_waits WHERE run_id = ? AND status = 'awaiting' ORDER BY node_key", fork.run.id);
      expect(childWaits).toHaveLength(2);
      await signalRun(workspace, fork.run.id, String(childWaits[0]!.node_key), { ok: true });
      await expect(signalRun(workspace, fork.run.id, String(childWaits[1]!.node_key), { ok: true })).resolves.toMatchObject({
        run: { status: "completed" },
      });
    });
  });


  it("signals dynamic fanout nodeKeys through scheduler control", async () => {
    await withRuntimeWorkspace("runtime-signal-dynamic", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, fanoutSignalWorkflow(), { items: ["a", "b"] });
      expect(awaiting.status).toBe("awaiting");
      const waits = runtimeRows(workspace, "SELECT node_key, node_id, status FROM signal_waits WHERE run_id = ? ORDER BY node_key", awaiting.run.id);
      expect(waits).toHaveLength(2);
      expect(waits).toEqual([
        expect.objectContaining({ node_id: "approve", status: "awaiting" }),
        expect.objectContaining({ node_id: "approve", status: "awaiting" }),
      ]);
      const run = (await getRun(workspace, awaiting.run.id))._unsafeUnwrap();
      expect(run?.dynamic?.nodeInstances.filter(instance => instance.nodeId === "approve" && instance.status === "awaiting")).toHaveLength(2);
      expect(run?.dynamic?.signalWaits.filter(wait => wait.nodeId === "approve" && wait.status === "awaiting")).toHaveLength(2);
      const snapshot = (await getRunVisualizationSnapshot(workspace, awaiting.run.id))._unsafeUnwrap();
      expect(snapshot?.overlay.workflow).toMatchObject({ name: "cli-fanout-signal", runId: awaiting.run.id, status: "awaiting" });
      expect(snapshot?.overlay.nodes.find(node => node.nodeId === "approve")).toMatchObject({
        kind: "signal",
        status: "awaiting",
        instances: expect.arrayContaining([
          expect.objectContaining({ nodeId: "approve", status: "awaiting" }),
          expect.objectContaining({ nodeId: "approve", status: "awaiting" }),
        ]),
      });
      expect(snapshot?.overlay.groups).toEqual([
        expect.objectContaining({
          nodeId: "approvals",
          kind: "fanout",
          status: "running",
          strategy: "all",
          members: expect.arrayContaining([
            expect.objectContaining({ memberKind: "fanout_item", status: "running" }),
            expect.objectContaining({ memberKind: "fanout_item", status: "running" }),
          ]),
        }),
      ]);

      await expect(signalRun(workspace, awaiting.run.id, "approve", { ok: true })).rejects.toThrow("ambiguous");
      await expect(signalRun(workspace, awaiting.run.id, String(waits[0]!.node_key), { ok: true })).resolves.toMatchObject({
        run: { status: "awaiting" },
      });
      await expect(signalRun(workspace, awaiting.run.id, "approve", { ok: true })).resolves.toMatchObject({
        run: { status: "completed" },
      });
    });
  });


  it("signals awaiting runs and rejects invalid signals without mutation", async () => {
    await withRuntimeWorkspace("runtime-signal", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, signalWorkflow());
      expect(awaiting.status).toBe("awaiting");
      const runId = awaiting.run.id;
      expect((await listRuns(workspace))._unsafeUnwrap()).toEqual([
        expect.objectContaining({ id: runId, status: "awaiting" }),
      ]);

      await expect(signalRun(workspace, runId, "approve", { ok: "yes" })).rejects.toMatchObject({
        failure: { type: "signal-payload-invalid", runId, target: "approve" },
      });

      await expect(controlRun(workspace, runId, "resume")).resolves.toMatchObject({ status: "awaiting" });

      const beforeMissingSignal = (await getRun(workspace, runId))._unsafeUnwrap();
      await expect(signalRun(workspace, runId, "missing", { ok: true })).rejects.toMatchObject({
        failure: { type: "signal-target-not-found", runId, target: "missing" },
      });
      const afterMissingSignal = (await getRun(workspace, runId))._unsafeUnwrap();
      expect(afterMissingSignal?.eventCount).toBe(beforeMissingSignal?.eventCount);
      expect(afterMissingSignal?.dynamic?.signalWaits).toEqual([
        expect.objectContaining({ status: "awaiting" }),
      ]);

      const signalPayload = { ok: true };
      const signalCommandIdempotencyKey = "signal:approve-command";
      await expect(signalRun(workspace, runId, "approve", signalPayload, signalCommandIdempotencyKey)).resolves.toMatchObject({
        run: { status: "completed", output: { ok: true } },
      });
      await expect(signalRun(workspace, runId, "approve", signalPayload, signalCommandIdempotencyKey)).resolves.toMatchObject({
        run: { status: "completed", output: { ok: true } },
      });
      const completedRun = (await getRun(workspace, runId))._unsafeUnwrap();
      expect(completedRun).toMatchObject({ status: "completed", output: { ok: true } });
      const consumedWait = completedRun?.dynamic?.signalWaits[0];
      expect(consumedWait).toMatchObject({
        status: "consumed",
        payload: signalPayload,
      });
      expect(consumedWait?.consumedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/));
    });
  });


  it("cancels a paused run before its root frame materializes", async () => {
    await withRuntimeWorkspace("runtime-cancel-paused-before-root", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, scalarWorkflow());
      const store = await openRuntimeStore(workspace);
      const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace })
        .finally(() => store.close());

      await expect(controlRun(workspace, run.id, "pause")).resolves.toMatchObject({ status: "paused" });
      expect((await getRunVisualizationSnapshot(workspace, run.id))._unsafeUnwrap()).toMatchObject({
        controls: { canCancelRun: true },
      });
      await expect(controlRun(workspace, run.id, "cancel")).resolves.toMatchObject({ status: "canceled" });
      expect(runtimeRows(
        workspace,
        "SELECT type FROM run_events WHERE run_id = ? AND type LIKE 'frame.%' ORDER BY sequence",
        run.id,
      )).toEqual([
        { type: "frame.started" },
        { type: "frame.cancelled" },
      ]);
    });
  });


  it("does not apply controls when another owner holds the run lease", async () => {
    await withRuntimeWorkspace("runtime-control-lease-conflict", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, signalWorkflow());
      const store = await openExistingWritableRuntimeStore(workspace);
      expect(store).toBeDefined();
      const claim = store!.scheduler.claimRun(awaiting.run.id, "other-owner", 30_000);
      expect(claim).toBeDefined();
      try {
        const result = await applySchedulerControlIntent(workspace, store!, {
          requestId: "lease-conflict",
          runId: awaiting.run.id,
          type: "cancel",
        }, { ownerId: "test-control-owner" });
        expect(result.advanced).toMatchObject({ status: "lease_lost" });
        expect(store!.getRun(awaiting.run.id)).toMatchObject({ status: "awaiting" });
      } finally {
        if (claim) store!.scheduler.releaseRun(claim);
        store?.close();
      }
    });
  });


  it("settles expired signal timeouts before validating late signal payloads", async () => {
    await withRuntimeWorkspace("runtime-signal-timeout-before-invalid-payload", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, timedSignalWorkflow());
      expect(awaiting.status).toBe("awaiting");
      const runId = awaiting.run.id;
      await waitUntil(() => {
        const row = runtimeRow(workspace, "SELECT deadline_at FROM signal_waits WHERE run_id = ?", runId) as { deadline_at?: string } | undefined;
        return typeof row?.deadline_at === "string" && Date.now() > Date.parse(row.deadline_at);
      });

      await expect(signalRun(workspace, runId, "approve", { ok: "yes" })).rejects.toThrow();
      expect((await getRun(workspace, runId))._unsafeUnwrap()).toMatchObject({ status: "failed" });
      expect(runtimeRows(workspace, "SELECT status, terminal_reason FROM signal_waits WHERE run_id = ?", runId)).toEqual([
        { status: "timed_out", terminal_reason: "signal_timeout" },
      ]);
    });
  });


  it("projects selected cancel only while the exact dynamic target is controllable", async () => {
    await withRuntimeWorkspace("runtime-selected-cancel-projection", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, signalWorkflow());
      const before = await inspectNode(workspace, {
        runId: awaiting.run.id,
        target: "approve",
      });
      expect(before.isOk()
        ? before.value.availableControls
        : undefined).toEqual([
        { type: "cancel", target: expect.any(String) },
      ]);
      const cancelTarget = before.isOk()
        ? before.value.availableControls[0]?.target
        : undefined;
      expect(cancelTarget).toEqual(
        before.isOk()
          ? before.value.summary.nodeKey
          : undefined,
      );

      await signalRun(workspace, awaiting.run.id, "approve", { ok: true });
      const after = await inspectNode(workspace, {
        runId: awaiting.run.id,
        target: "approve",
      });
      expect(after.isOk()
        ? after.value.availableControls
        : undefined).toEqual([]);
    });
  });

});

function retryEventType(kind: "node" | "frame"): "instance.retry_requested" | "frame.retry_requested" {
  return kind === "node" ? "instance.retry_requested" : "frame.retry_requested";
}

async function retryTarget(workspace: string, runId: string) {
  const snapshot = (await getRunVisualizationSnapshot(workspace, runId))._unsafeUnwrap();
  const target = snapshot?.controls.retryTargets[0];
  if (!target) throw new Error(`Expected one retry target for run '${runId}'.`);
  return target;
}
