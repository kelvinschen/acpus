import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import { toSchemaIR, type Schema } from "../../schema/index.js";
import type { DiagnosticIR, ParallelNodeIR, ScopeIR } from "../../ir/types.js";
import type { BuildScope, JoinMode, ScopeCallback } from "./shared.js";

export type ParallelStepSpec<Branches extends Record<string, ScopeCallback>> = {
  branches: Branches;
  join?: JoinMode;
  maxConcurrency?: number;
  output?: Schema<any>;
};

export function buildParallelNode<Branches extends Record<string, ScopeCallback>>(
  id: string,
  spec: ParallelStepSpec<Branches>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope,
): ParallelNodeIR {
  assertStableId(id, diagnostics);
  const branches: Record<string, ScopeIR> = {};
  for (const [key, fn] of Object.entries(spec.branches)) branches[key] = buildScope(fn);
  return stripUndefined({
    id,
    kind: "parallel",
    branches,
    join: spec.join,
    maxConcurrency: spec.maxConcurrency,
    outputSchema: spec.output ? toSchemaIR(spec.output) : undefined,
  }) as ParallelNodeIR;
}
