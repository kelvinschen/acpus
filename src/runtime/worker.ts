import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { resolveRunLocator } from "../run-index/locator.js";
import { runDir } from "../run-index/paths.js";
import { appendEvent, readRunIndex, updateRunIndex, type RunIndex, type RunStatus, type RunWorkerState } from "../run-index/read-write.js";
import { syncRun } from "./sync.js";

export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const WORKER_STALE_AFTER_MS = 60_000;

export type WorkerProgressEvent =
  | { type: "worker_started"; runId: string; pid: number; status: string }
  | { type: "run_progress"; runId: string; status: RunStatus; changedStages: Array<{ id: string; status: string }> }
  | { type: "worker_exited"; runId: string; pid: number; status: string; exitCode?: number | null };

export type WorkerReporter = (event: WorkerProgressEvent) => void | Promise<void>;

export function terminalRunStatus(status: RunStatus): boolean {
  return status === "completed" || status === "blocked" || status === "failed" || status === "cancelled";
}

export function workerIsActive(worker: RunWorkerState | undefined, now = Date.now()): boolean {
  if (!worker) return false;
  if (worker.status !== "starting" && worker.status !== "running") return false;
  if (!pidIsAlive(worker.pid)) return false;
  return now - Date.parse(worker.heartbeatAt) <= WORKER_STALE_AFTER_MS;
}

export function workerSummary(worker: RunWorkerState | undefined, now = Date.now()) {
  if (!worker) return undefined;
  const stale = (worker.status === "starting" || worker.status === "running") && !workerIsActive(worker, now);
  return {
    pid: worker.pid,
    generation: worker.generation ?? 0,
    status: stale ? "stale" : worker.status,
    startedAt: worker.startedAt,
    heartbeatAt: worker.heartbeatAt,
    exitedAt: worker.exitedAt,
    exitCode: worker.exitCode
  };
}

function pidIsAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export async function claimWorker(cwd: string, runId: string, pid: number, options: { force?: boolean } = {}): Promise<RunIndex> {
  return updateRunIndex(cwd, runId, (index) => {
    if (terminalRunStatus(index.status)) throw new Error(`Cannot start worker for terminal run ${runId} (${index.status}).`);
    if (!options.force && index.worker && workerIsActive(index.worker) && index.worker.pid !== pid) {
      throw new Error(`Run ${runId} already has an active worker pid=${index.worker.pid}.`);
    }
    const now = new Date().toISOString();
    const sameWorker = index.worker?.pid === pid;
    const generation = sameWorker ? (index.worker?.generation ?? 0) : (index.worker?.generation ?? 0) + 1;
    return {
      ...index,
      status: index.status === "pending" ? "running" : index.status,
      worker: {
        pid,
        generation,
        status: "running",
        startedAt: sameWorker ? index.worker!.startedAt : now,
        heartbeatAt: now
      }
    };
  });
}

export async function markWorkerExit(cwd: string, runId: string, pid: number, status: "exited" | "failed", exitCode?: number | null, generation?: number): Promise<RunIndex> {
  return updateRunIndex(cwd, runId, (index) => {
    if (index.worker?.pid !== pid) return index;
    if (generation !== undefined && (index.worker.generation ?? 0) !== generation) return index;
    return {
      ...index,
      worker: {
        ...index.worker,
        status,
        heartbeatAt: new Date().toISOString(),
        exitedAt: new Date().toISOString(),
        exitCode
      }
    };
  });
}

export async function heartbeatWorker(cwd: string, runId: string, pid: number, generation?: number): Promise<boolean> {
  let owned = false;
  await updateRunIndex(cwd, runId, (index) => {
    if (index.worker?.pid !== pid) return index;
    if (generation !== undefined && (index.worker.generation ?? 0) !== generation) return index;
    owned = true;
    if (terminalRunStatus(index.status)) return index;
    return {
      ...index,
      worker: {
        ...index.worker,
        status: "running",
        heartbeatAt: new Date().toISOString()
      }
    };
  });
  return owned;
}

export async function runWorkflowWorker(cwd: string, runId: string, options: { reporter?: WorkerReporter; force?: boolean } = {}): Promise<RunIndex> {
  const pid = process.pid;
  let finalIndex = await claimWorker(cwd, runId, pid, { force: options.force });
  const generation = finalIndex.worker?.generation ?? 0;
  await appendEvent(cwd, runId, { type: "worker_started", pid });
  await options.reporter?.({ type: "worker_started", runId, pid, status: finalIndex.status });
  const heartbeat = setInterval(() => {
    void heartbeatWorker(cwd, runId, pid, generation).catch(() => undefined);
  }, WORKER_HEARTBEAT_INTERVAL_MS);
  try {
    let previous = finalIndex;
    while (!terminalRunStatus(finalIndex.status)) {
      if (!await workerStillOwnsRun(cwd, runId, pid, generation)) {
        await appendEvent(cwd, runId, { type: "worker_ownership_lost", pid, generation });
        await options.reporter?.({ type: "worker_exited", runId, pid, status: "lost_ownership", exitCode: null });
        return readRunIndex(cwd, runId);
      }
      finalIndex = await syncRun(cwd, runId, { drainFanoutPool: true });
      if (!await workerStillOwnsRun(cwd, runId, pid, generation)) {
        await appendEvent(cwd, runId, { type: "worker_ownership_lost", pid, generation });
        await options.reporter?.({ type: "worker_exited", runId, pid, status: "lost_ownership", exitCode: null });
        return readRunIndex(cwd, runId);
      }
      const changedStages = Object.entries(finalIndex.stages)
        .filter(([id, stage]) => previous.stages[id]?.status !== stage.status)
        .map(([id, stage]) => ({ id, status: stage.status }));
      if (changedStages.length > 0 || previous.status !== finalIndex.status) {
        await heartbeatWorker(cwd, runId, pid, generation);
        await options.reporter?.({ type: "run_progress", runId, status: finalIndex.status, changedStages });
      }
      previous = finalIndex;
      if (!terminalRunStatus(finalIndex.status)) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await markWorkerExit(cwd, runId, pid, "exited", 0, generation);
    await appendEvent(cwd, runId, { type: "worker_exited", pid, status: finalIndex.status, exitCode: 0 });
    await options.reporter?.({ type: "worker_exited", runId, pid, status: finalIndex.status, exitCode: 0 });
    return readRunIndex(cwd, runId);
  } catch (error) {
    await markWorkerExit(cwd, runId, pid, "failed", 1, generation).catch(() => undefined);
    await appendEvent(cwd, runId, { type: "worker_exited", pid, status: "failed", exitCode: 1, errorMessage: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function spawnBackgroundWorker(cwd: string, runId: string): Promise<RunWorkerState> {
  const dir = runDir(runId, cwd);
  await fs.mkdir(dir, { recursive: true });
  const log = await fs.open(path.join(dir, "worker.log"), "a");
  const args = workerCommandArgs(runId);
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: ["ignore", log.fd, log.fd]
  });
  try {
    if (!child.pid) throw new Error("Failed to spawn worker process.");
    const index = await claimWorker(cwd, runId, child.pid);
    child.unref();
    await appendEvent(cwd, runId, { type: "worker_spawned", pid: child.pid, generation: index.worker?.generation });
    return index.worker!;
  } catch (error) {
    if (child.pid) child.kill();
    throw error;
  } finally {
    await log.close();
  }
}

function workerCommandArgs(runId: string): string[] {
  const args = process.argv.slice(1);
  const commandIndex = args.findIndex((arg) => arg === "run" || arg === "resume" || arg === "_run-worker");
  const prefix = commandIndex >= 0 ? args.slice(0, commandIndex) : args;
  return [...process.execArgv, ...prefix, "_run-worker", runId];
}

async function workerStillOwnsRun(cwd: string, runId: string, pid: number, generation: number): Promise<boolean> {
  const index = await readRunIndex(cwd, runId);
  return index.worker?.pid === pid && (index.worker.generation ?? 0) === generation;
}
