import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedAcpExecutor, inspectAcpOwnership, recoverAcpOwnership } from "@acpus/agent-executor";

const fixtureAgent = fileURLToPath(new URL("./fixtures/minimal-acp-agent.mjs", import.meta.url));
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
    await writeFile(join(workers, "acp_worker_0a0b.json"), JSON.stringify(manifest({ workerId: "acp_worker_0a0b", state: "active", owner: { pid: 99_999_999, startToken: "pid:99999999", generation: "old" } })));
    await writeFile(join(workers, "acp_worker_ac71.json"), JSON.stringify(manifest({ workerId: "acp_worker_ac71", state: "active", owner: { pid: process.pid, startToken: "owner-current", generation: "current" }, worker: { pid: process.pid } })));

    const health = await inspectAcpOwnership({ workersRoot: workers, owner: { pid: process.pid, startToken: "owner-current", generation: "current" } });

    expect(health).toMatchObject({ degraded: 1, orphaned: 1 });
    expect(health.manifests).toHaveLength(2);

    const replaced = await inspectAcpOwnership({ workersRoot: workers, owner: { pid: process.pid, startToken: "owner-replaced", generation: "current" } });
    expect(replaced).toMatchObject({ degraded: 1, orphaned: 2 });
    expect(replaced.manifests).toHaveLength(3);
  });

  it("bypasses invalid named-Agent config for a command and releases ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-agent-executor-"));
    temporaryDirectories.push(root);
    const workers = join(root, "workers");
    await mkdir(join(root, ".acpus"));
    await writeFile(join(root, ".acpus", "agents.json"), "{ invalid", "utf8");
    const executor = await createManagedAcpExecutor({
      workersRoot: workers,
      sessionStateDirectoryForRun: runId => join(root, "runs", runId),
      owner: { generation: "test" },
    });

    const value = await executor.withAttempt({
      runId: "run",
      attemptId: "attempt",
      sessionName: "session",
      cwd: root,
      env: {},
      agent: fixtureSelector(),
      permissionMode: "deny-all",
    }, async () => {
      const names = await readdir(workers);
      expect(names).toHaveLength(1);
      const persisted = JSON.parse(await readFile(join(workers, names[0]!), "utf8")) as Record<string, unknown>;
      expect(persisted).toMatchObject({
        schemaVersion: 2,
        owner: { pid: process.pid, generation: "test" },
      });
      expect(persisted).not.toHaveProperty("daemon");
      return "settled";
    });

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
      owner: { generation: "test" },
    });
    const failure = new Error("caller failed");

    await expect(executor.withAttempt({
      runId: "run",
      attemptId: "attempt",
      sessionName: "session",
      cwd: root,
      env: {},
      agent: fixtureSelector(),
      permissionMode: "deny-all",
    }, async () => { throw failure; })).rejects.toThrow("caller failed");

    expect(await readdir(workers)).toEqual([]);
  });

  it.skipIf(process.platform !== "linux")("keeps the managed provider inside the worker process group", async () => {
    const root = await temporaryRoot();
    const workers = join(root, "workers");
    const pidPath = join(root, "provider.pid");
    const executor = await testExecutor(root);

    await executor.withAttempt(attemptInput(
      root,
      fixtureSelector(),
      "process-group",
      undefined,
      { ACP_FIXTURE_PID_PATH: pidPath },
    ), async () => {
      const [manifestName] = await readdir(workers);
      const persisted = JSON.parse(await readFile(join(workers, manifestName!), "utf8")) as { worker: { pgid: number } };
      const providerPid = Number((await readFile(pidPath, "utf8")).trim());
      expect(await linuxProcessGroup(providerPid)).toBe(persisted.worker.pgid);
    });
  });

  it("preserves a structured eager-open failure and releases ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-agent-executor-"));
    temporaryDirectories.push(root);
    const workers = join(root, "workers");
    const executor = await createManagedAcpExecutor({
      workersRoot: workers,
      sessionStateDirectoryForRun: runId => join(root, "runs", runId),
      owner: { generation: "test" },
    });
    let callbackCalled = false;

    const result = await executor.withAttempt({
      runId: "run",
      attemptId: "attempt-open-failure",
      sessionName: "session-open-failure",
      cwd: root,
      env: {},
      agent: fixtureSelector("exit-on-initialize"),
      permissionMode: "deny-all",
    }, async attempt => {
      callbackCalled = true;
      return attempt.runTurn({
        agent: fixtureSelector("exit-on-initialize"),
        prompt: "unused",
        cwd: root,
        env: {},
        sessionName: "session-open-failure",
        permissionMode: "deny-all",
      });
    });

    expect(callbackCalled).toBe(true);
    expect(result).toMatchObject({
      status: "failed",
      failure: {
        kind: "provider_exit",
        origin: "provider",
        upstream: { source: "acp", operation: "open_session" },
      },
      responses: [],
    });
    expect(result).not.toHaveProperty("finalResponse");
    expect(await readdir(workers)).toEqual([]);
  });

  it("covers delayed and cancelled provider-open phases", { timeout: 12_000 }, async () => {
    const delayed = Promise.all(["delay-initialize", "delay-new"].map(async flag => {
      const root = await temporaryRoot();
      const workers = join(root, "workers");
      const executor = await testExecutor(root);

      const result = await executor.withAttempt(attemptInput(root, fixtureSelector(flag), flag), attempt =>
        attempt.runTurn(turnInput(root, fixtureSelector(flag), flag)));

      return [flag, {
        status: result.status,
        finalResponse: result.status === "completed" ? result.finalResponse : undefined,
        ownership: await readdir(workers),
      }] as const;
    }));
    const cancelled = Promise.all([
      { operation: "new", stop: "abort" },
      { operation: "initialize", stop: "shutdown" },
    ].map(async ({ operation, stop }) => {
      const root = await temporaryRoot();
      const workers = join(root, "workers");
      const gate = join(root, "gate");
      const executor = await testExecutor(root);
      const controller = new AbortController();
      let callbackCalled = false;

      const opening = executor.withAttempt(attemptInput(
        root,
        fixtureSelector(`gate-${operation}`),
        `${stop}-open`,
        controller.signal,
        { ACP_FIXTURE_GATE_DIRECTORY: gate },
      ), attempt => {
        callbackCalled = true;
        return attempt.runTurn(turnInput(root, fixtureSelector(), `${stop}-open`));
      });
      await waitForPath(join(gate, `${operation}.started`));
      expect(callbackCalled).toBe(false);

      if (stop === "abort") controller.abort();
      else await executor.shutdown();
      const result = await opening;

      return [stop, {
        callbackCalled,
        status: result.status,
        responses: result.responses,
        finalResponse: "finalResponse" in result ? result.finalResponse : undefined,
        ownership: await readdir(workers),
      }] as const;
    }));
    const [delayedOutcomes, cancelledOutcomes] = await Promise.all([delayed, cancelled]);

    expect(Object.fromEntries(delayedOutcomes)).toEqual({
      "delay-initialize": { status: "completed", finalResponse: "unit-response", ownership: [] },
      "delay-new": { status: "completed", finalResponse: "unit-response", ownership: [] },
    });
    expect(Object.fromEntries(cancelledOutcomes)).toEqual({
      abort: { callbackCalled: true, status: "cancelled", responses: [], finalResponse: undefined, ownership: [] },
      shutdown: { callbackCalled: true, status: "cancelled", responses: [], finalResponse: undefined, ownership: [] },
    });
  });

  it("does not expose an attempt when abort wins the ready race", { timeout: 12_000 }, async () => {
    const root = await temporaryRoot();
    const workers = join(root, "workers");
    const gate = join(root, "gate");
    const executor = await testExecutor(root);
    const controller = new AbortController();
    let callbackCalled = false;

    const opening = executor.withAttempt(attemptInput(
      root,
      fixtureSelector("gate-new"),
      "ready-race",
      controller.signal,
      { ACP_FIXTURE_GATE_DIRECTORY: gate },
    ), attempt => {
      callbackCalled = true;
      return attempt.runTurn(turnInput(root, fixtureSelector(), "ready-race"));
    });
    await waitForPath(join(gate, "new.started"));
    expect(callbackCalled).toBe(false);

    controller.abort();
    await writeFile(join(gate, "new.release"), "");
    const result = await opening;

    expect(callbackCalled).toBe(true);
    expect(result).toMatchObject({ status: "cancelled", responses: [] });
    expect(result).not.toHaveProperty("finalResponse");
    expect(await readdir(workers)).toEqual([]);
  });

  it("does not hand a late-starting worker to an attempt after shutdown begins", async () => {
    const root = await mkdtemp(join(tmpdir(), "acpus-agent-executor-"));
    temporaryDirectories.push(root);
    const workers = join(root, "workers");
    const executor = await createManagedAcpExecutor({
      workersRoot: workers,
      sessionStateDirectoryForRun: runId => join(root, "runs", runId),
      owner: { generation: "test" },
    });
    const attempt = executor.withAttempt({
      runId: "run",
      attemptId: "attempt",
      sessionName: "session",
      cwd: root,
      env: {},
      agent: fixtureSelector(),
      permissionMode: "deny-all",
    }, managed => managed.runTurn({
      agent: fixtureSelector(),
      prompt: "unused",
      cwd: root,
      env: {},
      sessionName: "session",
      permissionMode: "deny-all",
      signal: AbortSignal.abort(),
    }));

    await executor.shutdown();

    const result = await attempt;
    expect(result).toMatchObject({ status: "cancelled", responses: [] });
    expect(result).not.toHaveProperty("finalResponse");
    expect(await directoryEntries(workers)).toEqual([]);
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
      owner: { generation: "current" },
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
      owner: { generation: "current" },
    });

    expect(await childAlive(child)).toBe(false);
    expect(await readdir(workers)).toEqual([]);
  });
});

function manifest(overrides: Partial<{
  workerId: string;
  state: "active" | "degraded";
  owner: { pid: number; startToken?: string; generation: string };
  worker: { pid: number; startToken?: string };
}> = {}) {
  return {
    schemaVersion: 2,
    workerId: "acp_worker_dea0",
    runId: "run",
    attemptId: "attempt",
    sessionName: "session",
    owner: { pid: process.pid, startToken: "pid:ignored", generation: "current" },
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

async function linuxProcessGroup(pid: number): Promise<number> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
  return Number(fields[2]);
}

function fixtureSelector(...flags: string[]) {
  return {
    kind: "command" as const,
    command: [process.execPath, fixtureAgent, "unit-response", ...flags]
      .map(value => JSON.stringify(value))
      .join(" "),
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acpus-agent-executor-"));
  temporaryDirectories.push(root);
  return root;
}

function testExecutor(root: string) {
  return createManagedAcpExecutor({
    workersRoot: join(root, "workers"),
    sessionStateDirectoryForRun: runId => join(root, "runs", runId),
    owner: { generation: "test" },
  });
}

function attemptInput(
  root: string,
  agent: ReturnType<typeof fixtureSelector>,
  id: string,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = {},
) {
  return {
    runId: "run",
    attemptId: `attempt-${id}`,
    sessionName: `session-${id}`,
    cwd: root,
    env,
    agent,
    permissionMode: "deny-all" as const,
    ...(signal === undefined ? {} : { signal }),
  };
}

function turnInput(root: string, agent: ReturnType<typeof fixtureSelector>, id: string) {
  return {
    agent,
    prompt: "unused",
    cwd: root,
    env: {},
    sessionName: `session-${id}`,
    permissionMode: "deny-all" as const,
  };
}

async function waitForPath(path: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function directoryEntries(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
