import type { WorkflowIR } from "@acpus/core/ir";
import type { StaticExprShape } from "@acpus/expression/ir";
import type { WorkflowPreparationFailure } from "@acpus/workflow-compiler";
import type { WebGraph } from "./graph-types.js";

export type WorkflowVisualizationSource =
  | { kind: "catalog"; name: string }
  | { kind: "file"; path: string };

export type WorkflowVisualizationResult =
  | {
    status: "ready";
    graph: WebGraph;
    workflow: { name: string; description?: string; irVersion: number; nodeCount: number };
    contract: {
      inputSchema?: WorkflowIR["inputSchema"];
      output: WorkflowIR["root"]["output"];
      outputShape: StaticExprShape;
    };
    sourceGraphDigest: string;
  }
  | {
    status: "failed";
    phase: WorkflowPreparationFailure["phase"];
    message: string;
  };

export type NodeExecutionInspection = {
  available: boolean;
  reason?: string;
  summary: {
    status?: string;
    sessionName?: string;
    turnCount?: number;
    message?: string;
  };
  lastObservedAt?: string;
  contextWindow?: {
    used?: number;
    size?: number;
    percent?: number;
    updatedAt?: string;
  };
  tokenUsage?: {
    source?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  output?: {
    tail: string;
    totalBytes: number;
    truncated: boolean;
  };
  toolCallCount?: number;
  lastToolCalls: Array<{
    turn: number;
    toolCallId?: string;
    toolName?: string;
    status?: string;
    durationMs?: number;
    inputPreview?: string;
  }>;
};
