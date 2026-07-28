import { defineWorkflow } from "acpus/core";

export default defineWorkflow({
  name: "cli-concurrency-short-task",
}).build(({ step }) => {
  const result = step("short_task").task({
    input: null,
    exec: async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
      return { ok: true };
    },
  });

  return { ok: result.output.ok };
});
