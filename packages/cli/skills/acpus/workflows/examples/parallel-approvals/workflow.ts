/*
 * Pattern: Open independent approval waits concurrently and require both results.
 * Nodes: signal, parallel
 */
import { defineWorkflow, z } from "acpus/core";
import { template } from "acpus/expression";

const ApprovalSchema = z.object({
  approved: z.boolean(),
  note: z.string().default(""),
});

export default defineWorkflow({
  name: "parallel-approvals",
  inputSchema: z.object({ changeId: z.string() }),
}).build(({ input, step }) => {
  const approvals = step("approvals").parallel({
    branches: {
      security() {
        const approval = step("security_approval").signal({
          outputSchema: ApprovalSchema,
          prompt: template`Security approval for ${input.changeId}`,
          timeout: "2d",
          onTimeout: { message: "security approval timed out" },
        });
        return approval.output;
      },
      operations() {
        const approval = step("operations_approval").signal({
          outputSchema: ApprovalSchema,
          prompt: template`Operations approval for ${input.changeId}`,
          timeout: "2d",
          onTimeout: { message: "operations approval timed out" },
        });
        return approval.output;
      },
    },
  });

  return approvals.output;
});
