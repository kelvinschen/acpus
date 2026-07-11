import { access, mkdir, utimes, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { daemonEndpoint, getRun, requestDaemonAdmitRun, requestDaemonShutdown, requestDaemonStatus, startDaemonLoop } from "@acpus/runtime";
import { runDaemonTick } from "../src/daemon/tick.js";
import type { HookJournalEntry } from "../src/hooks/journal.js";
import { advanceRuntimeRun } from "../src/runs/advance-runtime.js";
import { openExistingWritableRuntimeStore, openRuntimeStore } from "../src/store/store.js";
import { applySignalRunControl } from "../src/runs/use-cases.js";
import { admitSyntheticWorkflow, prepareSyntheticWorkflow, runtimeRow, runtimeRows, signalWorkflow, taskArtifactWorkflow, timedSignalWorkflow, validWorkflow, withRuntimeWorkspace } from "./support/runtime-fixtures.js";

describe.concurrent("runtime daemon ticks", () => {
  it("admits runs through the daemon with explicit start behavior", async () => {
    await withRuntimeWorkspace("runtime-daemon-admit-start-behavior", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const loop = await startDaemonLoop(workspace, {
        heartbeatMs: 60_000,
        idleStopMs: 60_000,
        packageVersion: "test",
      });
      try {
        const pending = await requestDaemonAdmitRun(workspace, {
          prepared,
          input: { ready: true },
          start: false,
        });

        expect(pending).toMatchObject({
          name: "cli-valid",
          status: "pending",
          input: { ready: true },
        });
        expect(runtimeRows(workspace, "SELECT id FROM runs WHERE id = ?", pending.id)).toEqual([{ id: pending.id }]);

        const started = await requestDaemonAdmitRun(workspace, {
          prepared,
          input: { ready: true },
          start: true,
        });
        const advanced = await waitForTerminalRun(workspace, started.id);

        expect(started).toMatchObject({ name: "cli-valid" });
        expect(advanced).toMatchObject({
          status: "completed",
          run: {
            id: started.id,
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
          start: false,
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
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

  it("cleans stale staged directories but preserves admitted runs", async () => {
    await withRuntimeWorkspace("runtime-daemon-cleanup", async workspace => {
      const completed = await admitSyntheticWorkflow(workspace, taskArtifactWorkflow());
      const staged = join(workspace, ".acpus", ".local", "runs", ".staging-old");
      const orphan = join(workspace, ".acpus", ".local", "runs", "20990101000000F2CF49A02B2A537F5E8A");
      await mkdir(staged, { recursive: true });
      await mkdir(orphan, { recursive: true });
      await writeFile(join(staged, "leftover.txt"), "staged");
      const old = new Date(Date.now() - 120_000);
      await utimes(staged, old, old);
      await utimes(orphan, old, old);

      const store = await openExistingWritableRuntimeStore(workspace);
      expect(store).toBeDefined();
      try {
        await expect(runDaemonTick(store!, { startRun: () => {
          throw new Error("no run should start");
        } })).resolves.toMatchObject({ runs: 0 });
      } finally {
        store?.close();
      }

      expect(runtimeRows(workspace, "SELECT id FROM runs")).toEqual([{ id: completed.run.id }]);
      await expect(access(staged)).rejects.toThrow();
      await expect(access(orphan)).resolves.toBeUndefined();
    });
  });

  it("prunes expired hook journal rows during daemon ticks", async () => {
    await withRuntimeWorkspace("runtime-daemon-hook-journal-prune", async workspace => {
      const prepared = await prepareSyntheticWorkflow(workspace, validWorkflow());
      const store = await openRuntimeStore(workspace);
      try {
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        await expect(advanceRuntimeRun(workspace, store, run.id)).resolves.toMatchObject({ status: "completed" });
        store.writeHookJournal(hookJournalEntry(run.id, "old", "2000-01-01T00:00:00.000Z"));
        store.writeHookJournal(hookJournalEntry(run.id, "fresh", "2099-01-01T00:00:00.000Z"));

        await expect(runDaemonTick(store, { startRun: () => {
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        appendTimedSignalWait(store, run.id, "2099-01-01T00:00:00.000Z");

        expect(store.listDaemonWork(new Date("2026-07-01T00:00:00.000Z"))).toMatchObject({
          startableRuns: [],
          idleBlockers: 1,
        });

        const started: string[] = [];
        await expect(runDaemonTick(store, { startRun: runId => started.push(runId) })).resolves.toMatchObject({
          runs: 0,
          idleBlockers: 1,
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
        const run = await store.admitRun({ prepared, input: { ready: true }, cwd: workspace });
        appendTimedSignalWait(store, run.id, "2000-01-01T00:00:00.000Z");

        const started: string[] = [];
        await expect(runDaemonTick(store, { startRun: runId => started.push(runId) })).resolves.toMatchObject({
          runs: 1,
          idleBlockers: 1,
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
      await expect(applySignalRunControl(workspace, awaiting.run.id, "approve", { ok: true }, { requestId: "test-signal-control" })).resolves.toMatchObject({
        run: { id: awaiting.run.id, status: "running" },
      });

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
    store.scheduler.appendSchedulerEvents({
      runId,
      expectedVersion: store.scheduler.loadRunSnapshot(runId).version,
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
