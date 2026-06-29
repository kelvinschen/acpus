# Runtime Spec

## Purpose

The runtime persists admitted TypeScript workflow runs into a workspace-local
durable store. In the current implementation, admission freezes the workflow IR,
input, lock metadata, task bundle metadata, and initial run projections. It
advances pure non-agent, task-backed, command-backed agent, and built-in mock
agent-provider runs to completion, pauses at signal nodes until payload
delivery, and leaves other built-in agent-provider runs pending until provider
adapters are available. The detached supervisor owns a SQLite lease, consumes
pending command rows, and advances runnable pending runs.

## Requirements

### Store And Admission

- The implementation MUST create `.acpus/state/runtime.db` as the durable
  runtime store for the workspace.
- The runtime store MUST use SQLite for run admission data, event records, run
  projections, node projections, command rows, supervisor lease rows, and
  artifact registry rows.
- Run admission MUST typecheck, compile, and validate the workflow module before
  writing runtime state.
- Run admission MUST validate submitted input against the workflow `inputSchema`
  before writing runtime state.
- Run admission MUST persist the frozen `WorkflowIR`, workflow input, lock
  metadata, workflow entry, IR digest, source graph digest, task bundle count,
  and run directory path.
- Run admission MUST write a `run.admitted` event and the `runs` projection in
  the same SQLite transaction.
- Run admission MUST create initial `pending` node projection rows for every
  static node in the frozen IR graph.
- Run admission MUST copy bundled task source into `.acpus/runs/<run-id>/`.
- The runtime MUST complete admitted runs whose frozen IR can be fully executed
  by the non-agent scheduler.
- The runtime MUST execute task nodes through the frozen run-local task bundle.
- The runtime MUST evaluate task `run.input` expressions and pass the resulting
  runtime values to the task function as `TaskContext.input`.
- The runtime MUST evaluate task `run.cwd` and non-secret `run.env` expressions
  and pass them into `TaskContext` and the task `$` command wrapper.
- The runtime MUST pass task `run.execution.defaultCommandTimeout` into the task
  `$` command wrapper as the default command timeout.
- The runtime MUST preserve task `run.execution.defaultCommandTimeout` across task
  `$` configurator calls such as `$({ cwd })`.
- The runtime MUST support task `run.execution.commandRunner` value
  `"acpus-zx-core"` and `run.execution.shell` value `"bash"` as the current task
  command runner.
- The runtime MUST reject task `run.execution.shell` values other than `bash`
  and `run.execution.commandRunner` values other than `acpus-zx-core` until
  additional runners are implemented.
- The runtime MUST honor task `retry.max` by retrying failed task functions up to
  the configured retry budget.
- The runtime MUST honor task `timeout` by aborting the task signal and failing
  the task when the timeout expires.
- Task artifact writes after a task timeout MUST be rejected and MUST NOT create
  artifact registry rows.
- The runtime MUST provide task artifact APIs that write run-local artifact files
  and register artifact metadata in SQLite.
- The runtime MUST execute command-backed agent definitions as local commands and
  pass the rendered prompt through `ACPUS_AGENT_PROMPT`.
- The runtime MUST pass the current command-backed agent attempt through
  `ACPUS_AGENT_ATTEMPT`.
- The runtime MUST honor command-backed agent `retry.max` by retrying failed
  command attempts and invalid output attempts up to the configured retry budget.
- The runtime MUST honor command-backed agent `timeout` by terminating the
  command process and failing the node when the timeout expires.
- The runtime MUST fail command-backed agent execution when combined stdout and
  stderr exceed the runtime output cap.
- The runtime MUST execute the built-in `mock` agent provider deterministically
  from the rendered prompt.
- The runtime MUST execute provider-backed agent definitions through local
  provider command mappings from `ACPUS_AGENT_PROVIDER_COMMANDS` when a mapping
  for `agents.<key>.use` exists.
- Provider command mappings MUST receive `ACPUS_AGENT_PROMPT`,
  `ACPUS_AGENT_PROVIDER`, optional `ACPUS_AGENT_MODEL`, and
  `ACPUS_AGENT_ATTEMPT`.
- The runtime MUST keep admitted runs in `pending` status when execution reaches
  provider-backed agent nodes without a command mapping.
- The runtime MUST persist `awaiting` status when execution reaches a signal
  node without a payload.
- The runtime MUST accept JSON signal payloads, store them as signal node output,
  and continue execution from frozen SQLite state without reading live workflow
  source.
- Completed runs MUST persist root output, completed node outputs, and a
  `run.completed` event in SQLite.
- Completed runs MUST mark unexecuted static node rows as `skipped`.
- Runtime failures after admission MUST persist `failed` run status and a
  `run.failed` event before returning a failing CLI result.
- Runtime node outputs MUST be validated against their `outputSchema`,
  branch `outputSchema`, or `itemOutputSchema` before durable completion.
- Pause MUST transition pending or running runs to `paused` and append a durable
  control event.
- Resume MUST transition paused runs to `pending` and append a durable control
  event.
- Retry MUST transition failed runs to `pending`, clear run output and node
  output/error projections, and append a durable control event.
- Node retry MUST transition a failed run to `pending`, clear only the selected
  failed node output/error projection, preserve unrelated completed node outputs,
  and append a durable node retry event.
- Fork MUST create a new run from frozen source run data without reading live
  workflow source.
- Fork MAY freeze a replacement workflow module and/or input override for the new
  run.
- Fork MUST copy completed source node projections and artifacts produced by
  completed source nodes only when the forked frozen IR contains a matching node
  id with the same frozen node definition.
- Fork MUST copy root output only when the source run is completed.
- Fork MUST reset non-completed source node projections to `pending`, clear their
  output/error projections, and set the fork run status to `pending` unless the
  source run is completed.
- Fork MUST NOT inherit completed child nodes from an incomplete composite
  ancestor when the source run is not completed.
- Fork MUST verify copied artifact bytes against the artifact registry digest and
  size before writing fork rows.
- Fork MUST verify copied frozen run files, including `workflow.ir.json`,
  `lock.json`, and task bundle files, before writing fork rows.
- Fork MUST fail if copied output projections contain source-run artifact refs
  that do not have corresponding artifact registry rows.
- Fork MUST stage and verify run-directory copies, publish the fork run
  directory before opening the SQLite fork-row transaction, and remove the
  published directory if fork row persistence fails before process exit.
- SQLite MUST remain the source of truth for run inspection; orphan fork
  directories left by a hard crash before fork-row persistence MUST NOT be
  reported as runs.
- Writable runtime maintenance MUST remove stale `.staging-*` run directories.
- Explicit writable maintenance MAY remove stale `run_*` directories that are not
  referenced by SQLite `run_inputs`; the supervisor MUST NOT remove orphaned
  `run_*` directories during ordinary ticks because admission and fork publish
  run directories before SQLite persistence.
- Mutating run controls MUST persist a command row with applied or failed status.
- Replay MUST re-evaluate frozen root outputs from recorded completed node
  outputs without side effects and report whether they match the persisted run
  output.
- Replay MUST verify artifact registry rows against run-local artifact file
  digest and size, and report missing or mismatched artifact files.
- Replay MUST verify terminal run events against persisted run projections and
  report projection issues without mutating runtime state.
- Read-only run inspection MUST read SQLite projections rather than live
  workflow source.
- The runtime MUST NOT read edited workflow source when listing, showing, or
  reporting status for an admitted run.
- Read-only run inspection MUST NOT create runtime state when no runtime store
  exists.
- The runtime store MUST support a SQLite-backed supervisor lease with
  generation fencing, heartbeat updates, stale takeover, and release by current
  generation only.
- The detached supervisor MUST heartbeat under its current lease generation.
- The detached supervisor MUST consume pending durable command rows for pause,
  resume, retry, fork, signal, and shutdown.
- The detached supervisor MUST release its lease and exit after applying a
  durable shutdown command.
- The detached supervisor MUST NOT process later commands or advance runnable
  runs in the same tick after applying a shutdown command.
- The detached supervisor MUST recover stale `running` command rows owned by its
  current supervisor lease generation back to `pending` before consuming
  commands.
- The detached supervisor MUST NOT recover foreground CLI-owned commands or
  commands owned by a different supervisor generation.
- The detached supervisor MUST advance runnable pending runs from frozen SQLite
  state without reading live workflow source.
- The detached supervisor MUST leave blocked provider-required runs pending
  without repeatedly re-executing completed prefixes.

### Expression And Template Evaluation

- The runtime MUST evaluate `ExprIR` literal, ref, array, object, template, and
  call nodes.
- Runtime refs MUST resolve `input`, `workflow.input`, `nodes`, `runtime`,
  `fanout`, and `loop` paths from the supplied durable scope.
- Runtime expression calls MUST support the current core operator set used by
  lowered expressions: `not`, `and`, `or`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`,
  `len`, `includes`, `startsWith`, `endsWith`, `matches`, `coalesce`, `all`,
  `any`, `max`, and `min`.
- Runtime template rendering MUST render strings directly, scalar non-strings
  with `String(value)`, `undefined` as an empty string, and objects or arrays as
  stable pretty JSON.
- Runtime expression evaluation MUST fail loudly for unsupported calls or invalid
  operand types.
- Runtime boolean expression operators MUST require boolean operands and MUST NOT
  coerce values through JavaScript truthiness.

### Non-Agent Scheduler Skeleton

- The runtime MUST provide a pure non-agent scheduler path that executes frozen
  `WorkflowIR` without side effects.
- The non-agent scheduler MUST execute `assert`, `if`, `switch`, `parallel`,
  `fanout`, and `loop` nodes using the runtime expression evaluator.
- The non-agent scheduler MUST execute child scopes in isolated scope state and
  expose only declared composite outputs to the parent scope.
- The non-agent scheduler MUST aggregate `parallel` all-branch outputs by branch
  key.
- The non-agent scheduler MUST support `parallel` race strategy by returning the
  first successful branch in declaration order with `{ winner, result }`.
- Executable `parallel` race branches MUST be evaluated sequentially in branch
  declaration order and MUST NOT start later branches after a winner completes.
  If an executable branch fails, awaits, or blocks before producing a winner, the
  race MUST stop and MUST NOT start later branches. Completed node outputs from a
  failed executable race branch MUST NOT be merged into the durable completed-node
  set.
- Pure `parallel` race branches MAY skip failed branches in favor of the first
  later successful branch.
- The non-agent scheduler MUST aggregate `fanout` all-strategy outputs as an
  array and quorum-strategy outputs as `{ accepted, completed }`.
- The non-agent scheduler MUST fail quorum fanout when completed item count is
  below the required quorum count.
- The non-agent scheduler MUST support loop iteration refs, previous output refs,
  result refs, stop conditions, and `returnLast` exhaustion.
- The non-agent scheduler MUST render authored assert messages when assert
  conditions fail.
- The non-agent scheduler MUST fail when it reaches `task`, `agent`, or `signal`
  nodes without an explicit executor.

## Verification

- Tests MUST cover `acpus run <workflow-module>` admitting a pending run.
- Tests MUST cover `acpus run <workflow-module>` completing a pure non-agent run
  and persisting root output.
- Tests MUST cover persisted frozen input, IR digest, source graph digest, event
  count, node count, and task bundle count for an admitted run.
- Tests MUST cover invalid workflow input failing before runtime state is
  written.
- Tests MUST cover invalid JSON input failing before workflow typecheck,
  compile, or runtime state creation.
- Tests MUST cover read-only `acpus runs list`, `acpus runs show`, and
  `acpus runs status`.
- Tests MUST cover read-only inspection after the workflow source has changed.
- Tests MUST cover missing run inspection without runtime state creation.
- Tests MUST cover admission of a workflow with a bundled task and verify the
  run-local task bundle copy exactly matches frozen bundle source.
- Tests MUST cover runtime expression ref resolution, operator calls, structured
  array/object expression values, template rendering for objects and arrays, and
  evaluator error paths.
- Tests MUST cover non-agent scheduler execution of `assert`, `if`, `switch`,
  `parallel`, `fanout`, and `loop`, including fanout quorum aggregation and
  executor-required failures for `task`, `agent`, and `signal` nodes.
- Tests MUST cover composite child-scope isolation, assert failure messages,
  race strategy, loop exhaustion behavior, non-boolean conditions,
  empty fanout, non-array fanout input, and impossible quorum failure.
- Tests MUST cover completed run node output persistence, skipped untaken nodes,
  completed event payloads, failed post-admission execution, and pending
  executor-required agent and signal runs.
- Tests MUST cover task execution, task bundle loading, task artifact file
  writes, artifact registry rows, and artifact refs in task output.
- Tests MUST cover task `run.cwd`, `run.env`, `retry.max`, and `timeout`
  behavior.
- Tests MUST cover that timed-out tasks cannot write late artifacts after the
  timeout failure has been returned.
- Tests MUST cover command-backed agent execution, built-in mock provider
  execution, and durable agent output.
- Tests MUST cover command-backed agent `retry.max` and `timeout` behavior.
- Tests MUST cover durable failure when runtime output violates `outputSchema`.
- Tests MUST cover pause, resume, retry, and fork durable control operations,
  including completed-run fork inheritance of outputs and artifacts.
- Tests MUST cover node retry preserving completed dependency prefixes while
  rerunning only the selected failed node.
- Tests MUST cover fork rejection when source artifact files no longer match the
  artifact registry.
- Tests MUST cover durable command rows for run control operations.
- Tests MUST cover signal awaiting, signal payload acceptance, signal node output
  persistence, and source-independent continuation after signal delivery.
- Tests MUST cover supervisor lease acquisition, active lease rejection, stale
  takeover, heartbeat generation fencing, and release generation fencing.
- Tests MUST cover the detached supervisor consuming a durable signal command
  and advancing the awaiting run to completion.
- Tests MUST cover replay for a completed run.
