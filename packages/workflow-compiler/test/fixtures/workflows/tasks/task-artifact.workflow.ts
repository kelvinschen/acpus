import { defineWorkflow } from "@acpus/core";

export default defineWorkflow({
  name: "cli-task",
}).build(({ step }) => {
  const result = step("local_task").task({
    run: {
      input: {},
      exec: async ({ artifact }) => ({
        ok: true,
        artifact: await artifact.writeText("result.txt", "artifact-ok\n"),
      }),
    },
  });
  return { ok: result.output.ok, artifact: result.output.artifact };
});
