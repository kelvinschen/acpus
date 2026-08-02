/*
 * Pattern: Develop one reader-facing design through a resident Designer and three scoped resident challenge conversations sharing a run-scoped text blackboard, then publish the design with final review state.
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
      const pendingReview = [
        "# Status",
        "",
        "pending",
        "",
        "# Active Blockers",
        "",
        "None recorded yet.",
        "",
        "# Accepted Constraints",
        "",
        "None recorded yet.",
        "",
      ].join("\n");

      await $`mkdir -p ${`${root}/reviews`}`;
      await $`chmod 700 ${root}`;
      await writeOnce(`${root}/brief.txt`, `${input.brief}\n`);
      await writeOnce(`${root}/design.md`, "No design has been written yet.\n");
      await writeOnce(`${root}/reviews/fitness.txt`, pendingReview);
      await writeOnce(`${root}/reviews/failure.txt`, pendingReview);
      await writeOnce(`${root}/reviews/simplicity.txt`, pendingReview);
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
      step("design_board").agent({
        agent: agents.designer,
        cwd: blackboard.output.root,
        sessionKey: "design-forge:designer",
        prompt: md`
          You own both the design and the document that communicates it.

          Read brief.txt, design.md, and the three files under reviews/. brief.txt
          contains the design problem, audience, goals, constraints, success
          criteria, and starting context. The source workspace is
          ${meta.workspaceDir}. Modify only design.md.

          design.md is the reader-facing Markdown deliverable, not a scratchpad
          or review transcript. If no design has been written, inspect the source
          workspace and public sources as needed, then write the strongest useful
          proposal you can. Otherwise, treat Active Blockers as the authoritative
          delta: make the smallest coherent edits that resolve them, preserve every
          Accepted Constraint, and keep accepted decisions stable. Do not broaden
          the pass unless resolving a blocker requires it. Prefer deleting stale
          text over adding parallel explanations.

          Write the design in the task language used by brief.txt. Preserve code,
          identifiers, and source quotations in their original language when that
          improves precision.

          Write like a knowledgeable teammate addressing this audience: direct,
          concrete, and natural. Let facts and reasoning carry the argument; do
          not manufacture weight with stock framing, empty summaries, inflated
          claims, or performative jargon. Preserve facts, terminology, attribution,
          responsibility, and uncertainty. Once the document is clear and useful,
          stop polishing rather than trade precision for personality.

          Shape the document around the brief, its audience, and the actual design.
          Make the recommendation and its consequences easy to find, then provide
          only the context, alternatives, design detail, risks, operations,
          validation, and delivery information that this proposal needs.

          Optimize for reading and decision making:
          - Prefer a clear narrative with useful headings and progressive detail.
          - Separate facts, assumptions, decisions, trade-offs, and open questions.
          - Explain important boundaries, responsibilities, interfaces, flows,
            failure behavior, security concerns, and rollout implications when
            they matter to the design.
          - Use a compact table when comparison is easier to understand in rows and
            columns.
          - Use Mermaid diagrams to make important architecture, processes,
            interactions, lifecycles, data relationships, or deployments easier to
            understand. Give each diagram enough surrounding explanation, keep it
            consistent with the text, and omit diagrams that add no information.
          - Cite authoritative workspace files or public sources when they support
            material factual claims, standards, constraints, or prior art. Use
            normal Markdown links or a references section in whatever style best
            fits the document. Never invent a source, and do not force citations
            onto design judgments or common background knowledge.
          - Keep the final document self-contained.

          Update design.md, then reply with a very short completion note.
        `,
      });

      const challengePrompt = (
        lens: string,
        focus: string,
        notebook: string,
      ) => md`
        You are the ${lens} challenger.
        Focus: ${focus}

        Read brief.txt, design.md, and ${notebook}. brief.txt contains the design
        problem, audience, goals, constraints, success criteria, and starting
        context. Do not read another challenger's notebook.
        The source workspace is ${meta.workspaceDir}. Inspect it or relevant public
        sources only as needed to establish or adjudicate a blocker.
        Write only to that notebook; never edit design.md or another challenger's
        notebook.
        Write your notebook in the task language used by brief.txt. Preserve code,
        identifiers, and source quotations in their original language when that
        improves precision.

        Write like a knowledgeable teammate: direct, concrete, and natural. Let
        facts and reasoning carry the judgment; do not manufacture weight with
        stock framing, empty summaries, inflated claims, or performative jargon.
        Preserve facts, terminology, attribution, responsibility, and uncertainty.

        Review both the proposal and how clearly design.md communicates it. Block
        only on concrete gaps, weak assumptions, counterexamples, or misleading
        explanations within your focus that could materially change a decision,
        implementation, operational risk, or confidence in the evidence.

        If Status is pending, record at most three highest-consequence blockers;
        accept immediately if none exists. If Status is open, adjudicate only the
        existing Active Blockers. Add a blocker only for a regression introduced by
        the latest design pass; ignore newly noticed pre-existing concerns.

        Replace the entire notebook in every review; never append review history.
        Keep exactly these compact sections:
        - Status: replace the initial pending value with open or accepted.
        - Active Blockers: only unresolved blockers, or "None."
        - Accepted Constraints: concise decisions future edits must preserve.

        Return done=true exactly when Status is accepted and Active Blockers is
        empty. Return done=false exactly when Status is open.
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
      const design = await $`cat design.md`.text();
      const fitness = await $`cat reviews/fitness.txt`.text();
      const failure = await $`cat reviews/failure.txt`.text();
      const simplicity = await $`cat reviews/simplicity.txt`.text();
      const outcome = input.settled ? "consensus" : "round limit";
      const reviewState = [
        "DESIGN FORGE FINAL REVIEW STATE",
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
        "design-forge-review-state.txt",
        reviewState,
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
