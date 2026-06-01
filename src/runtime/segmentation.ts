import type { Stage, WorkflowSpec } from "../schema/workflow-spec.js";

export type FanoutSplitPlan = {
  fanout: Extract<Stage, { kind: "fanout" }>;
  upstreamStageIds: string[];
  downstreamStageIds: string[];
  continuationStartStageId?: string;
  batchSize: number;
};

export function fanoutSplitPlan(spec: WorkflowSpec): FanoutSplitPlan | undefined {
  const byId = new Map(spec.stages.map((stage) => [stage.id, stage] as const));
  const dependents = computeDependents(spec);
  const fanout = spec.stages.find((stage): stage is Extract<Stage, { kind: "fanout" }> =>
    stage.kind === "fanout" && effectiveConcurrency(spec, stage) > 1
  );
  if (!fanout) return undefined;
  const upstream = ancestorsOf(fanout.id, byId);
  const downstream = descendantsOf(fanout.id, dependents);
  return {
    fanout,
    upstreamStageIds: spec.stages.map((stage) => stage.id).filter((id) => upstream.has(id)),
    downstreamStageIds: spec.stages.map((stage) => stage.id).filter((id) => downstream.has(id)),
    continuationStartStageId: dependents.get(fanout.id)?.[0],
    batchSize: effectiveConcurrency(spec, fanout)
  };
}

export function resolveFanoutItems(stage: Extract<Stage, { kind: "fanout" }>, workflowInput: Record<string, unknown>, outputs: Record<string, unknown>): unknown[] {
  const value = resolveSource(stage.items.source, workflowInput, outputs);
  return Array.isArray(value) ? value : [];
}

export function readSourceStageId(source: string): string | undefined {
  const parts = source.split(".");
  return parts[0] === "outputs" ? parts[1] : undefined;
}

function effectiveConcurrency(spec: WorkflowSpec, stage: Stage): number {
  const global = spec.limits.maxConcurrency ?? 1;
  const local = stage.limits?.maxConcurrency ?? global;
  return Math.max(1, Math.min(global, local));
}

function computeDependents(spec: WorkflowSpec): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const stage of spec.stages) {
    for (const dep of stage.dependsOn ?? []) {
      const list = dependents.get(dep) ?? [];
      list.push(stage.id);
      dependents.set(dep, list);
    }
  }
  return dependents;
}

function ancestorsOf(id: string, byId: Map<string, Stage>): Set<string> {
  const result = new Set<string>();
  const visit = (stageId: string): void => {
    const stage = byId.get(stageId);
    for (const dep of stage?.dependsOn ?? []) {
      if (result.has(dep)) continue;
      result.add(dep);
      visit(dep);
    }
  };
  visit(id);
  return result;
}

function descendantsOf(id: string, dependents: Map<string, string[]>): Set<string> {
  const result = new Set<string>();
  const visit = (stageId: string): void => {
    for (const next of dependents.get(stageId) ?? []) {
      if (result.has(next)) continue;
      result.add(next);
      visit(next);
    }
  };
  visit(id);
  return result;
}

function resolveSource(source: string, workflowInput: Record<string, unknown>, outputs: Record<string, unknown>): unknown {
  const parts = source.split(".");
  const root = parts.shift();
  let current: unknown;
  if (root === "input") current = workflowInput;
  else if (root === "outputs") current = outputs;
  else return undefined;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
