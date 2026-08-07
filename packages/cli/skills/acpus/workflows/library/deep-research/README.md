# Deep Research Workflow

Only an explicit `/wf:deep-research` or `/workflow:deep-research` request runs
this workflow.

Use this workflow to investigate a complex question from several angles and turn
the findings into one sourced report. It can research public information, inspect
a local codebase, or combine both.

Deep research is a good fit when:

- the question has several related sub-questions;
- early findings may reveal gaps that need follow-up;
- claims should be compared or cross-checked before publication;
- the goal is a coherent analysis rather than uniform coverage of many items.

Use wide research instead when the main goal is to survey or compare dozens of
independent items under one consistent rubric.

Select between the workflows before invocation. Deep and wide research do not
nest or switch into one another.

## Inputs

- `question` (required): the question to investigate.
- `context` (optional): constraints or background such as audience, time range,
  repository scope, required topics, or source preferences.
- `depth` (optional): `quick`, `deep` (default), or `xdeep`. Use `quick` for a
  focused first pass, `deep` for a thorough investigation with follow-up and
  cross-checking, and `xdeep` for broad, high-stakes, or especially uncertain
  questions.
- `reportFormat` (optional): `html` (default, preferred), `md`, or `none`.

## Outputs

Every run produces `evidence-bundle.json`, containing the research scope,
coverage, detailed findings, sources, and cross-check notes when
applicable. Compatible research remains eligible for fork reuse when only the
presentation changes. Lane workers write compact records for synthesis: terms
stay stable within a lane, observations remain distinct from inference, and each
finding keeps its evidence, locator, confidence, and material caveat together.
Exact source metadata and reusable datasets travel as structured attachments;
semantic findings remain prose.
The lead also records a natural-language publication strategy in the research
brief: the reader outcome, one primary explanatory spine, opening and section
arc, evidence obligations, boundaries, and required ending. Lanes gather the
evidence for that strategy; they do not become the report's outline. The writer
uses one continuous reader path, opens with the smallest authored Markdown
orientation structure that makes the answer scannable, and moves exhaustive
reference detail out of the main narrative. HTML rendering preserves that
structure with editorial emphasis, then chooses a density profile, a
content-driven entrance, deliberate reading/medium/wide regions, legible
evidence type, evidence-gated color roles, and a quiet treatment for recurring
identifiers and source markers without adding a workflow step. The writer and
renderer use independent Agent sessions, and HTML runs retain the authoritative
Markdown as a sibling artifact of the final page. `report.artifact` identifies
the requested final format; `report.editorialArtifact` identifies the Markdown
source and equals it in Markdown mode.


## Run

Resolve the active Acpus skill directory and use the workflow's absolute path:

```sh
acpus workflow run /absolute/path/to/acpus-skill/workflows/library/deep-research/workflow.ts --input '{"question":"What should I research?","reportFormat":"html"}'
```

For a local codebase, run from that repository and describe the scope in
`context`:

```sh
acpus workflow run /absolute/path/to/acpus-skill/workflows/library/deep-research/workflow.ts --input '{"question":"How does the runtime schedule agent turns?","context":"This repository; focus on packages/runtime.","depth":"deep","reportFormat":"md"}'
```
