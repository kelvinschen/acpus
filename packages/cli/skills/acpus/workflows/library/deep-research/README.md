# Deep Research Workflow

Only an explicit `/wf:<hint>` or `/workflow:<hint>` request runs this public-web research workflow. Never use it for local files, repositories, code analysis, debugging, review, or implementation.

## Inputs

- `question` is required.
- `context` adds optional constraints, background, time ranges, audience context, or source preferences.
- `depth` is `quick`, `deep` (default), or `xdeep`. Omit it unless named; `xdeep` requires explicit `xdeep` or `extra deep`.
- `reportLanguage` is `auto`, `zh-CN`, or `en`; the default is `auto`.
- `maxAgentConcurrency` controls local fanout burst size; the default is `12`.
- `reportFormat` is `none`, `md`, or `html`; the default is `html`.
- `reportPath` optionally selects a workspace-contained destination for `md` or `html`; `none` ignores it.

## Requirements

Research Agents must provide Web Search, public HTTP retrieval, and local artifact reads. Markdown or HTML presentation also requires one workspace-scoped report write. Optional source-image use needs public media retrieval; when that is unavailable or reuse rights are unclear, publication falls back to package-grounded tables, diagrams, charts, and prose without failing the run. Acpus does not provide or detect these tools.

## Publication behavior

The publisher Agent plans a reader journey, writes from foundations toward deeper analysis, selects visuals only when they improve understanding, and re-reads the completed draft for reader experience plus evidence and visual integrity before publishing. It adapts the article and visual mix to the topic rather than filling a fixed template. Safety Tasks remain limited to paths, artifacts, and idempotent delivery.

## Outputs

The result always references the format-neutral research package. It returns `report: null` for `none`, otherwise a reader-facing Markdown or self-contained HTML artifact and workspace path. Other consumers can turn the package into formats such as slides.

## Run

Resolve the active Acpus skill directory and use the workflow's absolute path:

```sh
acpus workflow run /absolute/path/to/acpus-skill/workflows/library/deep-research/workflow.ts --input '{"question":"What should I research?","reportFormat":"html","reportLanguage":"auto"}'
```
