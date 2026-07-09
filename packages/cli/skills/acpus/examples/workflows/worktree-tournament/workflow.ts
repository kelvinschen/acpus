import { defineWorkflow, z } from "acpus/core";
import { md, template } from "acpus/expression";
import { createWorktree } from "acpus/tasks/git";

export default defineWorkflow({
  name: "worktree-tournament",
  description: "Create competing worktree implementations and have an agent judge the best result.",
  inputSchema: z.object({
    repoPath: z.path().describe("Source repository path used to create candidate worktrees and run the judge."),
    worktreeRoot: z.path().describe("Directory where per-run candidate worktrees should be created."),
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
  const paths = step("plan_worktrees").task({
    run: {
      input: { root: input.worktreeRoot, runId: meta.runId },
      exec: async ({ input }) => ({
        alpha: `${input.root}/${input.runId}-alpha`,
        beta: `${input.root}/${input.runId}-beta`,
        gamma: `${input.root}/${input.runId}-gamma`,
      }),
    },
  });

  const candidates = step("candidate_worktrees").parallel({
    branches: {
      alpha() {
        const worktree = step("create_alpha_worktree").task({
          run: {
            task: createWorktree,
            input: {
              repo: input.repoPath,
              path: paths.output.alpha,
              ref: input.baseRef,
              forceRemove: input.forceRemove,
            },
          },
          timeout: "2m",
        });

        const implementation = step("implement_alpha").agent({
          run: {
            agent: agents.implementer,
            cwd: worktree.output.worktreePath,
            prompt: md`
              Implement this task in the alpha worktree.

              Task: ${input.task}

              Return a Markdown implementation report with:
              - Changed files
              - Implementation summary
              - Test command run, or "not run" with the reason
            `,
          },
          timeout: "45m",
        });

        return {
          lane: "alpha",
          worktreePath: worktree.output.worktreePath,
          report: implementation.output,
        };
      },
      beta() {
        const worktree = step("create_beta_worktree").task({
          run: {
            task: createWorktree,
            input: {
              repo: input.repoPath,
              path: paths.output.beta,
              ref: input.baseRef,
              forceRemove: input.forceRemove,
            },
          },
          timeout: "2m",
        });

        const implementation = step("implement_beta").agent({
          run: {
            agent: agents.implementer,
            cwd: worktree.output.worktreePath,
            prompt: md`
              Implement this task in the beta worktree.

              Task: ${input.task}

              Return a Markdown implementation report with:
              - Changed files
              - Implementation summary
              - Test command run, or "not run" with the reason
            `,
          },
          timeout: "45m",
        });

        return {
          lane: "beta",
          worktreePath: worktree.output.worktreePath,
          report: implementation.output,
        };
      },
      gamma() {
        const worktree = step("create_gamma_worktree").task({
          run: {
            task: createWorktree,
            input: {
              repo: input.repoPath,
              path: paths.output.gamma,
              ref: input.baseRef,
              forceRemove: input.forceRemove,
            },
          },
          timeout: "2m",
        });

        const implementation = step("implement_gamma").agent({
          run: {
            agent: agents.implementer,
            cwd: worktree.output.worktreePath,
            prompt: md`
              Implement this task in the gamma worktree.

              Task: ${input.task}

              Return a Markdown implementation report with:
              - Changed files
              - Implementation summary
              - Test command run, or "not run" with the reason
            `,
          },
          timeout: "45m",
        });

        return {
          lane: "gamma",
          worktreePath: worktree.output.worktreePath,
          report: implementation.output,
        };
      },
    },
  });

  const judgment = step("judge_candidates").agent({
    outputSchema: z.object({
      winner: z.enum(["alpha", "beta", "gamma"]),
      rationale: z.string(),
    }),
    run: {
      agent: agents.judge,
      cwd: input.repoPath,
      prompt: md`
        Judge the best implementation for this task.

        Task: ${input.task}

        Each candidate includes its lane, worktree path, and Markdown implementation report.

        Alpha: ${candidates.output.alpha}
        Beta: ${candidates.output.beta}
        Gamma: ${candidates.output.gamma}

        Return the winning lane and a concise rationale.
      `,
    },
    retry: { max: 1 },
    timeout: "30m",
  });

  return {
    runId: meta.runId,
    winner: judgment.output.winner,
    rationale: judgment.output.rationale,
    candidates: {
      alpha: candidates.output.alpha,
      beta: candidates.output.beta,
      gamma: candidates.output.gamma,
    },
  };
});
