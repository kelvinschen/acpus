import { task, z, /* defineWorkflow */ } from "acpus/core";

export const summarizeIssue = task.define({
  // Reusable task modules may import third-party dependencies installed with the workflow package.
  inputSchema: z.object({
    id: z.string(),
    title: z.string(),
    labels: z.array(z.string()),
  }),
  exec: async ({ input }) => ({
    labelCount: input.labels.length,
    titleLine: `${input.id}: ${input.title}`,
  }),
});
