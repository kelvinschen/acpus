import { defineWorkflow, z } from "acpus/core";
import { and, lte, md, template } from "acpus/expression";

const ReviewOut = z.object({
  ready: z.boolean(),
  riskCount: z.number(),
  issues: z.array(z.string()),
  summary: z.string(),
});

export default defineWorkflow({
  name: "review-with-task",
  inputSchema: z.object({
    repoPath: z.path(),
    baseRef: z.string().default("main"),
    headRef: z.string().default("HEAD"),
  }),
  agents: {
    reviewer: { use: "codex", permissionMode: "approve-reads" },
  },
}).build(({ input, agents, meta, step }) => {
  const diff = step("collect_diff").task({
    run: {
      input: { baseRef: input.baseRef, headRef: input.headRef },
      cwd: input.repoPath,
      exec: async ({ input, $, artifact }) => {
        const result = await $`git diff ${input.baseRef} ${input.headRef}`;
        return {
          patch: await artifact.writeText("diff.patch", result.stdout, {
            mediaType: "text/x-patch",
          }),
        };
      },
    },
    timeout: "5m",
  });

  const review = step("review").agent({
    outputSchema: ReviewOut,
    run: {
      agent: agents.reviewer,
      prompt: md`
        Review the patch artifact for release readiness.

        Patch: ${diff.output.patch}

        Return exactly one JSON value matching the declared schema.
      `,
      cwd: input.repoPath,
    },
    retry: { max: 2 },
    timeout: "30m",
  });

  step("require_low_risk").assert({
    condition: and(review.output.ready, lte(review.output.riskCount, 3)),
    message: template`Review not ready: ${review.output.summary}`,
  });

  return {
    runId: meta.runId,
    ready: review.output.ready,
    riskCount: review.output.riskCount,
    issues: review.output.issues,
    summary: review.output.summary,
    patch: diff.output.patch,
  };
});
