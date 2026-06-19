import type { ExpressionContext, ExecutorResult } from "../types.js";
import type { IrNode } from "@acpus/core";

/**
 * A single execution request handed to an executor. Carries the resolved
 * `nodeKey` (stable node identity, used e.g. to derive an acpx session name)
 * and a `continuation` flag distinguishing a fresh turn from an existing-session turn.
 */
export interface ExecutionRequest {
  node: IrNode;
  context: ExpressionContext;
  signal: AbortSignal;
  /** Resolved node key (includes loop/fanout/lane/subworkflow dimensions). */
  nodeKey: string;
  /** Fully prepared prompt/request text for this executor call. */
  prompt?: string;
  /** Fully rendered semantic session key for explicit same-Run session sharing. */
  sessionKey?: string;
  /** True when continuing a previously paused node (continuation prompt). */
  continuation?: boolean;
  /** True when this is a parse/schema auto-retry iteration (continuation prompt + schema section). */
  retry?: boolean;
  /** Injected env from beforeProgramExec; the executor merges into the child env. */
  injectedEnv?: Record<string, string>;
  /** Called with raw stdout/stderr chunks while the executor is still running. */
  onStream?: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface ExecutorAdapter {
  execute(request: ExecutionRequest): Promise<ExecutorResult>;
}
