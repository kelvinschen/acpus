# Dynamic Workflow Design

This design snapshot has been superseded by the runtime orchestrator refactor.

Current behavior is documented in:

- `docs/runtime-orchestrator-refactor-decisions.md`
- `docs/runtime-orchestrator-refactor-implementation.md`
- `docs/workflow-spec.md`
- `docs/cli.md`

The supported model is:

- author a validated `workflow.spec.json`;
- compile it to `execution-plan.json`;
- schedule ready stages in the orchestrator runtime;
- call ACPX agents through `AcpxRuntime`;
- persist prompts, attempts, parsed outputs, session bindings, and run status;
- resume by reading the run index and continuing unfinished stage work.
