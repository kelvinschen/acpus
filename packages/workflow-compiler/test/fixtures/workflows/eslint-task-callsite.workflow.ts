import { defineWorkflow, z } from "@acpus/core";

export default defineWorkflow({
  name: "eslint_task_callsite_fixture",
}).build(({ step }) => {
  const spec = {
    outputSchema: z.object({ ok: z.boolean() }),
    run: { input: {}, exec: async () => ({ ok: true }) },
  };
  step("nonliteral").task(spec);

  const saved = step("saved");
  saved.task({
    outputSchema: z.object({ ok: z.boolean() }),
    run: { input: {}, exec: async () => ({ ok: true }) },
  });

  return { ok: true };
});
