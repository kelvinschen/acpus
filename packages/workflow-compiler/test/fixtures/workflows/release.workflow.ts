import {
  defineWorkflow,
  z,
} from "@acpus/core";
import {
  where,
  every,
  max,
  template,
} from "@acpus/expression";
import localDependencyTask from "./tasks/local-dependency.task.js";
import nodeModuleDependencyTask from "./tasks/node-module-dependency.task.js";

const PrepareReleaseOut = z.object({
  changedFiles: z.array(z.path()),
  diff: z.artifact("text/x-patch"),
  changelogDraft: z.artifact("text/markdown"),
});

const TestOut = z.object({
  passed: z.boolean(),
  summary: z.string(),
  log: z.artifact("text/plain"),
});

const ReviewOut = z.object({
  ready: z.boolean(),
  riskCount: z.number().int(),
  issues: z.array(z.string()),
  summary: z.string(),
});

export default defineWorkflow({
  name: "release-readiness",

  inputSchema: z.object({
    repoPath: z.path(),
    packageName: z.string(),
    version: z.string(),
    baseRef: z.string().default("main"),
    headRef: z.string().default("HEAD"),
  }),

  agents: {
    reviewer: {
      use: "codex",
      policy: "read",
    },
    summarizer: {
      use: "codex",
      policy: "read",
    },
  },
}).build(({ input, agents, step, meta }) => {
  const packageInfo = step("normalize_package").task({
    run: {
      task: localDependencyTask,
      input: {
        packageName: input.packageName,
      },
    },
  });

  const normalizedRepo = step("normalize_path").task({
    run: {
      task: nodeModuleDependencyTask,
      input: {
        path: input.repoPath,
      },
    },
  });

  const prepare = step("prepare_release").task({
    outputSchema: PrepareReleaseOut,
    run: {
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
          diff: await artifact.writeText("diff.patch", diff.stdout, {
            mediaType: "text/x-patch",
          }),
          changelogDraft: await artifact.writeText(
            "CHANGELOG_DRAFT.md",
            changelog,
            { mediaType: "text/markdown" },
          ),
        };
      },
    },

    timeout: "5m",
  });

  const tests = step("run_tests").task({
    outputSchema: TestOut,
    run: {
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
          log: await artifact.writeText(
            "test.log",
            result.stdout + result.stderr,
            { mediaType: "text/plain" },
          ),
        };
      },
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
      run: {
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
      },

      timeout: "30m",
    }),
  );

  step("require_all_reviews_ready").assert({
    condition: every(reviews.map((review) =>
      where(review.output, {
        ready: true,
        riskCount: { lte: 3 },
      }),
    )),
    message: template`
      One or more reviews failed.

      Review outputs:
      ${reviews.map((review) => review.output)}
    `,
  });

  const summary = step("final_summary").agent({
    outputSchema: z.object({
      summary: z.string(),
    }),
    run: {
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
        ${reviews.map((review) => review.output)}
      `,
    },
  });

  return {
    runId: meta.runId,
    ready: every(reviews.map((review) => review.output.ready)),
    maxRiskCount: max(reviews.map((review) => review.output.riskCount)),
    summary: summary.output.summary,
    changelogDraft: prepare.output.changelogDraft,
  };
});
