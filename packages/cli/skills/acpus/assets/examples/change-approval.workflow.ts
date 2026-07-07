import { defineWorkflow, z } from "acpus/core";
import { md, template } from "acpus/expression";

const PlanOut = z.object({
  ready: z.boolean(),
  summary: z.string(),
  nextDraft: z.string(),
});

export default defineWorkflow({
  name: "change-approval",
  inputSchema: z.object({
    repoPath: z.path(),
    request: z.string(),
    requireApproval: z.boolean().default(true),
  }),
  agents: {
    planner: { use: "codex" },
  },
}).build(({ input, agents, meta, step }) => {
  const initial = step("draft_plan").agent({
    outputSchema: PlanOut,
    run: {
      agent: agents.planner,
      cwd: input.repoPath,
      prompt: template`Draft an implementation plan for: ${input.request}`,
    },
    retry: { max: 1 },
    timeout: "20m",
  });

  const refined = step("refine_plan").loop({
    initial: {
      ready: initial.output.ready,
      round: 0,
      summary: initial.output.summary,
      draft: initial.output.nextDraft,
    },
    maxIterations: 2,
    do: ({ iter, previous, step }) => {
      const review = step("refine_round").agent({
        outputSchema: PlanOut,
        run: {
          agent: agents.planner,
          cwd: input.repoPath,
          prompt: md`
            Refine implementation plan round ${iter}.

            Original request: ${input.request}
            Previous draft: ${previous.draft}
            Previous summary: ${previous.summary}

            Return a ready flag, concise summary, and next draft.
          `,
        },
        retry: { max: 1 },
        timeout: "20m",
      });
      return {
        ready: review.output.ready,
        round: iter,
        summary: review.output.summary,
        draft: review.output.nextDraft,
      };
    },
    stopWhen: ({ result }) => result.ready,
    onExhausted: "returnLast",
  });

  const approval = step("approval").if({
    condition: input.requireApproval,
    then: ({ step }) => {
      const human = step("human_approval").signal({
        outputSchema: z.object({
          approved: z.boolean(),
          notes: z.string().default(""),
        }),
        run: {
          prompt: md`
            Approve the implementation plan for run ${meta.runId}.

            Request: ${input.request}
            Plan: ${refined.output.draft}
          `,
        },
        timeout: "24h",
        onTimeout: { action: "fail", message: "approval timed out" },
      });
      return { approved: human.output.approved, notes: human.output.notes };
    },
    else: ({ step }) => {
      const automatic = step("auto_approval").task({
        run: {
          input: { ready: refined.output.ready },
          exec: async ({ input }) => ({
            approved: input.ready,
            notes: input.ready ? "auto-approved ready plan" : "plan not ready",
          }),
        },
      });
      return { approved: automatic.output.approved, notes: automatic.output.notes };
    },
  });

  step("require_approval").assert({
    condition: approval.output.approved,
    message: template`Change approval failed: ${approval.output.notes}`,
  });

  return {
    runId: meta.runId,
    approved: approval.output.approved,
    notes: approval.output.notes,
    ready: refined.output.ready,
    summary: refined.output.summary,
    plan: refined.output.draft,
  };
});
