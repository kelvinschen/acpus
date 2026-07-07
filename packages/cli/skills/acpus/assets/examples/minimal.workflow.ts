import { defineWorkflow, z } from "acpus/core";

export default defineWorkflow({
  name: "minimal-greeting",
  inputSchema: z.object({
    name: z.string(),
  }),
}).build(({ input, meta, step }) => {
  const greeting = step("greet").task({
    run: {
      input: { name: input.name },
      exec: async ({ input }) => ({
        message: `Hello, ${input.name}!`,
      }),
    },
  });

  return {
    runId: meta.runId,
    message: greeting.output.message,
  };
});
