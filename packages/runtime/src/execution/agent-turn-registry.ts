export type AgentTurnExecution = Readonly<{
  runId: string;
  nodeKey: string;
  nodeId: string;
  agentSessionId: string;
  attemptId: string;
  turnId: string;
  sessionLeaseId: string;
  abort(reason: "steer"): void;
}>;

export type AgentTurnProof = Readonly<Omit<AgentTurnExecution, "nodeId" | "abort">>;

export class AgentTurnExecutionRegistry {
  private readonly executions = new Map<string, AgentTurnExecution>();

  register(execution: AgentTurnExecution): () => void {
    if (this.executions.has(execution.attemptId)) {
      throw new Error(`Agent Attempt '${execution.attemptId}' already has a registered Turn.`);
    }
    this.executions.set(execution.attemptId, execution);
    return () => {
      if (this.executions.get(execution.attemptId) === execution) this.executions.delete(execution.attemptId);
    };
  }

  get(attemptId: string): AgentTurnExecution | undefined {
    return this.executions.get(attemptId);
  }

  proves(proof: AgentTurnProof): boolean {
    const execution = this.executions.get(proof.attemptId);
    return execution?.runId === proof.runId
      && execution.nodeKey === proof.nodeKey
      && execution.agentSessionId === proof.agentSessionId
      && execution.turnId === proof.turnId
      && execution.sessionLeaseId === proof.sessionLeaseId;
  }
}
