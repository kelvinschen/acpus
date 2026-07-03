import { defineWorkflow, z } from "acpus/core";
import { every, template, where } from "acpus/expression";

const ReviewOutput = z.object({
  agent: z.enum(["pi", "claude"]),
  verdict: z.enum(["approve", "revise", "reject"]),
  summary: z.string(),
  strengths: z.array(z.string()),
  concerns: z.array(z.string()),
  recommendations: z.array(z.string()),
  confidence: z.number(),
});

const VerificationOutput = z.object({
  reviewedAgent: z.enum(["pi", "claude"]),
  verifierAgent: z.enum(["pi", "claude"]),
  accepted: z.boolean(),
  score: z.number(),
  rubricFailures: z.array(z.string()),
  missedIssues: z.array(z.string()),
  unsupportedClaims: z.array(z.string()),
  requiredCorrections: z.array(z.string()),
  summary: z.string(),
});

export default defineWorkflow({
  name: "adversarial-review",

  inputSchema: z.object({
    subject: z.string(),
    rubric: z.string(),
    criteria: z.array(z.string()).default([]),
    context: z.string().default(""),
    minimumScore: z.number().default(4),
  }),

  agents: {
    pi: {
      use: "pi",
      permissionMode: "approve-reads",
    },
    claude: {
      use: "claude",
      permissionMode: "approve-reads",
    },
  },
}).build(({ input, agents, meta, step }) => {
  const primaryReviews = step("primary_reviews").parallel({
    maxConcurrency: 2,
    branches: {
      pi: {
        do: ({ step }) => {
          const review = step("pi_review").agent({
            outputSchema: ReviewOutput,
            run: {
              agent: agents.pi,
              cwd: meta.workspaceDir,
              session: { key: template`${meta.workflowName}:${meta.runId}:pi-review` },
              prompt: template`
                You are the Pi primary reviewer.

                Subject:
                ${input.subject}

                Context:
                ${input.context}

                Rubric:
                ${input.rubric}

                Criteria:
                ${input.criteria}

                Produce an independent review. Set agent to "pi". Use confidence
                as a 0 to 1 score. Be specific about evidence, assumptions, risks,
                and recommended changes. Return JSON matching the declared schema.
              `,
            },
            timeout: "45m",
          });

          return { review: review.output };
        },
      },
      claude: {
        do: ({ step }) => {
          const review = step("claude_review").agent({
            outputSchema: ReviewOutput,
            run: {
              agent: agents.claude,
              cwd: meta.workspaceDir,
              session: { key: template`${meta.workflowName}:${meta.runId}:claude-review` },
              prompt: template`
                You are the Claude primary reviewer.

                Subject:
                ${input.subject}

                Context:
                ${input.context}

                Rubric:
                ${input.rubric}

                Criteria:
                ${input.criteria}

                Produce an independent review. Set agent to "claude". Use
                confidence as a 0 to 1 score. Be specific about evidence,
                assumptions, risks, and recommended changes. Return JSON matching
                the declared schema.
              `,
            },
            timeout: "45m",
          });

          return { review: review.output };
        },
      },
    },
  });

  const adversarialChecks = step("adversarial_checks").parallel({
    maxConcurrency: 2,
    branches: {
      claude_checks_pi: {
        do: ({ step }) => {
          const verification = step("claude_verify_pi").agent({
            outputSchema: VerificationOutput,
            run: {
              agent: agents.claude,
              cwd: meta.workspaceDir,
              session: { key: template`${meta.workflowName}:${meta.runId}:claude-verify-pi` },
              prompt: template`
                You are the adversarial verifier for the Pi review.

                Subject:
                ${input.subject}

                Context:
                ${input.context}

                Rubric:
                ${input.rubric}

                Criteria:
                ${input.criteria}

                Pi review to verify:
                ${primaryReviews.output.pi.review}

                Attack the review against the rubric. Look for missed issues,
                unsupported claims, weak evidence, and gaps in the criteria.
                Set reviewedAgent to "pi" and verifierAgent to "claude".
                Set accepted to true only if the review satisfies the rubric.
                Score from 0 to 5. Return JSON matching the declared schema.
              `,
            },
            timeout: "45m",
          });

          return { verification: verification.output };
        },
      },
      pi_checks_claude: {
        do: ({ step }) => {
          const verification = step("pi_verify_claude").agent({
            outputSchema: VerificationOutput,
            run: {
              agent: agents.pi,
              cwd: meta.workspaceDir,
              session: { key: template`${meta.workflowName}:${meta.runId}:pi-verify-claude` },
              prompt: template`
                You are the adversarial verifier for the Claude review.

                Subject:
                ${input.subject}

                Context:
                ${input.context}

                Rubric:
                ${input.rubric}

                Criteria:
                ${input.criteria}

                Claude review to verify:
                ${primaryReviews.output.claude.review}

                Attack the review against the rubric. Look for missed issues,
                unsupported claims, weak evidence, and gaps in the criteria.
                Set reviewedAgent to "claude" and verifierAgent to "pi".
                Set accepted to true only if the review satisfies the rubric.
                Score from 0 to 5. Return JSON matching the declared schema.
              `,
            },
            timeout: "45m",
          });

          return { verification: verification.output };
        },
      },
    },
  });

  const accepted = every([
    where(adversarialChecks.output.claude_checks_pi.verification, {
      accepted: true,
      score: { gte: input.minimumScore },
    }),
    where(adversarialChecks.output.pi_checks_claude.verification, {
      accepted: true,
      score: { gte: input.minimumScore },
    }),
  ]);

  step("require_adversarial_acceptance").assert({
    condition: accepted,
    message: template`
      Adversarial verification failed.

      Claude checking Pi:
      ${adversarialChecks.output.claude_checks_pi.verification}

      Pi checking Claude:
      ${adversarialChecks.output.pi_checks_claude.verification}
    `,
  });

  return {
    accepted,
    piReview: primaryReviews.output.pi.review,
    claudeReview: primaryReviews.output.claude.review,
    claudeChecksPi: adversarialChecks.output.claude_checks_pi.verification,
    piChecksClaude: adversarialChecks.output.pi_checks_claude.verification,
  };
});
