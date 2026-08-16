# Representative workflow patterns

Patterns are ordered from least to more orchestration. Choose the first shape that completely delivers and verifies the outcome; later patterns are not upgrades. These examples model the usual one-shot case: adapt duties and counts from the request, replace every teaching `use` with a selected Profile's exact `use` and optional `model`, replace angle-bracket literals with the current request's correctly escaped values, and never add a node merely because an example contains it.

## A. Minimal: exact deterministic observation

Use a Task-only workflow when the requested result is completely determined by a local operation and needs no model judgment. This is sufficient for requests such as listing the current workspace.

```ts
import { defineWorkflow } from "acpus/core";

export default defineWorkflow({
  name: "workspace-listing",
}).build(({ meta, step }) => {
  const listing = step("list_workspace").task({
    input: { workspaceDir: meta.workspaceDir },
    exec: async ({ input }) => {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(input.workspaceDir, { withFileTypes: true });
      return entries
        .map(entry => ({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" }))
        .sort((left, right) => left.name.localeCompare(right.name));
    },
  });
  return listing.output;
});
```

## B. Minimal: one coherent Agent duty

Use one Agent when a focused outcome needs investigation, judgment, or tool use but has no independently valuable subproblem or verification requirement.

```ts
import { defineWorkflow } from "acpus/core";
import { md } from "acpus/expression";

export default defineWorkflow({
  name: "focused-work",
  agents: { worker: { use: "selected-worker-use" } },
}).build(({ agents, meta, step }) => {
  const request = "<current user's exact focused request>";
  const result = step("work").agent({
    agent: agents.worker,
    cwd: meta.workspaceDir,
    prompt: md`
      Complete this focused request: ${request}
      Inspect or research as needed. Return the result with the evidence needed to trust it.`,
  });
  return result.output;
});
```

## C. Small: independent lenses with synthesis

Use a small parallel graph when a decision genuinely benefits from a few non-overlapping lenses. The final Agent exists because the user needs one reconciled result; omit it when parallel outputs are already the deliverable.

```ts
import { defineWorkflow } from "acpus/core";
import { md } from "acpus/expression";

export default defineWorkflow({
  name: "focused-reviewed-decision",
  agents: {
    evidence: { use: "selected-evidence-use" },
    risk: { use: "selected-risk-use" },
    synthesizer: { use: "selected-synthesizer-use" },
  },
}).build(({ agents, meta, step }) => {
  const task = "<current decision task>";
  const rubric = "<current acceptance rubric>";
  const lenses = step("independent_lenses").parallel({
    branches: {
      evidence: () => step("evidence_analysis").agent({
        agent: agents.evidence,
        cwd: meta.workspaceDir,
        prompt: md`Analyze evidence and feasibility for ${task}. Rubric: ${rubric}`,
      }).output,
      risk: () => step("risk_analysis").agent({
        agent: agents.risk,
        cwd: meta.workspaceDir,
        prompt: md`Independently analyze failure modes and tradeoffs for ${task}. Rubric: ${rubric}`,
      }).output,
    },
  });
  const result = step("synthesize").agent({
    agent: agents.synthesizer,
    cwd: meta.workspaceDir,
    prompt: md`
      Produce one decision for ${task} against ${rubric}.
      Reconcile these independent lenses and preserve material disagreement: ${lenses.output}`,
  });
  return result.output;
});
```

## D. Bounded multi-aspect work: uncertain coverage

Use a planner only when distinct coverage cannot be enumerated reliably while authoring. Derive and embed a concrete breadth from the requested coverage; the `6` below is illustrative, not a fallback count. Add staged reducers only when the resulting findings are too large for reliable direct synthesis.

```ts
import { defineWorkflow, z } from "acpus/core";
import { md } from "acpus/expression";

const Aspect = z.object({ name: z.string(), focus: z.string() });

export default defineWorkflow({
  name: "bounded-evidence-synthesis",
  agents: {
    planner: { use: "selected-planner-use" },
    researcher: { use: "selected-researcher-use" },
    synthesizer: { use: "selected-synthesizer-use" },
  },
}).build(({ agents, meta, step }) => {
  const subject = "<current research subject>";
  const asOf = "<current evidence cutoff>";
  const rubric = "<current evidence and answer rubric>";
  const breadth = 6;
  const plan = step("plan_coverage").agent({
    agent: agents.planner,
    cwd: meta.workspaceDir,
    outputSchema: z.object({ aspects: z.array(Aspect) }),
    prompt: md`
      Plan exactly ${breadth} necessary, non-overlapping research aspects.
      Subject: ${subject}
      Evidence current through: ${asOf}
      Rubric: ${rubric}
      Define coverage only; do not answer the research question.`,
  });
  const aspects = step("validate_coverage").task({
    input: { aspects: plan.output.aspects, breadth },
    exec: async ({ input }) => {
      if (input.aspects.length !== input.breadth) {
        throw new Error(`Expected ${input.breadth} aspects, got ${input.aspects.length}.`);
      }
      const names = new Set(input.aspects.map(aspect => aspect.name));
      if (names.size !== input.aspects.length) throw new Error("Aspect names must be unique.");
      return input.aspects;
    },
  });
  const findings = step("research_aspects").fanout({
    over: aspects.output,
    do: ({ item, itemIndex }) => step("research_aspect").agent({
      agent: agents.researcher,
      cwd: meta.workspaceDir,
      prompt: md`
        Investigate only aspect ${itemIndex}: ${item.name}. Focus: ${item.focus}
        Subject: ${subject}; evidence current through: ${asOf}.
        Prefer primary sources. Preserve URLs, event and publication dates,
        supported claims, contradictions, and unresolved uncertainty.`,
    }).output,
  });
  const final = step("synthesize").agent({
    agent: agents.synthesizer,
    cwd: meta.workspaceDir,
    prompt: md`
      Answer ${subject} against ${rubric}, current through ${asOf}.
      Findings: ${findings.output}
      Cite evidence near claims, reconcile contradictions, and label uncertainty.`,
  });
  return final.output;
});
```

For consequential alternatives, extend only as justified: distinct candidates → deterministic checks → independent reviewers → judge. For iterative improvement, use a resident worker and fresh reviewer in a bounded loop only when each round receives a concrete delta. Nest composites only for a real dependency, runtime collection, decision, or recovery seam.
