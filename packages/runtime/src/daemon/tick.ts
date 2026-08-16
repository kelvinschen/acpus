import type { RuntimeStore } from "../store/store.js";

const hookJournalRetentionMs = 7 * 24 * 60 * 60 * 1_000;

export type RuntimeTickResult = {
  runs: number;
  idleBlockers: number;
};

export async function runRuntimeTick(store: Pick<RuntimeStore, "listRuntimeWork" | "pruneHookJournal">, options: {
  startSession: (runId: string) => "started" | "already-active" | "terminal" | "quarantined";
  dispatchHooks?: (runId: string) => "dispatched" | "retry" | "quarantined";
}): Promise<RuntimeTickResult> {
  let runs = 0;
  const sessionOwnedRuns = new Set<string>();
  const work = store.listRuntimeWork();
  for (const run of work.startableRuns) {
    const disposition = options.startSession(run.id);
    if (disposition === "started") runs += 1;
    if (disposition === "started" || disposition === "already-active") {
      sessionOwnedRuns.add(run.id);
    }
  }
  for (const runId of work.hookDispatchRunIds) {
    if (sessionOwnedRuns.has(runId)) continue;
    options.dispatchHooks?.(runId);
  }
  store.pruneHookJournal(new Date(Date.now() - hookJournalRetentionMs));
  return { runs, idleBlockers: work.idleBlockers };
}
