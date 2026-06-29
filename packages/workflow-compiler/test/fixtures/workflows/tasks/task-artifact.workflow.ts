import { defineWorkflow, z } from "@acpus/core";

export default defineWorkflow({
  name: "cli-task",
}).build(({ step, output }) => {
  const result = step("local_task").task({
    outputSchema: z.object({ ok: z.boolean(), artifact: z.artifact("text/plain") }),
    run: {
      input: {},
      exec: async ({ artifact }) => ({
        ok: true,
        artifact: await artifact.writeText("result.txt", "artifact-ok\n"),
      }),
    },
  });
  return output({ ok: result.output.ok, artifact: result.output.artifact });
});
