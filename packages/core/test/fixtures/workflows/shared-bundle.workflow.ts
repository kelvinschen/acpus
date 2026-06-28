import { defineWorkflow, task, z } from "@acpus/core";
import sharedOk from "./tasks/shared-ok.task.js";

// `localDup` has byte-identical task source to the imported `sharedOk`, so both
// task nodes resolve to the same bundle id. The valid imported callsite is
// declared first; the invalid workflow-local callsite must still be rejected
// (the join must fail closed regardless of node order).
const localDup = task.define({
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  exec: async () => ({ ok: true }),
});

export default defineWorkflow({
  name: "shared-bundle-fixture",
}).build(({ step, output }) => {
  const good = step("good_call").task({ task: sharedOk, input: {} });
  step("bad_call").task({ task: localDup, input: {} });

  return output({ ok: good.output.ok });
});
