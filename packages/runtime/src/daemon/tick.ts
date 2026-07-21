import type { RuntimeStore } from "../store/store.js";

const hookJournalRetentionMs = 7 * 24 * 60 * 60 * 1_000;

export type DaemonTickResult = {
  runs: number;
  idleBlockers: number;
};

export async function runDaemonTick(store: Pick<RuntimeStore, "listDaemonWork" | "pruneHookJournal">, options: {
  startSession: (runId: string) => "started" | "already-active" | "terminal" | "quarantined";
  dispatchHooks?: (runId: string) => "dispatched" | "retry" | "quarantined";
}): Promise<DaemonTickResult> {
  let runs = 0;
  const work = store.listDaemonWork();
  for (const run of work.startableRuns) {
    if (options.startSession(run.id) === "started") runs += 1;
  }
  for (const runId of work.hookDispatchRunIds) {
    options.dispatchHooks?.(runId);
  }
  store.pruneHookJournal(new Date(Date.now() - hookJournalRetentionMs));
  return { runs, idleBlockers: work.idleBlockers };
}
