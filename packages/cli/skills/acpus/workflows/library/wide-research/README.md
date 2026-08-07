# Wide Research Workflow

Only an explicit `/wf:wide-research` or `/workflow:wide-research` request runs
this workflow.

Use it to research many comparable items under one evidence rubric and publish
a sourced landscape, comparison, or recommendation. An item can be a product,
company, paper, person, source, jurisdiction, dataset, file, case, or another
independently researchable unit.

Wide research is a good fit when:

- the goal is broad coverage rather than an adaptive investigation of a few
  interdependent questions;
- every item should receive comparable evidence treatment;
- the result should expose missing evidence and source provenance.

Use deep research instead when the work depends on iterative follow-up,
cross-checking, or developing one line of argument.

## Inputs

- `question` (required): the population to research and the comparison or survey
  goal.
- `context` (optional): audience, time range, required fields, repositories,
  source preferences, or a precise definition of one item.
- `breadth` (optional): `quick` targets 8 items, `wide` targets 16 and is the
  default, and `xwide` targets 64. The workflow may return fewer when grounded
  evidence is insufficient.
- `reportFormat` (optional): `html` (default and preferred), `md`, or `none`.

## Execution

The lead defines a shared evidence frame, canonical identity rule, and up to 16
mutually exclusive coverage cells. Each Cell Worker discovers, selects,
researches, semantically reconciles, and locally compresses its own units in one
context. The publication writer owns cross-cell identities, conflicts, gaps,
and final coverage interpretation. A comparison matrix, ranking, or time series
that needs one definition and observation window stays inside one source-local
cell rather than being split by rows or periods.

The workflow keeps at most 16 Cell Workers ready at once. `quick` maps 8 cells,
`wide` maps 16, and `xwide` maps 16 cells with an average quota of 4 units each.
There is no audit or repair Task, global reducer, or serial coverage-manager
Agent. The writer receives a compact cell index and reads independent prose
records plus structured source and dataset attachments from the evidence bundle.

## Outputs

Every run produces `wide-research-evidence-bundle.json`. It contains the
research plan, prepared cells, independent Cell Worker outputs,
their coverage notes, exact source records, and reusable datasets. Semantic
findings remain Agent-authored prose rather than machine-normalized claims.
`reportFormat: none` returns only this evidence artifact.

Markdown uses one publication writer. HTML starts a fresh renderer Agent from
that completed draft so presentation cannot inherit the research context or
revise the evidence. HTML runs publish both the authoritative Markdown draft and
the final HTML artifact. `report.artifact` identifies the requested final format;
`report.editorialArtifact` identifies the Markdown source and equals it in
Markdown mode.

## Run

Resolve the active Acpus skill directory and use the workflow's absolute path:

```sh
acpus workflow run /absolute/path/to/acpus-skill/workflows/library/wide-research/workflow.ts --input '{"question":"Compare 16 agent orchestration frameworks by execution model, durability, observability, and extension surface.","breadth":"wide","reportFormat":"html"}'
```

For a source survey, define what counts as one item:

```sh
acpus workflow run /absolute/path/to/acpus-skill/workflows/library/wide-research/workflow.ts --input '{"question":"Survey 64 primary publications on inference-time scaling and summarize each publication under a common evidence rubric.","context":"One coverage unit is one paper or official technical report; prefer original publications over commentary.","breadth":"xwide","reportFormat":"md"}'
```
