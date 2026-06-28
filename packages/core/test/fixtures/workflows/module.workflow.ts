import {
  defineWorkflow,
  task,
  template,
  where,
  z,
} from "@acpus/core";

const NormalizeOutput = z.object({
  slug: z.string(),
});

const ReviewOutput = z.object({
  ready: z.boolean(),
});

const normalizePackage = task.define({
  inputSchema: z.object({ packageName: z.string() }),
  outputSchema: NormalizeOutput,
  exec: async ({ input }) => ({
    slug: input.packageName.trim().toLowerCase().replaceAll(" ", "-"),
  }),
});

export default defineWorkflow({
  name: "module-fixture",
  inputSchema: z.object({
    packageName: z.string(),
  }),
  agents: {
    reviewer: { use: "codex", policy: "read" },
  },
}).build(({ input, step, output }) => {
  const normalized = step("normalize_package").task({
    task: normalizePackage,
    input: { packageName: input.packageName },
  });

  const review = step("review").agent({
    outputSchema: ReviewOutput,
    run: {
      agent: "reviewer",
      prompt: template`Review ${normalized.output.slug}`,
    },
  });

  step("require_ready").assert({
    condition: where(review.output, { ready: true }),
    message: template`Review failed for ${normalized.output.slug}`,
  });

  return output({
    ready: review.output.ready,
    slug: normalized.output.slug,
  });
});
