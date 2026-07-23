# Deep Research Workflow

Researches a question across public sources, verifies claims, preserves conflicting or uncertain evidence, and always produces a durable research package with optional Markdown or HTML presentation.

## Inputs

- `question` is required.
- `context` adds optional constraints, background, time ranges, or source preferences.
- `depth` is `quick`, `standard`, or `deep`; the default is `standard`. **use deep only if user explicitly request**
- `reportLanguage` is `auto`, `zh-CN`, or `en`; the default is `auto`.
- `maxAgentConcurrency` controls local fanout burst size; the default is `12`.
- `reportFormat` is `none`, `md`, or `html`; the default is `html`.
- `reportPath` optionally selects a workspace-contained destination for `md` or `html`; `none` ignores it.

## Requirements

Agent backends must provide Web Search, Web Fetch, and local artifact reads. Markdown or HTML presentation also requires one workspace-scoped report write. Acpus does not provide or detect these tools; the bundled configuration expects the locally named `traex` Agent.

## Outputs

The result always references the format-neutral research package. It returns `report: null` for `none`, otherwise a Markdown or HTML artifact and workspace path. Other consumers can turn the package into formats such as slides.

## Run

Resolve the active Acpus skill directory and use the workflow's absolute path:

```sh
acpus workflow run /absolute/path/to/acpus-skill/workflows/library/deep-research/workflow.ts --input '{"question":"What should I research?","depth":"standard","reportFormat":"html","reportLanguage":"auto"}'
```
