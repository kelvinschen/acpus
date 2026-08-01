/*
 * Pattern: Develop one reader-facing design through three resident challenge
 * conversations sharing a run-scoped text blackboard, then publish the design
 * separately from the review history.
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
  description: "Develop and publish a readable Markdown design through resident challenges on a shared text blackboard.",
  inputSchema: z.object({
    brief: z.string().describe(
      "The problem, audience, goals, constraints, success criteria, and any useful starting context for the design.",
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
          You own both the design and the document that communicates it.

          Work directly in the text blackboard at ${blackboard.output.root}. Read
          brief.txt, design.txt, and the three files under reviews/. The source
          workspace is ${meta.workspaceDir}; inspect it when useful. You may also
          consult public sources when they materially improve the proposal, but
          modify only files in the blackboard.

          Reviewer completion:
          - fitness: ${state.fitnessDone}
          - failure: ${state.failureDone}
          - simplicity: ${state.simplicityDone}

          design.txt is the reader-facing Markdown deliverable, not a scratchpad
          or review transcript. On the first pass, write the strongest useful
          proposal you can. On later passes, improve it and respond inside each
          active review notebook to unresolved or reopened concerns. Preserve
          accepted constraints and do not disturb a reviewer that has completed.

          Use judgment rather than a fixed template. Shape the document around the
          brief, its audience, and the actual design. Make the recommendation and
          its consequences easy to find, then provide the context, alternatives,
          design detail, risks, operations, validation, and delivery information
          that this particular proposal needs. Omit sections that add no value and
          add sections the subject genuinely requires.

          Optimize for reading and decision making:
          - Prefer a clear narrative with useful headings and progressive detail.
          - Separate facts, assumptions, decisions, trade-offs, and open questions.
          - Explain important boundaries, responsibilities, interfaces, flows,
            failure behavior, security concerns, and rollout implications when
            they matter to the design.
          - Use a compact table when comparison is easier to understand in rows and
            columns.
          - Add Mermaid diagrams only when a visual explains an important
            architecture, process, interaction, lifecycle, data relationship, or
            deployment more clearly than prose. Give each useful diagram enough
            surrounding explanation to be understood and keep it consistent with
            the text. Do not add decorative diagrams.
          - Cite authoritative workspace files or public sources when they support
            material factual claims, standards, constraints, or prior art. Use
            normal Markdown links or a references section in whatever style best
            fits the document. Never invent a source, and do not force citations
            onto design judgments or common background knowledge.
          - Keep the final document self-contained. Keep challenge history in the
            review notebooks rather than copying it into the proposal.

          This is a best-effort design, not a compliance form. There is no required
          heading list, citation notation, diagram count, decision schema, or
          publication marker. The quality bar is that the result is useful,
          credible, appropriately visual, and easy for its intended readers to
          follow.

          The files, not your response, are the source of truth. Return only a very
          short note that this pass is complete.
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
        design.txt, and any review notebook useful for context. The source
        workspace is ${meta.workspaceDir}; inspect it or relevant public sources
        when useful. Write only to ${notebook}; never edit design.txt or another
        challenger's notebook.

        Challenge both the proposal and how well design.txt communicates it, but
        do not turn the review into a rigid compliance checklist. Concentrate on
        consequential gaps, weak assumptions, counterexamples, misleading
        explanations, and choices that a decision maker, implementer, operator, or
        future maintainer could misunderstand.

        Consider whether the document makes the recommendation, rationale,
        alternatives, trade-offs, boundaries, important failure modes, and open
        questions clear at the depth appropriate to this brief. Also consider
        whether a table, diagram, or reference would materially improve the
        explanation, and whether any existing visual or citation is useful and
        trustworthy. Do not demand a particular section, notation, source count,
        or diagram merely for completeness.

        On your first visit, record a useful batch of the most important unresolved
        concerns and return done=false. On later visits, judge the Designer's
        responses against the full current design, accept adequate resolutions,
        reopen weak ones with concrete reasons, and add new concerns only when they
        are material. Organize the notebook however best supports the conversation.

        When your lens has no meaningful unresolved issue and its important
        constraints are protected, record your acceptance and the constraints
        future edits must preserve, then return done=true. Otherwise return
        done=false. Return only JSON matching the schema.
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
                "Fit to the brief, audience, goals, constraints, success criteria, important alternatives, and strength of the recommendation and supporting evidence.",
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
                "Counterexamples, edge cases, recovery, concurrency, security, privacy, compatibility, rollout, observability, and operational failure.",
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
                "Unnecessary complexity, coupling, cheaper approaches, testability, operability, document hierarchy, terminology, duplication, and whether every table or diagram earns its cognitive cost.",
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
      const brief = await $`cat brief.txt`.text();
      const design = await $`cat design.txt`.text();
      const fitness = await $`cat reviews/fitness.txt`.text();
      const failure = await $`cat reviews/failure.txt`.text();
      const simplicity = await $`cat reviews/simplicity.txt`.text();
      const outcome = input.settled ? "consensus" : "round limit";
      const reviewLog = [
        "DESIGN FORGE REVIEW LOG",
        `Outcome: ${outcome}`,
        `Rounds: ${input.rounds}`,
        "",
        "===== BRIEF =====",
        brief.trimEnd(),
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

      const blackboard = await artifact.write(
        "design-forge.md",
        `${design.trimEnd()}\n`,
        { mediaType: "text/markdown" },
      );
      await artifact.write(
        "design-forge-review-log.txt",
        reviewLog,
        { mediaType: "text/plain" },
      );
      return { blackboard };
    },
  });

  return {
    settled,
    rounds: cycle.output.rounds,
    blackboard: published.output.blackboard,
  };
});