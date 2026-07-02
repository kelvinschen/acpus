import { defineWorkflow, task, z } from "acpus/core";

const sdk = {
  job: (_name: string) => ({ task: () => "ok" }),
};

export const externalJob = task.define({
  inputSchema: z.object({}),
  exec: async () => ({ value: sdk.job("external").task() }),
});

export default defineWorkflow({
  name: "eslint_third_party_task_method_fixture",
}).build(({ step }) => {
  const result = step("external_job").task({ run: { task: externalJob, input: {} } });
  return { value: result.output.value };
});
