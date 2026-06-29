import { defineWorkflow, z } from "@acpus/core";
import { where } from "@acpus/core/expression";

export default defineWorkflow({
  name: "runtime-wiring",
  inputSchema: z.object({ ready: z.boolean() }),
}).build(({ input, step, output }) => {
  step("require_ready").assert({
    condition: where(input, { ready: true }),
  });

  return output({ ready: input.ready });
});
