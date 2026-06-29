import { openRuntimeStore } from "../store/store.js";
import { runSupervisorTick } from "./tick.js";

export type SupervisorLoopOptions = {
  heartbeatMs?: number;
  workspaceRealpath?: string;
  pid?: number;
  endpoint?: string;
  tokenHash?: string;
  protocolVersion?: number;
  packageVersion: string;
  nodeVersion?: string;
  execPath?: string;
  staleAfterMs?: number;
  onShutdown?: () => void;
};

export type SupervisorLoopHandle = {
  shutdown(): Promise<void>;
};

export async function startSupervisorLoop(cwd: string, options: SupervisorLoopOptions): Promise<SupervisorLoopHandle> {
  const heartbeatMs = options.heartbeatMs ?? 1_000;
  const workspaceRealpath = options.workspaceRealpath ?? cwd;
  const store = await openRuntimeStore(cwd);
  const lease = store.claimSupervisor({
    workspaceRealpath,
    pid: options.pid ?? process.pid,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.tokenHash ? { tokenHash: options.tokenHash } : {}),
    protocolVersion: options.protocolVersion ?? 1,
    packageVersion: options.packageVersion,
    nodeVersion: options.nodeVersion ?? process.version,
    execPath: options.execPath ?? process.execPath,
    staleAfterMs: options.staleAfterMs ?? 30_000,
  });

  let ticking = false;
  let stopped = false;
  const timer = setInterval(() => {
    void tick();
  }, heartbeatMs);

  async function shutdown(): Promise<void> {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    store.releaseSupervisor({
      workspaceRealpath,
      generation: lease.generation,
    });
    store.close();
  }

  async function tick(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    try {
      if (!store.heartbeatSupervisor({ workspaceRealpath, generation: lease.generation })) {
        await shutdown();
        options.onShutdown?.();
        return;
      }
      const result = await runSupervisorTick(cwd, store, { ownerGeneration: lease.generation });
      if (result.shutdown) {
        await shutdown();
        options.onShutdown?.();
      }
    } catch {
      // Keep the supervisor process alive; individual command failures are
      // recorded by the reducer.
    } finally {
      ticking = false;
    }
  }

  void tick();
  return { shutdown };
}
