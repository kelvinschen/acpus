import { defineWorkflow, where, z } from "@acpus/core";

export default defineWorkflow({
  name: "cli-valid",
  inputSchema: z.object({ ready: z.boolean() }),
}).build(({ input, step, output }) => {
  step("require_ready").assert({
    condition: where(input, { ready: true }),
  });

  return output({ ready: input.ready });
});
