/*
 * Pattern: Develop one design through three resident challenge conversations
 * sharing a run-scoped plain-text blackboard.
 * Scale: at most maxRounds × (1 designer + 3 challengers); peak ready Agents: 3.
 * Nodes: agent, task, if, parallel, loop
 */
import { defineWorkflow, z } from "acpus/core";
import { and, gte, md, or } from "acpus/expression";

const Completion = z.object({
  done: z.boolean(),
});

export default defineWorkflow({
  name: "design-forge",
  description: "Develop a decision-ready design through resident challenges on a shared text blackboard.",
  inputSchema: z.object({
    brief: z.string().describe(
      "The problem, goals, constraints, and success criteria for the design.",
    ),
    maxRounds: z.number().int().positive().default(5).describe(
      "Maximum number of design and challenge rounds.",
    ),
  }),
  agents: {
    designer: { use: "trae" },
    challenger: { use: "trae" },
  },
}).build(({ input, agents, meta, step }) => {
  const blackboard = step("seed_blackboard").task({
    input: {
      brief: input.brief,
      runId: meta.runId,
    },
    exec: async ({ input, $ }) => {
      const root = `/tmp/acpus-design-forge/${input.runId}`;
      const writeOnce = async (path: string, content: string): Promise<void> => {
        const existing = await $`test -e ${path}`.nothrow();
        if (existing.exitCode !== 0) await $`printf %s ${content} > ${path}`;
      };

      await $`mkdir -p ${`${root}/reviews`}`;
      await $`chmod 700 ${root}`;
      await writeOnce(`${root}/brief.txt`, `${input.brief}\n`);
      await writeOnce(`${root}/design.txt`, "No design has been written yet.\n");
      await writeOnce(`${root}/reviews/fitness.txt`, "No fitness review has been recorded yet.\n");
      await writeOnce(`${root}/reviews/failure.txt`, "No failure review has been recorded yet.\n");
      await writeOnce(`${root}/reviews/simplicity.txt`, "No simplicity review has been recorded yet.\n");
      return { root };
    },
  });

  const cycle = step("design_cycle").loop({
    state: {
      fitnessDone: false,
      failureDone: false,
      simplicityDone: false,
      rounds: 0,
    },
    do({ state, round }) {
      const design = step("design_board").agent({
        agent: agents.designer,
        cwd: blackboard.output.root,
        prompt: md`
          Work directly in the plain-text blackboard at
          ${blackboard.output.root}. Read brief.txt, design.txt, and the three
          files under reviews/. The source workspace is ${meta.workspaceDir};
          inspect it when useful, but modify only files in the blackboard.

          Reviewer completion:
          - fitness: ${state.fitnessDone}
          - failure: ${state.failureDone}
          - simplicity: ${state.simplicityDone}

          On the first pass, create the strongest useful design you can in
          design.txt. On later passes, improve it and respond inside the review
          notebooks to every unresolved or reopened concern. Mark what you
          believe is resolved, preserve useful history and accepted constraints,
          and do not disturb a reviewer that has completed.

          There is no required notation or document template. Organize and
          rewrite the text however best supports the reasoning. The files, not
          your response, are the source of truth. Return only a very short note
          that this pass is complete.
        `,
      });

      const challengePrompt = (
        lens: string,
        focus: string,
        notebook: string,
      ) => md`
        Continue as the resident ${lens} challenger.
        Focus: ${focus}

        The Designer has completed the current pass: ${design.output}
        Work in the blackboard at ${blackboard.output.root}. Read brief.txt,
        design.txt, and any review notebook useful for context. Write only to
        ${notebook}; never edit design.txt or another challenger's notebook.

        On your first visit, record several consequential questions or
        counterexamples, make it clear that they remain unresolved, and return
        done=false. On later visits, judge the Designer's responses using the
        full design: accept adequate resolutions, reopen weak ones with concrete
        reasons, and add another useful batch when material uncertainty remains.

        When your lens has no meaningful unresolved issue and its important
        constraints are protected, record your acceptance and the constraints
        future edits must preserve, then return done=true. Otherwise return
        done=false. Use whatever plain-text organization best supports your
        reasoning; the workflow never parses the notebook.
      `;

      const challenges = step("challenge_panel").parallel({
        maxConcurrency: 3,
        branches: {
          fitness: () => step("fitness_gate").if({
            condition: state.fitnessDone,
            then: () => ({ done: true }),
            else: () => step("challenge_fitness").agent({
              agent: agents.challenger,
              cwd: blackboard.output.root,
              sessionKey: "design-forge:challenger:fitness",
              outputSchema: Completion,
              prompt: challengePrompt(
                "fitness",
                "Fit to the brief, goals, constraints, success criteria, users, and important alternatives.",
                "reviews/fitness.txt",
              ),
            }).output,
          }).output,
          failure: () => step("failure_gate").if({
            condition: state.failureDone,
            then: () => ({ done: true }),
            else: () => step("challenge_failure").agent({
              agent: agents.challenger,
              cwd: blackboard.output.root,
              sessionKey: "design-forge:challenger:failure",
              outputSchema: Completion,
              prompt: challengePrompt(
                "failure",
                "Counterexamples, edge cases, recovery, concurrency, security, and operational failure.",
                "reviews/failure.txt",
              ),
            }).output,
          }).output,
          simplicity: () => step("simplicity_gate").if({
            condition: state.simplicityDone,
            then: () => ({ done: true }),
            else: () => step("challenge_simplicity").agent({
              agent: agents.challenger,
              cwd: blackboard.output.root,
              sessionKey: "design-forge:challenger:simplicity",
              outputSchema: Completion,
              prompt: challengePrompt(
                "simplicity",
                "Unnecessary complexity, coupling, cheaper approaches, testability, comprehension, and operation.",
                "reviews/simplicity.txt",
              ),
            }).output,
          }).output,
        },
      });

      const settled = and(
        challenges.output.fitness.done,
        challenges.output.failure.done,
        challenges.output.simplicity.done,
      );
      return {
        state: {
          fitnessDone: challenges.output.fitness.done,
          failureDone: challenges.output.failure.done,
          simplicityDone: challenges.output.simplicity.done,
          rounds: round,
        },
        stop: or(settled, gte(round, input.maxRounds)),
      };
    },
  });

  const settled = and(
    cycle.output.fitnessDone,
    cycle.output.failureDone,
    cycle.output.simplicityDone,
  );
  const published = step("publish_blackboard").task({
    cwd: blackboard.output.root,
    input: {
      rounds: cycle.output.rounds,
      settled,
    },
    exec: async ({ input, $, artifact }) => {
      const [brief, design, fitness, failure, simplicity] = await Promise.all([
        $`cat brief.txt`.text(),
        $`cat design.txt`.text(),
        $`cat reviews/fitness.txt`.text(),
        $`cat reviews/failure.txt`.text(),
        $`cat reviews/simplicity.txt`.text(),
      ]);
      const content = [
        "DESIGN FORGE",
        `Outcome: ${input.settled ? "consensus" : "round limit"}`,
        `Rounds: ${input.rounds}`,
        "",
        "===== BRIEF =====",
        brief.trimEnd(),
        "",
        "===== DESIGN =====",
        design.trimEnd(),
        "",
        "===== FITNESS REVIEW =====",
        fitness.trimEnd(),
        "",
        "===== FAILURE REVIEW =====",
        failure.trimEnd(),
        "",
        "===== SIMPLICITY REVIEW =====",
        simplicity.trimEnd(),
        "",
      ].join("\n");
      return {
        blackboard: await artifact.write(
          "design-forge.txt",
          content,
          { mediaType: "text/plain" },
        ),
      };
    },
  });

  return {
    settled,
    rounds: cycle.output.rounds,
    blackboard: published.output.blackboard,
  };
});
