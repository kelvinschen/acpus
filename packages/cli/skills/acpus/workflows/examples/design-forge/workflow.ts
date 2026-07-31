/*
 * Pattern: Develop one reader-facing design through three resident challenge
 * conversations sharing a run-scoped blackboard, then publish the design and a
 * separate audit package.
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
  description: "Develop and publish a decision-ready Markdown design through resident challenges on a shared blackboard.",
  inputSchema: z.object({
    brief: z.string().describe(
      "The problem, audience, goals, constraints, success criteria, and any known references for the design.",
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

      const designTemplate = [
        "# Design proposal",
        "",
        "> Status: Draft. Replace every instructional placeholder before publication.",
        "",
        "<!-- design-forge:summary -->",
        "## Decision at a glance",
        "Explain the recommendation, its audience, and the outcome it enables.",
        "",
        "<!-- design-forge:context -->",
        "## Context, scope, and success criteria",
        "Explain the current state, goals, non-goals, constraints, assumptions, and measurable success criteria.",
        "",
        "<!-- design-forge:options -->",
        "## Options and decision",
        "Compare credible alternatives, then explain the selected option and its consequences.",
        "",
        "<!-- design-forge:design -->",
        "## Proposed design",
        "Describe boundaries, responsibilities, interfaces, data, control flow, and selected diagrams.",
        "",
        "<!-- design-forge:operations -->",
        "## Reliability, security, and operations",
        "Cover failure behavior, recovery, security boundaries, observability, and the operating model.",
        "",
        "<!-- design-forge:risks -->",
        "## Risks, assumptions, and open questions",
        "Distinguish accepted trade-offs from unresolved questions and residual risks.",
        "",
        "<!-- design-forge:delivery -->",
        "## Delivery and validation",
        "Describe rollout, migration, testing, compatibility, ownership, and rollback.",
        "",
        "<!-- design-forge:references -->",
        "## References",
        "List only sources registered in references.json and cite them by stable ID.",
        "",
      ].join("\n");
      const referenceTemplate = `${JSON.stringify({
        schemaVersion: 1,
        external: [],
        workspace: [],
      }, null, 2)}\n`;
      const decisionTemplate = [
        "# Decision log",
        "",
        "Track architecturally significant choices with stable IDs such as D-001.",
        "",
        "| ID | Status | Decision | Context and rationale | Alternatives | Consequences and reversibility |",
        "| --- | --- | --- | --- | --- | --- |",
        "",
      ].join("\n");
      const diagramTemplate = [
        "# Diagram plan",
        "",
        "For every selected or rejected visual, record the reader question, diagram type, scope, and rationale.",
        "A diagram is optional when prose or a compact table communicates the design more clearly.",
        "",
      ].join("\n");

      await $`mkdir -p ${`${root}/reviews`}`;
      await $`chmod 700 ${root}`;
      await writeOnce(`${root}/brief.txt`, `${input.brief}\n`);
      await writeOnce(`${root}/design.txt`, designTemplate);
      await writeOnce(`${root}/references.json`, referenceTemplate);
      await writeOnce(`${root}/decision-log.md`, decisionTemplate);
      await writeOnce(`${root}/diagram-plan.md`, diagramTemplate);
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
          Role
          You are the design owner and publication author. Develop the design and
          maintain one reader-facing Markdown document that a decision maker,
          implementer, operator, and future maintainer can understand without
          reading the review notebooks.

          Blackboard
          Work directly in ${blackboard.output.root}. Read brief.txt, design.txt,
          references.json, decision-log.md, diagram-plan.md, and all three files
          under reviews/. The source workspace is ${meta.workspaceDir}; inspect it
          when useful, but modify only files in the blackboard.

          Reviewer completion
          - fitness: ${state.fitnessDone}
          - failure: ${state.failureDone}
          - simplicity: ${state.simplicityDone}

          Primary deliverable
          design.txt is the final reader-facing Markdown design document, not a
          scratchpad and not a transcript. On the first pass, replace the seeded
          instructional text with the strongest useful design you can. On later
          passes, improve it and respond inside each active review notebook to
          every unresolved or reopened concern. Preserve accepted constraints and
          do not disturb a reviewer that has completed.

          Reader-first document contract
          - Write in the language of the brief unless the brief explicitly asks
            for another language.
          - Use progressive disclosure. Lead with the decision, expected outcome,
            audience, and status. Explain context and alternatives before
            implementation detail. Keep review history and exhaustive evidence
            outside the main narrative.
          - Preserve these exact hidden markers in design.txt so publication can
            validate coverage: design-forge:summary, design-forge:context,
            design-forge:options, design-forge:design,
            design-forge:operations, design-forge:risks,
            design-forge:delivery, and design-forge:references.
          - State goals, non-goals, constraints, assumptions, success measures,
            current state, and the chosen design explicitly. Define unfamiliar
            terms and abbreviations on first use.
          - Use compact tables for alternatives, interface inventories, risk
            registers, rollout phases, or responsibility mappings when comparison
            is the reader's task. Introduce every table and keep its cells concise.
          - Give each paragraph one job. State its point early, then explain what,
            why, and how. Remove duplicated conclusions and review chatter.
          - Keep unresolved questions and residual risks visible without letting
            them obscure the recommended path.

          Design and decision contract
          - Maintain decision-log.md with stable D-001-style IDs for significant
            choices. Record context, status, the selected option, rationale,
            alternatives, consequences, and reversibility.
          - Explain system boundaries, responsibilities, interfaces, data
            ownership, control flow, invariants, compatibility, and operational
            ownership at the level needed to implement and review the proposal.
          - Cover failure modes, concurrency, recovery, security and privacy
            boundaries, observability, testing, rollout, migration, and rollback
            when relevant. Do not manufacture requirements absent from the brief;
            label assumptions and open questions instead.
          - Distinguish sourced facts from design judgments. Make the reasoning
            chain from goals and constraints to decisions visible.

          Evidence and reference contract
          - Inspect the workspace for authoritative local facts. Use available Web
            Search or public-page reading only when an external reference
            materially improves a factual claim, standard choice, prior-art
            comparison, or design rationale.
          - Never invent a URL, title, repository path, source claim, benchmark, or
            standard. When external retrieval is unavailable, continue with
            workspace evidence and identify the remaining evidence gap.
          - Register every citation in references.json before using it. Preserve
            this exact JSON shape:
              schemaVersion: 1
              external: entries with id, title, url, publisher, sourceType,
              relevance, and supports
              workspace: entries with id, path, title, relevance, and supports
          - Use R1, R2, and so on for external entries and W1, W2, and so on for
            workspace entries. Cite them in design.txt as [R1] or [W1]. Every
            citation must resolve and support the adjacent claim.
          - In the References section, list every cited ID with its title and
            publisher plus a clickable public URL, or its repository-relative path
            for workspace evidence. Do not register or list unused sources.
          - Prefer primary, official, standards, research-paper, and repository
            sources over commentary. Explain why a weaker source is still useful.

          Visual communication contract
          - Add a visual only when it reduces cognitive load for an important
            reader question. Decorative charts are not allowed.
          - Use a context or container view for boundaries and ownership, a
            flowchart or sequence diagram for behavior across participants, a
            state diagram for lifecycle rules, an entity-relationship view for
            persistent data, and a deployment view for runtime topology. Use a
            table instead when comparison is the actual reader task.
          - Embed selected diagrams as Mermaid fenced blocks in design.txt and keep
            diagram-plan.md current with the reader question, type, scope, and
            rationale for each selected or rejected visual.
          - Give every diagram a figure title and a one-sentence reading guide.
            State scope and abstraction level. Name every element, label every
            relationship with intent, define abbreviations, keep notation
            consistent, and ensure prose and diagram describe the same design.
          - Prefer a few high-information diagrams over many shallow ones. Do not
            encode essential meaning only through color, shape, or layout; include
            a concise textual fallback.

          Review handling
          - Review issues need stable IDs, explicit status, and a concrete
            resolution in the notebook. Mark what you believe is resolved and
            identify the corresponding document, decision, evidence, or diagram
            change.
          - A reviewer may reopen weak resolutions. Do not mark an issue resolved
            merely because it was discussed.
          - The files, not your response, are the source of truth. Return only a
            very short note that this pass is complete.
        `,
      });

      const challengePrompt = (
        lens: string,
        focus: string,
        notebook: string,
      ) => md`
        Continue as the resident ${lens} challenger.
        Primary focus: ${focus}

        The Designer has completed the current pass: ${design.output}
        Work in the blackboard at ${blackboard.output.root}. Read brief.txt,
        design.txt, references.json, decision-log.md, diagram-plan.md, and any
        review notebook useful for context. Write only to ${notebook}; never edit
        design.txt, a support file, or another challenger's notebook.

        Challenge both the design and the document that communicates it.
        design.txt is the proposed final artifact, so a sound idea hidden inside
        an unreadable, untraceable, or misleading document is not complete.

        Review method
        - On your first visit, record several consequential questions,
          counterexamples, or document defects and return done=false.
        - Give each issue a stable lens-specific ID, severity, affected section,
          decision or figure, concrete evidence or counterexample, required
          change, and status. Avoid cosmetic preferences that do not affect a
          decision, implementation, operation, or reader comprehension.
        - On later visits, judge the response against the full current document
          and support files. Accept adequate resolutions, reopen weak ones with
          concrete reasons, and add another useful batch when material uncertainty
          remains.

        Design checks shared by every lens
        - Trace the proposal from goals, non-goals, constraints, and success
          criteria through alternatives to the selected decisions.
        - Check that consequential assumptions, interfaces, invariants, data
          ownership, failure behavior, security boundaries, rollout, testing,
          observability, and operational ownership are covered when relevant.
        - Verify that decision-log.md captures significant choices and their
          rationale, alternatives, consequences, and reversibility.

        Publication checks shared by every lens
        - A busy reader should understand the decision and impact from the opening,
          then move from context to detail without reading review logs.
        - Headings, paragraphs, lists, tables, and terminology must reduce rather
          than add cognitive load. Repeated caveats and raw challenge history
          belong outside the main narrative.
        - Every [R...] and [W...] citation must resolve in references.json. Reject
          invented, irrelevant, stale, or non-supporting references and factual
          claims presented without evidence when evidence is material.
        - Every selected diagram must answer a named reader question, declare its
          scope and abstraction level, name its elements, label relationship
          intent, define notation, agree with the prose, and have a text fallback.
          Request a missing diagram only when it communicates an important
          boundary, behavior, lifecycle, data model, or deployment more clearly
          than prose or a table.
        - Open questions and residual risks must be visible and calibrated while
          the recommended path remains unambiguous.

        Completion rule
        When your lens has no meaningful unresolved design or publication issue
        and its important constraints are protected, record acceptance plus the
        constraints future edits must preserve, then return done=true. Otherwise
        return done=false. The workflow never parses the notebook, so use clear
        plain-text organization and return only JSON matching the schema.
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
                "Fit to the brief, audience, current state, goals, constraints, success criteria, alternatives, decision traceability, and strength of supporting references.",
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
                "Counterexamples, edge cases, recovery, concurrency, security, privacy, compatibility, rollout, observability, and operational failure, including whether temporal or boundary diagrams expose risky paths.",
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
      workspaceDir: meta.workspaceDir,
    },
    exec: async ({ input, $, artifact }) => {
      const brief = await $`cat brief.txt`.text();
      const design = await $`cat design.txt`.text();
      const referencesText = await $`cat references.json`.text();
      const decisions = await $`cat decision-log.md`.text();
      const diagramPlan = await $`cat diagram-plan.md`.text();
      const fitness = await $`cat reviews/fitness.txt`.text();
      const failure = await $`cat reviews/failure.txt`.text();
      const simplicity = await $`cat reviews/simplicity.txt`.text();

      const document = design.trim();
      if (document.length < 800 || document.includes("Replace every instructional placeholder")) {
        throw new Error("design.txt is still an incomplete instructional draft.");
      }
      if (!/^#\s+\S+/m.test(document) || (document.match(/^##\s+/gm) ?? []).length < 5) {
        throw new Error("design.txt needs a title and a scannable section hierarchy.");
      }
      const requiredMarkers = [
        "summary",
        "context",
        "options",
        "design",
        "operations",
        "risks",
        "delivery",
        "references",
      ];
      const missingMarkers = requiredMarkers.filter(marker =>
        !document.includes(`<!-- design-forge:${marker} -->`));
      if (missingMarkers.length) {
        throw new Error(`design.txt is missing publication sections: ${missingMarkers.join(", ")}.`);
      }

      type ExternalReference = {
        id: string;
        title: string;
        url: string;
        publisher: string;
        sourceType: string;
        relevance: string;
        supports: string;
      };
      type WorkspaceReference = {
        id: string;
        path: string;
        title: string;
        relevance: string;
        supports: string;
      };
      type ReferenceRegistry = {
        schemaVersion: number;
        external: ExternalReference[];
        workspace: WorkspaceReference[];
      };

      let parsed: unknown;
      try {
        parsed = JSON.parse(referencesText) as unknown;
      } catch {
        throw new Error("references.json must contain valid JSON.");
      }
      const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value);
      const hasText = (value: unknown): value is string =>
        typeof value === "string" && value.trim().length > 0;
      if (
        !isRecord(parsed)
        || parsed.schemaVersion !== 1
        || !Array.isArray(parsed.external)
        || !Array.isArray(parsed.workspace)
      ) {
        throw new Error("references.json does not match the design-forge reference registry.");
      }

      const ids = new Set<string>();
      const external: ExternalReference[] = [];
      for (const candidate of parsed.external) {
        if (
          !isRecord(candidate)
          || !hasText(candidate.id)
          || !hasText(candidate.title)
          || !hasText(candidate.url)
          || !hasText(candidate.publisher)
          || !hasText(candidate.sourceType)
          || !hasText(candidate.relevance)
          || !hasText(candidate.supports)
        ) {
          throw new Error("An external reference is missing required provenance fields.");
        }
        if (!/^R[1-9]\d*$/.test(candidate.id) || ids.has(candidate.id)) {
          throw new Error(`Invalid or duplicate external reference ID '${candidate.id}'.`);
        }
        let protocol = "";
        try {
          protocol = new URL(candidate.url).protocol;
        } catch {
          throw new Error(`External reference '${candidate.id}' has an invalid URL.`);
        }
        if (protocol !== "http:" && protocol !== "https:") {
          throw new Error(`External reference '${candidate.id}' must use public HTTP(S).`);
        }
        ids.add(candidate.id);
        external.push({
          id: candidate.id,
          title: candidate.title,
          url: candidate.url,
          publisher: candidate.publisher,
          sourceType: candidate.sourceType,
          relevance: candidate.relevance,
          supports: candidate.supports,
        });
      }

      const workspace: WorkspaceReference[] = [];
      for (const candidate of parsed.workspace) {
        if (
          !isRecord(candidate)
          || !hasText(candidate.id)
          || !hasText(candidate.path)
          || !hasText(candidate.title)
          || !hasText(candidate.relevance)
          || !hasText(candidate.supports)
        ) {
          throw new Error("A workspace reference is missing required provenance fields.");
        }
        const path = candidate.path.trim().replaceAll("\\", "/");
        if (
          !/^W[1-9]\d*$/.test(candidate.id)
          || ids.has(candidate.id)
          || path.startsWith("/")
          || path.split("/").includes("..")
        ) {
          throw new Error(`Workspace reference '${candidate.id}' is invalid or unsafe.`);
        }
        const existing = await $`test -e ${`${input.workspaceDir}/${path}`}`.nothrow();
        if (existing.exitCode !== 0) {
          throw new Error(`Workspace reference '${candidate.id}' points to a missing path.`);
        }
        ids.add(candidate.id);
        workspace.push({
          id: candidate.id,
          path,
          title: candidate.title,
          relevance: candidate.relevance,
          supports: candidate.supports,
        });
      }
      const references: ReferenceRegistry = {
        schemaVersion: 1,
        external,
        workspace,
      };

      const cited = [...document.matchAll(/\[((?:R|W)[1-9]\d*)\]/g)]
        .flatMap(match => match[1] === undefined ? [] : [match[1]]);
      const citedIds = new Set(cited);
      const unresolvedCitations = [...citedIds].filter(id => !ids.has(id));
      if (unresolvedCitations.length) {
        throw new Error(`design.txt cites unknown references: ${unresolvedCitations.join(", ")}.`);
      }
      const unusedReferences = [...ids].filter(id => !citedIds.has(id));
      if (unusedReferences.length) {
        throw new Error(`references.json contains unused sources: ${unusedReferences.join(", ")}.`);
      }
      for (const source of external) {
        if (!document.includes(source.url)) {
          throw new Error(`The References section must link external source '${source.id}'.`);
        }
      }
      for (const source of workspace) {
        if (!document.includes(source.path)) {
          throw new Error(`The References section must name workspace source '${source.id}'.`);
        }
      }
      if (document.includes("file://")) {
        throw new Error("design.txt must not publish file:// links.");
      }

      const lines = document.split(/\r?\n/);
      let inMermaid = false;
      let mermaidLines = 0;
      let mermaidCount = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!inMermaid && trimmed === "```mermaid") {
          inMermaid = true;
          mermaidLines = 0;
          mermaidCount += 1;
          continue;
        }
        if (inMermaid && trimmed === "```") {
          if (mermaidLines < 2) {
            throw new Error("A Mermaid diagram is empty or uninformative.");
          }
          inMermaid = false;
          continue;
        }
        if (inMermaid && trimmed) mermaidLines += 1;
      }
      if (inMermaid) throw new Error("design.txt has an unclosed Mermaid fence.");

      const outcome = input.settled ? "consensus" : "round-limit";
      const markdown = [
        "---",
        `design_forge_outcome: ${outcome}`,
        `design_forge_rounds: ${input.rounds}`,
        `design_forge_diagrams: ${mermaidCount}`,
        "---",
        "",
        document,
        "",
      ].join("\n");
      const reviewLog = [
        "DESIGN FORGE REVIEW LOG",
        `Outcome: ${outcome}`,
        `Rounds: ${input.rounds}`,
        "",
        "===== BRIEF =====",
        brief.trimEnd(),
        "",
        "===== DECISION LOG =====",
        decisions.trimEnd(),
        "",
        "===== DIAGRAM PLAN =====",
        diagramPlan.trimEnd(),
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
      const designPackage = {
        schemaVersion: 1,
        outcome,
        rounds: input.rounds,
        diagramCount: mermaidCount,
        brief: brief.trimEnd(),
        document,
        references,
        decisionLog: decisions.trimEnd(),
        diagramPlan: diagramPlan.trimEnd(),
        reviews: {
          fitness: fitness.trimEnd(),
          failure: failure.trimEnd(),
          simplicity: simplicity.trimEnd(),
        },
      };

      const blackboard = await artifact.write(
        "design-forge.md",
        markdown,
        { mediaType: "text/markdown" },
      );
      await artifact.write(
        "design-forge-package.json",
        JSON.stringify(designPackage, null, 2),
        { mediaType: "application/json" },
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
