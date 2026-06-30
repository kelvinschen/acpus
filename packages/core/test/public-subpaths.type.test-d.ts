import { assertType, expectTypeOf, test } from "vitest";
import { defineWorkflow, task, template, z, type TaskContext } from "@acpus/core";
import { fallback, refExpr, where, type Expr, type WorkflowValue } from "@acpus/core/expression";
import { validateWorkflowIR, type ExprIR, type WorkflowIR } from "@acpus/core/ir";
import { createDollar, type Dollar } from "@acpus/core/runtime";
import { isSchema, validateValue, type InferSchema } from "@acpus/core/schema";
import { compileWorkflowDefinition, type WorkflowDefinition } from "@acpus/core/workflow";

// @ts-expect-error expression helpers must not be exported from the root entrypoint.
import { where as rootWhere } from "@acpus/core";
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
  type InputValue = InferSchema<typeof Input>;

  assertType<InputValue>({ ready: true });
  expectTypeOf(refExpr<InputValue>(["input"])).toEqualTypeOf<Expr<InputValue> & { readonly ready: Expr<boolean>; readonly name: Expr<string | undefined> }>();
  assertType<Expr<boolean>>(where(refExpr<InputValue>(["input"]), { ready: true }));
  assertType<WorkflowValue<string | undefined>>(refExpr<InputValue>(["input"]).name);
  assertType<Expr<string>>(fallback(refExpr<InputValue>(["input"]).name, ""));

  const definition = defineWorkflow({ name: "package-subpath-types", inputSchema: Input }).build(({ input }) => ({ ready: input.ready }));
  assertType<WorkflowDefinition<any, any>>(definition);
  assertType<WorkflowIR>(compileWorkflowDefinition(definition));
  assertType<ExprIR>({ kind: "literal", value: true });
  assertType<WorkflowIR["diagnostics"]>(validateWorkflowIR(compileWorkflowDefinition(definition)));

  assertType<Dollar>(createDollar());
  const ctx = null as unknown as TaskContext<{}>;
  assertType<Dollar>(ctx.$);
  assertType(task);
  assertType(template);
  assertType<boolean>(isSchema(Input));
  assertType(validateValue(Input, { ready: true }));

  void rootWhere;
  void rootRuntime;
  void runtimeRef;
  void (null as unknown as RootExpr);
  void (null as unknown as RootWorkflowIR);
});
