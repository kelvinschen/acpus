# Wide Research Workflow

Only an explicit `/wf:wide-research` or `/workflow:wide-research` request runs
this workflow.

Use this workflow to research many comparable items under one consistent rubric
and turn the findings into a sourced comparison. An item can be a product,
company, paper, person, source, jurisdiction, dataset, file, case, or any other
independently researchable unit.

Wide research is a good fit when:

- the goal is broad coverage rather than a deep investigation of a few
  interdependent questions;
- every item should receive comparable attention;
- the result should show coverage, missing evidence, and source provenance.

Use deep research instead when the work depends on adaptive follow-up,
cross-checking, or developing one line of argument.

## Inputs

- `question` (required): the population to research and the comparison or survey
  goal.
- `context` (optional): constraints such as audience, time range, required
  fields, repositories, source preferences, or a precise definition of one item.
- `breadth` (optional): coverage preset: `quick` (8 items), `wide` (16,
  default), or `xwide` (64). The workflow may return fewer when evidence is
  insufficient.
- `reportFormat` (optional): `html` (default), `md`, or `none`.

## Outputs

Every run produces `wide-research-evidence-bundle.json` with the research scope,
selected items, per-item findings, coverage statistics, unresolved gaps, and a
deduplicated source index. Unit researchers use the same compact evidence-record
standard as deep-research lane workers: terms stay stable within a record,
observations remain distinct from inference, and each finding keeps its evidence,
locator, confidence, and material caveat together for reduction.
The lead also records a natural-language publication strategy in the research
brief: the reader outcome, one primary explanatory spine, opening and section
arc, evidence obligations, boundaries, and required ending. Coverage units and
the common rubric supply comparable evidence for that strategy; they do not
dictate the final report's section order. The writer opens with the smallest
authored Markdown orientation structure that makes the answer scannable. HTML
rendering preserves that structure with editorial emphasis, then chooses a
density profile, a content-driven entrance, deliberate reading/medium/wide
regions, legible evidence type, evidence-gated color roles, and a quiet treatment
for recurring identifiers and source markers without adding a workflow step.


## Run

Resolve the active Acpus skill directory and use the workflow's absolute path:

```sh
acpus workflow run /absolute/path/to/acpus-skill/workflows/library/wide-research/workflow.ts --input '{"question":"Compare 16 agent orchestration frameworks by execution model, durability, observability, and extension surface.","breadth":"wide","reportFormat":"html"}'
```

For a source survey, define what counts as one item:

```sh
acpus workflow run /absolute/path/to/acpus-skill/workflows/library/wide-research/workflow.ts --input '{"question":"Survey 64 primary publications on inference-time scaling and summarize each publication under a common evidence rubric.","context":"One coverage unit is one paper or official technical report; prefer original publications over commentary.","breadth":"xwide","reportFormat":"md"}'
```
