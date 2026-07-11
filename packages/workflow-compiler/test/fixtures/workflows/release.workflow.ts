import {
  defineWorkflow,
  z,
} from "acpus/core";
import {
  lift,
  template,
} from "acpus/expression";
import localDependencyTask from "./tasks/local-dependency.task.js";
import nodeModuleDependencyTask from "./tasks/node-module-dependency.task.js";

const ReviewOut = z.object({
  ready: z.boolean(),
  riskCount: z.number().int(),
  issues: z.array(z.string()),
  summary: z.string(),
});

export default defineWorkflow({
  name: "release-readiness",

  inputSchema: z.object({
    repoPath: z.string(),
    packageName: z.string(),
    version: z.string(),
    baseRef: z.string().default("main"),
    headRef: z.string().default("HEAD"),
  }),

  agents: {
    reviewer: {
      use: "codex",
      permissionMode: "approve-reads",
    },
    summarizer: {
      use: "codex",
      permissionMode: "approve-reads",
    },
  },
}).build(({ input, agents, step, meta }) => {
  const packageInfo = step("normalize_package").task({
    task: localDependencyTask,
    input: {
      packageName: input.packageName,
    },
  });

  const normalizedRepo = step("normalize_path").task({
    task: nodeModuleDependencyTask,
    input: {
      path: input.repoPath,
    },
  });

  const prepare = step("prepare_release").task({
    input: {
      repoPath: input.repoPath,
      version: input.version,
      baseRef: input.baseRef,
      headRef: input.headRef,
      packageSlug: packageInfo.output.slug,
      normalizedRepoPath: normalizedRepo.output.normalized,
    },
    cwd: input.repoPath,
    exec: async ({ input, $, artifact }) => {
      const changed = await $`
      git diff --name-only ${input.baseRef} ${input.headRef}
    `;

      const changedFiles = changed.stdout.trim().split("\n").filter(Boolean);

      const diff = await $`
      git diff ${input.baseRef} ${input.headRef}
    `;

      const changelog = [
        `# Release ${input.version}`,
        "",
        `Package: ${input.packageSlug}`,
        `Repository: ${input.normalizedRepoPath}`,
        "",
        "## Changed files",
        ...changedFiles.map((file: string) => `- ${file}`),
        "",
      ].join("\n");

      return {
        changedFiles,
        diff: await artifact.write("diff.patch", diff.stdout, {
          mediaType: "text/x-patch",
        }),
        changelogDraft: await artifact.write(
          "CHANGELOG_DRAFT.md",
          changelog,
          { mediaType: "text/markdown" },
        ),
      };
    },

    timeout: "5m",
  });

  const tests = step("run_tests").task({
    input: {
      repoPath: input.repoPath,
    },
    cwd: input.repoPath,
    env: {
      CI: "true",
    },
    exec: async ({ $, artifact }) => {
      const result = await $`
      pnpm test
    `.allowExitCode([0, 1]);

      return {
        passed: result.exitCode === 0,
        summary:
          result.exitCode === 0
            ? "Tests passed."
            : "Tests failed. See attached log.",
        log: await artifact.write(
          "test.log",
          result.stdout + result.stderr,
          { mediaType: "text/plain" },
        ),
      };
    },

    timeout: "15m",
  });

  step("require_tests").assert({
    condition: tests.output.passed,
    message: template`
      Tests failed.

      Summary:
      ${tests.output.summary}

      Log:
      ${tests.output.log}
    `,
  });

  const reviewFocuses = [
    ["security", "security and supply-chain risks"],
    ["performance", "performance regressions"],
    ["docs", "documentation and release-note gaps"],
  ] as const;

  const reviews = reviewFocuses.map(([id, focus]) =>
    step(`review_${id}`).agent({
      outputSchema: ReviewOut,
      agent: agents.reviewer,
      prompt: template`
        Review package ${packageInfo.output.normalized} for ${focus}.

        Diff:
        ${prepare.output.diff}

        Changelog draft:
        ${prepare.output.changelogDraft}

        Test summary:
        ${tests.output.summary}

        Return JSON matching the declared schema.
      `,

      timeout: "30m",
    }),
  );
  const reviewSummaries = reviews.map((review) =>
    lift(review.output, output => ({
      ready: output.ready,
      riskCount: output.riskCount,
      summary: output.summary.trim(),
    })),
  );

  step("require_all_reviews_ready").assert({
    condition: lift({ summaries: reviewSummaries }, ({ summaries }) => summaries.every(review => review.ready && review.riskCount <= 3)),
    message: template`
      One or more reviews failed.

      Review outputs:
      ${reviewSummaries}
    `,
  });

  const summary = step("final_summary").agent({
    outputSchema: z.object({
      summary: z.string(),
    }),
    agent: agents.summarizer,
    prompt: template`
      Write a concise release readiness summary.

      Package:
      ${packageInfo.output.normalized}

      Version:
      ${input.version}

      Changelog draft:
      ${prepare.output.changelogDraft}

      Reviews:
      ${reviewSummaries}
    `,
  });

  return {
    runId: meta.runId,
    ready: lift({ summaries: reviewSummaries }, ({ summaries }) => summaries.every(review => review.ready)),
    maxRiskCount: lift({ summaries: reviewSummaries }, ({ summaries }) => Math.max(...summaries.map(review => review.riskCount))),
    summary: summary.output.summary,
    changelogDraft: prepare.output.changelogDraft,
  };
});
