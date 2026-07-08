import { defineWorkflow, z } from "acpus/core";
import { eq, ifElse, md } from "acpus/expression";

export default defineWorkflow({
  name: "multi-aspect-brainstorm",
  description: "Run multi-aspect brainstorm rounds and synthesize the final result.",

  inputSchema: z.object({
    rounds: z.number().default(1).describe(
      "Number of brainstorm rounds to run. Use 1 for a first pass; increase when you want agents to iterate on the latest synthesis.",
    ),
    subject: z.string().describe(
      "The topic, problem, product idea, design question, or decision space to brainstorm.",
    ),
    rubric: z.string().describe(
      "The main goals for the brainstorm, such as desired qualities, success direction, audience, or constraints that should shape the ideas.",
    ),
    criteria: z.string().default("").describe(
      "Optional comma-separated criteria or constraints, for example: cheap, fast to prototype, low operational risk.",
    ),
    context: z.string().default("").describe(
      "Optional background information the agents should consider, such as existing decisions, user needs, project constraints, or prior attempts.",
    ),
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
                      You are Alpha in a multi-aspect brainstorm. Your lens is practical solution design and execution paths.

                      Generate feasible directions, implementation shapes, sequencing ideas, and refinements.
                      Do not approve, reject, score, audit, or produce review findings.
                      Work independently, but use later round updates to deepen and sharpen your ideas.

                      Subject:
                      ${input.subject}

                      Context:
                      ${input.context}

                      Brainstorm goals:
                      ${input.rubric}

                      Comma-separated useful constraints and selection criteria:
                      ${input.criteria}
                    `, "")}

                    Round: ${iter}

                    ${ifElse(firstRound, "Produce your first independent pass.", md`
                      Continue from the existing Alpha session. Do not restate the setup.
                      Use the latest synthesis to add practical options, tighten execution paths, and refine tradeoffs.

                      Previous synthesis:
                      ${previous.synthesis}
                    `)}

                    Return concise natural-language notes with options, refinements, tradeoffs, and next experiments.
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
                      You are Beta in a multi-aspect brainstorm. Your lens is option expansion, unusual alternatives, and edge-aware constraints.

                      Generate non-obvious directions, neglected constraints, surprising combinations, and ways to keep risk visible while expanding choices.
                      Do not approve, reject, score, audit, or produce review findings.
                      Work independently, but use later round updates to broaden and sharpen the option space.

                      Subject:
                      ${input.subject}

                      Context:
                      ${input.context}

                      Brainstorm goals:
                      ${input.rubric}

                      Comma-separated useful constraints and selection criteria:
                      ${input.criteria}
                    `, "")}

                    Round: ${iter}

                    ${ifElse(firstRound, "Produce your first independent pass.", md`
                      Continue from the existing Beta session. Do not restate the setup.
                      Use the latest synthesis to add alternatives, expose overlooked constraints, and refine tradeoffs.

                      Previous synthesis:
                      ${previous.synthesis}
                    `)}

                    Return concise natural-language notes with options, refinements, tradeoffs, and next experiments.
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
                      You are Gamma in a multi-aspect brainstorm. Your lens is theme clustering, prioritization, and promising combinations.

                      Organize ideas into coherent themes, identify high-leverage priorities, and combine compatible directions into stronger concepts.
                      Do not approve, reject, score, audit, or produce review findings.
                      Work independently, but use later round updates to improve structure and synthesis opportunities.

                      Subject:
                      ${input.subject}

                      Context:
                      ${input.context}

                      Brainstorm goals:
                      ${input.rubric}

                      Comma-separated useful constraints and selection criteria:
                      ${input.criteria}
                    `, "")}

                    Round: ${iter}

                    ${ifElse(firstRound, "Produce your first independent pass.", md`
                      Continue from the existing Gamma session. Do not restate the setup.
                      Use the latest synthesis to cluster ideas, refine priorities, and combine promising directions.

                      Previous synthesis:
                      ${previous.synthesis}
                    `)}

                    Return concise natural-language notes with options, refinements, tradeoffs, and next experiments.
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
                      You are Delta in a multi-aspect brainstorm. Your lens is assumptions, missing information, experiments, and alternate framings.

                      Surface assumptions, open questions, small experiments, useful evidence to gather, and reframes that could unlock better ideas.
                      Do not approve, reject, score, audit, or produce review findings.
                      Work independently, but use later round updates to enrich the question set and exploration paths.

                      Subject:
                      ${input.subject}

                      Context:
                      ${input.context}

                      Brainstorm goals:
                      ${input.rubric}

                      Comma-separated useful constraints and selection criteria:
                      ${input.criteria}
                    `, "")}

                    Round: ${iter}

                    ${ifElse(firstRound, "Produce your first independent pass.", md`
                      Continue from the existing Delta session. Do not restate the setup.
                      Use the latest synthesis to add assumptions, questions, experiments, and alternate framings.

                      Previous synthesis:
                      ${previous.synthesis}
                    `)}

                    Return concise natural-language notes with options, refinements, tradeoffs, and next experiments.
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
              You are the synthesizer for a multi-aspect brainstorm.
              Combine independent aspect outputs into a useful idea map.
              Do not approve, reject, score, audit, or produce review findings.

              Subject:
              ${input.subject}

              Context:
              ${input.context}

              Brainstorm goals:
              ${input.rubric}

              Comma-separated useful constraints and selection criteria:
              ${input.criteria}
            `, "")}

            Round: ${iter}

            ${ifElse(firstRound, "Produce the clearest idea map for this first round.", "Continue from the existing synthesizer session. Produce the clearest idea map for this round.")}
            Do not average opinions mechanically.

            Current aspect outputs:
            Alpha: ${aspects.output.alpha.aspect}
            Beta: ${aspects.output.beta.aspect}
            Gamma: ${aspects.output.gamma.aspect}
            Delta: ${aspects.output.delta.aspect}

            Return a concise natural-language synthesis with strongest directions, notable alternatives, tradeoffs, open questions, and next exploration steps.
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
