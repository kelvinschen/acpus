import { assertType, test } from "vitest";
import { defineWorkflow, task, z, type InferSchema, type TaskContext, type WorkflowDefinition } from "acpus/core";
import { template, where, type Expr } from "acpus/expression";
import { createWorktree, type CreateWorktreeInput } from "acpus/tasks/git";

test("acpus facade subpaths expose separated authoring surfaces", () => {
  const Input = z.object({ ready: z.boolean(), repo: z.path() });
  type InputValue = InferSchema<typeof Input>;

  assertType<InputValue>({ ready: true, repo: "." });
  assertType<Expr<boolean>>(where(true, true));
  assertType<Expr<string>>(template`repo ${"."}`);
  assertType<TaskContext<{}>>(null as unknown as TaskContext<{}>);
  assertType(task);
  assertType<CreateWorktreeInput>({ repo: ".", path: ".tmp-worktree" });
  assertType(createWorktree);

  const definition = defineWorkflow({ name: "facade-types", inputSchema: Input }).build(({ input }) => ({ ready: input.ready }));
  assertType<WorkflowDefinition<any, any>>(definition);
});
