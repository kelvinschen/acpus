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

## Inputs

- `question` (required): the question to investigate.
- `context` (optional): constraints or background such as audience, time range,
  repository scope, required topics, or source preferences.
- `depth` (optional): `quick`, `deep` (default), or `xdeep`. Use `quick` for a
  focused first pass, `deep` for a thorough investigation with follow-up and
  cross-checking, and `xdeep` for broad, high-stakes, or especially uncertain
  questions.
- `reportFormat` (optional): `html` (default), `md`, or `none`.

## Outputs

Every run produces a format-neutral evidence bundle containing the research
scope, coverage, detailed findings, sources, and cross-check notes when
applicable. Lane workers write compact records for downstream synthesis: terms
stay stable within a lane, observations remain distinct from inference, and each
finding keeps its evidence, locator, confidence, and material caveat together.


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
