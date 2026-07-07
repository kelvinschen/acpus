import { defineWorkflow, z } from "acpus/core";
import { coalesce, head, template } from "acpus/expression";

const Ticket = z.object({
  id: z.string(),
  summary: z.string(),
});

const TicketReview = z.object({
  ready: z.boolean(),
  risk: z.number(),
  summary: z.string(),
});

const Approval = z.object({
  approved: z.boolean(),
  notes: z.string().default(""),
});

export default defineWorkflow({
  name: "composite-review",
  inputSchema: z.object({
    tickets: z.array(Ticket),
    requireApproval: z.boolean().default(true),
  }),
  agents: {
    reviewer: { use: "codex", permissionMode: "approve-reads" },
  },
}).build(({ input, agents, meta, step }) => {
  const inventory = step("inventory").task({
    run: {
      input: { tickets: input.tickets },
      exec: async ({ input }) => ({
        count: input.tickets.length,
      }),
    },
  });

  const reviews = step("review_tickets").fanout({
    over: input.tickets,
    key: ({ item }) => template`ticket-${item.id}`,
    maxConcurrency: 2,
    do: ({ item, step }) => {
      const lane = step("ticket_lane").parallel({
        branches: {
          review: {
            do: ({ step }) => {
              const review = step("review_ticket").agent({
                outputSchema: TicketReview,
                run: {
                  agent: agents.reviewer,
                  prompt: template`Review ticket ${item.id}: ${item.summary}`,
                },
                retry: { max: 1 },
              });
              return {
                ready: review.output.ready,
                risk: review.output.risk,
                summary: review.output.summary,
              };
            },
          },
          remediation: {
            do: ({ step }) => {
              const remediation = step("remediation_loop").loop({
                initial: { done: false, round: 0, summary: "" },
                maxIterations: 2,
                do: ({ iter, previous, step }) => {
                  const plan = step("plan_round").task({
                    run: {
                      input: {
                        ticketId: item.id,
                        previousSummary: previous.summary,
                        round: iter,
                      },
                      exec: async ({ input }) => ({
                        done: input.round >= 1,
                        round: input.round,
                        summary: `round ${input.round} for ${input.ticketId}: ${input.previousSummary}`,
                      }),
                    },
                  });

                  return {
                    done: plan.output.done,
                    round: plan.output.round,
                    summary: plan.output.summary,
                  };
                },
                stopWhen: ({ result }) => result.done,
                onExhausted: "returnLast",
              });

              return { summary: remediation.output.summary };
            },
          },
        },
      });

      return {
        id: item.id,
        ready: lane.output.review.ready,
        risk: lane.output.review.risk,
        summary: lane.output.review.summary,
        remediation: lane.output.remediation.summary,
      };
    },
  });

  const approval = step("approval").if({
    condition: input.requireApproval,
    then: ({ step }) => {
      const human = step("human_approval").signal({
        outputSchema: Approval,
        run: {
          prompt: template`Approve ${inventory.output.count} ticket reviews: ${reviews.output}`,
        },
        timeout: "24h",
        onTimeout: { action: "fail", message: "approval timed out" },
      });
      return { approved: human.output.approved, notes: human.output.notes };
    },
    else: ({ step }) => {
      const auto = step("auto_approval").task({
        run: {
          input: {},
          exec: async () => ({
            approved: true,
            notes: "auto-approved",
          }),
        },
      });
      return { approved: auto.output.approved, notes: auto.output.notes };
    },
  });

  step("require_approval").assert({
    condition: approval.output.approved,
    message: template`Approval denied: ${approval.output.notes}`,
  });

  return {
    runId: meta.runId,
    ticketCount: inventory.output.count,
    approved: approval.output.approved,
    firstSummary: coalesce(head(reviews.output).summary, "(none)"),
  };
});
