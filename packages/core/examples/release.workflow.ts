import {
  defineWorkflow,
  z,
  agent,
  task,
  md,
  where,
  all,
  max,
  json,
} from "../src/index.js";
import normalizePackage, { NormalizePackageOutput } from "./tasks/normalize-package.task.js";

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

  input: z.object({
    repoPath: z.path(),
    packageName: z.string(),
    version: z.string(),
    baseRef: z.string().default("main"),
    headRef: z.string().default("HEAD"),
  }),

  agents: {
    reviewer: agent.define({
      provider: "codex",
      policy: "read",
    }),
    summarizer: agent.define({
      provider: "codex",
      policy: "read",
    }),
  },
}).build(({ input, step, output }) => {
  const packageInfo = step.task("normalize_package", {
    input: {
      packageName: input.packageName,
    },
    output: NormalizePackageOutput,
    run: normalizePackage,
  });

  const prepare = step.task("prepare_release", {
    input: {
      repoPath: input.repoPath,
      version: input.version,
      baseRef: input.baseRef,
      headRef: input.headRef,
      packageSlug: packageInfo.output.slug,
    },

    output: PrepareReleaseOut,

    cwd: input.repoPath,

    run: task(async ({ input, $, artifact, log }) => {
      log.info(`Preparing release ${input.version}`);

      const changed = await $`
        git diff --name-only ${input.baseRef} ${input.headRef}
      `;

      const changedFiles = changed.stdout
        .trim()
        .split("\n")
        .filter(Boolean);

      const diff = await $`
        git diff ${input.baseRef} ${input.headRef}
      `;

      const changelog = [
        `# Release ${input.version}`,
        "",
        `Package: ${input.packageSlug}`,
        "",
        "## Changed files",
        ...changedFiles.map((file: string) => `- ${file}`),
        "",
      ].join("\n");

      return {
        changedFiles,
        diff: await artifact.writeText("diff.patch", diff.stdout, { mediaType: "text/x-patch" }),
        changelogDraft: await artifact.writeText("CHANGELOG_DRAFT.md", changelog, { mediaType: "text/markdown" }),
      };
    }),

    timeout: "5m",
  });

  const tests = step.task("run_tests", {
    input: {
      repoPath: input.repoPath,
    },

    output: TestOut,

    cwd: input.repoPath,

    run: task(async ({ input, $, artifact }) => {
      const result = await $`
        pnpm test
      `.allowExitCode([0, 1]);

      return {
        passed: result.exitCode === 0,
        summary: result.exitCode === 0 ? "Tests passed." : "Tests failed. See attached log.",
        log: await artifact.writeText("test.log", result.stdout + result.stderr, { mediaType: "text/plain" }),
      };
    }),

    env: {
      CI: "true",
    },

    timeout: "15m",
  });

  step.guard("require_tests", {
    when: where(tests.output, { passed: true }),
    otherwise: "fail",
    message: md`
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
    step.agent(`review_${id}`, {
      input: {
        focus,
        packageName: packageInfo.output.normalized,
        diff: prepare.output.diff,
        changelogDraft: prepare.output.changelogDraft,
        testSummary: tests.output.summary,
      },

      output: ReviewOut,

      run: agent({
        use: "reviewer",
        prompt: ({ focus, packageName, diff, changelogDraft, testSummary }) => md`
          Review package ${packageName} for ${focus}.

          Diff:
          ${diff}

          Changelog draft:
          ${changelogDraft}

          Test summary:
          ${testSummary}

          Return JSON matching the declared schema.
        `,
      }),

      timeout: "30m",
    }),
  );

  step.guard("require_all_reviews_ready", {
    when: all(reviews, review =>
      where(review.output, {
        ready: true,
        riskCount: { lte: 3 },
      }),
    ),
    otherwise: "fail",
    message: md`
      One or more reviews failed.

      Review outputs:
      ${json(reviews.map(review => review.output))}
    `,
  });

  const summary = step.agent("final_summary", {
    input: {
      version: input.version,
      packageName: packageInfo.output.normalized,
      reviews: reviews.map(review => review.output),
      changelogDraft: prepare.output.changelogDraft,
    },

    output: z.object({
      summary: z.string(),
    }),

    run: agent({
      use: "summarizer",
      prompt: ({ version, packageName, reviews, changelogDraft }) => md`
        Write a concise release readiness summary.

        Package:
        ${packageName}

        Version:
        ${version}

        Changelog draft:
        ${changelogDraft}

        Reviews:
        ${json(reviews)}
      `,
    }),
  });

  return output({
    ready: all(reviews, review => review.output.ready),
    maxRiskCount: max(reviews, review => review.output.riskCount),
    summary: summary.output.summary,
    changelogDraft: prepare.output.changelogDraft,
  });
});
