import { defineWorkflow, task, z } from "@acpus/core";
import slash from "slash";

export const normalizePath = task.define({
  inputSchema: z.object({ path: z.string() }),
  exec: async ({ input }) => ({ normalized: slash(input.path) }),
});

export default defineWorkflow({
  name: "same-file-reusable",
  inputSchema: z.object({ path: z.string() }),
}).build(({ input, step }) => {
  const normalized = step("normalize_path").task({
    run: {
      task: normalizePath,
      input: { path: input.path },
    },
  });

  return { normalized: normalized.output.normalized };
});
