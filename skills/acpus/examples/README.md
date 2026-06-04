# Workflow Examples

These YAML files are the canonical examples for current Acpus workflow patterns.

The repository-visible `workflows/examples` entry is a relative symlink to this directory so skill installs copy the real files while repository users keep the familiar examples path.

Examples:

- `simple-feature.workflow.spec.yaml` - linear plan, implement, review, summarize flow.
- `route.workflow.spec.yaml` - agent route selection with explicit route outputs.
- `fanout/program-fanin.workflow.spec.yaml` - fanout lanes with program fanin.
- `fanout-plan-loop-review-summary.workflow.spec.yaml` - fanout planning, implementation/review loop, and final summary.
