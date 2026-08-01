# Deep Research Workflow

Only an explicit `/wf:<hint>` or `/workflow:<hint>` request runs this public-web research workflow. Never use it for local files, repositories, code analysis, debugging, review, or implementation.

## Inputs

- `question` is required.
- `context` adds optional constraints, background, time ranges, audience context, or source preferences.
- `depth` is `quick`, `deep` (default), or `xdeep`. Omit it unless named; `xdeep` requires explicit `xdeep` or `extra deep`.
- `maxAgentConcurrency` controls local fanout burst size; the default is `12`.
- `reportFormat` is `none`, `md`, or `html`; the default is `html`.
- `reportPath` optionally selects a workspace-contained destination for `md` or `html`; `none` ignores it.

## Requirements

Searcher and verifier Agents need Web Search, fetchers need public HTTP retrieval, and synthesizer/publisher Agents need local artifact reads. Markdown or HTML presentation also requires one workspace-scoped report write. Optional source-image use needs public media retrieval; when that is unavailable or reuse rights are unclear, publication falls back to package-grounded tables, diagrams, charts, and prose without failing the run. Acpus does not provide or detect these tools.

## Publication behavior

Each reader-facing Agent uses the research question in its context to choose the response language; the workflow has no language option or language value passed between nodes. Search evidence, planning state, editorial drafts, and validation feedback flow directly into the consuming Agent context without Task-written handoff files. Tasks remain only at deterministic seams: validation, safety-bounded selection and tallying, durable artifacts, paths, and idempotent delivery. The publisher Agent plans a reader journey, writes from foundations toward deeper analysis, selects visuals only when they improve understanding, and re-reads the completed draft before publishing.

## Outputs

The result always references the format-neutral research package. It returns `report: null` for `none`, otherwise a reader-facing Markdown or self-contained HTML artifact and workspace path. Other consumers can turn the package into formats such as slides.

## Run

Resolve the active Acpus skill directory and use the workflow's absolute path:

```sh
acpus workflow run /absolute/path/to/acpus-skill/workflows/library/deep-research/workflow.ts --input '{"question":"What should I research?","reportFormat":"html"}'
```
