import type { AcpusIr, HookPayload, IrNode } from "@acpus/core";
import type { ExpressionContext, NodeExecutionState, NodeKeyDynamic, RunState } from "../types.js";

/** Run-scoped fields shared by every payload built during a Run. */
export interface RunScope {
  runId: string;
  workflowName: string;
  workflowSourcePath: string;
  workflowSourceDir: string;
  cwd: string;
}

/** Derive the run scope once per Run from the frozen IR and metadata. */
export function runScope(ir: AcpusIr, meta: RunState): RunScope {
  const sourcePath = meta.workflowSourcePath ?? ir.source.path ?? "";
  return {
    runId: meta.runId,
    workflowName: meta.workflowName,
    workflowSourcePath: sourcePath,
    workflowSourceDir: sourcePath ? dirnameOf(sourcePath) : "",
    cwd: process.cwd()
  };
}

/** Base payload carrying the common fields for any hook event/injector. */
export function basePayload(scope: RunScope, hookEventName: string): HookPayload {
  return {
    hook_event_name: hookEventName,
    run_id: scope.runId,
    workflow_name: scope.workflowName,
    workflow_source_path: scope.workflowSourcePath,
    workflow_source_dir: scope.workflowSourceDir,
    cwd: scope.cwd,
    timestamp: new Date().toISOString()
  };
}

/** Attach node-level identity and dynamic-context fields to a payload. */
export function withNodeFields(
  payload: HookPayload,
  node: IrNode,
  nodeKey: string,
  state: NodeExecutionState | undefined,
  dynamic: NodeKeyDynamic,
  ctx?: ExpressionContext
): HookPayload {
  payload.node_key = nodeKey;
  payload.node_id = node.id;
  payload.node_kind = node.kind;
  if (state?.attempt !== undefined) payload.node_attempt = state.attempt;
  if (dynamic.loopRound !== undefined) payload.loop_round = dynamic.loopRound;
  if (dynamic.fanoutItemId !== undefined) payload.fanout_item_id = dynamic.fanoutItemId;
  if (dynamic.laneId !== undefined) payload.parallel_lane_id = dynamic.laneId;
  if (ctx?.item_index !== undefined) payload.fanout_item_index = ctx.item_index;
  return payload;
}

function dirnameOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : idx === 0 ? "/" : "";
}
