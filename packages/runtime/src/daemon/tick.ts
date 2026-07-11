import type { RuntimeStore } from "../store/store.js";

const hookJournalRetentionMs = 7 * 24 * 60 * 60 * 1_000;

export type DaemonTickResult = {
  runs: number;
  idleBlockers: number;
};

export async function runDaemonTick(store: RuntimeStore, options: { startSession: (runId: string) => void }): Promise<DaemonTickResult> {
  await store.cleanupRunDirectories();
  let runs = 0;
  const work = store.listDaemonWork();
  for (const run of work.startableRuns) {
    options.startSession(run.id);
    runs += 1;
  }
  try {
    store.pruneHookJournal(new Date(Date.now() - hookJournalRetentionMs));
  } catch {
    // Retention is opportunistic and must not block scheduling.
  }
  return { runs, idleBlockers: work.idleBlockers };
}
