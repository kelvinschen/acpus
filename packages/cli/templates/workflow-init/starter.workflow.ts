import { defineWorkflow, z } from "acpus/core";
import { fmap, lift2, template, /* md, lift3, lift, and, not, or, eq, ne, gt, lt, gte, lte */ } from "acpus/expression";
// import { createWorktree } from "acpus/tasks/git"; // Optional Git task helper:

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

  const writeSummary = step("write_summary").task({
    run: {
      input: { summary },
      exec: async ({ input, artifact }) => ({
        summaryArtifact: await artifact.writeText(
          "summary.md",
          `${input.summary}\n`,
          { mediaType: "text/markdown" },
        ),
      }),
    },
  });

  return {
    runId: meta.runId,
    summary,
    summaryArtifact: writeSummary.output.summaryArtifact,
  };
});
