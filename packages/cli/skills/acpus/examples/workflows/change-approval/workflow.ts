/*
 * Pattern: Draft, iteratively refine, optionally approve, and enforce a change plan.
 * Nodes: agent, task, signal, assert, if, loop
 */
import { defineWorkflow, z, /* task */ } from "acpus/core";
import {
  gte, md, or, template,
  /* lift, eq, ne, lt, lte, gt, not, and */
} from "acpus/expression";
// import { createWorktree } from "acpus/tasks/git";

const PlanOut = z.object({
  ready: z.boolean(),
  summary: z.string(),
  nextDraft: z.string(),
});

export default defineWorkflow({
  name: "change-approval",
  description: "Draft and refine an implementation plan, then optionally wait for human approval.",
  inputSchema: z.object({
    repoPath: z.string().describe("Repository path where the planning agent should inspect context."),
    request: z.string().describe("The implementation request or change proposal to turn into a plan."),
    requireApproval: z.boolean().default(true).describe(
      "Whether to pause for a human approval signal before the workflow can complete.",
    ),
  }),
  agents: {
    planner: { use: "codex" },
  },
}).build(({ input, agents, meta, step }) => {
  const initial = step("draft_plan").agent({
    outputSchema: PlanOut,
    agent: agents.planner,
    cwd: input.repoPath,
    prompt: template`Draft an implementation plan for: ${input.request}`,
    timeout: "20m",
  });

  const refined = step("refine_plan").loop({
    state: {
      ready: initial.output.ready,
      summary: initial.output.summary,
      draft: initial.output.nextDraft,
    },
    do({ round, state }) {
      // This static id is reused safely; each loop iteration receives a distinct runtime nodeKey.
      const review = step("refine_round").agent({
        outputSchema: PlanOut,
        agent: agents.planner,
        cwd: input.repoPath,
        prompt: md`
          Refine implementation plan round ${round}.

          Original request: ${input.request}
          Previous draft: ${state.draft}
          Previous summary: ${state.summary}

          Return a ready flag, concise summary, and next draft.
        `,
        timeout: "20m",
      });
      return {
        state: {
          ready: review.output.ready,
          summary: review.output.summary,
          draft: review.output.nextDraft,
        },
        stop: or(review.output.ready, gte(round, 2)),
      };
    },
  });

  const approval = step("approval").if({
    condition: input.requireApproval,
    then() {
      const human = step("human_approval").signal({
        outputSchema: z.object({
          approved: z.boolean(),
          notes: z.string().default(""),
        }),
        prompt: md`
          Approve the implementation plan for run ${meta.runId}.

          Request: ${input.request}
          Plan: ${refined.output.draft}
        `,
        timeout: "24h",
        onTimeout: { message: "approval timed out" },
      });
      return { approved: human.output.approved, notes: human.output.notes };
    },
    else() {
      const automatic = step("auto_approval").task({
        input: { ready: refined.output.ready },
        exec: async ({ input }) => ({
          approved: input.ready,
          notes: input.ready ? "auto-approved ready plan" : "plan not ready",
        }),
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
