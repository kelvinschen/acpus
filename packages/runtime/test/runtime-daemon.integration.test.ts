import { admitRunForTest } from "./support/runtime-store.js";
import { access, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineWorkflow, z } from "@acpus/core";
import { describe, expect, it } from "vitest";
import type { Result } from "neverthrow";
import {
  DAEMON_PROTOCOL_VERSION,
  daemonEndpoint,
  getRun,
  requestDaemonAdmitRun as requestDaemonAdmitRunResult,
  requestDaemonControl as requestDaemonControlResult,
  requestDaemonShutdown as requestDaemonShutdownResult,
  requestDaemonStatus as requestDaemonStatusResult,
  startDaemonLoop,
  type DaemonClientFailure,
  type Sha256Digest,
} from "@acpus/runtime";
import { runDaemonTick } from "../src/daemon/tick.js";
import type { HookJournalEntry } from "../src/hooks/journal.js";
import { applySchedulerControlIntent } from "../src/scheduler/control.js";
import type { SchedulerEvent } from "../src/scheduler/events.js";
import { bootstrapRootEvents } from "../src/scheduler/materialize.js";
import { ancestorGroupMembersForNode } from "../src/scheduler/membership.js";
import { settleFrozenRunTransitions } from "../src/scheduler/runtime-runner.js";
import { frozenRunScope } from "../src/scheduler/settle.js";
import { applySchedulerEvents, cancellationEventsForNode, nextGroupCompletionBatchEvents } from "../src/scheduler/transitions.js";
import { openRuntimeStore } from "../src/store/store.js";
import { admitSyntheticWorkflow, fanoutSignalWorkflow, parallelSignalAllWorkflow, preparedWorkflow, prepareSyntheticWorkflow, runtimeDatabasePath, runtimeRow, runtimeRows, runtimeRunsRoot, signalWorkflow, taskArtifactWorkflow, timedSignalWorkflow, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
import { throwingSchedulerStore } from "./support/scheduler-store.js";
import { advanceRuntimeRun } from "./support/scheduler.js";

async function requestDaemonAdmitRun(...args: Parameters<typeof requestDaemonAdmitRunResult>) {
  return unwrapDaemon(await requestDaemonAdmitRunResult(...args));
}

async function requestDaemonControl(...args: Parameters<typeof requestDaemonControlResult>) {
  return unwrapDaemon(await requestDaemonControlResult(...args));
}

async function requestDaemonShutdown(...args: Parameters<typeof requestDaemonShutdownResult>) {
  return unwrapDaemon(await requestDaemonShutdownResult(...args));
}

async function requestDaemonStatus(...args: Parameters<typeof requestDaemonStatusResult>) {
  return unwrapDaemon(await requestDaemonStatusResult(...args));
}

function unwrapDaemon<T>(result: Result<T, DaemonClientFailure>): T {
  if (result.isOk()) return result.value;
  throw Object.assign(new Error(result.error.message), result.error.type === "rejected" ? { code: result.error.code } : {});
}

describe.concurrent("runtime daemon ticks", () => {
  it("admits runs only after registering daemon-owned execution", async () => {
    await withRuntimeWorkspace("runtime-daemon-admit-ownership", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 60_000,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      try {
        expect(await requestDaemonStatus(workspace)).toMatchObject({
          protocolVersion: DAEMON_PROTOCOL_VERSION,
        });
        const admitted = await requestDaemonAdmitRun(workspace, {
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
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 60_000,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      try {
        await expect(requestDaemonAdmitRun(workspace, {
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
        await expect(requestDaemonAdmitRun(workspace, {
          prepared: preparedWorkflow(invalidIr, join(workspace, prepared.source.entry), workspace),
          input: { ready: true },
        })).rejects.toMatchObject({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("WorkflowIR irVersion must be 7"),
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
          await expect(requestDaemonAdmitRun(workspace, {
            prepared: candidate as unknown as typeof prepared,
            input: { ready: true },
          })).rejects.toMatchObject({
            code: "INVALID_REQUEST",
            message: "Invalid daemon admission request.",
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
          await expect(requestDaemonAdmitRun(workspace, {
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
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 60_000,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      try {
        const source = await requestDaemonAdmitRun(workspace, { prepared, input: { ready: true } });
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

  it("rejects manual shutdown while another client request is active", async () => {
    await withRuntimeWorkspace("runtime-daemon-shutdown-active-connection", async workspace => {
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
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 5,
        idleStopMs: 10,
        packageVersion: "test",
        onShutdown: resolveShutdown,
      });
      await shutdown;

      expect(runtimeRows(workspace, "SELECT generation FROM daemon_lease")).toEqual([]);
      await loop.shutdown();
    });
  });

  it("closes instead of silently retrying a corrupted durable deadline", async () => {
    await withRuntimeWorkspace("runtime-daemon-corrupted-deadline", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
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

      expect(runtimeRows(workspace, "SELECT generation FROM daemon_lease")).toEqual([]);
      await expect(requestDaemonStatus(workspace)).rejects.toThrow();
      await loop.shutdown();
    });
  });

  it("persists daemon idle state in runtime diagnostics", async () => {
    await withRuntimeWorkspace("runtime-daemon-idle-diagnostics", async workspace => {
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 5,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      try {
        await waitUntil(() => {
          const row = runtimeRow(workspace, "SELECT idle_since_at, idle_stop_ms FROM daemon_lease") as { idle_since_at: string | null; idle_stop_ms: number | null } | undefined;
          return row !== undefined && row.idle_since_at !== null && row.idle_stop_ms === 60_000;
        });
        const store = await openRuntimeStore(workspace);
        try {
          expect(store.getRuntimeDiagnostics().daemon).toMatchObject({
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
        const probeStore = await openRuntimeStore(workspace);
        try {
          probeStore.writeHookJournal(hookJournalEntry(completed.run.id, "startup-cleanup-probe", "2000-01-01T00:00:00.000Z"));
        } finally {
          probeStore.close();
        }
        await waitUntil(() => runtimeRows(workspace, "SELECT definition_hash FROM hook_journal WHERE definition_hash = ?", "startup-cleanup-probe").length === 0);
        await expect(access(late)).resolves.toBeUndefined();
      } finally {
        await loop.shutdown();
      }

      expect(runtimeRows(workspace, "SELECT id FROM runs")).toEqual([{ id: completed.run.id }]);
    });
  });

  it("rejects an orphan final run directory at startup without deleting it", async () => {
    await withRuntimeWorkspace("runtime-daemon-orphan-run", async workspace => {
      const initialized = await openRuntimeStore(workspace);
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
      expect(runtimeRows(workspace, "SELECT generation FROM daemon_lease")).toEqual([]);
      await expect(requestDaemonStatus(workspace)).rejects.toThrow();
    });
  });

  it("prunes expired hook journal rows during daemon ticks", async () => {
    await withRuntimeWorkspace("runtime-daemon-hook-journal-prune", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        await expect(advanceRuntimeRun(workspace, store, run.id, "hook-prune-owner")).resolves.toMatchObject({ status: "completed" });
        store.writeHookJournal(hookJournalEntry(run.id, "old", "2000-01-01T00:00:00.000Z"));
        store.writeHookJournal(hookJournalEntry(run.id, "fresh", "2099-01-01T00:00:00.000Z"));

        await expect(runDaemonTick(store, { startSession: () => {
          throw new Error("no run should start");
        } })).resolves.toMatchObject({ runs: 0 });

        expect(store.getHookJournal(run.id).map(entry => entry.definitionHash)).toEqual(["fresh"]);
      } finally {
        store.close();
      }
    });
  });

  it("treats timed signal waits as daemon work without starting future deadlines", async () => {
    await withRuntimeWorkspace("runtime-daemon-signal-timeout-work", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        appendTimedSignalWait(store, run.id, "2099-01-01T00:00:00.000Z");

        expect(store.listDaemonWork(new Date("2026-07-01T00:00:00.000Z"))).toMatchObject({
          startableRuns: [],
          idleBlockers: 2,
        });

        const started: string[] = [];
        await expect(runDaemonTick(store, { startSession: runId => {
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
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: { ready: true }, cwd: workspace });
        appendTimedSignalWait(store, run.id, "2000-01-01T00:00:00.000Z");

        const started: string[] = [];
        await expect(runDaemonTick(store, { startSession: runId => {
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
      const initial = await openRuntimeStore(workspace);
      const run = await admitRunForTest(initial, { prepared, input: { ready: true }, cwd: workspace });
      appendAwaitingStuckGroup(initial, run.id, groupCase);
      expect(initial.getRun(run.id)?.status).toBe("awaiting");
      initial.close();

      const reopened = await openRuntimeStore(workspace);
      try {
        expect(reopened.listDaemonWork(new Date("2026-07-01T00:00:00.000Z")).startableRuns.map(candidate => candidate.id)).toContain(run.id);
        const started: string[] = [];
        await expect(runDaemonTick(reopened, { startSession: runId => {
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
      const initial = await openRuntimeStore(workspace);
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

      const reopened = await openRuntimeStore(workspace);
      try {
        expect(reopened.listDaemonWork().startableRuns.map(run => run.id)).toContain(awaiting.run.id);
        const recoveryClaim = reopened.scheduler.claimRun(awaiting.run.id, "terminal-group-recovery", 60_000);
        if (!recoveryClaim) throw new Error("failed to claim terminal-group recovery");
        settleFrozenRunTransitions({ store: reopened, runId: awaiting.run.id, ownerEpoch: recoveryClaim.ownerEpoch });
        reopened.scheduler.releaseRun(recoveryClaim);
        expect(reopened.getRun(awaiting.run.id)?.status).toBe("failed");
        expect(reopened.listDaemonWork().startableRuns.map(run => run.id)).not.toContain(awaiting.run.id);
      } finally {
        reopened.close();
      }
    });
  });

  it("does not restart an awaiting group that has terminal members but no derivable transition", async () => {
    await withRuntimeWorkspace("runtime-daemon-group-reconciliation-no-spin", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, fanoutSignalWorkflow(), { items: ["a", "b"] });
      const store = await openRuntimeStore(workspace);
      try {
        const claim = store.scheduler.claimRun(awaiting.run.id, "partial-fanout-owner", 60_000);
        if (!claim) throw new Error("failed to claim partial fanout run");
        const wait = Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(awaiting.run.id).projection.signalWaits)[0];
        if (!wait) throw new Error("fanout signal run has no awaiting node");
        const result = applySchedulerControlIntent(store, {
          requestId: "partial-fanout-signal",
          runId: awaiting.run.id,
          type: "signal",
          node: wait.nodeKey,
          payload: { ok: true },
        }, claim.ownerEpoch);
        expect(result.isOk()).toBe(true);
        settleFrozenRunTransitions({ store, runId: awaiting.run.id, ownerEpoch: claim.ownerEpoch });
        store.scheduler.releaseRun(claim);
        expect(store.getRun(awaiting.run.id)?.status).toBe("awaiting");
        expect(Object.values(throwingSchedulerStore(store.scheduler).loadRunSnapshot(awaiting.run.id).projection.groupMembers))
          .toEqual(expect.arrayContaining([expect.objectContaining({ status: "completed" })]));
        expect(store.listDaemonWork().startableRuns.map(run => run.id)).not.toContain(awaiting.run.id);
      } finally {
        store.close();
      }
    });
  });

  it("restarts an awaiting run when a terminal leaf still needs frame propagation", async () => {
    await withRuntimeWorkspace("runtime-daemon-terminal-leaf-reconciliation", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, parallelTaskSignalRecoveryWorkflow());
      const initial = await openRuntimeStore(workspace);
      const run = await admitRunForTest(initial, { prepared, input: {}, cwd: workspace });
      appendParallelTaskSignalCrash(initial, run.id, "completed");
      const before = throwingSchedulerStore(initial.scheduler).loadRunSnapshot(run.id).projection;
      expect(Object.values(before.groupMembers)).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: "completed" })]));
      expect(initial.getRun(run.id)?.status).toBe("awaiting");
      initial.close();

      const reopened = await openRuntimeStore(workspace);
      try {
        expect(reopened.listDaemonWork().startableRuns.map(candidate => candidate.id)).toContain(run.id);
        const claim = reopened.scheduler.claimRun(run.id, "terminal-leaf-recovery", 60_000);
        if (!claim) throw new Error("failed to claim terminal-leaf recovery");
        settleFrozenRunTransitions({ store: reopened, runId: run.id, ownerEpoch: claim.ownerEpoch });
        reopened.scheduler.releaseRun(claim);
        expect(Object.values(throwingSchedulerStore(reopened.scheduler).loadRunSnapshot(run.id).projection.groupMembers))
          .toEqual(expect.arrayContaining([expect.objectContaining({ status: "completed" })]));
        expect(reopened.getRun(run.id)?.status).toBe("awaiting");
        expect(reopened.listDaemonWork().startableRuns.map(candidate => candidate.id)).not.toContain(run.id);
      } finally {
        reopened.close();
      }
    });
  });

  it("restarts an awaiting run when another branch attempt is due", async () => {
    await withRuntimeWorkspace("runtime-daemon-due-attempt-with-signal", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, parallelTaskSignalRecoveryWorkflow());
      const initial = await openRuntimeStore(workspace);
      const run = await admitRunForTest(initial, { prepared, input: {}, cwd: workspace });
      appendParallelTaskSignalCrash(initial, run.id, "due_attempt");
      expect(initial.getRun(run.id)?.status).toBe("awaiting");
      initial.close();

      const now = new Date("2026-07-01T00:00:01.000Z");
      const reopened = await openRuntimeStore(workspace);
      try {
        expect(reopened.listDaemonWork(now).startableRuns.map(candidate => candidate.id)).toContain(run.id);
        const claim = reopened.scheduler.claimRun(run.id, "due-attempt-recovery", 60_000);
        if (!claim) throw new Error("failed to claim due-attempt recovery");
        settleFrozenRunTransitions({ store: reopened, runId: run.id, ownerEpoch: claim.ownerEpoch, now });
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
      const initial = await openRuntimeStore(workspace);
      const run = await admitRunForTest(initial, { prepared, input: {}, cwd: workspace });
      appendParallelTaskSignalCrash(initial, run.id, state);
      expect(initial.getRun(run.id)?.status).toBe("awaiting");
      initial.close();

      const reopened = await openRuntimeStore(workspace);
      try {
        expect(reopened.listDaemonWork().startableRuns.map(candidate => candidate.id)).toContain(run.id);
        const started: string[] = [];
        await expect(runDaemonTick(reopened, { startSession: runId => {
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
      const store = await openRuntimeStore(workspace);
      try {
        const run = await admitRunForTest(store, { prepared, input: {}, cwd: workspace });
        appendParallelTaskSignalCrash(store, run.id, "ready");
        expect(store.getRun(run.id)?.status).toBe("awaiting");
        expect(store.listDaemonWork().startableRuns.map(candidate => candidate.id)).not.toContain(run.id);
      } finally {
        store.close();
      }
    });
  });

  it("recovers signal controls that were consumed without a follow-up drive", async () => {
    await withRuntimeWorkspace("runtime-daemon-signal-control-recovery", async workspace => {
      const awaiting = await admitSyntheticWorkflow(workspace, signalWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const claim = store.scheduler.claimRun(awaiting.run.id, "signal-control-owner", 30_000)!;
        applySchedulerControlIntent(store, {
          requestId: "test-signal-control",
          runId: awaiting.run.id,
          type: "signal",
          node: "approve",
          payload: { ok: true },
          commandIdempotencyKey: "test-signal-control",
        }, claim.ownerEpoch);
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

async function waitForTerminalRun(cwd: string, runId: string): Promise<{ status: string; run: NonNullable<Awaited<ReturnType<typeof getRun>>> }> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = await getRun(cwd, runId);
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

function appendTimedSignalWait(store: Awaited<ReturnType<typeof openRuntimeStore>>, runId: string, deadlineAt: string): void {
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
  store: Awaited<ReturnType<typeof openRuntimeStore>>,
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
  store: Awaited<ReturnType<typeof openRuntimeStore>>,
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

function hookJournalEntry(runId: string, definitionHash: string, triggeredAt: string): HookJournalEntry {
  return {
    runId,
    eventSequence: definitionHash === "old" ? 1 : 2,
    triggerOrder: 1,
    event: "run.completed",
    source: "project",
    sourcePath: "/workspace/.acpus/hooks.json",
    handlerId: definitionHash,
    definitionHash,
    status: "completed",
    exitCode: 0,
    triggeredAt,
  };
}
