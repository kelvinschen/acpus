/*
 * Pattern: Iterate with resident and fresh reviewers in a bounded loop.
 * Nodes: agent, parallel, fanout, loop
 */
import { defineWorkflow, z } from "acpus/core";
import { gte, lift, md, or } from "acpus/expression";

const Decision = z.object({
  approved: z.boolean(),
  feedback: z.string(),
});

type ReviewState = z.infer<typeof Decision> & {
  result: string;
  rounds: number;
};

export default defineWorkflow({
  name: "adversarial-review",
  description: "Iterate on a task until adversarial review approves it or the round limit is reached.",
  inputSchema: z.object({
    task: z.string().describe("The task the worker should complete."),
    rubric: z.string().describe("The requirements used to judge the result."),
    context: z.string().default("").describe("Optional background or constraints."),
    maxReviewers: z.number().default(3).describe("Maximum number of fresh review lenses."),
    maxRounds: z.number().default(3).describe("Maximum worker-review rounds."),
  }),
  agents: {
    planner: { use: "pi" },
    worker: { use: "claude" },
    reviewer: { use: "pi" },
    judge: { use: "claude" },
  },
}).build(({ input, agents, meta, step }) => {
  const reviewerLimit = lift(input.maxReviewers, value => Math.max(1, Math.floor(value)));
  const roundLimit = lift(input.maxRounds, value => Math.max(1, Math.floor(value)));

  const plan = step("plan_reviews").agent({
    agent: agents.planner,
    cwd: meta.workspaceDir,
    outputSchema: z.object({
      lenses: z.array(z.object({ name: z.string(), focus: z.string() })),
    }),
    prompt: md`
      Plan distinct adversarial review lenses for this task.

      Task: ${input.task}
      Rubric: ${input.rubric}
      Context: ${input.context}
      Maximum lenses: ${reviewerLimit}

      Cover the most consequential failure modes without overlap. Return no more
      than the requested maximum.`,
    timeout: "30m",
  });
  const lenses = lift(plan.output.lenses, reviewerLimit, (items, limit) => items.slice(0, limit));

  const initial: ReviewState = {
    approved: false,
    feedback: "Produce the first complete result.",
    result: "",
    rounds: 0,
  };

  const cycle = step("review_cycle").loop({
    state: initial,
    do({ round, state }) {
      const work = step("work").agent({
        agent: agents.worker,
        cwd: meta.workspaceDir,
        sessionKey: "adversarial-review:worker",
        prompt: md`
          Complete the task and return the full replacement result.

          Task: ${input.task}
          Rubric: ${input.rubric}
          Context: ${input.context}
          Round: ${round}
          Previous result: ${state.result}
          Feedback to address: ${state.feedback}`,
        timeout: "30m",
      });

      const reviews = step("reviews").parallel({
        branches: {
          resident: () => step("resident_review").agent({
            agent: agents.reviewer,
            cwd: meta.workspaceDir,
            sessionKey: "adversarial-review:resident",
            prompt: md`
              Track whether the result improves across rounds.
              Task: ${input.task}
              Rubric: ${input.rubric}
              Context: ${input.context}
              Round: ${round}
              Result: ${work.output}
              Report only concrete issues and regressions.`,
            timeout: "40m",
          }).output,
          fresh: () => step("fresh_reviews").fanout({
            over: lenses,
            maxConcurrency: reviewerLimit,
            do: ({ item }) => step("fresh_review").agent({
              agent: agents.reviewer,
              cwd: meta.workspaceDir,
              prompt: md`
                Review independently through the "${item.name}" lens.
                Focus: ${item.focus}
                Task: ${input.task}
                Rubric: ${input.rubric}
                Context: ${input.context}
                Result: ${work.output}
                Report blockers separately from non-blocking improvements.`,
              timeout: "40m",
            }).output,
          }).output,
        },
      });

      const decision = step("judge").agent({
        agent: agents.judge,
        cwd: meta.workspaceDir,
        outputSchema: Decision,
        prompt: md`
          Decide whether the result satisfies the rubric.

          Task: ${input.task}
          Rubric: ${input.rubric}
          Context: ${input.context}
          Result: ${work.output}
          Resident review: ${reviews.output.resident}
          Fresh reviews: ${reviews.output.fresh}

          Approve only when no blocking issue remains. Do not block on nits.
          Feedback must explain the evidence and give actionable fixes.`,
        timeout: "40m",
      });

      return {
        state: {
          approved: decision.output.approved,
          feedback: decision.output.feedback,
          result: work.output,
          rounds: round,
        },
        stop: or(decision.output.approved, gte(round, roundLimit)),
      };
    },
  });

  return {
    approved: cycle.output.approved,
    feedback: cycle.output.feedback,
    rounds: cycle.output.rounds,
    result: cycle.output.result,
    reviewLenses: lenses,
  };
});
