import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import type { Simplify, ValueOf } from "../../internal/type-utils.js";
import { toSchemaIR, type InferSchema, type Schema } from "../../schema/index.js";
import type { DiagnosticIR, ParallelBranchIR, ParallelNodeIR } from "../../ir/types.js";
import type { BuildScope, ObjectSchema, ParallelStrategy, ScopeCallback, ScopeOutput } from "./shared.js";

export type ParallelBranchSpec<OutSchema extends ObjectSchema> = {
  outputSchema: OutSchema;
  do: ScopeCallback<ScopeOutput<InferSchema<OutSchema>>>;
};

export type ParallelStepSpec<
  Branches extends Record<string, ObjectSchema> = Record<string, ObjectSchema>,
  Strategy extends ParallelStrategy = "all",
> = Simplify<{
  branches: { [K in keyof Branches]: ParallelBranchSpec<Branches[K]> };
  maxConcurrency?: number;
} & (Strategy extends "race" ? { strategy: "race" } : { strategy?: "all" })>;

type BranchOutputs<Branches extends Record<string, ObjectSchema>> = {
  readonly [K in keyof Branches]: InferSchema<Branches[K]>;
};

export type ParallelNodeRefOutput<
  Branches extends Record<string, ObjectSchema>,
  Strategy extends ParallelStrategy,
> = Strategy extends "race"
  ? {
      winner: Extract<keyof Branches, string>;
      result: ValueOf<BranchOutputs<Branches>>;
    }
  : BranchOutputs<Branches>;

export function buildParallelNode<
  Branches extends Record<string, ObjectSchema>,
  Strategy extends ParallelStrategy,
>(
  id: string,
  spec: ParallelStepSpec<Branches, Strategy>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope,
): ParallelNodeIR {
  assertStableId(id, diagnostics);
  const branches: Record<string, ParallelBranchIR> = {};
  for (const [key, branch] of Object.entries(spec.branches) as Array<[string, ParallelBranchSpec<ObjectSchema>]>) {
    branches[key] = {
      outputSchema: toSchemaIR(branch.outputSchema),
      scope: buildScope<{}, ScopeOutput<InferSchema<typeof branch.outputSchema>>>(branch.do),
    };
  }
  return stripUndefined({
    id,
    kind: "parallel",
    strategy: spec.strategy ?? "all",
    maxConcurrency: spec.maxConcurrency,
    branches,
  }) as ParallelNodeIR;
}
