import { assertType, test } from "vitest";
import { defineWorkflow, task, z, type TaskContext, type WorkflowDefinition } from "acpus/core";
import { and, eq, gt, gte, lift, lt, lte, ne, not, or, template, type Expr } from "acpus/expression";
import { createWorktree } from "acpus/tasks/git";

test("acpus facade subpaths expose separated authoring surfaces", () => {
  const Input = z.object({ ready: z.boolean(), repo: z.string() });
  type InputValue = z.infer<typeof Input>;

  assertType<InputValue>({ ready: true, repo: "." });
  assertType<Expr<boolean>>(lift(true, ready => ready === true));
  assertType<Expr<boolean>>(lift(true, false, (left, right) => left || right));
  assertType<Expr<boolean>>(lift(true, false, true, (first, second, third) => first || second || third));
  assertType<Expr<boolean>>(lift({ ready: true }, ({ ready }) => ready));
  assertType<Expr<boolean>>(eq("release", "release"));
  assertType<Expr<boolean>>(ne("release", "draft"));
  assertType<Expr<boolean>>(lt(1, 2));
  assertType<Expr<boolean>>(lte(1, 1));
  assertType<Expr<boolean>>(gt(2, 1));
  assertType<Expr<boolean>>(gte(1, 1));
  assertType<Expr<boolean>>(not(false));
  assertType<Expr<boolean>>(and(true, true));
  assertType<Expr<boolean>>(or(false, true));
  assertType<Expr<string>>(template`repo ${"."}`);
  assertType<TaskContext<string>>(null as unknown as TaskContext<string>);
  assertType(task);
  assertType<"external">(createWorktree.kind);

  const definition = defineWorkflow({ name: "facade-types", inputSchema: Input }).build(({ input }) => ({ ready: input.ready }));
  assertType<WorkflowDefinition<any, any>>(definition);
});
