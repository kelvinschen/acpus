/*
 * Pattern: Run parallel agent perspectives in a bounded synthesis loop.
 * Nodes: agent, parallel, loop
 */
import { defineWorkflow, z, /* task */ } from "acpus/core";
import {
  gte, md,
  /* fmap, lift2, lift3, lift, eq, ne, lt, lte, gt, not, and, or, template */
} from "acpus/expression";
// import { createWorktree } from "acpus/tasks/git";

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
    state: {
      alpha: "",
      beta: "",
      gamma: "",
      delta: "",
      synthesis: "",
    },
    do({ round, state }) {
      const aspects = step("aspect_work").parallel({
        maxConcurrency: 4,
        branches: {
          alpha() {
            const aspect = step("alpha_aspect").agent({
              agent: agents.alpha,
              cwd: meta.workspaceDir,
              sessionKey: "alpha-brainstorm",
              prompt: md`
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

                Round: ${round}

                For round 1, produce your first independent pass. For later rounds, continue from the existing Alpha session and use the latest synthesis to deepen execution paths and tradeoffs.

                Previous synthesis:
                ${state.synthesis}

                Return concise natural-language notes with options, refinements, tradeoffs, and next experiments.
              `,
              timeout: "45m",
            });

            return { aspect: aspect.output };
          },
          beta() {
            const aspect = step("beta_aspect").agent({
              agent: agents.beta,
              cwd: meta.workspaceDir,
              sessionKey: "beta-brainstorm",
              prompt: md`
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

                Round: ${round}

                For round 1, produce your first independent pass. For later rounds, continue from the existing Beta session and use the latest synthesis to broaden alternatives and expose overlooked constraints.

                Previous synthesis:
                ${state.synthesis}

                Return concise natural-language notes with options, refinements, tradeoffs, and next experiments.
              `,
              timeout: "45m",
            });

            return { aspect: aspect.output };
          },
          gamma() {
            const aspect = step("gamma_aspect").agent({
              agent: agents.gamma,
              cwd: meta.workspaceDir,
              sessionKey: "gamma-brainstorm",
              prompt: md`
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

                Round: ${round}

                For round 1, produce your first independent pass. For later rounds, continue from the existing Gamma session and use the latest synthesis to cluster ideas and refine priorities.

                Previous synthesis:
                ${state.synthesis}

                Return concise natural-language notes with options, refinements, tradeoffs, and next experiments.
              `,
              timeout: "45m",
            });

            return { aspect: aspect.output };
          },
          delta() {
            const aspect = step("delta_aspect").agent({
              agent: agents.delta,
              cwd: meta.workspaceDir,
              sessionKey: "delta-brainstorm",
              prompt: md`
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

                Round: ${round}

                For round 1, produce your first independent pass. For later rounds, continue from the existing Delta session and use the latest synthesis to add assumptions, questions, experiments, and alternate framings.

                Previous synthesis:
                ${state.synthesis}

                Return concise natural-language notes with options, refinements, tradeoffs, and next experiments.
              `,
              timeout: "45m",
            });

            return { aspect: aspect.output };
          },
        },
      });

      const synthesis = step("synthesize_round").agent({
        agent: agents.synthesizer,
        cwd: meta.workspaceDir,
        sessionKey: "multi-aspect-synthesizer",
        prompt: md`
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

          Round: ${round}

          For round 1, produce the clearest first idea map. For later rounds, continue from the existing synthesizer session and produce the clearest idea map for this round.
          Do not average opinions mechanically.

          Current aspect outputs:
          Alpha: ${aspects.output.alpha.aspect}
          Beta: ${aspects.output.beta.aspect}
          Gamma: ${aspects.output.gamma.aspect}
          Delta: ${aspects.output.delta.aspect}

          Return a concise natural-language synthesis with strongest directions, notable alternatives, tradeoffs, open questions, and next exploration steps.
        `,
        timeout: "45m",
      });

      return {
        state: {
          alpha: aspects.output.alpha.aspect,
          beta: aspects.output.beta.aspect,
          gamma: aspects.output.gamma.aspect,
          delta: aspects.output.delta.aspect,
          synthesis: synthesis.output,
        },
        stop: gte(round, input.rounds),
      };
    },
  });

  return { synthesis: rounds.output.synthesis };
});
