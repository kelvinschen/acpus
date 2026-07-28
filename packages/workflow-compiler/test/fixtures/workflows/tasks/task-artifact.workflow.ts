import { defineWorkflow } from "acpus/core";

export default defineWorkflow({
  name: "cli-task",
}).build(({ step }) => {
  const result = step("local_task").task({
    input: null,
    exec: async ({ artifact }) => ({
      ok: true,
      artifact: await artifact.write("result.txt", "artifact-ok\n"),
    }),
  });
  return { ok: result.output.ok, artifact: result.output.artifact };
});
