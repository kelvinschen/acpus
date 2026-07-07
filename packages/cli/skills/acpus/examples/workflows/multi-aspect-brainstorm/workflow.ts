import { defineWorkflow, z } from "acpus/core";
import { eq, ifElse, md } from "acpus/expression";

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
      alpha: "",
      beta: "",
      gamma: "",
      delta: "",
      synthesis: "",
    },
    maxIterations: input.rounds,
    do: ({ iter, previous, step }) => {
      const firstRound = eq(iter, 0);
      const aspects = step("aspect_work").parallel({
        maxConcurrency: 4,
        branches: {
          alpha: {
            do: ({ step }) => {
              const aspect = step("alpha_aspect").agent({
                run: {
                  agent: agents.alpha,
                  cwd: meta.workspaceDir,
                  sessionKey: "alpha-brainstorm",
                  prompt: md`
                    ${ifElse(firstRound, md`
                      You are Alpha in a multi-aspect workflow. Your lens is correctness, feasibility, and practical execution.

                      Mode: ${input.mode}
                      If mode is "review", evaluate the subject against the rubric and criteria.
                      If mode is "brainstorm", generate useful directions, options, and refinements.
                      Work independently, but use later round updates to deepen or correct your view.

                      Subject:
                      ${input.subject}

                      Context:
                      ${input.context}

                      Rubric:
                      ${input.rubric}

                      Criteria:
                      ${input.criteria}
                    `, "")}

                    Round: ${iter}

                    ${ifElse(firstRound, "Produce your first independent pass.", md`
                      Continue from the existing Alpha session. Do not restate the setup.
                      Use the latest synthesis to deepen, correct, or sharpen your independent view.

                      Previous synthesis:
                      ${previous.synthesis}
                    `)}

                    Return concise natural-language notes. Cover your key ideas, concerns, and recommendation.
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
                run: {
                  agent: agents.beta,
                  cwd: meta.workspaceDir,
                  sessionKey: "beta-brainstorm",
                  prompt: md`
                    ${ifElse(firstRound, md`
                      You are Beta in a multi-aspect workflow. Your lens is risks, edge cases, and neglected constraints.

                      Mode: ${input.mode}
                      If mode is "review", look for failure modes and weak assumptions.
                      If mode is "brainstorm", expand the option space while keeping risks visible.
                      Work independently, but use later round updates to deepen or correct your view.

                      Subject:
                      ${input.subject}

                      Context:
                      ${input.context}

                      Rubric:
                      ${input.rubric}

                      Criteria:
                      ${input.criteria}
                    `, "")}

                    Round: ${iter}

                    ${ifElse(firstRound, "Produce your first independent pass.", md`
                      Continue from the existing Beta session. Do not restate the setup.
                      Use the latest synthesis to deepen, correct, or sharpen your independent view.

                      Previous synthesis:
                      ${previous.synthesis}
                    `)}

                    Return concise natural-language notes. Cover your key ideas, concerns, and recommendation.
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
                run: {
                  agent: agents.gamma,
                  cwd: meta.workspaceDir,
                  sessionKey: "gamma-brainstorm",
                  prompt: md`
                    ${ifElse(firstRound, md`
                      You are Gamma in a multi-aspect workflow. Your lens is rubric fit, coherence, and prioritization.

                      Mode: ${input.mode}
                      If mode is "review", check direct compliance and call out gaps.
                      If mode is "brainstorm", organize promising ideas into coherent priorities.
                      Work independently, but use later round updates to deepen or correct your view.

                      Subject:
                      ${input.subject}

                      Context:
                      ${input.context}

                      Rubric:
                      ${input.rubric}

                      Criteria:
                      ${input.criteria}
                    `, "")}

                    Round: ${iter}

                    ${ifElse(firstRound, "Produce your first independent pass.", md`
                      Continue from the existing Gamma session. Do not restate the setup.
                      Use the latest synthesis to deepen, correct, or sharpen your independent view.

                      Previous synthesis:
                      ${previous.synthesis}
                    `)}

                    Return concise natural-language notes. Cover your key ideas, concerns, and recommendation.
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
                run: {
                  agent: agents.delta,
                  cwd: meta.workspaceDir,
                  sessionKey: "delta-brainstorm",
                  prompt: md`
                    ${ifElse(firstRound, md`
                      You are Delta in a multi-aspect workflow. Your lens is evidence, assumptions, and missing alternatives.

                      Mode: ${input.mode}
                      If mode is "review", separate supported claims from speculation.
                      If mode is "brainstorm", identify missing alternatives and evidence that would improve the result.
                      Work independently, but use later round updates to deepen or correct your view.

                      Subject:
                      ${input.subject}

                      Context:
                      ${input.context}

                      Rubric:
                      ${input.rubric}

                      Criteria:
                      ${input.criteria}
                    `, "")}

                    Round: ${iter}

                    ${ifElse(firstRound, "Produce your first independent pass.", md`
                      Continue from the existing Delta session. Do not restate the setup.
                      Use the latest synthesis to deepen, correct, or sharpen your independent view.

                      Previous synthesis:
                      ${previous.synthesis}
                    `)}

                    Return concise natural-language notes. Cover your key ideas, concerns, and recommendation.
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
        run: {
          agent: agents.synthesizer,
          cwd: meta.workspaceDir,
          sessionKey: "multi-aspect-synthesizer",
          prompt: md`
            ${ifElse(firstRound, md`
              You are the synthesizer for a multi-aspect workflow.

              Mode: ${input.mode}
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
            `, "")}

            Round: ${iter}

            ${ifElse(firstRound, "Produce the best current result for this first round.", "Continue from the existing synthesizer session. Produce the best current result for this round.")}
            Do not average opinions mechanically.

            Current aspect outputs:
            Alpha: ${aspects.output.alpha.aspect}
            Beta: ${aspects.output.beta.aspect}
            Gamma: ${aspects.output.gamma.aspect}
            Delta: ${aspects.output.delta.aspect}

            Return a concise natural-language synthesis with summary, findings, tradeoffs, and next steps.
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
