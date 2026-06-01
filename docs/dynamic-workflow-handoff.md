# Dynamic Workflow Handoff

This document has been superseded by the runtime orchestrator refactor.

Maintained references:

- `docs/runtime-orchestrator-refactor-decisions.md` for architecture decisions.
- `docs/runtime-orchestrator-refactor-implementation.md` for the migration plan.
- `docs/workflow-spec.md` for the supported authoring contract.
- `docs/cli.md` for current command behavior.

The current orchestrator compiles `workflow.spec.json` into
`execution-plan.json` and executes stages through the ACPX runtime APIs. Run
state is represented by stages, attempts, session bindings, prompts, and output
artifacts. Historical flow-source artifacts are intentionally not part of the
supported path.
