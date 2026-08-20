import { err, ok, type Result } from "neverthrow";
import type { FrozenSchedulerRun } from "./settle.js";
import type { SchedulerSnapshot } from "./store-port.js";
import { indexNodes } from "./ir-walk.js";

export type RetrySessionImpactError = Readonly<{
  type: "shared_session_retry_requires_fork";
  nodeKey: string;
}>;

export type RetrySessionImpact = Readonly<{
  agentSessionIds: readonly string[];
}>;

export function planRetrySessionImpact(input: Readonly<{
  frozen: FrozenSchedulerRun;
  snapshot: SchedulerSnapshot;
  reexecutedNodeKeys: readonly string[];
  materializedSessions?: readonly Readonly<{ agentSessionId: string; nodeKey: string }>[];
}>): Result<RetrySessionImpact, RetrySessionImpactError> {
  const nodes = indexNodes(input.frozen.ir.root);
  const reexecuted = new Set(input.reexecutedNodeKeys);
  for (const nodeKey of input.reexecutedNodeKeys) {
    const instance = input.snapshot.projection.instances[nodeKey];
    const node = instance === undefined ? undefined : nodes.get(instance.nodeId);
    if (node?.kind === "agent" && node.run.sessionKey !== undefined) {
      return err({ type: "shared_session_retry_requires_fork", nodeKey });
    }
  }
  return ok({
    agentSessionIds: [...new Set((input.materializedSessions ?? [])
      .filter(session => reexecuted.has(session.nodeKey))
      .map(session => session.agentSessionId))].sort(),
  });
}
