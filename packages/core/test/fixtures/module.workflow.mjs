import { agent, defineWorkflow, task, template, where, z } from "../../src/index.js";

const NormalizeOutput = z.object({
  slug: z.string(),
});

const ReviewOutput = z.object({
  ready: z.boolean(),
});

const normalizePackage = task.define({
  input: z.object({ packageName: z.string() }),
  output: NormalizeOutput,
}).run(async ({ input }) => ({
  slug: input.packageName.trim().toLowerCase().replaceAll(" ", "-"),
}));

export default defineWorkflow({
  name: "module-fixture",
  input: z.object({
    packageName: z.string(),
  }),
  agents: {
    reviewer: agent.define({ provider: "codex", policy: "read" }),
  },
}).build(({ input, step, output }) => {
  const normalized = step.task("normalize_package", {
    input: { packageName: input.packageName },
    run: normalizePackage,
  });

  const review = step.agent("review", {
    input: { slug: normalized.output.slug },
    output: ReviewOutput,
    run: ({ input }) => ({
      use: "reviewer",
      prompt: template`Review ${input.slug}`,
    }),
  });

  step.guard("require_ready", {
    when: where(review.output, { ready: true }),
    otherwise: "fail",
    message: template`Review failed for ${normalized.output.slug}`,
  });

  return output({
    ready: review.output.ready,
    slug: normalized.output.slug,
  });
});
