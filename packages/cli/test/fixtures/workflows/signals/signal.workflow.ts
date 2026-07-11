import { defineWorkflow, z } from "acpus/core";

export default defineWorkflow({
  name: "cli-signal",
}).build(({ step }) => {
  step("before").assert({ condition: true });
  const approval = step("approve").signal({ outputSchema: z.object({ ok: z.boolean() }), prompt: "approve" });
  step("after").assert({ condition: approval.output.ok });
  return { ok: approval.output.ok };
});
