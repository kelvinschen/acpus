# CLI Spec

## Purpose

The `acpus` CLI is the user-facing entry point for TypeScript workflow pre-run
validation and runtime admission. In the current implementation it provides a
dry-run gate, can admit durable runs, and completes pure non-agent, task-backed,
command-backed agent, and built-in mock-agent workflows. Signal nodes await
external payloads and then continue from frozen runtime state. Other built-in
agent-provider adapters are not yet implemented. The `runs supervise` command
starts a workspace-local supervisor that owns the SQLite lease, consumes pending
durable command rows, and advances runnable pending runs.

## Requirements

- The CLI package MUST be named `acpus` and MUST expose a binary named `acpus`.
- The CLI command surface MUST be implemented with Commander so subcommands and
  options have a stable extension point.
- The CLI MUST support `acpus run <workflow-module> --dry-run`.
- The CLI MUST support `acpus run <workflow-module>` without `--dry-run` by
  admitting a durable pending run.
- The CLI MUST support `acpus run <workflow-module> --input <json>` and MUST
  freeze that JSON value as the admitted workflow input.
- The dry-run gate MUST run these phases in order:
  1. Typecheck the workflow module with TypeScript and no emit.
  2. Compile the module through `@acpus/core` to `WorkflowIR`.
  3. Fail if the compiled IR contains any diagnostic with `severity: "error"`.
  4. Write `.acpus/preflight/<id>/` with `workflow.ir.json`, `lock.json`, and
     bundled task assets.
- Runtime admission MUST run the same typecheck, compile, and validation phases
  as dry-run before writing runtime state.
- Runtime admission MUST validate `--input` against the workflow `inputSchema`
  before writing runtime state.
- Runtime admission MUST fail invalid JSON input before typecheck, compile, or
  runtime state creation.
- Runtime admission MUST write `.acpus/state/runtime.db` and
  `.acpus/runs/<run-id>/`.
- Runtime admission MUST return the admitted run id and `pending` status.
- Runtime admission MUST return `completed` status when a pure non-agent
  workflow finishes through the in-memory scheduler.
- Runtime admission MUST complete workflows with task nodes by executing frozen
  run-local task bundles.
- Runtime admission MUST complete command-backed agent workflows by executing the
  configured local command.
- Runtime admission MUST honor command-backed agent retry and timeout options.
- Runtime admission MUST complete built-in `mock` agent workflows
  deterministically from the rendered prompt.
- Runtime admission MUST complete provider-backed agent workflows when
  `ACPUS_AGENT_PROVIDER_COMMANDS` maps the provider `use` id to a local command.
- Runtime admission MUST persist `awaiting` status for signal nodes until a
  signal payload is delivered.
- Runtime admission MUST leave workflows with built-in agent-provider nodes in
  `pending` status when no provider command mapping exists.
- The CLI MUST support `acpus runs list`, `acpus runs show <run-id>`, and
  `acpus runs status <run-id>` for read-only inspection of admitted runs.
- The CLI MUST support `acpus runs pause <run-id>`, `resume <run-id>`,
  `retry <run-id>`, and `fork <run-id>` for durable run controls.
- The CLI MUST support `acpus runs fork <run-id> --workflow <workflow-module>`
  and `--input <json>` for freezing replacement fork workflow/input data.
- The CLI MUST support `acpus runs retry <run-id> --node <node-id>` to retry a
  single failed node while preserving other completed node outputs.
- The CLI MUST support `acpus runs signal <run-id> --node <node-id> --payload
  <json>` for awaiting signal nodes.
- The CLI MUST support `acpus runs replay <run-id>` for read-only replay checks.
- The CLI MUST support `acpus runs supervise --background` for starting the
  detached workspace supervisor.
- The CLI MUST support `acpus runs shutdown` for queuing a durable workspace
  supervisor shutdown command and returning the command record.
- The detached workspace supervisor MUST consume pending durable command rows
  without requiring the foreground CLI to apply them.
- In workspace development, the typecheck and compile phases MUST use the
  `development` export condition so workflow modules resolve live
  `@acpus/core` source. Outside a workspace checkout, the CLI MUST rely on
  normal package resolution and MUST NOT force the `development` condition.
- The compile phase MUST use a TypeScript-aware module loader so `.workflow.ts`
  modules can be imported.
- The CLI MUST support `--json`, producing a stable JSON result with `ok`,
  `phase`, workflow summary, diagnostics, preflight directory, IR digest, task
  bundle count, admitted run details when available, and optional typecheck
  details.
- The CLI MUST exit with code `0` on successful dry-run, `1` on typecheck,
  compile, validation, or run lookup failure, and `2` on usage errors.

## Verification

- Tests MUST cover successful `run --dry-run` for a TypeScript workflow module.
- Tests MUST cover JSON output and default preflight artifact writing.
- Tests MUST cover typecheck failure before compile.
- Tests MUST cover IR diagnostic failure after compile.
- Tests MUST cover `run` without `--dry-run` admitting a pending durable run.
- Tests MUST cover `run` without `--dry-run` completing a pure non-agent durable
  run and exposing its output through run inspection.
- Tests MUST cover invalid JSON input and input-schema validation failures.
- Tests MUST cover read-only run list/show/status commands.
- Tests MUST cover pause, resume, retry, and fork run control commands.
- Tests MUST cover node-scoped retry through the run control command surface.
- Tests MUST cover signal delivery through the run control command surface.
- Tests MUST cover replay through the run control command surface.
- Tests MUST cover `runs supervise --background` creating a supervisor lease
  without sidecar state.
