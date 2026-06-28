import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RuntimeEngine, type ExecuteOptions } from "./engine.js";
import { RuntimeStore, now } from "./store.js";

export type SpawnSupervisorResult = {
  started: boolean;
  generation: number;
};

export type SpawnSupervisorOptions = ExecuteOptions;

export type RunSupervisorOptions = ExecuteOptions & {
  generation: number;
  once?: boolean | undefined;
  idleMs?: number | undefined;
};

const PROTOCOL_VERSION = 1;
const HEARTBEAT_FRESH_MS = 10_000;

export async function spawnSupervisor(workspaceDir: string, options: SpawnSupervisorOptions = {}): Promise<SpawnSupervisorResult> {
  const workspaceRealpath = await realpath(workspaceDir);
  const store = RuntimeStore.open(workspaceRealpath);
  const claimed = claimSupervisorLease(store, workspaceRealpath);
  if (!claimed.started) return claimed;

  const cliPath = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../cli.ts" : "../cli.js", import.meta.url));
  const supervisorArgs = [cliPath, "supervisor", "--workspace", workspaceRealpath, "--generation", String(claimed.generation), ...(options.agentStub ? ["--agent-stub"] : [])];
  const args = import.meta.url.endsWith(".ts")
    ? ["--import", await import.meta.resolve("tsx"), ...supervisorArgs]
    : supervisorArgs;
  const child = spawn(process.execPath, args, {
    cwd: workspaceRealpath,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ACPUS_SUPERVISOR: "1" },
  });
  child.unref();
  return claimed;
}

export async function runSupervisor(workspaceDir: string, options: RunSupervisorOptions): Promise<void> {
  const workspaceRealpath = await realpath(workspaceDir);
  const engine = RuntimeEngine.open(workspaceRealpath);
  const idleMs = options.idleMs ?? 1_000;
  for (;;) {
    heartbeat(engine.store, workspaceRealpath, options.generation);
    const runs = engine.store.listRuns(100).filter(run => run.status === "queued" || run.status === "running");
    for (const run of runs) {
      heartbeat(engine.store, workspaceRealpath, options.generation);
      await engine.execute(run.runId, { agentStub: options.agentStub ?? false });
    }
    if (options.once) return;
    await sleep(idleMs);
  }
}

function claimSupervisorLease(store: RuntimeStore, workspaceRealpath: string): SpawnSupervisorResult {
  return store.withTransaction(() => {
    const existing = store.db.prepare("SELECT generation, heartbeat_at FROM supervisor_lease WHERE workspace_realpath = ?").get(workspaceRealpath) as { generation?: number; heartbeat_at?: string } | undefined;
    if (existing?.heartbeat_at && Date.now() - Date.parse(existing.heartbeat_at) < HEARTBEAT_FRESH_MS) {
      return { started: false, generation: Number(existing.generation ?? 0) };
    }
    const generation = Number(existing?.generation ?? 0) + 1;
    store.db.prepare(`
      INSERT INTO supervisor_lease(workspace_realpath, generation, pid, endpoint, auth_token_hash, heartbeat_at, protocol_version, package_version, node_version, exec_path)
      VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_realpath) DO UPDATE SET
        generation = excluded.generation,
        pid = excluded.pid,
        heartbeat_at = excluded.heartbeat_at,
        protocol_version = excluded.protocol_version,
        package_version = excluded.package_version,
        node_version = excluded.node_version,
        exec_path = excluded.exec_path
    `).run(workspaceRealpath, generation, process.pid, now(), PROTOCOL_VERSION, "0.6.0-alpha", process.version, process.execPath);
    return { started: true, generation };
  });
}

function heartbeat(store: RuntimeStore, workspaceRealpath: string, generation: number): void {
  store.db.prepare("UPDATE supervisor_lease SET heartbeat_at = ?, pid = ? WHERE workspace_realpath = ? AND generation = ?")
    .run(now(), process.pid, workspaceRealpath, generation);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
