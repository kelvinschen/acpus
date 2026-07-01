import { defineWorkflow, task, z } from "@acpus/core";
import type { TaskToken } from "@acpus/core";

type ReusableTask<Input, Output> = Extract<TaskToken<Input, Output>, { kind: "external" }>;

const sdk = {
  job: (_name: string) => ({ task: () => "ok" }),
};

export const externalJob: ReusableTask<{}, { value: string }> = task.define({
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.string() }),
  exec: async () => ({ value: sdk.job("external").task() }),
});

export default defineWorkflow({
  name: "eslint_third_party_task_method_fixture",
}).build(({ step }) => {
  const result = step("external_job").task({ run: { task: externalJob, input: {} } });
  return { value: result.output.value };
});
