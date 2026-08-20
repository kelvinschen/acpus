import type { JsonValue } from "@acpus/expression/ir";
import type { Sha256Digest } from "@acpus/core/content-identity";
import type { AgentSessionCheckpointValue } from "../execution/agent-operation-plan.js";
import type { AgentAttemptSessionBinding } from "../scheduler/store-port.js";

export type ForkReplayArtifact = {
  id: string;
  nodeKey?: string;
  attempt: number;
  mediaType?: string;
  digest: string;
  size: number;
  relativePath: string;
};

export type ForkReplayFact = {
  nodeKey: string;
  sourceSequence: number;
  operationDigest: string;
  inputDigest: string;
  sessionGroupDigest?: string;
  output?: JsonValue;
  artifacts: ForkReplayArtifact[];
};

export type AgentSessionReplaySession = Readonly<{
  agentSessionId: string;
  runId: string;
  scopeDigest: Sha256Digest;
  generation: number;
  explicitShared: boolean;
  bindingDigest?: Sha256Digest;
  reportedVersion?: string;
  lifecycle: "active" | "abandoned";
  checkpoint: AgentSessionCheckpointValue;
}>;

export type AgentSessionAuthorityReplay = Readonly<{
  sessions: readonly AgentSessionReplaySession[];
  bindings: readonly AgentAttemptSessionBinding[];
}>;

export function replayAgentSessionAuthority(input: Readonly<{
  runId: string;
  sessions: readonly AgentSessionReplaySession[];
  bindings: readonly AgentAttemptSessionBinding[];
}>): AgentSessionAuthorityReplay {
  const sessions = [...input.sessions].sort((left, right) => left.scopeDigest.localeCompare(right.scopeDigest)
    || left.generation - right.generation);
  const sessionIds = new Set<string>();
  const activeScopes = new Set<string>();
  for (const session of sessions) {
    if (session.runId !== input.runId || sessionIds.has(session.agentSessionId)) {
      throw new Error(`Agent Session replay for run '${input.runId}' contains a duplicate or cross-run Session.`);
    }
    sessionIds.add(session.agentSessionId);
    if (session.lifecycle === "active") {
      if (activeScopes.has(session.scopeDigest)) throw new Error(`Agent Session scope '${session.scopeDigest}' has multiple active generations.`);
      activeScopes.add(session.scopeDigest);
    }
  }
  const bindings = [...input.bindings].sort((left, right) => left.attemptId.localeCompare(right.attemptId));
  const attemptIds = new Set<string>();
  for (const binding of bindings) {
    if (binding.runId !== input.runId || !sessionIds.has(binding.agentSessionId) || attemptIds.has(binding.attemptId)) {
      throw new Error(`Agent Session replay for run '${input.runId}' contains an invalid binding.`);
    }
    attemptIds.add(binding.attemptId);
  }
  return {
    sessions,
    bindings,
  };
}
