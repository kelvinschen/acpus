/*
 * Pattern: Fan out six worktree implementations and have an agent judge them.
 * Nodes: agent, task, fanout
 */
import { defineWorkflow, z } from "acpus/core";
import { md, template } from "acpus/expression";
import { createWorktree } from "acpus/tasks/git";

const CandidateLanes = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"] as const;

export default defineWorkflow({
  name: "worktree-tournament",
  description: "Create competing worktree implementations and have an agent judge the best result.",
  inputSchema: z.object({
    repoPath: z.string().describe("Source repository path used to create candidate worktrees and run the judge."),
    worktreeRoot: z.string().describe("Directory where per-run candidate worktrees should be created."),
    task: z.string().describe("Implementation task each candidate agent should attempt independently."),
    baseRef: z.string().default("HEAD").describe("Git ref used as the base for each candidate worktree."),
    forceRemove: z.boolean().default(false).describe(
      "Whether createWorktree may remove an existing candidate worktree path before recreating it.",
    ),
  }),
  agents: {
    implementer: { use: "codex" },
    judge: { use: "codex" },
  },
}).build(({ input, agents, meta, step }) => {
  const candidates = step("candidate_worktrees").fanout({
    over: CandidateLanes,
    do: ({ item }) => {
      const worktree = step("create_candidate_worktree").task({
        task: createWorktree,
        input: {
          repo: input.repoPath,
          path: template`${input.worktreeRoot}/${meta.runId}-${item}`,
          ref: input.baseRef,
          forceRemove: input.forceRemove,
        },
        timeout: "2m",
      });

      const implementation = step("implement_candidate").agent({
        agent: agents.implementer,
        cwd: worktree.output.worktreePath,
        prompt: md`
          Implement this task independently in the ${item} worktree.

          Task: ${input.task}

          Return a Markdown implementation report with:
          - Changed files
          - Implementation summary
          - Test command run, or "not run" with the reason
        `,
      });

      return {
        lane: item,
        worktreePath: worktree.output.worktreePath,
        report: implementation.output,
      };
    },
  });

  const judgment = step("judge_candidates").agent({
    outputSchema: z.object({
      winner: z.enum(CandidateLanes),
      rationale: z.string(),
    }),
    agent: agents.judge,
    cwd: input.repoPath,
    prompt: md`
      Judge the best implementation for this task.

      Task: ${input.task}

      Each candidate includes its lane, worktree path, and Markdown implementation report.
      Candidates: ${candidates.output}

      Return the winning lane and a concise rationale.
    `,
  });

  return {
    runId: meta.runId,
    winner: judgment.output.winner,
    rationale: judgment.output.rationale,
    candidates: candidates.output,
  };
});
