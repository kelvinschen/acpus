import { defineWorkflow, z } from "acpus/core";
import { createWorktree } from "acpus/tasks/git";

export default defineWorkflow({
  name: "runtime-create-worktree",
  inputSchema: z.object({
    repo: z.string(),
    path: z.string(),
  }),
}).build(({ input, step }) => {
  const result = step("create_worktree").task({
    run: {
      task: createWorktree,
      input: {
        repo: input.repo,
        path: input.path,
      },
    },
  });

  return {
    ok: result.output.ok,
    worktreePath: result.output.worktreePath,
    baseSha: result.output.baseSha,
  };
});
