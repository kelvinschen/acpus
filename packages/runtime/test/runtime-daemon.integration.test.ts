import { admitRunForTest } from "./support/runtime-store.js";
import { access, mkdir, utimes, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Result } from "neverthrow";
import {
  daemonEndpoint,
  getRun,
  requestDaemonAdmitRun as requestDaemonAdmitRunResult,
  requestDaemonControl as requestDaemonControlResult,
  requestDaemonShutdown as requestDaemonShutdownResult,
  requestDaemonStatus as requestDaemonStatusResult,
  startDaemonLoop,
  type DaemonClientFailure,
} from "@acpus/runtime";
import { runDaemonTick } from "../src/daemon/tick.js";
import type { HookJournalEntry } from "../src/hooks/journal.js";
import { applySchedulerControlIntent } from "../src/scheduler/control.js";
import { openRuntimeStore } from "../src/store/store.js";
import { admitSyntheticWorkflow, prepareSyntheticWorkflow, runtimeRow, runtimeRows, signalWorkflow, taskArtifactWorkflow, timedSignalWorkflow, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";
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
              workflow: { entry: prepared.lock.workflow.entry },
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
      const otherDigest = `sha256:${"a".repeat(64)}`;
      const thirdDigest = `sha256:${"b".repeat(64)}`;
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
            candidate: { ...prepared, sourceGraphDigest: otherDigest, lock: { ...prepared.lock, sourceGraphDigest: otherDigest } },
            message: "source graph digest does not match workflow and package lock digests",
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
            candidate: { ...prepared, lock: { ...prepared.lock, workflow: { ...prepared.lock.workflow, entry: "other.workflow.ts" } } },
            message: "lock entry",
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
      const db = new DatabaseSync(join(workspace, ".acpus", ".local", "state", "runtime.db"));
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
        idleStopMs: 500,
        packageVersion: "test",
      });
      try {
        await waitUntil(() => {
          const row = runtimeRow(workspace, "SELECT idle_since_at, idle_stop_ms FROM daemon_lease") as { idle_since_at: string | null; idle_stop_ms: number | null } | undefined;
          return row?.idle_since_at !== null && row?.idle_stop_ms === 500;
        });
        const store = await openRuntimeStore(workspace);
        try {
          expect(store.getRuntimeDiagnostics().daemon).toMatchObject({
            idleSinceAt: expect.any(String),
            idleStopMs: 500,
          });
        } finally {
          store.close();
        }
      } finally {
        await loop.shutdown();
      }
    });
  });

  it("cleans stale staging once at startup and preserves all other run directories", async () => {
    await withRuntimeWorkspace("runtime-daemon-cleanup", async workspace => {
      const completed = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const runsRoot = join(workspace, ".acpus", ".local", "runs");
      const stale = join(runsRoot, ".staging-old");
      const fresh = join(runsRoot, ".staging-fresh");
      const late = join(runsRoot, ".staging-late");
      const orphan = join(runsRoot, "20990101000000F2CF49A02B2A537F5E8A");
      await mkdir(stale, { recursive: true });
      await mkdir(fresh, { recursive: true });
      await mkdir(orphan, { recursive: true });
      await writeFile(join(stale, "leftover.txt"), "staged");
      const old = new Date(Date.now() - 120_000);
      await utimes(stale, old, old);
      await utimes(orphan, old, old);

      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 5,
        idleStopMs: 1_000,
        packageVersion: "test",
      });
      try {
        await expect(access(stale)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(access(fresh)).resolves.toBeUndefined();
        await expect(access(orphan)).resolves.toBeUndefined();
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
