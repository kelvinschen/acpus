import { defineWorkflow } from "@acpus/core";

export default defineWorkflow({
  name: "eslint_task_callsite_fixture",
}).build(({ step }) => {
  const spec = {
    run: { input: {}, exec: async () => ({ ok: true }) },
  };
  step("nonliteral").task(spec);

  const saved = step("saved");
  saved.task({
    run: { input: {}, exec: async () => ({ ok: true }) },
  });

  return { ok: true };
});
