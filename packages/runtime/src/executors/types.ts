import type { ExpressionContext, ExecutorResult } from "../types.js";
import type { IrNode } from "@acpus/core";

/**
 * A single execution request handed to an executor. Carries the resolved
 * `nodeKey` (stable node identity, used e.g. to derive an acpx session name)
 * and a `resume` flag distinguishing a fresh run from a continuation.
 */
export interface ExecutionRequest {
  node: IrNode;
  context: ExpressionContext;
  signal: AbortSignal;
  /** Resolved node key (includes loop/fanout/lane/subworkflow dimensions). */
  nodeKey: string;
  /** True when continuing a previously paused node (continuation prompt). */
  resume?: boolean;
  /** True when this is a parse/schema auto-retry iteration (continuation prompt + schema section). */
  retry?: boolean;
}

export interface ExecutorAdapter {
  execute(request: ExecutionRequest): Promise<ExecutorResult>;
}
