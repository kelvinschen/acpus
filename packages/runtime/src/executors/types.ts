import type { ExpressionContext, ExecutorResult } from "../types.js";
import type { IrNode } from "@acpus/core";

export interface ExecutorAdapter {
  execute(node: IrNode, context: ExpressionContext, signal: AbortSignal): Promise<ExecutorResult>;
}
