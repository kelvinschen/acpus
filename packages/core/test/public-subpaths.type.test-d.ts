import { assertType, expectTypeOf, test } from "vitest";
import { defineWorkflow, task, z, type TaskContext } from "@acpus/core";
import { fmap, template, type Expr, type Resolvable } from "@acpus/expression";
import { refExpr, type ExprIR } from "@acpus/expression/ir";
import type { Result } from "neverthrow";
import {
  childScopes,
  tryParseDurationMs,
  validateWorkflowIR,
  walkNodes,
  type DurationParseError,
  type FanoutNodeIR,
  type IfNodeIR,
  type LoopNodeIR,
  type LoopTransitionScopeIR,
  type NodeChildScope,
  type NodeIR,
  type NodeVisit,
  type ParallelNodeIR,
  type ScopeIR,
  type SwitchNodeIR,
  type WorkflowIR,
} from "@acpus/core/ir";
import { createDollar, type Dollar } from "@acpus/core/runtime";
import { isSchema, validateValue } from "@acpus/core/schema";
import { compileWorkflowDefinition, type WorkflowDefinition } from "@acpus/core/workflow";

// @ts-expect-error expression helpers must not be exported from the root entrypoint.
import { fmap as rootFmap } from "@acpus/core";
// @ts-expect-error workflow meta is exposed through build context, not root package values.
import { runtime as rootRuntime } from "@acpus/core";
// @ts-expect-error workflow meta is exposed through build context, not runtime subpath values.
import { runtime as runtimeRef } from "@acpus/core/runtime";
// @ts-expect-error expression types must not be exported from the root entrypoint.
import type { Expr as RootExpr } from "@acpus/core";
// @ts-expect-error IR types must not be exported from the root entrypoint.
import type { WorkflowIR as RootWorkflowIR } from "@acpus/core";

test("public package subpaths expose the intended type surface", () => {
  const Input = z.object({ ready: z.boolean(), name: z.string().optional() });
  type InputValue = z.infer<typeof Input>;

  assertType<InputValue>({ ready: true });
  expectTypeOf(refExpr<InputValue>(["input"])).toEqualTypeOf<Expr<InputValue> & { readonly ready: Expr<boolean>; readonly name: Expr<string | undefined> }>();
  assertType<Expr<boolean>>(fmap(refExpr<InputValue>(["input"]), input => input.ready === true));
  assertType<Resolvable<string | undefined>>(refExpr<InputValue>(["input"]).name);
  assertType<Expr<string>>(fmap(refExpr<InputValue>(["input"]).name, name => name ?? ""));

  const definition = defineWorkflow({ name: "package-subpath-types", inputSchema: Input }).build(({ input }) => ({ ready: input.ready }));
  assertType<WorkflowDefinition<any, any>>(definition);
  assertType<WorkflowIR>(compileWorkflowDefinition(definition));
  assertType<ExprIR>({ kind: "literal", value: true });
  assertType<WorkflowIR["diagnostics"]>(validateWorkflowIR(compileWorkflowDefinition(definition)));
  expectTypeOf(tryParseDurationMs).toEqualTypeOf<(value: string) => Result<number, DurationParseError>>();
  expectTypeOf<DurationParseError>().toEqualTypeOf<
    | { type: "invalid-duration-syntax"; value: string }
    | { type: "duration-out-of-range"; value: string }
  >();
  expectTypeOf(childScopes).toEqualTypeOf<(node: NodeIR) => readonly NodeChildScope[]>();
  expectTypeOf(walkNodes).toEqualTypeOf<(scope: ScopeIR) => IterableIterator<NodeVisit>>();
  expectTypeOf<NodeVisit>().toEqualTypeOf<{
    node: NodeIR;
    ancestry: readonly NodeChildScope[];
  }>();
  expectTypeOf<NodeChildScope>().toEqualTypeOf<
    | { kind: "if"; owner: IfNodeIR; branchId: "then" | "else"; scope: ScopeIR }
    | {
        kind: "switch";
        owner: SwitchNodeIR;
        branchId: `case:${number}` | "default";
        scope: ScopeIR;
      }
    | { kind: "parallel"; owner: ParallelNodeIR; branchId: string; scope: ScopeIR }
    | { kind: "fanout"; owner: FanoutNodeIR; scope: ScopeIR }
    | { kind: "loop"; owner: LoopNodeIR; scope: LoopTransitionScopeIR }
  >();

  assertType<Dollar>(createDollar());
  const ctx = null as unknown as TaskContext<{}>;
  expectTypeOf<keyof TaskContext<{}>>().toEqualTypeOf<"input" | "$" | "artifact" | "env" | "abortSignal">();
  expectTypeOf(ctx.env).toEqualTypeOf<Record<string, string | undefined>>();
  assertType<Dollar>(ctx.$);
  assertType<AbortSignal>(ctx.abortSignal);
  assertType(task);
  assertType(template);
  assertType<boolean>(isSchema(Input));
  assertType(validateValue(Input, { ready: true }));

  void rootFmap;
  void rootRuntime;
  void runtimeRef;
  void (null as unknown as RootExpr);
  void (null as unknown as RootWorkflowIR);
});
