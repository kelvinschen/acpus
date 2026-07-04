import type { RuntimeStore } from "../store/store.js";

export type DaemonTickResult = {
  runs: number;
  idleBlockers: number;
};

export async function runDaemonTick(store: RuntimeStore, options: { startRun: (runId: string) => void }): Promise<DaemonTickResult> {
  await store.cleanupRunDirectories();
  let runs = 0;
  const work = store.listDaemonWork();
  for (const run of work.startableRuns) {
    options.startRun(run.id);
    runs += 1;
  }
  return { runs, idleBlockers: work.idleBlockers };
}
