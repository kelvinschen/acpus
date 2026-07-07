import { defineWorkflow, z } from "acpus/core";
import { and, lte, md, template } from "acpus/expression";

export default defineWorkflow({
  name: "release-review",
  inputSchema: z.object({
    repoPath: z.path(),
    baseRef: z.string().default("main"),
    headRef: z.string().default("HEAD"),
    maxRisk: z.number().default(3),
  }),
  agents: {
    reviewer: { use: "codex" },
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
          changed: result.stdout.trim().length > 0,
        };
      },
    },
    timeout: "5m",
  });

  const review = step("review_release").agent({
    outputSchema: z.object({
      ready: z.boolean(),
      riskCount: z.number(),
      issues: z.array(z.string()),
      summary: z.string(),
    }),
    run: {
      agent: agents.reviewer,
      cwd: input.repoPath,
      prompt: md`
        Review this release diff for ship readiness.

        Patch artifact: ${diff.output.patch}

        Return JSON with readiness, risk count, issues, and a concise summary.
      `,
    },
    retry: { max: 2 },
    timeout: "30m",
  });

  step("require_release_ready").assert({
    condition: and(review.output.ready, lte(review.output.riskCount, input.maxRisk)),
    message: template`Release review failed: ${review.output.summary}`,
  });

  return {
    runId: meta.runId,
    changed: diff.output.changed,
    ready: review.output.ready,
    riskCount: review.output.riskCount,
    issues: review.output.issues,
    summary: review.output.summary,
    patch: diff.output.patch,
  };
});
