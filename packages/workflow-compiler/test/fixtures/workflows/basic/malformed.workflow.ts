import { defineWorkflow, z } from "@acpus/core";

export default defineWorkflow({
  name: "cli-malformed",
  inputSchema: z.object({ ready: z.boolean() }),
}).build(({ input, step, output }) => {
  step("bad id").assert({ condition: true });
  return output({ ready: input.ready });
});
