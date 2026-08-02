import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedAcpExecutor, inspectAcpOwnership, recoverAcpOwnership } from "@acpus/agent-executor";

const temporaryDirectories: string[] = [];
const spawnedChildren: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(spawnedChildren.splice(0).map(stopChild));
  await Promise.all(temporaryDirectories.splice(0).map(async directory => {
    await (await import("node:fs/promises")).rm(directory, { recursive: true, force: true });
  }));
});

describe("ACP ownership inspection", () => {
  it("reports only residual degraded or orphaned manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-agent-executor-"));
    temporaryDirectories.push(root);
    const workers = join(root, "workers");
    await mkdir(workers);
    await writeFile(join(workers, "acp_worker_dea0.json"), JSON.stringify(manifest({ state: "degraded" })));
    await writeFile(join(workers, "acp_worker_0a0b.json"), JSON.stringify(manifest({ workerId: "acp_worker_0a0b", state: "active", daemon: { pid: 99_999_999, startToken: "pid:99999999", generation: "old" } })));
    await writeFile(join(workers, "acp_worker_ac71.json"), JSON.stringify(manifest({ workerId: "acp_worker_ac71", state: "active", daemon: { pid: process.pid, startToken: "pid:ignored", generation: "current" }, worker: { pid: process.pid, startToken: "pid:ignored" } })));

    const health = await inspectAcpOwnership({ workersRoot: workers, daemon: { pid: process.pid, generation: "current" } });

    expect(health).toMatchObject({ degraded: 1, orphaned: 2 });
    expect(health.manifests).toHaveLength(3);
  });

  it("owns and releases an initialized worker without starting a provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-agent-executor-"));
    temporaryDirectories.push(root);
    const workers = join(root, "workers");
    await writeFile(join(root, ".acpxrc.json"), "{ invalid", "utf8");
    const executor = await createManagedAcpExecutor({
      workersRoot: workers,
      sessionStateDirectoryForRun: runId => join(root, "runs", runId),
      daemon: { generation: "test" },
    });

    const value = await executor.withAttempt({
      runId: "run",
      attemptId: "attempt",
      sessionName: "session",
      cwd: root,
      env: {},
      agent: { kind: "command", command: "unused-acp" },
      permissionMode: "deny-all",
    }, async () => "settled");

    expect(value).toBe("settled");
    expect(await readdir(workers)).toEqual([]);
  });

  it("releases an initialized worker after a caller failure without replacing that failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-agent-executor-"));
    temporaryDirectories.push(root);
    const workers = join(root, "workers");
    const executor = await createManagedAcpExecutor({
      workersRoot: workers,
      sessionStateDirectoryForRun: runId => join(root, "runs", runId),
      daemon: { generation: "test" },
    });
    const failure = new Error("caller failed");

    await expect(executor.withAttempt({
      runId: "run",
      attemptId: "attempt",
      sessionName: "session",
      cwd: root,
      env: {},
      agent: { kind: "command", command: "unused-acp" },
      permissionMode: "deny-all",
    }, async () => { throw failure; })).rejects.toThrow("caller failed");

    expect(await readdir(workers)).toEqual([]);
  });

  it("does not hand a late-starting worker to an attempt after shutdown begins", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-agent-executor-"));
    temporaryDirectories.push(root);
    const workers = join(root, "workers");
    const executor = await createManagedAcpExecutor({
      workersRoot: workers,
      sessionStateDirectoryForRun: runId => join(root, "runs", runId),
      daemon: { generation: "test" },
    });
    const attempt = executor.withAttempt({
      runId: "run",
      attemptId: "attempt",
      sessionName: "session",
      cwd: root,
      env: {},
      agent: { kind: "command", command: "unused-acp" },
      permissionMode: "deny-all",
    }, managed => managed.runTurn({
      agent: { kind: "command", command: "unused-acp" },
      prompt: "unused",
      cwd: root,
      env: {},
      sessionName: "session",
      permissionMode: "deny-all",
      signal: AbortSignal.abort(),
    }));

    await executor.shutdown();

    const result = await attempt;
    expect(result).toMatchObject({ status: "failed", failure: { kind: "worker_lost" }, responses: [] });
    expect(result).not.toHaveProperty("finalResponse");
    expect(await readdir(workers)).toEqual([]);
  });

  it("does not sweep a live worker when its creation identity is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-agent-executor-"));
    temporaryDirectories.push(root);
    const workers = join(root, "workers");
    await mkdir(workers);
    const child = idleChild();
    await writeFile(join(workers, "acp_worker_0a0b.json"), JSON.stringify(manifest({
      workerId: "acp_worker_0a0b",
      worker: { pid: requirePid(child) },
    })));

    await recoverAcpOwnership({
      workersRoot: workers,
      sessionStateDirectoryForRun: runId => join(root, "runs", runId),
      daemon: { generation: "current" },
    });

    expect(await childAlive(child)).toBe(true);
    expect(await readdir(workers)).toEqual(["acp_worker_0a0b.json"]);
  });

  it.skipIf(process.platform !== "linux")("sweeps a process only when its creation identity matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-agent-executor-"));
    temporaryDirectories.push(root);
    const workers = join(root, "workers");
    await mkdir(workers);
    const child = idleChild();
    const pid = requirePid(child);
    const startToken = await linuxStartToken(pid);
    await writeFile(join(workers, "acp_worker_ac71.json"), JSON.stringify(manifest({
      workerId: "acp_worker_ac71",
      worker: { pid, startToken },
    })));

    await recoverAcpOwnership({
      workersRoot: workers,
      sessionStateDirectoryForRun: runId => join(root, "runs", runId),
      daemon: { generation: "current" },
    });

    expect(await childAlive(child)).toBe(false);
    expect(await readdir(workers)).toEqual([]);
  });
});

function manifest(overrides: Partial<{
  workerId: string;
  state: "active" | "degraded";
  daemon: { pid: number; startToken?: string; generation: string };
  worker: { pid: number; startToken?: string };
}> = {}) {
  return {
    schemaVersion: 1,
    workerId: "acp_worker_dea0",
    runId: "run",
    attemptId: "attempt",
    sessionName: "session",
    daemon: { pid: process.pid, startToken: "pid:ignored", generation: "current" },
    worker: { pid: process.pid, startToken: "pid:ignored" },
    state: "active" as const,
    createdAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

function idleChild(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
  spawnedChildren.push(child);
  return child;
}

function requirePid(child: ChildProcess): number {
  if (child.pid === undefined) throw new Error("Expected child pid.");
  return child.pid;
}

async function childAlive(child: ChildProcess): Promise<boolean> {
  try {
    process.kill(requirePid(child), 0);
    return true;
  } catch {
    return false;
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (await childAlive(child)) child.kill("SIGKILL");
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "close").then(() => {}),
    new Promise(resolve => setTimeout(resolve, 1_000)),
  ]);
}

async function linuxStartToken(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
  const startTime = fields[19];
  if (!startTime) throw new Error("Expected Linux process start token.");
  return `linux:${startTime}`;
}
