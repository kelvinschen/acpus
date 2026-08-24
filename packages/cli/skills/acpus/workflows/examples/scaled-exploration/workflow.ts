/*
 * Pattern: Plan a standard-scale fanout and reduce results in batches.
 * Nodes: agent, task, fanout
 * Scale: 1 planner + breadth explorers + ceil(breadth / batchSize) reducers + 1 final.
 */
import { defineWorkflow, z } from "acpus/core";
import { md } from "acpus/expression";

const Aspect = z.object({
  name: z.string(),
  focus: z.string(),
});

const Exploration = z.object({
  aspect: z.string(),
  findings: z.array(z.string()),
  tradeoffs: z.array(z.string()),
  experiments: z.array(z.string()),
});

const Synthesis = z.object({
  strongestDirections: z.array(z.string()),
  alternatives: z.array(z.string()),
  tradeoffs: z.array(z.string()),
  openQuestions: z.array(z.string()),
  nextExperiments: z.array(z.string()),
});

export default defineWorkflow({
  name: "scaled-exploration",
  description: "Explore a broad question at standard scale and synthesize it through bounded batches.",
  inputSchema: z.object({
    subject: z.string().describe("The topic, design question, or decision space to explore."),
    rubric: z.string().describe("Goals and criteria that should shape useful directions."),
    context: z.string().default("").describe("Background, constraints, and prior decisions."),
    breadth: z.number().default(32).describe(
      "Number of distinct aspects to explore; the default yields standard scale.",
    ),
    batchSize: z.number().default(8).describe(
      "Explorer outputs per reducer Agent.",
    ),
  }),
  agents: {
    planner: {},
    explorer: {},
    synthesizer: {},
  },
}).build(({ input, agents, meta, step }) => {
  const plan = step("plan_aspects").agent({
    agent: agents.planner,
    cwd: meta.workspaceDir,
    outputSchema: z.object({ aspects: z.array(Aspect) }),
    prompt: md`
      Plan exactly ${input.breadth} distinct, non-overlapping aspects for independent exploration.

      Subject: ${input.subject}
      Goals: ${input.rubric}
      Context: ${input.context}

      Cover the decision space rather than variations of one idea. Do not solve
      the aspects. Return exactly the requested number with a short name and
      precise focus for each.`,
  });

  const aspects = step("validate_plan").task({
    input: {
      aspects: plan.output.aspects,
      breadth: input.breadth,
    },
    exec: async ({ input }) => {
      if (input.aspects.length !== input.breadth) {
        throw new Error(`Expected ${input.breadth} aspects, received ${input.aspects.length}.`);
      }
      return input.aspects;
    },
  });

  const explorations = step("explore_aspects").fanout({
    over: aspects.output,
    do: ({ item }) => step("explore_aspect").agent({
      agent: agents.explorer,
      cwd: meta.workspaceDir,
      outputSchema: Exploration,
      prompt: md`
        Explore this assigned aspect independently.

        Subject: ${input.subject}
        Goals: ${input.rubric}
        Context: ${input.context}
        Aspect: ${item.name}
        Focus: ${item.focus}

        Generate concrete findings and alternatives. Expose meaningful
        tradeoffs and propose small experiments. Do not summarize other
        aspects or judge a final answer.`,
    }).output,
  });

  const batches = step("batch_findings").task({
    input: {
      findings: explorations.output,
      batchSize: input.batchSize,
    },
    exec: async ({ input }) => Array.from(
      { length: Math.ceil(input.findings.length / input.batchSize) },
      (_, index) => input.findings.slice(index * input.batchSize, (index + 1) * input.batchSize),
    ),
  });

  const reductions = step("reduce_batches").fanout({
    over: batches.output,
    do: ({ item, itemIndex }) => step("reduce_batch").agent({
      agent: agents.synthesizer,
      cwd: meta.workspaceDir,
      outputSchema: Synthesis,
      prompt: md`
        Reduce exploration batch ${itemIndex} without erasing disagreement.

        Subject: ${input.subject}
        Goals: ${input.rubric}
        Batch findings: ${item}

        Cluster compatible findings, preserve important alternatives and
        tradeoffs, identify open questions, and retain concrete experiments.`,
    }).output,
  });

  const synthesis = step("synthesize_exploration").agent({
    agent: agents.synthesizer,
    cwd: meta.workspaceDir,
    outputSchema: Synthesis,
    prompt: md`
      Produce the final synthesis from independently reduced batches.

      Subject: ${input.subject}
      Goals: ${input.rubric}
      Context: ${input.context}
      Batch syntheses: ${reductions.output}

      Combine compatible directions without averaging away meaningful
      disagreement. Preserve notable alternatives, tradeoffs, unanswered
      questions, and the most useful next experiments.`,
  });

  return {
    aspects: aspects.output,
    synthesis: synthesis.output,
  };
});
