# Deep Research Workflow

Only an explicit `/wf:<hint>` or `/workflow:<hint>` request runs this workflow.

Deep research as an orchestrator-worker system. A resident lead decomposes the
question into independent investigation lanes; each lane is owned end to end by
one worker in its own fresh context; a writer fuses the lane reports into one
reader-facing rich report. The multi-agent shape is load-bearing: N isolated
worker contexts investigate more ground than a single saturated context, and the
lanes run in parallel, so the run buys breadth, depth, and speed at once rather
than emulating one agent with tools.

Workers use whatever fits their lane. A lane may be answered from the public web,
from the local workspace (code, configuration, tests, docs), from read-only shell
inspection, or any mix, so the workflow handles arbitrary topics including local
code projects. The workflow neither provides nor detects these capabilities; each
worker uses what the selected Agent offers and reports honestly when a source is
out of reach.

## Inputs

- `question` is required.
- `context` adds optional constraints, background, time ranges, audience,
  repositories, or source preferences.
- `depth` is `quick`, `deep` (default), or `xdeep`. It sets lane breadth,
  rounds, and cross-check in one choice: `quick` is 4 lanes in 1 round with no
  cross-check, `deep` is 6 lanes across 2 rounds, and `xdeep` is 10 lanes across
  3 rounds. A later round adds follow-up lanes for gaps the lead identifies.
- `reportFormat` is `none`, `md`, or `html`; the default is `html`.

## Cross-check as an aid, not the axis

The skeptic pass is advisory and runs for `deep` and `xdeep` only. It flags
findings that overreach their support, conflict across lanes, or rest on weak
sources, and the writer weighs those notes while drafting. Cross-check never
decides the report's structure and never gates what the report may say.

## Publication behavior

Each reader-facing Agent chooses its output language from the research question in
its context; the workflow has no language option and passes no language value
between nodes. The research brief, every lane report, and the skeptic notes flow
directly into the writer's context through workflow expressions, without
Task-written handoff files. Tasks remain only at delivery seams: the durable
evidence bundle, the internal draft directory, and publishing the report as a
durable artifact. The writer plans a reader journey, writes from foundations
toward deeper analysis, builds tables, charts, and diagrams only from lane-report
datasets and findings, and re-reads the draft before publishing.

## Outputs

The result always references the format-neutral evidence bundle (brief, coverage,
every lane report, and the skeptic notes). It returns `report: null` for `none`,
otherwise a reader-facing Markdown or self-contained HTML report as a durable
artifact.

## Run

Resolve the active Acpus skill directory and use the workflow's absolute path:

```sh
acpus workflow run /absolute/path/to/acpus-skill/workflows/library/deep-research/workflow.ts --input '{"question":"What should I research?","reportFormat":"html"}'
```

To investigate a local code project, point the run at that repository and describe
the target in `context`:

```sh
acpus workflow run /absolute/path/to/acpus-skill/workflows/library/deep-research/workflow.ts --input '{"question":"How does the runtime schedule agent turns?","context":"This repository; focus on packages/runtime.","depth":"deep","reportFormat":"md"}'
```
