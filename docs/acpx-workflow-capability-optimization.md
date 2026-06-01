# ACPX Workflow Capability Optimization

This exploration document has been superseded by the runtime orchestrator
refactor.

The orchestrator no longer depends on a generated flow execution layer. The
current integration point is `src/runtime/agent-runtime.ts`, which creates ACPX
runtime sessions and maps orchestrator role modes to ACPX permission modes.

Use these maintained references instead:

- `docs/runtime-orchestrator-refactor-decisions.md`
- `docs/runtime-orchestrator-refactor-implementation.md`
- `docs/cli.md`
- `README.md`
