import type { AdvanceRunSummary } from "../scheduler/advance.js";
import { advanceFrozenRun, type RuntimeHookCursor } from "../scheduler/runtime-runner.js";
import type { RuntimeStore } from "../store/store.js";
import type { HookRunner } from "../hooks/runner.js";
import type { NodeProgressWriter } from "../progress/writer.js";
import { loadAgentHostPolicy, type AgentHostPolicy } from "../configuration.js";

type RuntimeAdvanceOptions = {
  maxLeafConcurrency?: number;
  agentHostPolicy?: AgentHostPolicy;
  hookRunner?: HookRunner;
  hookCursor?: RuntimeHookCursor;
  progressWriter?: NodeProgressWriter;
};

export async function advanceRuntimeRun(cwd: string, store: RuntimeStore, runId: string, ownerId: string, options: RuntimeAdvanceOptions = {}): Promise<AdvanceRunSummary> {
  if (!store.getFrozenRun(runId)) {
    throw new Error(`Run '${runId}' was not found.`);
  }
  const hookCursor = options.hookCursor ?? { sequence: store.getLastRunEventSequence(runId) };
  const agentHostPolicy = options.agentHostPolicy ?? loadAgentHostPolicy(process.env);
  return advanceFrozenRun({
    cwd,
    store,
    runId,
    ownerId,
    ...(options.maxLeafConcurrency === undefined ? {} : { maxLeafConcurrency: options.maxLeafConcurrency }),
    agentHostPolicy,
    ...(options.hookRunner === undefined ? {} : { hookRunner: options.hookRunner }),
    hookCursor,
    ...(options.progressWriter === undefined ? {} : { progressWriter: options.progressWriter }),
  });
}
