import { assertType, expectTypeOf, test } from "vitest";
import { defineWorkflow, task, z, type ArtifactRef, type TaskContext } from "@acpus/core";
import { lift, template, type Expr, type Resolvable } from "@acpus/expression";
import { refExpr, type ExprIR } from "@acpus/expression/ir";
import type { Result } from "neverthrow";
import {
  childScopes,
  isPositiveInteger,
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
import { compileWorkflowDefinition, type WorkflowDefinition } from "@acpus/core/workflow";

// @ts-expect-error expression helpers must not be exported from the root entrypoint.
import { lift as rootLift } from "@acpus/core";
// @ts-expect-error workflow meta is exposed through build context, not root package values.
import { runtime as rootRuntime } from "@acpus/core";
// @ts-expect-error workflow meta is exposed through build context, not runtime subpath values.
import { runtime as runtimeRef } from "@acpus/core/runtime";
// @ts-expect-error expression types must not be exported from the root entrypoint.
import type { Expr as RootExpr } from "@acpus/core";
// @ts-expect-error IR types must not be exported from the root entrypoint.
import type { WorkflowIR as RootWorkflowIR } from "@acpus/core";
// @ts-expect-error output constraints are internal to workflow interfaces.
import type { OutputValue as RootOutputValue, OutputValues as RootOutputValues } from "@acpus/core";
// @ts-expect-error workflow subpath does not expose standalone output helper types.
import type { OutputValue as WorkflowOutputValue, OutputValues as WorkflowOutputValues } from "@acpus/core/workflow";

test("public package subpaths expose the intended type surface", () => {
  const Input = z.object({ ready: z.boolean(), name: z.string().optional() });
  type InputValue = z.infer<typeof Input>;

  assertType<InputValue>({ ready: true });
  expectTypeOf(refExpr<InputValue>(["input"])).toEqualTypeOf<Expr<InputValue> & { readonly ready: Expr<boolean>; readonly name: Expr<string | undefined> }>();
  assertType<Expr<boolean>>(lift(refExpr<InputValue>(["input"]), input => input.ready === true));
  assertType<Resolvable<string | undefined>>(refExpr<InputValue>(["input"]).name);
  assertType<Expr<string>>(lift(refExpr<InputValue>(["input"]).name, name => name ?? ""));

  const definition = defineWorkflow({ name: "package-subpath-types", inputSchema: Input }).build(({ input }) => ({ ready: input.ready }));
  assertType<WorkflowDefinition<any, any>>(definition);
  assertType<WorkflowIR>(compileWorkflowDefinition(definition));
  assertType<ExprIR>({ kind: "literal", value: true });
  assertType<WorkflowIR["diagnostics"]>(validateWorkflowIR(compileWorkflowDefinition(definition)));
  expectTypeOf(tryParseDurationMs).toEqualTypeOf<(value: string) => Result<number, DurationParseError>>();
  expectTypeOf(isPositiveInteger).toEqualTypeOf<(value: unknown) => value is number>();
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
  if (false) {
    const ref = null as unknown as ArtifactRef;
    assertType<Promise<ArtifactRef>>(ctx.artifact.write("output.txt", "text"));
    assertType<Promise<ArtifactRef>>(ctx.artifact.write("output.bin", new Uint8Array()));
    assertType<string>(ctx.artifact.path(ref));
    // @ts-expect-error ArtifactApi exposes one write method.
    ctx.artifact.writeText("output.txt", "text");
    // @ts-expect-error JSON serialization belongs to the caller.
    ctx.artifact.writeJson("output.json", {});
    // @ts-expect-error Byte writes use artifact.write(...).
    ctx.artifact.writeBytes("output.bin", new Uint8Array());
    // @ts-expect-error File reads belong to the caller.
    ctx.artifact.fromFile("output.txt");
  }
  assertType(task);
  assertType(template);
  void rootLift;
  void rootRuntime;
  void runtimeRef;
  void (null as unknown as RootExpr);
  void (null as unknown as RootWorkflowIR);
  void (null as unknown as RootOutputValue);
  void (null as unknown as RootOutputValues);
  void (null as unknown as WorkflowOutputValue);
  void (null as unknown as WorkflowOutputValues);
});
