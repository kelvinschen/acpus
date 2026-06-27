import type { ExpressionContext, ExecutorResult } from "../types.js";
import type { IrNode } from "@acpus/core";

export interface BaseExecutionRequest {
  node: IrNode;
  context: ExpressionContext;
  signal: AbortSignal;
  /** Resolved node key (includes loop/fanout/lane/subworkflow dimensions). */
  nodeKey: string;
}

export interface AgentExecutionRequest extends BaseExecutionRequest {
  kind: "agent";
  /** Fully prepared prompt/request text for this executor call. */
  prompt?: string;
  /** Fully rendered semantic session key for explicit same-Run session sharing. */
  sessionKey?: string;
  /** True when continuing a previously paused node (continuation prompt). */
  continuation?: boolean;
  /** True when this is a parse/schema auto-retry iteration (continuation prompt + schema section). */
  retry?: boolean;
  /** Called with raw stdout/stderr chunks while the executor is still running. */
  onStream?: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface ProgramExecutionRequest extends BaseExecutionRequest {
  kind: "program";
  /** Injected env from beforeProgramExec; the executor merges into the child env. */
  injectedEnv?: Record<string, string>;
}

export type ExecutionRequest = AgentExecutionRequest | ProgramExecutionRequest;

export interface ExecutorAdapter<TRequest extends ExecutionRequest = ExecutionRequest> {
  execute(request: TRequest): Promise<ExecutorResult>;
}
