import { defineWorkflow, z } from "acpus/core";
import { md, template } from "acpus/expression";
import { createWorktree } from "acpus/tasks/git";

const ImplementationOut = z.object({
  changedFiles: z.array(z.string()),
  summary: z.string(),
  testCommand: z.string().default(""),
});

export default defineWorkflow({
  name: "worktree-tournament",
  inputSchema: z.object({
    repoPath: z.path(),
    worktreeRoot: z.path(),
    task: z.string(),
    baseRef: z.string().default("HEAD"),
    forceRemove: z.boolean().default(false),
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
      alpha: {
        do: ({ step }) => {
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
            outputSchema: ImplementationOut,
            run: {
              agent: agents.implementer,
              cwd: worktree.output.worktreePath,
              prompt: md`
                Implement this task in the alpha worktree.

                Task: ${input.task}

                Return changed files, a concise summary, and the test command you ran.
              `,
            },
            timeout: "45m",
          });

          return {
            lane: "alpha",
            worktreePath: worktree.output.worktreePath,
            changedFiles: implementation.output.changedFiles,
            summary: implementation.output.summary,
            testCommand: implementation.output.testCommand,
          };
        },
      },
      beta: {
        do: ({ step }) => {
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
            outputSchema: ImplementationOut,
            run: {
              agent: agents.implementer,
              cwd: worktree.output.worktreePath,
              prompt: md`
                Implement this task in the beta worktree.

                Task: ${input.task}

                Return changed files, a concise summary, and the test command you ran.
              `,
            },
            timeout: "45m",
          });

          return {
            lane: "beta",
            worktreePath: worktree.output.worktreePath,
            changedFiles: implementation.output.changedFiles,
            summary: implementation.output.summary,
            testCommand: implementation.output.testCommand,
          };
        },
      },
      gamma: {
        do: ({ step }) => {
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
            outputSchema: ImplementationOut,
            run: {
              agent: agents.implementer,
              cwd: worktree.output.worktreePath,
              prompt: md`
                Implement this task in the gamma worktree.

                Task: ${input.task}

                Return changed files, a concise summary, and the test command you ran.
              `,
            },
            timeout: "45m",
          });

          return {
            lane: "gamma",
            worktreePath: worktree.output.worktreePath,
            changedFiles: implementation.output.changedFiles,
            summary: implementation.output.summary,
            testCommand: implementation.output.testCommand,
          };
        },
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
