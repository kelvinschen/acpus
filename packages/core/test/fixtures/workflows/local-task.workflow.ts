import { defineWorkflow, task, z } from "@acpus/core";

const LocalOutput = z.object({
  ok: z.boolean(),
});

const localTask = task.define({
  inputSchema: z.object({}),
  outputSchema: LocalOutput,
  exec: async () => ({ ok: true }),
});

export default defineWorkflow({
  name: "local-task-fixture",
}).build(({ step, output }) => {
  const result = step("local_task").task({
    task: localTask,
    input: {},
  });

  return output({ ok: result.output.ok });
});
