import type { AdvanceRunSummary } from "../scheduler/advance.js";
import { advanceFrozenRun, type RuntimeHookCursor } from "../scheduler/runtime-runner.js";
import type { RunOwnerClaim } from "../scheduler/store-port.js";
import type { RuntimeStore } from "../store/store.js";
import type { HookRunner } from "../hooks/runner.js";
import type { NodeProgressWriter } from "../progress/writer.js";

type RuntimeAdvanceOptions = {
  onClaim?: (claim: RunOwnerClaim) => void;
  onRelease?: (claim: RunOwnerClaim) => void;
  onActiveAttempt?: Parameters<typeof advanceFrozenRun>[0]["onActiveAttempt"];
  hookRunner?: HookRunner;
  hookCursor?: RuntimeHookCursor;
  progressWriter?: NodeProgressWriter;
};

export async function advanceRuntimeRun(cwd: string, store: RuntimeStore, runId: string, ownerId: string, options: RuntimeAdvanceOptions = {}): Promise<AdvanceRunSummary> {
  if (!store.getFrozenRun(runId)) {
    throw new Error(`Run '${runId}' was not found.`);
  }
  const hookCursor = options.hookCursor ?? { sequence: store.getLastRunEventSequence(runId) };
  let last: AdvanceRunSummary | undefined;
  for (let drives = 0; drives < 1_000; drives += 1) {
    last = await advanceFrozenRun({
      cwd,
      store,
      runId,
      ownerId,
      ...(options.onClaim === undefined ? {} : { onClaim: options.onClaim }),
      ...(options.onRelease === undefined ? {} : { onRelease: options.onRelease }),
      ...(options.onActiveAttempt === undefined ? {} : { onActiveAttempt: options.onActiveAttempt }),
      ...(options.hookRunner === undefined ? {} : { hookRunner: options.hookRunner }),
      hookCursor,
      ...(options.progressWriter === undefined ? {} : { progressWriter: options.progressWriter }),
    });
    if (last.status === "idle" && madeProgress(last)) continue;
    if (last.status !== "idle" || !madeProgress(last)) return last;
  }
  throw new Error(`Run '${runId}' did not quiesce after 1000 scheduler drives.`);
}

function madeProgress(summary: AdvanceRunSummary): boolean {
  return summary.started + summary.completed + summary.failed + summary.cancelled > 0;
}
