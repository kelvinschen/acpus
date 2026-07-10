import { defineWorkflow, secret, task, z } from "acpus/core";
import { and, eq, fmap, gt, gte, lift, lift2, lift3, lt, lte, md, ne, not, or, template } from "acpus/expression";
// Optional Git task helper:
// import { createWorktree } from "acpus/tasks/git";

/*
 * Authoring rules:
 * - Inside build(), input, meta, and node.output values are Expr tokens.
 * - Do not use JavaScript if, &&, ||, ===, !, .map, .length, or untagged
 *   template strings over Expr values.
 * - Use step().if/switch/parallel/fanout/loop for graph control flow.
 * - Use eq/ne and lt/lte/gt/gte for scalar predicates; combine booleans with
 *   not/and/or. Use fmap/lift helpers for custom runtime computations.
 * - Use template/md for Expr strings.
 * - Task exec callbacks run as normal runtime TypeScript and may use artifact.
 */
export default defineWorkflow({
  name: "acpus-workflow-starter",
  description: "Review a topic with an agent.",
  inputSchema: z.object({
    topic: z.string(),
  }),
  agents: {
    worker: { use: "codex" },
  },
}).build(({ input, agents, meta, step }) => {
  const normalizedTopic = fmap(input.topic, topic => topic.trim());

  const review = step("review").agent({
    outputSchema: z.object({
      ready: z.boolean(),
      summary: z.string(),
    }),
    run: {
      agent: agents.worker,
      prompt: template`Review ${normalizedTopic} and return JSON matching the output schema.`,
    },
  });

  const summary = lift2(
    review.output.ready,
    review.output.summary,
    (ready, summary) => `${ready ? "READY" : "NOT READY"}: ${summary}`,
  );

  return {
    runId: meta.runId,
    summary,
  };
});
