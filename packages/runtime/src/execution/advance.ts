import type { JsonValue } from "@acpus/core";
import { getProviderCommandFromEnv } from "@acpus/agent-executor";
import { executeAgentNode } from "./agent-node.js";
import { ExecutorRequiredError, RuntimeNodeError, SignalAwaitingError, executeWorkflow } from "./scheduler.js";
import type { RuntimeStore } from "../store/store.js";
import { executeTaskNode } from "./task-executor.js";

export type AdvanceResult =
  | { status: "completed"; run: ReturnType<RuntimeStore["completeRun"]> }
  | { status: "awaiting"; run: ReturnType<RuntimeStore["awaitSignal"]>; nodeKey: string }
  | { status: "blocked"; run: NonNullable<ReturnType<RuntimeStore["getRun"]>> }
  | { status: "failed"; run: ReturnType<RuntimeStore["failRun"]>; message: string };

export async function advanceRun(cwd: string, store: RuntimeStore, runId: string): Promise<AdvanceResult> {
  const frozen = store.getFrozenRun(runId);
  if (!frozen) throw new Error(`Run '${runId}' was not found.`);
  try {
    const execution = await executeWorkflow(frozen.ir, frozen.input, {
      signalPayloads: store.getSignalPayloads(runId),
      completedNodes: store.getCompletedNodeOutputs(runId),
      taskExecutor: (node, scope) => executeTaskNode(node, scope, { cwd, runId, store }),
      agentExecutor: (node, scope) => executeAgentNode(node, scope, { cwd, agents: frozen.ir.agents, getProviderCommand: getProviderCommandFromEnv }),
    });
    return {
      status: "completed",
      run: store.completeRun({
        runId,
        output: execution.output as JsonValue,
        nodes: execution.executedNodes,
      }),
    };
  } catch (error) {
    if (error instanceof SignalAwaitingError) {
      return {
        status: "awaiting",
        nodeKey: error.nodeId,
        run: store.awaitSignal({ runId, nodeKey: error.nodeId, nodes: error.executedNodes }),
      };
    }
    if (error instanceof ExecutorRequiredError) {
      if (Object.keys(error.executedNodes).length > 0) store.persistCompletedNodes({ runId, nodes: error.executedNodes });
      store.blockRun({ runId, nodeKey: error.nodeId, message: error.message });
      const run = store.getRun(runId);
      if (!run) throw new Error(`Run '${runId}' was not found.`);
      return { status: "blocked", run };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof RuntimeNodeError && Object.keys(error.executedNodes).length > 0) {
      store.persistCompletedNodes({ runId, nodes: error.executedNodes });
    }
    return {
      status: "failed",
      message,
      run: store.failRun({
        runId,
        message,
        ...(error instanceof RuntimeNodeError ? { nodeKey: error.nodeId } : {}),
      }),
    };
  }
}
