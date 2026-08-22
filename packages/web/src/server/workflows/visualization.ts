import { walkNodes, type WorkflowIR } from "@acpus/core/ir";
import { staticExprShape } from "@acpus/expression/ir";
import { tryPrepareWorkflow, type WorkflowPreparationFailure } from "@acpus/workflow-compiler";
import * as Effect from "effect/Effect";
import type {
  WorkflowVisualizationResult,
  WorkflowVisualizationSource,
} from "../../api-types.js";
import { workflowIrToWebGraph } from "../graph.js";
import {
  resolveWorkflowSource,
  type WorkflowSourceFailure,
} from "./source.js";

type WorkflowVisualizationFailure = WorkflowSourceFailure | WorkflowPreparationFailure;

type ReadyWorkflowVisualization = Extract<WorkflowVisualizationResult, { status: "ready" }>;

export function tryVisualizeWorkflowSource(
  cwd: string,
  source: WorkflowVisualizationSource,
): Effect.Effect<ReadyWorkflowVisualization, WorkflowVisualizationFailure> {
  return resolveWorkflowSource(cwd, source)
    .pipe(Effect.flatMap(workflow => tryPrepareWorkflow({
      workspaceDir: cwd,
      source: { kind: "path", entry: workflow },
    })), Effect.map(prepared => staticWorkflowVisualization(prepared.ir, prepared.sourceGraphDigest)));
}
export function staticWorkflowVisualization(ir: WorkflowIR, sourceGraphDigest: string): ReadyWorkflowVisualization {
  return {
    status: "ready",
    graph: workflowIrToWebGraph(ir),
    workflow: {
      name: ir.name,
      ...(ir.description === undefined ? {} : { description: ir.description }),
      agents: ir.agents,
      irVersion: ir.irVersion,
      nodeCount: Array.from(walkNodes(ir.root)).length,
    },
    contract: {
      ...(ir.inputSchema === undefined ? {} : { inputSchema: ir.inputSchema }),
      output: ir.root.output,
      outputShape: staticExprShape(ir.root.output),
    },
    sourceGraphDigest,
  };
}
