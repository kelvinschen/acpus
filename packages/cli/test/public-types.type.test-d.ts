import { assertType, test } from "vitest";
import { defineWorkflow, task, z, type InferSchema, type TaskContext, type WorkflowDefinition } from "acpus/core";
import { fmap, lift, lift2, lift3, template, type Expr } from "acpus/expression";
import { createWorktree, type CreateWorktreeInput } from "acpus/tasks/git";
// @ts-expect-error old algebra helpers are not exported from the facade.
import { eq } from "acpus/expression";

void eq;

test("acpus facade subpaths expose separated authoring surfaces", () => {
  const Input = z.object({ ready: z.boolean(), repo: z.path() });
  type InputValue = InferSchema<typeof Input>;

  assertType<InputValue>({ ready: true, repo: "." });
  assertType<Expr<boolean>>(fmap(true, ready => ready === true));
  assertType<Expr<boolean>>(lift2(true, false, (left, right) => left || right));
  assertType<Expr<boolean>>(lift3(true, false, true, (first, second, third) => first || second || third));
  assertType<Expr<boolean>>(lift({ ready: true }, ({ ready }) => ready));
  assertType<Expr<string>>(template`repo ${"."}`);
  assertType<TaskContext<{}>>(null as unknown as TaskContext<{}>);
  assertType(task);
  assertType<CreateWorktreeInput>({ repo: ".", path: ".tmp-worktree" });
  assertType(createWorktree);

  const definition = defineWorkflow({ name: "facade-types", inputSchema: Input }).build(({ input }) => ({ ready: input.ready }));
  assertType<WorkflowDefinition<any, any>>(definition);
});
