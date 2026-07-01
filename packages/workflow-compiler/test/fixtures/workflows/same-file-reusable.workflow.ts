import { defineWorkflow, task, z } from "@acpus/core";
import type { TaskToken } from "@acpus/core";
import slash from "slash";

type ReusableTask<Input, Output> = Extract<TaskToken<Input, Output>, { kind: "external" }>;

export const normalizePath: ReusableTask<{ path: string }, { normalized: string }> = task.define({
  inputSchema: z.object({ path: z.string() }),
  outputSchema: z.object({ normalized: z.string() }),
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
