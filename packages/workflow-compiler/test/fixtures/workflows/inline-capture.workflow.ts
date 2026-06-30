import { defineWorkflow, z } from "@acpus/core";

const PREFIX = "outer-";

export default defineWorkflow({
  name: "inline-capture-fixture",
}).build(({ step }) => {
  const result = step("capture").task({
    outputSchema: z.object({ slug: z.string() }),
    run: {
      input: {},
      // References `PREFIX` from the workflow module scope, so the inline task
      // is not self-contained and must be rejected with TB007.
      exec: async () => ({ slug: `${PREFIX}value` }),
    },
  });

  return { slug: result.output.slug };
});
