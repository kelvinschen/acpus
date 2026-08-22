import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { admitRunForTest } from "./support/runtime-store.js";
import { access, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineWorkflow, z } from "@acpus/core";
import type { Sha256Digest } from "@acpus/core/content-identity";
import { describe, expect, it } from "vitest";
import {
  daemonEndpoint,
  requestDaemonControl as requestDaemonControlResult,
  requestDaemonShutdown as requestDaemonShutdownResult,
  requestDaemonStatus as requestDaemonStatusResult,
} from "../src/daemon/client.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonClientFailure } from "../src/daemon/protocol.js";
import { getRun } from "../src/runs/use-cases.js";
import { startDaemonLoop } from "./support/daemon-loop.js";
import { runRuntimeTick } from "../src/daemon/tick.js";
import type { HookJournalEntry } from "../src/hooks/journal.js";
import { applySchedulerControlIntent } from "../src/scheduler/control.js";
import type { SchedulerEvent } from "../src/scheduler/events.js";
import { bootstrapRootEvents } from "../src/scheduler/materialize.js";
import { ancestorGroupMembersForNode } from "../src/scheduler/membership.js";
import { settleFrozenRunTransitions } from "../src/scheduler/runtime-runner.js";
import { frozenRunScope } from "../src/scheduler/settle.js";
import { cancellationEventsForNode, nextGroupCompletionBatchEvents } from "../src/scheduler/group-policy.js";
import { applySchedulerEvents } from "../src/scheduler/transitions.js";
import { openRuntimeStoreAdapter, type RunDetails, type RuntimeStoreAdapter } from "../src/store/store.js";
import { makeRuntimeStoreService } from "../src/store/service.js";
import { initializeRuntimeStoreForTest, admitSyntheticWorkflow, fanoutSignalWorkflow, parallelSignalAllWorkflow, preparedWorkflow, prepareSyntheticWorkflow, runtimeDatabasePath, runtimeRow, runtimeRows, runtimeRunsRoot, signalWorkflow, taskArtifactWorkflow, timedSignalWorkflow, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { submitRunThroughDaemon } from "./support/daemon-submit.js";

function runTick(store: RuntimeStoreAdapter, options: {
  startSession: (runId: string) => "started" | "already-active" | "terminal" | "quarantined";
  dispatchHooks?: (runId: string) => "dispatched" | "retry" | "quarantined";
}) {
  return Effect.runPromise(runRuntimeTick(makeRuntimeStoreService(store), {
    startSession: runId => Effect.sync(() => options.startSession(runId)),
    ...(options.dispatchHooks === undefined
      ? {}
      : { dispatchHooks: (runId: string) => Effect.sync(() => options.dispatchHooks!(runId)) }),
  }));
}

async function requestDaemonControl(...args: Parameters<typeof requestDaemonControlResult>) {
  return unwrapDaemon(await Effect.runPromise(Effect.result(requestDaemonControlResult(...args))));
}

async function requestDaemonShutdown(...args: Parameters<typeof requestDaemonShutdownResult>) {
  return unwrapDaemon(await Effect.runPromise(Effect.result(requestDaemonShutdownResult(...args))));
}

async function requestDaemonStatus(...args: Parameters<typeof requestDaemonStatusResult>) {
  return unwrapDaemon(await Effect.runPromise(Effect.result(requestDaemonStatusResult(...args))));
}

function unwrapDaemon<T>(result: Result.Result<T, DaemonClientFailure>): T {
  if (Result.isSuccess(result)) return result.success;
  throw Object.assign(new Error(result.failure.message), result.failure.type === "rejected" ? { code: result.failure.code } : {});
}

describe.concurrent("runtime daemon ticks", () => {
  it("admits runs only after registering daemon-owned execution", async () => {
    await withRuntimeWorkspace("runtime-daemon-admit-ownership", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      await initializeRuntimeStoreForTest(workspace);
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 60_000,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      try {
        expect(await requestDaemonStatus(workspace)).toMatchObject({
          protocolVersion: DAEMON_PROTOCOL_VERSION,
        });
        const admitted = await submitRunThroughDaemon(workspace, {
          prepared,
          input: { ready: true },
        });

        expect(admitted).toMatchObject({
          name: "cli-valid",
          input: { ready: true },
        });
        expect(runtimeRows(workspace, "SELECT id FROM runs WHERE id = ?", admitted.id)).toEqual([{ id: admitted.id }]);
        const terminal = await waitForTerminalRun(workspace, admitted.id);

        expect(terminal).toMatchObject({
          status: "completed",
          run: {
            id: admitted.id,
            status: "completed",
            output: { ready: true },
          },
        });
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("rejects daemon admission when prepared IR and IR JSON diverge", async () => {
    await withRuntimeWorkspace("runtime-daemon-admit-ir-mismatch", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      await initializeRuntimeStoreForTest(workspace);
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 60_000,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      try {
        await expect(submitRunThroughDaemon(workspace, {
          prepared: {
            ...prepared,
            irJson: `${JSON.stringify({ ...prepared.ir, name: "different" })}\n`,
          },
          input: { ready: true },
        })).rejects.toMatchObject({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("does not match prepared IR"),
        });
        const invalidIr = { ...prepared.ir, irVersion: 6 } as any;
        await expect(submitRunThroughDaemon(workspace, {
          prepared: preparedWorkflow(invalidIr, join(workspace, prepared.source.entry), workspace),
          input: { ready: true },
        })).rejects.toMatchObject({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("WorkflowIR irVersion must be 8"),
        });
        expect(runtimeRows(workspace, "SELECT id FROM runs")).toEqual([]);
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("rejects malformed prepared workflow locks at the daemon socket boundary", async () => {
    await withRuntimeWorkspace("runtime-daemon-admit-malformed-lock", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      await initializeRuntimeStoreForTest(workspace);
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 60_000,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      try {
        const malformed = [
          {
            ...prepared,
            lock: {
              ...prepared.lock,
              workflow: { source: prepared.lock.workflow.source },
            },
          },
          {
            ...prepared,
            lock: {
              ...prepared.lock,
              ir: { ...prepared.lock.ir, path: "workflow.json" },
            },
          },
          {
            ...prepared,
            lock: {
              ...prepared.lock,
              generatedAt: "2026-07-11T00:00:00.000Z",
            },
          },
        ];
        for (const candidate of malformed) {
          await expect(submitRunThroughDaemon(workspace, {
            prepared: candidate as unknown as typeof prepared,
            input: { ready: true },
          })).rejects.toMatchObject({
            code: "INVALID_REQUEST",
            message: "Invalid daemon submission request.",
          });
        }
        expect(runtimeRows(workspace, "SELECT id FROM runs")).toEqual([]);
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("rejects inconsistent prepared workflow lock digests before admission", async () => {
    await withRuntimeWorkspace("runtime-daemon-admit-inconsistent-lock", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const otherDigest: Sha256Digest = `sha256:${"a".repeat(64)}`;
      const thirdDigest: Sha256Digest = `sha256:${"b".repeat(64)}`;
      await initializeRuntimeStoreForTest(workspace);
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 60_000,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      try {
        const inconsistent = [
          {
            candidate: { ...prepared, lock: { ...prepared.lock, sourceGraphDigest: otherDigest } },
            message: "lock source graph digest",
          },
          {
            candidate: { ...prepared, packageLockDigest: otherDigest },
            message: "lock package lock digest",
          },
          {
            candidate: { ...prepared, packageLockDigest: otherDigest, lock: { ...prepared.lock, packageLockDigest: thirdDigest } },
            message: "lock package lock digest",
          },
          {
            candidate: {
              ...prepared,
              lock: {
                ...prepared.lock,
                workflow: {
                  ...prepared.lock.workflow,
                  source: { kind: "workspace" as const, entry: "other.workflow.ts" },
                },
              },
            },
            message: "lock source",
          },
        ];
        for (const { candidate, message } of inconsistent) {
          await expect(submitRunThroughDaemon(workspace, {
            prepared: candidate,
            input: { ready: true },
          })).rejects.toMatchObject({
            code: "INVALID_REQUEST",
            message: expect.stringContaining(message),
          });
        }
        expect(runtimeRows(workspace, "SELECT id FROM runs")).toEqual([]);
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("rejects an inconsistent replacement fork lock before creating the fork", async () => {
    await withRuntimeWorkspace("runtime-daemon-fork-inconsistent-lock", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      await initializeRuntimeStoreForTest(workspace);
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 60_000,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      try {
        const source = await submitRunThroughDaemon(workspace, { prepared, input: { ready: true } });
        await expect(requestDaemonControl(workspace, {
          requestId: "fork-inconsistent-lock",
          type: "fork",
          runId: source.id,
          prepared: {
            ...prepared,
            packageLockDigest: `sha256:${"a".repeat(64)}`,
          },
        })).rejects.toMatchObject({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("lock package lock digest"),
        });
        expect(runtimeRows(workspace, "SELECT id FROM runs WHERE id != ?", source.id)).toEqual([]);
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("marks only a repeated authored fork target as an ambiguity at the daemon boundary", async () => {
    await withRuntimeWorkspace("runtime-daemon-fork-target-ambiguity", async workspace => {
      const source = await admitSyntheticWorkflow(workspace, fanoutSignalWorkflow(), { items: ["a", "b"] });
      expect(source.status).toBe("awaiting");
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 60_000,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      try {
        const ambiguous = await Effect.runPromise(Effect.result(requestDaemonControlResult(workspace, {
          requestId: "fork-repeated-authored-target",
          type: "fork",
          runId: source.run.id,
          target: "approve",
        })));
        expect(Result.isFailure(ambiguous)).toBe(true);
        if (Result.isFailure(ambiguous)) {
          expect(ambiguous.failure).toMatchObject({
            type: "rejected",
            code: "RUN_NOT_CONTROLLABLE",
            ambiguity: true,
          });
        }

        const missing = await Effect.runPromise(Effect.result(requestDaemonControlResult(workspace, {
          requestId: "fork-missing-target",
          type: "fork",
          runId: source.run.id,
          target: "missing",
        })));
        expect(Result.isFailure(missing)).toBe(true);
        if (Result.isFailure(missing)) {
          expect(missing.failure).toMatchObject({
            type: "rejected",
            code: "RUN_NOT_CONTROLLABLE",
          });
          expect(missing.failure).not.toHaveProperty("ambiguity");
        }
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("rejects manual shutdown while another client request is active", async () => {
    await withRuntimeWorkspace("runtime-daemon-shutdown-active-connection", async workspace => {
      await initializeRuntimeStoreForTest(workspace);
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 60_000,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      const socket = connect(daemonEndpoint(workspace));
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        });
        await expect(requestDaemonShutdown(workspace)).rejects.toMatchObject({
          code: "CONTROL_CONFLICT",
        });
      } finally {
        socket.destroy();
        await loop.shutdown();
      }
    });
  });

  it("releases its lease after a continuous idle window", async () => {
    await withRuntimeWorkspace("runtime-daemon-idle-stop", async workspace => {
      let resolveShutdown!: () => void;
      const shutdown = new Promise<void>(resolve => {
        resolveShutdown = resolve;
      });
      await initializeRuntimeStoreForTest(workspace);
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 5,
        idleStopMs: 10,
        packageVersion: "test",
        onShutdown: resolveShutdown,
      });
      await shutdown;

      expect(runtimeRows(
        workspace,
        "SELECT epoch FROM runtime_authority WHERE released_at IS NULL",
      )).toEqual([]);
      await loop.shutdown();
    });
  });

  it("closes instead of silently retrying a corrupted durable deadline", async () => {
    await withRuntimeWorkspace("runtime-daemon-corrupted-deadline", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      let runId: string;
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        runId = run.id;
        appendTimedSignalWait(store, run.id, "2099-01-01T00:00:00.000Z");
      } finally {
        store.close();
      }
      const db = new DatabaseSync(runtimeDatabasePath(workspace));
      try {
        db.prepare("UPDATE signal_waits SET deadline_at = 'not-a-deadline' WHERE run_id = ?").run(runId!);
      } finally {
        db.close();
      }
      let resolveShutdown!: () => void;
      const shutdown = new Promise<void>(resolve => {
        resolveShutdown = resolve;
      });
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 5,
        idleStopMs: 60_000,
        packageVersion: "test",
        onShutdown: resolveShutdown,
      });

      await shutdown;

      expect(runtimeRows(
        workspace,
        "SELECT epoch FROM runtime_authority WHERE released_at IS NULL",
      )).toEqual([]);
      await expect(requestDaemonStatus(workspace)).rejects.toThrow();
      await loop.shutdown();
    });
  });

  it("persists daemon idle state in runtime diagnostics", async () => {
    await withRuntimeWorkspace("runtime-daemon-idle-diagnostics", async workspace => {
      await initializeRuntimeStoreForTest(workspace);
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 5,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      try {
        await waitUntil(() => {
          const row = runtimeRow(workspace, "SELECT idle_since_at, idle_stop_ms FROM runtime_authority") as { idle_since_at: string | null; idle_stop_ms: number | null } | undefined;
          return row !== undefined && row.idle_since_at !== null && row.idle_stop_ms === 60_000;
        });
        const store = await openRuntimeStoreAdapter(workspace);
        try {
          expect(store.getRuntimeDiagnostics().authority).toMatchObject({
            idleSinceAt: expect.any(String),
            idleStopMs: 60_000,
          });
        } finally {
          store.close();
        }
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("cleans stale staging once at startup and preserves committed run directories", async () => {
    await withRuntimeWorkspace("runtime-daemon-cleanup", async workspace => {
      const completed = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const runsRoot = runtimeRunsRoot(workspace);
      const stale = join(runsRoot, ".staging-old");
      const fresh = join(runsRoot, ".staging-fresh");
      const late = join(runsRoot, ".staging-late");
      await mkdir(stale, { recursive: true });
      await mkdir(fresh, { recursive: true });
      await writeFile(join(stale, "leftover.txt"), "staged");
      const old = new Date(Date.now() - 120_000);
      await utimes(stale, old, old);

      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 5,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      try {
        await expect(access(stale)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(access(fresh)).resolves.toBeUndefined();
        await expect(access(join(runsRoot, completed.run.id))).resolves.toBeUndefined();

        await mkdir(late);
        await utimes(late, old, old);
        const probeStore = await openRuntimeStoreAdapter(workspace);
        try {
          probeStore.writeHookJournal(hookJournalEntry(completed.run.id, "startup-cleanup-probe", "2000-01-01T00:00:00.000Z"));
        } finally {
          probeStore.close();
        }
        await waitUntil(() => runtimeRows(workspace, "SELECT handler_id FROM hook_journal WHERE handler_id = ?", "startup-cleanup-probe").length === 0);
        await expect(access(late)).resolves.toBeUndefined();
      } finally {
        await loop.shutdown();
      }

      expect(runtimeRows(workspace, "SELECT id FROM runs")).toEqual([{ id: completed.run.id }]);
    });
  });

  it("rejects an orphan final run directory at startup without deleting it", async () => {
    await withRuntimeWorkspace("runtime-daemon-orphan-run", async workspace => {
      const initialized = await openRuntimeStoreAdapter(workspace);
      initialized.close();
      const orphan = join(runtimeRunsRoot(workspace), "20990101000000F2CF49A02B2A537F5E8A");
      const sentinel = join(orphan, "sentinel.txt");
      await mkdir(orphan, { recursive: true });
      await writeFile(sentinel, "uncommitted publication");

      await expect(startDaemonLoop(workspace, {
        heartbeatMs: 5,
        idleStopMs: 60_000,
        packageVersion: "test",
      })).rejects.toThrow();

      await expect(readFile(sentinel, "utf8")).resolves.toBe("uncommitted publication");
      expect(runtimeRows(
        workspace,
        "SELECT epoch FROM runtime_authority WHERE released_at IS NULL",
      )).toEqual([]);
      await expect(requestDaemonStatus(workspace)).rejects.toThrow();
    });
  });

  it("treats timed signal waits as daemon work without starting future deadlines", async () => {
    await withRuntimeWorkspace("runtime-daemon-signal-timeout-work", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        appendTimedSignalWait(store, run.id, "2099-01-01T00:00:00.000Z");

        expect(store.listRuntimeWork(new Date("2026-07-01T00:00:00.000Z"))).toMatchObject({
          startableRuns: [],
          idleBlockers: 2,
        });

        const started: string[] = [];
        await expect(runTick(store, { startSession: runId => {
          started.push(runId);
          return "started";
        } })).resolves.toMatchObject({
          runs: 0,
          idleBlockers: 2,
        });
        expect(started).toEqual([]);
      } finally {
        store.close();
      }
    });
  });

  it("starts runs with due signal timeout work", async () => {
    await withRuntimeWorkspace("runtime-daemon-signal-timeout-due", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        appendTimedSignalWait(store, run.id, "2000-01-01T00:00:00.000Z");

        const started: string[] = [];
        await expect(runTick(store, { startSession: runId => {
          started.push(runId);
          return "started";
        } })).resolves.toMatchObject({
          runs: 1,
          idleBlockers: 2,
        });
        expect(started).toEqual([run.id]);
      } finally {
        store.close();
      }
    });
  });

  it.each([
    { label: "cancelled all", strategy: "all", kind: "parallel", terminal: "cancelled" },
    { label: "failed all", strategy: "all", kind: "parallel", terminal: "failed" },
    { label: "completed race", strategy: "race", kind: "parallel", terminal: "completed" },
    { label: "reached quorum", strategy: "quorum", kind: "fanout", terminal: "completed" },
  ] as const)("restarts an awaiting run with a reconcilable $label group", async groupCase => {
    await withRuntimeWorkspace(`runtime-daemon-awaiting-group-reconciliation-${groupCase.strategy}-${groupCase.terminal}`, async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const initial = await openRuntimeStoreAdapter(workspace);
      const run = await admitRunForTest(initial, { prepared, input: { ready: true }, cwd: workspace });
      appendAwaitingStuckGroup(initial, run.id, groupCase);
      expect(initial.getRun(run.id)?.status).toBe("awaiting");
      initial.close();

      const reopened = await openRuntimeStoreAdapter(workspace);
      try {
        expect(reopened.listRuntimeWork(new Date("2026-07-01T00:00:00.000Z")).startableRuns.map(candidate => candidate.id)).toContain(run.id);
        const started: string[] = [];
        await expect(runTick(reopened, { startSession: runId => {
          started.push(runId);
          return "started";
        } })).resolves.toMatchObject({ runs: 1 });
        expect(started).toContain(run.id);
      } finally {
        reopened.close();
      }
    });
  });

  it("restarts an awaiting run after group termination was persisted before frame propagation", async () => {
    await withRuntimeWorkspace("runtime-daemon-terminal-group-frame-reconciliation", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, parallelSignalAllWorkflow());
      const initial = await openRuntimeStoreAdapter(workspace);
      const claim = initial.scheduler.claimRun(awaiting.run.id, "terminal-group-owner", 60_000);
      if (!claim) throw new Error("failed to claim terminal-group test run");
      const snapshot = throwingSchedulerStore(initial.scheduler).loadRunSnapshot(awaiting.run.id);
      const nodeKey = Object.values(snapshot.projection.signalWaits)[0]?.nodeKey;
      if (!nodeKey) throw new Error("parallel signal run has no awaiting node");
      const cancellation = cancellationEventsForNode(snapshot.projection, nodeKey, "operator_cancelled");
      const groupTerminal = nextGroupCompletionBatchEvents(applySchedulerEvents(snapshot.projection, cancellation));
      throwingSchedulerStore(initial.scheduler).appendSchedulerEvents({
        runId: awaiting.run.id,
        expectedVersion: snapshot.version,
        ownerEpoch: claim.ownerEpoch,
        idempotencyKey: "daemon-terminal-group-before-frame",
        events: [
          ...cancellation,
          ...groupTerminal,
          { type: "instance.ready", payload: { runId: awaiting.run.id, nodeKey: "external.wait", nodeId: "external_wait", parentFrameKey: "root", instancePath: [] } },
          { type: "instance.awaiting", payload: { nodeKey: "external.wait", statusReason: "signal" } },
          { type: "signal.awaiting", payload: { runId: awaiting.run.id, nodeKey: "external.wait", nodeId: "external_wait" } },
        ],
      });
      initial.scheduler.releaseRun(claim);
      expect(initial.getRun(awaiting.run.id)?.status).toBe("awaiting");
      initial.close();

      const reopened = await openRuntimeStoreAdapter(workspace);
      try {
        expect(reopened.listRuntimeWork().startableRuns.map(run => run.id)).toContain(awaiting.run.id);
        const recoveryClaim = reopened.scheduler.claimRun(awaiting.run.id, "terminal-group-recovery", 60_000);
        if (!recoveryClaim) throw new Error("failed to claim terminal-group recovery");
        await Effect.runPromise(settleFrozenRunTransitions({
          store: makeRuntimeStoreService(reopened),
          runId: awaiting.run.id,
          ownerEpoch: recoveryClaim.ownerEpoch,
        }));
        reopened.scheduler.releaseRun(recoveryClaim);
        expect(reopened.getRun(awaiting.run.id)?.status).toBe("failed");
        expect(reopened.listRuntimeWork().startableRuns.map(run => run.id)).not.toContain(awaiting.run.id);
      } finally {
        reopened.close();
      }
    });
  });

  it("does not restart an awaiting group that has terminal members but no derivable transition", async () => {
    await withRuntimeWorkspace("runtime-daemon-group-reconciliation-no-spin", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, fanoutSignalWorkflow(), { items: ["a", "b"] });
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const claim = store.scheduler.claimRun(awaiting.run.id, "partial-fanout-owner", 60_000);
        if (!claim) throw new Error("failed to claim partial fanout run");
        const wait = Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(awaiting.run.id).projection.signalWaits)[0];
        if (!wait) throw new Error("fanout signal run has no awaiting node");
        const result = await Effect.runPromise(Effect.result(applySchedulerControlIntent(makeRuntimeStoreService(store), {
          requestId: "partial-fanout-signal",
          runId: awaiting.run.id,
          type: "signal",
          node: wait.nodeKey,
          payload: { ok: true },
        }, claim.ownerEpoch)));
        expect(Result.isSuccess(result)).toBe(true);
        await Effect.runPromise(settleFrozenRunTransitions({
          store: makeRuntimeStoreService(store),
          runId: awaiting.run.id,
          ownerEpoch: claim.ownerEpoch,
        }));
        store.scheduler.releaseRun(claim);
        expect(store.getRun(awaiting.run.id)?.status).toBe("awaiting");
        expect(Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(awaiting.run.id).projection.groupMembers))
          .toEqual(expect.arrayContaining([expect.objectContaining({ status: "completed" })]));
        expect(store.listRuntimeWork().startableRuns.map(run => run.id)).not.toContain(awaiting.run.id);
      } finally {
        store.close();
      }
    });
  });

  it("restarts an awaiting run when a terminal leaf still needs frame propagation", async () => {
    await withRuntimeWorkspace("runtime-daemon-terminal-leaf-reconciliation", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, parallelTaskSignalRecoveryWorkflow());
      const initial = await openRuntimeStoreAdapter(workspace);
      const run = await admitRunForTest(initial, { prepared, input: {}, cwd: workspace });
      appendParallelTaskSignalCrash(initial, run.id, "completed");
      const before = throwingSchedulerStore(initial.scheduler).loadRunSnapshot(run.id).projection;
      expect(Object.values(before.groupMembers)).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: "completed" })]));
      expect(initial.getRun(run.id)?.status).toBe("awaiting");
      initial.close();

      const reopened = await openRuntimeStoreAdapter(workspace);
      try {
        expect(reopened.listRuntimeWork().startableRuns.map(candidate => candidate.id)).toContain(run.id);
        const claim = reopened.scheduler.claimRun(run.id, "terminal-leaf-recovery", 60_000);
        if (!claim) throw new Error("failed to claim terminal-leaf recovery");
        await Effect.runPromise(settleFrozenRunTransitions({
          store: makeRuntimeStoreService(reopened),
          runId: run.id,
          ownerEpoch: claim.ownerEpoch,
        }));
        reopened.scheduler.releaseRun(claim);
        expect(Object.values(throwingSchedulerStore(reopened.scheduler).loadRunSnapshot(run.id).projection.groupMembers))
          .toEqual(expect.arrayContaining([expect.objectContaining({ status: "completed" })]));
        expect(reopened.getRun(run.id)?.status).toBe("awaiting");
        expect(reopened.listRuntimeWork().startableRuns.map(candidate => candidate.id)).not.toContain(run.id);
      } finally {
        reopened.close();
      }
    });
  });

  it("restarts an awaiting run when another branch attempt is due", async () => {
    await withRuntimeWorkspace("runtime-daemon-due-attempt-with-signal", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, parallelTaskSignalRecoveryWorkflow());
      const initial = await openRuntimeStoreAdapter(workspace);
      const run = await admitRunForTest(initial, { prepared, input: {}, cwd: workspace });
      appendParallelTaskSignalCrash(initial, run.id, "due_attempt");
      expect(initial.getRun(run.id)?.status).toBe("awaiting");
      initial.close();

      const now = new Date("2026-07-01T00:00:01.000Z");
      const reopened = await openRuntimeStoreAdapter(workspace);
      try {
        expect(reopened.listRuntimeWork(now).startableRuns.map(candidate => candidate.id)).toContain(run.id);
        const claim = reopened.scheduler.claimRun(run.id, "due-attempt-recovery", 60_000);
        if (!claim) throw new Error("failed to claim due-attempt recovery");
        await Effect.runPromise(Effect.gen(function* () {
          yield* TestClock.setTime(now.getTime());
          return yield* settleFrozenRunTransitions({
            store: makeRuntimeStoreService(reopened),
            runId: run.id,
            ownerEpoch: claim.ownerEpoch,
          });
        }).pipe(Effect.provide(TestClock.layer())));
        reopened.scheduler.releaseRun(claim);
        expect(reopened.getRun(run.id)?.status).toBe("failed");
      } finally {
        reopened.close();
      }
    });
  });

  it.each([
    { label: "stale started attempt", state: "started_attempt" },
    { label: "admissible ready task", state: "ready" },
  ] as const)("restarts an awaiting run with a $label", async ({ state }) => {
    await withRuntimeWorkspace(`runtime-daemon-awaiting-${state}`, async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, parallelTaskSignalRecoveryWorkflow());
      const initial = await openRuntimeStoreAdapter(workspace);
      const run = await admitRunForTest(initial, { prepared, input: {}, cwd: workspace });
      appendParallelTaskSignalCrash(initial, run.id, state);
      expect(initial.getRun(run.id)?.status).toBe("awaiting");
      initial.close();

      const reopened = await openRuntimeStoreAdapter(workspace);
      try {
        expect(reopened.listRuntimeWork().startableRuns.map(candidate => candidate.id)).toContain(run.id);
        const started: string[] = [];
        await expect(runTick(reopened, { startSession: runId => {
          started.push(runId);
          return "started";
        } })).resolves.toMatchObject({ runs: 1 });
        expect(started).toEqual([run.id]);
      } finally {
        reopened.close();
      }
    });
  });

  it("does not restart ready work blocked by a running member's local concurrency slot", async () => {
    await withRuntimeWorkspace("runtime-daemon-awaiting-ready-local-cap", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, parallelTaskSignalRecoveryWorkflow(1));
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        appendParallelTaskSignalCrash(store, run.id, "ready");
        expect(store.getRun(run.id)?.status).toBe("awaiting");
        expect(store.listRuntimeWork().startableRuns.map(candidate => candidate.id)).not.toContain(run.id);
      } finally {
        store.close();
      }
    });
  });

  it("recovers signal controls that were consumed without a follow-up drive", async () => {
    await withRuntimeWorkspace("runtime-daemon-signal-control-recovery", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, signalWorkflow());
      const store = await openRuntimeStoreAdapter(workspace);
      try {
        const claim = store.scheduler.claimRun(awaiting.run.id, "signal-control-owner", 30_000)!;
        await Effect.runPromise(applySchedulerControlIntent(makeRuntimeStoreService(store), {
          requestId: "test-signal-control",
          runId: awaiting.run.id,
          type: "signal",
          node: "approve",
          payload: { ok: true },
          commandIdempotencyKey: "test-signal-control",
        }, claim.ownerEpoch));
        store.scheduler.releaseRun(claim);
      } finally {
        store.close();
      }
      expect(runtimeRow(workspace, "SELECT status FROM runs WHERE id = ?", awaiting.run.id)).toMatchObject({ status: "running" });

      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 5,
        idleStopMs: 500,
        packageVersion: "test",
      });
      try {
        await waitUntil(() => runtimeRow(workspace, "SELECT status FROM runs WHERE id = ?", awaiting.run.id)?.status === "completed");
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("settles expired signal timeouts through a daemon run session", async () => {
    await withRuntimeWorkspace("runtime-daemon-signal-timeout-settlement", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, timedSignalWorkflow());
      expect(awaiting.status).toBe("awaiting");
      await waitUntil(() => {
        const row = runtimeRow(workspace, "SELECT deadline_at FROM signal_waits WHERE run_id = ?", awaiting.run.id) as { deadline_at?: string } | undefined;
        return typeof row?.deadline_at === "string" && Date.now() > Date.parse(row.deadline_at);
      });

      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 5,
        idleStopMs: 500,
        packageVersion: "test",
      });
      try {
        await waitUntil(() => runtimeRow(workspace, "SELECT status FROM runs WHERE id = ?", awaiting.run.id)?.status === "failed");
        expect(runtimeRows(workspace, "SELECT status, terminal_reason FROM signal_waits WHERE run_id = ?", awaiting.run.id)).toEqual([
          { status: "timed_out", terminal_reason: "signal_timeout" },
        ]);
      } finally {
        await loop.shutdown();
      }
    });
  });
});

async function waitForTerminalRun(cwd: string, runId: string): Promise<{ status: string; run: RunDetails }> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = Result.getOrThrow((await Effect.runPromise(Effect.result(getRun(cwd, runId)))));
    if (run && ["completed", "failed", "canceled"].includes(run.status)) return { status: run.status, run };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Run '${runId}' did not become terminal.`);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}

function appendTimedSignalWait(store: Awaited<ReturnType<typeof openRuntimeStoreAdapter>>, runId: string, deadlineAt: string): void {
  const claim = store.scheduler.claimRun(runId, "owner-a", 60_000);
  if (!claim) throw new Error("failed to claim test run");
  try {
    throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
      runId,
      expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).version,
      ownerEpoch: claim.ownerEpoch,
      idempotencyKey: `daemon-signal-timeout:${deadlineAt}`,
      events: [
        { type: "instance.ready", payload: { runId, nodeKey: "approve~1", nodeId: "approve", instancePath: [{ kind: "node", nodeId: "approve" }], readinessSequence: 1 } },
        { type: "instance.awaiting", payload: { nodeKey: "approve~1", statusReason: "signal" } },
        { type: "signal.awaiting", payload: { runId, nodeKey: "approve~1", nodeId: "approve", deadlineAt } },
      ],
    });
  } finally {
    store.scheduler.releaseRun(claim);
  }
}

function appendAwaitingStuckGroup(
  store: Awaited<ReturnType<typeof openRuntimeStoreAdapter>>,
  runId: string,
  groupCase: {
    strategy: "all" | "race" | "quorum";
    kind: "parallel" | "fanout";
    terminal: "cancelled" | "failed" | "completed";
  },
): void {
  const claim = store.scheduler.claimRun(runId, "stuck-all-owner", 60_000);
  if (!claim) throw new Error("failed to claim test run");
  try {
    const terminalEvent: SchedulerEvent = groupCase.terminal === "completed"
      ? { type: "group.member_completed", payload: { memberKey: "group.terminal", completionSequence: 1 } }
      : groupCase.terminal === "failed"
        ? { type: "group.member_failed", payload: { memberKey: "group.terminal", error: { reason: "boom" } } }
        : { type: "group.member_cancelled", payload: { memberKey: "group.terminal", cancelReason: "parent_failed" } };
    const terminalMember: SchedulerEvent = groupCase.kind === "parallel"
      ? { type: "group.member_ready", payload: { runId, groupKey: "group", memberKey: "group.terminal", memberKind: "branch", branchId: "terminal", readinessSequence: 1 } }
      : { type: "group.member_ready", payload: { runId, groupKey: "group", memberKey: "group.terminal", memberKind: "fanout_item", itemIndex: 0, item: null, readinessSequence: 1 } };
    const activeMember: SchedulerEvent = groupCase.kind === "parallel"
      ? { type: "group.member_ready", payload: { runId, groupKey: "group", memberKey: "group.active", memberKind: "branch", branchId: "active", readinessSequence: 2 } }
      : { type: "group.member_ready", payload: { runId, groupKey: "group", memberKey: "group.active", memberKind: "fanout_item", itemIndex: 1, item: null, readinessSequence: 2 } };
    const groupStarted: SchedulerEvent = groupCase.strategy === "race"
      ? { type: "group.started", payload: { runId, groupKey: "group", nodeKey: "group", nodeId: "group", kind: "parallel", strategy: "race" } }
      : groupCase.strategy === "quorum"
        ? { type: "group.started", payload: { runId, groupKey: "group", nodeKey: "group", nodeId: "group", kind: "fanout", strategy: "quorum", quorumCount: 1 } }
        : groupCase.kind === "parallel"
          ? { type: "group.started", payload: { runId, groupKey: "group", nodeKey: "group", nodeId: "group", kind: "parallel", strategy: "all" } }
          : { type: "group.started", payload: { runId, groupKey: "group", nodeKey: "group", nodeId: "group", kind: "fanout", strategy: "all" } };
    throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
      runId,
      expectedVersion: throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId).version,
      ownerEpoch: claim.ownerEpoch,
      idempotencyKey: `daemon-awaiting-stuck-${groupCase.strategy}-${groupCase.terminal}`,
      events: [
        { type: "frame.started", payload: { runId, frameKey: "root", frameKind: "root" } },
        { type: "frame.started", payload: { runId, frameKey: "group", frameKind: "node", parentFrameKey: "root", nodeKey: "group", nodeId: "group", strategy: groupCase.strategy } },
        groupStarted,
        terminalMember,
        terminalEvent,
        activeMember,
        { type: "instance.ready", payload: { runId, nodeKey: "group.active", nodeId: "active", instancePath: [], readinessSequence: 2 } },
        { type: "group.member_started", payload: { memberKey: "group.active" } },
        { type: "instance.started", payload: { nodeKey: "group.active" } },
        { type: "instance.ready", payload: { runId, nodeKey: "external.wait", nodeId: "external_wait", parentFrameKey: "root", instancePath: [] } },
        { type: "instance.awaiting", payload: { nodeKey: "external.wait", statusReason: "signal" } },
        { type: "signal.awaiting", payload: { runId, nodeKey: "external.wait", nodeId: "external_wait" } },
      ],
    });
  } finally {
    store.scheduler.releaseRun(claim);
  }
}

function appendParallelTaskSignalCrash(
  store: Awaited<ReturnType<typeof openRuntimeStoreAdapter>>,
  runId: string,
  state: "completed" | "due_attempt" | "started_attempt" | "ready",
): void {
  const claim = store.scheduler.claimRun(runId, `parallel-task-signal-${state}`, 60_000);
  if (!claim) throw new Error("failed to claim parallel task/signal test run");
  try {
    const frozen = store.getFrozenRun(runId);
    if (!frozen) throw new Error(`Run '${runId}' has no frozen workflow.`);
    const snapshot = throwingSchedulerStore(store.scheduler).loadRunSnapshot(runId);
    const materialized = throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
      runId,
      expectedVersion: snapshot.version,
      ownerEpoch: claim.ownerEpoch,
      idempotencyKey: `parallel-task-signal-bootstrap:${state}`,
      events: bootstrapRootEvents(runId, frozen.ir, frozenRunScope(frozen)),
    });
    const task = Object.values(materialized.projection.instances).find(instance => instance.nodeId === "work");
    const signal = Object.values(materialized.projection.instances).find(instance => instance.nodeId === "wait");
    if (!task || !signal) throw new Error("parallel task/signal workflow did not materialize both leaf instances");
    const taskMember = ancestorGroupMembersForNode(materialized.projection, task.nodeKey)[0];
    const signalMember = ancestorGroupMembersForNode(materialized.projection, signal.nodeKey)[0];
    if (!taskMember || !signalMember) throw new Error("parallel task/signal workflow did not materialize group membership");
    const attemptId = `attempt:${state}`;
    const events: SchedulerEvent[] = [
      { type: "group.member_started", payload: { memberKey: signalMember.memberKey } },
      { type: "instance.awaiting", payload: { nodeKey: signal.nodeKey, statusReason: "signal" } },
      { type: "signal.awaiting", payload: { runId, nodeKey: signal.nodeKey, nodeId: signal.nodeId } },
      ...(state === "ready" ? [] : [
        { type: "group.member_started", payload: { memberKey: taskMember.memberKey } },
        { type: "instance.started", payload: { nodeKey: task.nodeKey } },
        { type: "attempt.started", payload: { runId, attemptId, nodeKey: task.nodeKey, nodeId: task.nodeId, attemptNo: 1, ownerEpoch: claim.ownerEpoch, ...(state === "due_attempt" ? { deadlineAt: "2026-07-01T00:00:00.000Z" } : {}) } },
        ...(state === "completed"
          ? [
              { type: "attempt.completed", payload: { attemptId, result: { ok: true } } },
              { type: "instance.completed", payload: { nodeKey: task.nodeKey, attemptId, output: { ok: true }, acceptedAttemptId: attemptId } },
            ] satisfies SchedulerEvent[]
          : []),
      ] satisfies SchedulerEvent[]),
    ];
    throwingSchedulerStore(store.scheduler).appendSchedulerEvents({
      runId,
      expectedVersion: materialized.version,
      ownerEpoch: claim.ownerEpoch,
      idempotencyKey: `parallel-task-signal-state:${state}`,
      events,
    });
  } finally {
    store.scheduler.releaseRun(claim);
  }
}

function parallelTaskSignalRecoveryWorkflow(maxConcurrency?: number) {
  return defineWorkflow({ name: "runtime-daemon-parallel-task-signal" }).build(({ step }) => {
    const result = step("parallel").parallel({
      strategy: "all",
      ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
      branches: {
        task() {
          const work = step("work").task({ input: null, exec: async () => ({ ok: true }) });
          return { ok: work.output.ok };
        },
        signal() {
          const wait = step("wait").signal({ outputSchema: z.object({ ok: z.boolean() }), prompt: "wait" });
          return { ok: wait.output.ok };
        },
      },
    });
    return { result: result.output };
  });
}

function hookJournalEntry(runId: string, handlerId: string, triggeredAt: string): HookJournalEntry {
  return {
    runId,
    eventSequence: handlerId === "old" ? 1 : 2,
    triggerOrder: 1,
    event: "run.completed",
    source: "project",
    sourcePath: "/workspace/.acpus/config.json",
    handlerId,
    status: "completed",
    exitCode: 0,
    triggeredAt,
  };
}
