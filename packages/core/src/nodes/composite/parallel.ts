import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import type { Simplify, ValueOf } from "../../internal/type-utils.js";
import type { DiagnosticIR, ParallelBranchIR, ParallelNodeIR } from "../../ir/types.js";
import type { BuildScope, ParallelStrategy, RuntimeValueOf, ScopeCallback } from "./shared.js";

/** Authoring spec for static parallel branches. */
export type ParallelStepSpec<
  Branches extends Record<string, ScopeCallback> = Record<string, ScopeCallback>,
  Strategy extends ParallelStrategy = "all",
> = Simplify<{
  branches: Branches;
  maxConcurrency?: number;
} & (Strategy extends "race" ? { strategy: "race" } : { strategy?: "all" })>;

type BranchOutput<Branch> = Branch extends (ctx: never) => infer Output ? RuntimeValueOf<Output> : never;
type BranchOutputs<Branches extends Record<string, ScopeCallback>> = {
  readonly [K in keyof Branches]: BranchOutput<Branches[K]>;
};

export type ParallelNodeRefOutput<
  Branches extends Record<string, ScopeCallback>,
  Strategy extends ParallelStrategy,
> = Strategy extends "race"
  ? {
      winner: Extract<keyof Branches, string>;
      result: ValueOf<BranchOutputs<Branches>>;
    }
  : BranchOutputs<Branches>;

export function buildParallelNode<
  Branches extends Record<string, ScopeCallback>,
  Strategy extends ParallelStrategy,
>(
  id: string,
  spec: ParallelStepSpec<Branches, Strategy>,
  diagnostics: DiagnosticIR[],
  buildScope: BuildScope,
): ParallelNodeIR {
  assertStableId(id, diagnostics);
  const branches: Record<string, ParallelBranchIR> = {};
  for (const [key, branch] of Object.entries(spec.branches) as Array<[string, ScopeCallback]>) {
    branches[key] = {
      scope: buildScope(branch),
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
