import { defineWorkflow, z } from "acpus/core";
import { md } from "acpus/expression";

const AspectOutput = z.object({
  summary: z.string(),
  ideas: z.string(),
  concerns: z.string(),
  recommendation: z.string(),
});

const SynthesisOutput = z.object({
  summary: z.string(),
  findings: z.string(),
  tradeoffs: z.string(),
  nextSteps: z.string(),
});

const emptyAspect = {
  summary: "",
  ideas: "",
  concerns: "",
  recommendation: "",
};

const emptySynthesis = {
  summary: "",
  findings: "",
  tradeoffs: "",
  nextSteps: "",
};

export default defineWorkflow({
  name: "multi-aspect-brainstorm",
  description: "Run multi-aspect review or brainstorm rounds and synthesize the final result.",

  inputSchema: z.object({
    mode: z.enum(["review", "brainstorm"]).default("brainstorm"),
    rounds: z.number().default(1),
    subject: z.string(),
    rubric: z.string(),
    criteria: z.array(z.string()).default([]),
    context: z.string().default(""),
  }),

  agents: {
    alpha: {
      use: "pi",
    },
    beta: {
      use: "pi",
    },
    gamma: {
      use: "claude",
    },
    delta: {
      use: "claude",
    },
    synthesizer: {
      use: "claude",
    },
  },
}).build(({ input, agents, meta, step }) => {
  const rounds = step("brainstorm_rounds").loop({
    initial: {
      round: 0,
      alpha: emptyAspect,
      beta: emptyAspect,
      gamma: emptyAspect,
      delta: emptyAspect,
      synthesis: emptySynthesis,
    },
    maxIterations: input.rounds,
    do: ({ iter, previous, step }) => {
      const aspects = step("aspect_work").parallel({
        maxConcurrency: 4,
        branches: {
          alpha: {
            do: ({ step }) => {
              const aspect = step("alpha_aspect").agent({
                outputSchema: AspectOutput,
                run: {
                  agent: agents.alpha,
                  cwd: meta.workspaceDir,
                  sessionKey: "alpha-brainstorm",
                  prompt: md`
                    You are Alpha. Your lens is correctness, feasibility, and practical execution.

                    Mode: ${input.mode}
                    Round: ${iter}

                    If mode is "review", evaluate the subject against the rubric and criteria.
                    If mode is "brainstorm", generate useful directions, options, and refinements.
                    Work independently, but use the previous round to deepen or correct your view.

                    Subject:
                    ${input.subject}

                    Context:
                    ${input.context}

                    Rubric:
                    ${input.rubric}

                    Criteria:
                    ${input.criteria}

                    Previous synthesis:
                    ${previous.synthesis}

                    Previous Alpha output:
                    ${previous.alpha}

                    Return JSON matching the declared schema. Use each field as a concise natural-language paragraph.
                  `,
                },
                timeout: "45m",
              });

              return { aspect: aspect.output };
            },
          },
          beta: {
            do: ({ step }) => {
              const aspect = step("beta_aspect").agent({
                outputSchema: AspectOutput,
                run: {
                  agent: agents.beta,
                  cwd: meta.workspaceDir,
                  sessionKey: "beta-brainstorm",
                  prompt: md`
                    You are Beta. Your lens is risks, edge cases, and neglected constraints.

                    Mode: ${input.mode}
                    Round: ${iter}

                    If mode is "review", look for failure modes and weak assumptions.
                    If mode is "brainstorm", expand the option space while keeping risks visible.
                    Work independently, but use the previous round to deepen or correct your view.

                    Subject:
                    ${input.subject}

                    Context:
                    ${input.context}

                    Rubric:
                    ${input.rubric}

                    Criteria:
                    ${input.criteria}

                    Previous synthesis:
                    ${previous.synthesis}

                    Previous Beta output:
                    ${previous.beta}

                    Return JSON matching the declared schema. Use each field as a concise natural-language paragraph.
                  `,
                },
                timeout: "45m",
              });

              return { aspect: aspect.output };
            },
          },
          gamma: {
            do: ({ step }) => {
              const aspect = step("gamma_aspect").agent({
                outputSchema: AspectOutput,
                run: {
                  agent: agents.gamma,
                  cwd: meta.workspaceDir,
                  sessionKey: "gamma-brainstorm",
                  prompt: md`
                    You are Gamma. Your lens is rubric fit, coherence, and prioritization.

                    Mode: ${input.mode}
                    Round: ${iter}

                    If mode is "review", check direct compliance and call out gaps.
                    If mode is "brainstorm", organize promising ideas into coherent priorities.
                    Work independently, but use the previous round to deepen or correct your view.

                    Subject:
                    ${input.subject}

                    Context:
                    ${input.context}

                    Rubric:
                    ${input.rubric}

                    Criteria:
                    ${input.criteria}

                    Previous synthesis:
                    ${previous.synthesis}

                    Previous Gamma output:
                    ${previous.gamma}

                    Return JSON matching the declared schema. Use each field as a concise natural-language paragraph.
                  `,
                },
                timeout: "45m",
              });

              return { aspect: aspect.output };
            },
          },
          delta: {
            do: ({ step }) => {
              const aspect = step("delta_aspect").agent({
                outputSchema: AspectOutput,
                run: {
                  agent: agents.delta,
                  cwd: meta.workspaceDir,
                  sessionKey: "delta-brainstorm",
                  prompt: md`
                    You are Delta. Your lens is evidence, assumptions, and missing alternatives.

                    Mode: ${input.mode}
                    Round: ${iter}

                    If mode is "review", separate supported claims from speculation.
                    If mode is "brainstorm", identify missing alternatives and evidence that would improve the result.
                    Work independently, but use the previous round to deepen or correct your view.

                    Subject:
                    ${input.subject}

                    Context:
                    ${input.context}

                    Rubric:
                    ${input.rubric}

                    Criteria:
                    ${input.criteria}

                    Previous synthesis:
                    ${previous.synthesis}

                    Previous Delta output:
                    ${previous.delta}

                    Return JSON matching the declared schema. Use each field as a concise natural-language paragraph.
                  `,
                },
                timeout: "45m",
              });

              return { aspect: aspect.output };
            },
          },
        },
      });

      const synthesis = step("synthesize_round").agent({
        outputSchema: SynthesisOutput,
        run: {
          agent: agents.synthesizer,
          cwd: meta.workspaceDir,
          sessionKey: "multi-aspect-synthesizer",
          prompt: md`
            You are the synthesizer for a multi-aspect ${input.mode} workflow.

            Produce the best current result for round ${iter}. Do not average opinions mechanically.
            In review mode, separate supported findings, unresolved disagreements, and actionable next steps.
            In brainstorm mode, converge the strongest ideas into a clear direction while preserving tradeoffs.

            Subject:
            ${input.subject}

            Context:
            ${input.context}

            Rubric:
            ${input.rubric}

            Criteria:
            ${input.criteria}

            Previous synthesis:
            ${previous.synthesis}

            Current aspect outputs:
            Alpha: ${aspects.output.alpha.aspect}
            Beta: ${aspects.output.beta.aspect}
            Gamma: ${aspects.output.gamma.aspect}
            Delta: ${aspects.output.delta.aspect}

            Return JSON matching the declared schema. Use each field as a concise natural-language paragraph.
          `,
        },
        timeout: "45m",
      });

      return {
        round: iter,
        alpha: aspects.output.alpha.aspect,
        beta: aspects.output.beta.aspect,
        gamma: aspects.output.gamma.aspect,
        delta: aspects.output.delta.aspect,
        synthesis: synthesis.output,
      };
    },
    onExhausted: "returnLast",
  });

  return { synthesis: rounds.output.synthesis };
});
