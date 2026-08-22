import * as Effect from "effect/Effect";
import type { RuntimeStoreBusy, RuntimeStoreShape } from "../store/service.js";

const hookJournalRetentionMs = 7 * 24 * 60 * 60 * 1_000;

export type RuntimeTickResult = {
  runs: number;
  idleBlockers: number;
};

export function runRuntimeTick(store: Pick<RuntimeStoreShape, "listRuntimeWork" | "pruneHookJournal">, options: {
  startSession: (runId: string) => Effect.Effect<"started" | "already-active" | "terminal" | "quarantined", RuntimeStoreBusy>;
  dispatchHooks?: (runId: string) => Effect.Effect<"dispatched" | "retry" | "quarantined">;
}): Effect.Effect<RuntimeTickResult, RuntimeStoreBusy> {
  return Effect.gen(function* () {
    let runs = 0;
    const sessionOwnedRuns = new Set<string>();
    const work = yield* store.listRuntimeWork();
    for (const run of work.startableRuns) {
      const disposition = yield* options.startSession(run.id);
      if (disposition === "started") runs += 1;
      if (disposition === "started" || disposition === "already-active") {
        sessionOwnedRuns.add(run.id);
      }
    }
    for (const runId of work.hookDispatchRunIds) {
      if (sessionOwnedRuns.has(runId)) continue;
      if (options.dispatchHooks) yield* options.dispatchHooks(runId);
    }
    yield* store.pruneHookJournal(new Date(Date.now() - hookJournalRetentionMs));
    return { runs, idleBlockers: work.idleBlockers };
  });
}
