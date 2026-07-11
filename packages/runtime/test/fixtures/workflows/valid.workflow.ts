import { defineWorkflow, z } from "acpus/core";
import { lift } from "acpus/expression";

export default defineWorkflow({
  name: "runtime-wiring",
  inputSchema: z.object({ ready: z.boolean() }),
}).build(({ input, step }) => {
  step("require_ready").assert({
    condition: lift(input.ready, ready => ready === true),
  });

  return { ready: input.ready };
});
