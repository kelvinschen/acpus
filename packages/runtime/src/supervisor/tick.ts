import { applyControlCommand } from "../control/apply-command.js";
import { advanceRuntimeRun } from "../runs/advance-runtime.js";
import type { RuntimeStore } from "../store/store.js";

export type SupervisorTickResult = {
  commands: number;
  runs: number;
  shutdown: boolean;
};

export async function runSupervisorTick(cwd: string, store: RuntimeStore, options: { ownerGeneration?: number; commandStaleAfterMs?: number } = {}): Promise<SupervisorTickResult> {
  await store.cleanupRunDirectories();
  store.recoverStaleCommands({
    ...(options.ownerGeneration === undefined ? {} : { ownerGeneration: options.ownerGeneration }),
    ...(options.commandStaleAfterMs === undefined ? {} : { olderThanMs: options.commandStaleAfterMs }),
  });
  let commands = 0;
  let shutdown = false;
  for (const command of store.listPendingCommands()) {
    if (command.type === "shutdown") {
      store.finishCommand({ id: command.id, status: "applied", payload: { status: "shutdown" } });
      commands += 1;
      return { commands, runs: 0, shutdown: true };
    }
    try {
      await applyControlCommand(cwd, store, command, options.ownerGeneration === undefined ? {} : { ownerGeneration: options.ownerGeneration });
    } catch {}
    commands += 1;
  }

  let runs = 0;
  for (const run of store.listRunnableRuns()) {
    const advanced = await advanceRuntimeRun(cwd, store, run.id);
    if (advanced.status !== "idle") runs += 1;
  }
  return { commands, runs, shutdown };
}
