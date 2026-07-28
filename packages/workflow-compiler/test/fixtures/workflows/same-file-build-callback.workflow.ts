import { defineWorkflow, task, z } from "acpus/core";

export const stableTask = task.define({
  inputSchema: z.string(),
  exec: async () => ({ ok: true }),
});

export default defineWorkflow({
  name: "same-file-build-callback",
}).build(({ step }) => {
  if (process.env.ACPUS_FAIL_IF_BUILD_CALLBACK_EXECUTED === "1") {
    throw new Error("workflow build callback executed during task import");
  }

  const result = step("stable_task").task({
    task: stableTask, input: "value",
  });
  return { ok: result.output.ok };
});
