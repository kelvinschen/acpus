import { defineWorkflow, z } from "acpus/core";
import { template } from "acpus/expression";

const Approval = z.object({
  approved: z.boolean(),
  notes: z.string().default(""),
});

export default defineWorkflow({
  name: "signal-approval",
  inputSchema: z.object({
    topic: z.string(),
  }),
  agents: {
    drafter: { use: "codex", permissionMode: "approve-reads" },
  },
}).build(({ input, agents, step }) => {
  const draft = step("draft").agent({
    outputSchema: z.object({ summary: z.string() }),
    run: {
      agent: agents.drafter,
      prompt: template`Draft a short plan for ${input.topic}.`,
    },
  });

  const approval = step("approval").signal({
    outputSchema: Approval,
    run: {
      prompt: template`Approve this plan: ${draft.output.summary}`,
    },
    timeout: "24h",
    onTimeout: { action: "fail", message: "approval timed out" },
  });

  step("require_approval").assert({
    condition: approval.output.approved,
    message: template`Approval denied: ${approval.output.notes}`,
  });

  return {
    approved: approval.output.approved,
    notes: approval.output.notes,
    summary: draft.output.summary,
  };
});
