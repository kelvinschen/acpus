import { defineWorkflow, z } from "acpus/core";
import { fmap } from "acpus/expression";

export default defineWorkflow({
  name: "runtime-wiring",
  inputSchema: z.object({ ready: z.boolean() }),
}).build(({ input, step }) => {
  step("require_ready").assert({
    condition: fmap(input.ready, ready => ready === true),
  });

  return { ready: input.ready };
});
