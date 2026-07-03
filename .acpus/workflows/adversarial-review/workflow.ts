import { defineWorkflow, z } from "acpus/core";
import { md } from "acpus/expression";

const ReviewOutput = z.object({
  summary: z.string(),
  findings: z.string(),
  concerns: z.string(),
  recommendation: z.string(),
});

const CritiqueOutput = z.object({
  critique: z.string(),
  objections: z.string(),
  questions: z.string(),
});

const SynthesisOutput = z.object({
  assessment: z.string(),
  consensus: z.string(),
  disagreements: z.string(),
  actions: z.string(),
});

export default defineWorkflow({
  name: "adversarial-review",

  inputSchema: z.object({
    subject: z.string(),
    rubric: z.string(),
    criteria: z.array(z.string()).default([]),
    context: z.string().default(""),
  }),

  agents: {
    alpha: {
      use: "pi",
      permissionMode: "approve-reads",
    },
    beta: {
      use: "pi",
      permissionMode: "approve-reads",
    },
    gamma: {
      use: "claude",
      permissionMode: "approve-reads",
    },
    delta: {
      use: "claude",
      permissionMode: "approve-reads",
    },
    synthesizer: {
      use: "claude",
      permissionMode: "approve-reads",
    },
  },
}).build(({ input, agents, meta, step }) => {
  const reviews = step("worker_reviews").parallel({
    maxConcurrency: 4,
    branches: {
      alpha: {
        do: ({ step }) => {
          const review = step("alpha_review").agent({
            outputSchema: ReviewOutput,
            run: {
              agent: agents.alpha,
              cwd: meta.workspaceDir,
              sessionKey: "alpha-review",
              prompt: md`
                You are Alpha. Your lens is correctness and feasibility.

                Work independently. Do not assume what any other reviewer will say.
                Focus on whether the subject is technically correct, coherent,
                feasible, and supported by the given context.

                Subject:
                ${input.subject}

                Context:
                ${input.context}

                Rubric:
                ${input.rubric}

                Criteria:
                ${input.criteria}

                Return JSON matching the declared schema. Use each field as a
                concise natural-language paragraph. Do not split content into
                arrays or nested structures.
              `,
            },
            timeout: "45m",
          });

          return { review: review.output };
        },
      },
      beta: {
        do: ({ step }) => {
          const review = step("beta_review").agent({
            outputSchema: ReviewOutput,
            run: {
              agent: agents.beta,
              cwd: meta.workspaceDir,
              sessionKey: "beta-review",
              prompt: md`
                You are Beta. Your lens is risks and edge cases.

                Work independently. Do not assume what any other reviewer will say.
                Look for failure modes, hidden assumptions, operational risks,
                ambiguous requirements, and edge cases that could be missed.

                Subject:
                ${input.subject}

                Context:
                ${input.context}

                Rubric:
                ${input.rubric}

                Criteria:
                ${input.criteria}

                Return JSON matching the declared schema. Use each field as a
                concise natural-language paragraph. Do not split content into
                arrays or nested structures.
              `,
            },
            timeout: "45m",
          });

          return { review: review.output };
        },
      },
      gamma: {
        do: ({ step }) => {
          const review = step("gamma_review").agent({
            outputSchema: ReviewOutput,
            run: {
              agent: agents.gamma,
              cwd: meta.workspaceDir,
              sessionKey: "gamma-review",
              prompt: md`
                You are Gamma. Your lens is rubric compliance.

                Work independently. Do not assume what any other reviewer will say.
                Check the subject against the rubric and criteria directly. Call
                out gaps, partial matches, overclaims, and ambiguous compliance.

                Subject:
                ${input.subject}

                Context:
                ${input.context}

                Rubric:
                ${input.rubric}

                Criteria:
                ${input.criteria}

                Return JSON matching the declared schema. Use each field as a
                concise natural-language paragraph. Do not split content into
                arrays or nested structures.
              `,
            },
            timeout: "45m",
          });

          return { review: review.output };
        },
      },
      delta: {
        do: ({ step }) => {
          const review = step("delta_review").agent({
            outputSchema: ReviewOutput,
            run: {
              agent: agents.delta,
              cwd: meta.workspaceDir,
              sessionKey: "delta-review",
              prompt: md`
                You are Delta. Your lens is evidence and missing assumptions.

                Work independently. Do not assume what any other reviewer will say.
                Separate what is supported from what is inferred. Identify missing
                evidence, untested assumptions, and places where the conclusion
                needs stronger grounding.

                Subject:
                ${input.subject}

                Context:
                ${input.context}

                Rubric:
                ${input.rubric}

                Criteria:
                ${input.criteria}

                Return JSON matching the declared schema. Use each field as a
                concise natural-language paragraph. Do not split content into
                arrays or nested structures.
              `,
            },
            timeout: "45m",
          });

          return { review: review.output };
        },
      },
    },
  });

  const critiques = step("adversarial_critiques").parallel({
    maxConcurrency: 4,
    branches: {
      alpha: {
        do: ({ step }) => {
          const critique = step("alpha_critique").agent({
            outputSchema: CritiqueOutput,
            run: {
              agent: agents.alpha,
              cwd: meta.workspaceDir,
              sessionKey: "alpha-critique",
              prompt: md`
                You are Alpha. Now act as a red-team critic.

                Attack the other workers' reviews. Do not merely summarize them.
                Find weak evidence, missed issues, overconfidence, contradictions,
                and rubric coverage gaps. You may note self-corrections, but your
                primary target is Beta, Gamma, and Delta.

                Subject:
                ${input.subject}

                Rubric:
                ${input.rubric}

                Criteria:
                ${input.criteria}

                Worker reviews:
                Alpha: ${reviews.output.alpha.review}
                Beta: ${reviews.output.beta.review}
                Gamma: ${reviews.output.gamma.review}
                Delta: ${reviews.output.delta.review}

                Return JSON matching the declared schema. Use each field as a
                concise natural-language paragraph. Do not split content into
                arrays or nested structures. Do not output scores or acceptance
                decisions.
              `,
            },
            timeout: "45m",
          });

          return { critique: critique.output };
        },
      },
      beta: {
        do: ({ step }) => {
          const critique = step("beta_critique").agent({
            outputSchema: CritiqueOutput,
            run: {
              agent: agents.beta,
              cwd: meta.workspaceDir,
              sessionKey: "beta-critique",
              prompt: md`
                You are Beta. Now act as a red-team critic.

                Attack the other workers' reviews. Do not merely summarize them.
                Find weak evidence, missed issues, overconfidence, contradictions,
                and rubric coverage gaps. You may note self-corrections, but your
                primary target is Alpha, Gamma, and Delta.

                Subject:
                ${input.subject}

                Rubric:
                ${input.rubric}

                Criteria:
                ${input.criteria}

                Worker reviews:
                Alpha: ${reviews.output.alpha.review}
                Beta: ${reviews.output.beta.review}
                Gamma: ${reviews.output.gamma.review}
                Delta: ${reviews.output.delta.review}

                Return JSON matching the declared schema. Use each field as a
                concise natural-language paragraph. Do not split content into
                arrays or nested structures. Do not output scores or acceptance
                decisions.
              `,
            },
            timeout: "45m",
          });

          return { critique: critique.output };
        },
      },
      gamma: {
        do: ({ step }) => {
          const critique = step("gamma_critique").agent({
            outputSchema: CritiqueOutput,
            run: {
              agent: agents.gamma,
              cwd: meta.workspaceDir,
              sessionKey: "gamma-critique",
              prompt: md`
                You are Gamma. Now act as a red-team critic.

                Attack the other workers' reviews. Do not merely summarize them.
                Find weak evidence, missed issues, overconfidence, contradictions,
                and rubric coverage gaps. You may note self-corrections, but your
                primary target is Alpha, Beta, and Delta.

                Subject:
                ${input.subject}

                Rubric:
                ${input.rubric}

                Criteria:
                ${input.criteria}

                Worker reviews:
                Alpha: ${reviews.output.alpha.review}
                Beta: ${reviews.output.beta.review}
                Gamma: ${reviews.output.gamma.review}
                Delta: ${reviews.output.delta.review}

                Return JSON matching the declared schema. Use each field as a
                concise natural-language paragraph. Do not split content into
                arrays or nested structures. Do not output scores or acceptance
                decisions.
              `,
            },
            timeout: "45m",
          });

          return { critique: critique.output };
        },
      },
      delta: {
        do: ({ step }) => {
          const critique = step("delta_critique").agent({
            outputSchema: CritiqueOutput,
            run: {
              agent: agents.delta,
              cwd: meta.workspaceDir,
              sessionKey: "delta-critique",
              prompt: md`
                You are Delta. Now act as a red-team critic.

                Attack the other workers' reviews. Do not merely summarize them.
                Find weak evidence, missed issues, overconfidence, contradictions,
                and rubric coverage gaps. You may note self-corrections, but your
                primary target is Alpha, Beta, and Gamma.

                Subject:
                ${input.subject}

                Rubric:
                ${input.rubric}

                Criteria:
                ${input.criteria}

                Worker reviews:
                Alpha: ${reviews.output.alpha.review}
                Beta: ${reviews.output.beta.review}
                Gamma: ${reviews.output.gamma.review}
                Delta: ${reviews.output.delta.review}

                Return JSON matching the declared schema. Use each field as a
                concise natural-language paragraph. Do not split content into
                arrays or nested structures. Do not output scores or acceptance
                decisions.
              `,
            },
            timeout: "45m",
          });

          return { critique: critique.output };
        },
      },
    },
  });

  const synthesis = step("synthesize_result").agent({
    outputSchema: SynthesisOutput,
    run: {
      agent: agents.synthesizer,
      cwd: meta.workspaceDir,
      sessionKey: "synthesizer",
      prompt: md`
        You are the synthesizer for an adversarial review workflow.

        Produce the overall result. Do not average opinions mechanically. Weigh
        the blind reviews against the red-team critiques, identify which concerns
        are well-supported, and separate consensus from unresolved disagreement.

        Subject:
        ${input.subject}

        Context:
        ${input.context}

        Rubric:
        ${input.rubric}

        Criteria:
        ${input.criteria}

        Blind worker reviews:
        Alpha: ${reviews.output.alpha.review}
        Beta: ${reviews.output.beta.review}
        Gamma: ${reviews.output.gamma.review}
        Delta: ${reviews.output.delta.review}

        Adversarial critiques:
        Alpha: ${critiques.output.alpha.critique}
        Beta: ${critiques.output.beta.critique}
        Gamma: ${critiques.output.gamma.critique}
        Delta: ${critiques.output.delta.critique}

        Return JSON matching the declared schema. Use each field as a concise
        natural-language paragraph. Do not split content into arrays or nested
        structures.
      `,
    },
    timeout: "45m",
  });

  return {
    synthesis: synthesis.output,
    reviews: {
      alpha: reviews.output.alpha.review,
      beta: reviews.output.beta.review,
      gamma: reviews.output.gamma.review,
      delta: reviews.output.delta.review,
    },
    critiques: {
      alpha: critiques.output.alpha.critique,
      beta: critiques.output.beta.critique,
      gamma: critiques.output.gamma.critique,
      delta: critiques.output.delta.critique,
    },
  };
});
