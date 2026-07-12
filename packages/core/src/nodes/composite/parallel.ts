import { assertStableId, stripUndefined } from "../../graph/lowering.js";
import { valueToExprIR } from "@acpus/expression/ir";
import type { Resolvable } from "@acpus/expression";
import type { Simplify, ValueOf } from "../../internal/type-utils.js";
import type { DiagnosticIR, ParallelNodeIR, ScopeIR } from "../../ir/types.js";
import type { BuildScope, CheckedScopeCallback, ParallelStrategy, RuntimeValueOf, ScopeCallback, ScopeOutput } from "./shared.js";

type CheckedBranches<Branches extends Record<string, ScopeCallback>> = {
  readonly [Key in keyof Branches]: Branches[Key] & CheckedScopeCallback<NoInfer<Branches[Key]>>;
};

/** Authoring spec for static parallel branches. */
export type ParallelStepSpec<
  Branches extends Record<string, ScopeCallback> = Record<string, ScopeCallback>,
  Strategy extends ParallelStrategy = "all",
> = Simplify<{
  branches: Branches & CheckedBranches<NoInfer<Branches>>;
  maxConcurrency?: Resolvable<number | undefined>;
} & (Strategy extends "race" ? { strategy: "race" } : { strategy?: "all" })>;

type BranchOutput<Branch> = Branch extends ScopeCallback ? RuntimeValueOf<ScopeOutput<Branch>> : never;
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
  const branches: Record<string, ScopeIR> = {};
  for (const [key, branch] of Object.entries(spec.branches) as Array<[string, ScopeCallback]>) {
    branches[key] = buildScope(branch);
  }
  return stripUndefined({
    id,
    kind: "parallel",
    strategy: spec.strategy ?? "all",
    maxConcurrency: spec.maxConcurrency === undefined ? undefined : valueToExprIR(spec.maxConcurrency),
    branches,
  }) as ParallelNodeIR;
}
