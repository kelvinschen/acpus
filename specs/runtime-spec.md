# Runtime Spec

## Purpose

`@acpus/runtime` persists and advances prepared workflow runs in a workspace-local durable store. It accepts a prepared workflow and normalized input, writes SQLite state and run-local files, executes supported frozen IR, exposes read APIs and durable controls, handles signal continuation, supports replay checks, and runs a detached supervisor. Workflow typecheck, module compile, and preflight preparation belong to `@acpus/workflow-compiler`.

## Requirements

### Admission And Store

- The runtime MUST create `.acpus/state/runtime.db` as the durable runtime store for a workspace.
- The runtime store MUST use SQLite for run admission data, events, run projections, node projections, command rows, supervisor lease rows, and artifact registry rows.
- Run admission MUST accept a prepared workflow containing frozen IR JSON, lock metadata, source graph digest, and task bundle metadata.
- Run admission MUST accept input that has already been normalized against the workflow input schema.
- Run admission MUST persist the `WorkflowIR`, workflow input, lock metadata, workflow entry, IR digest, source graph digest, task bundle count, and run directory path.
- Run admission MUST write a `run.admitted` event and the run projection in the same SQLite transaction.
- Run admission MUST create initial `pending` node projection rows for every static node in the frozen IR graph.
- Run admission MUST copy bundled task source into `.acpus/runs/<run-id>/task-bundles/`.
- Completed runs MUST persist root output, completed node outputs, skipped untaken nodes, and a `run.completed` event.
- Runtime failures after admission MUST persist failed run state and a `run.failed` event.

### Input And Payload Normalization

- `normalizeWorkflowInput(ir, input)` MUST validate workflow input against `WorkflowIR.inputSchema` and return normalized input.
- `normalizeSignalPayload(ir, nodeId, payload)` MUST validate signal payloads against the target signal node output schema.
- Invalid workflow input or signal payload MUST fail before mutating runtime state for the corresponding operation.

### Expression And Template Evaluation

- The runtime MUST evaluate `ExprIR` literal, ref, array, object, template, and call nodes.
- Runtime refs MUST resolve `input`, `workflow.input`, `nodes`, `runtime`, `fanout`, and `loop` paths from durable execution scope.
- Runtime expression calls MUST support the current lowered operator set: `not`, `and`, `or`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `len`, `includes`, `startsWith`, `endsWith`, `matches`, `coalesce`, `all`, `any`, `max`, and `min`.
- Runtime template rendering MUST render strings directly, scalar non-strings with `String(value)`, `undefined` as an empty string, and objects or arrays as stable pretty JSON.
- Runtime expression evaluation MUST fail loudly for unsupported calls or invalid operand types.
- Runtime boolean expression operators MUST require boolean operands and MUST NOT coerce values through JavaScript truthiness.

### Scheduler And Execution

- The runtime MUST provide a non-agent scheduler path that executes supported frozen `WorkflowIR`.
- The scheduler MUST execute `assert`, `if`, `switch`, `parallel`, `fanout`, and `loop` nodes.
- Assert nodes MUST continue when their condition evaluates true and fail when it evaluates false.
- The scheduler MUST execute child scopes in isolated scope state and expose only declared composite outputs to the parent scope.
- Parallel `all` strategy MUST aggregate branch outputs by branch key.
- Parallel `race` strategy MUST return the first successful branch in declaration order with `{ winner, result }`.
- Executable `parallel` race branches MUST stop after a winner, failure, await, or block according to current scheduler behavior.
- Fanout `all` strategy MUST aggregate outputs as an array.
- Fanout `quorum` strategy MUST aggregate outputs as `{ accepted, completed }` and fail when completed item count is below the required quorum.
- Loop execution MUST support `iter`, `previous`, `result`, stop conditions, and `returnLast` exhaustion.
- The runtime MUST execute task nodes through frozen run-local task bundles.
- Task execution MUST evaluate task `run.input`, `run.cwd`, and non-secret `run.env` expressions before invoking the task.
- The runtime MUST pass task execution options to the task `$` command wrapper, including default command timeout.
- Supported task execution values MUST be `commandRunner: "acpus-zx-core"` and `shell: "bash"`.
- Task retry and timeout options MUST be honored.
- Task artifact APIs MUST write run-local artifact files and register metadata in SQLite.
- Task artifact writes after task timeout MUST be rejected and MUST NOT create artifact registry rows.
- Agent and signal execution that cannot complete immediately MUST leave the durable run in a resumable state.
- Provider-backed agent nodes without a provider command mapping MUST produce a blocked advance result while the durable run remains pending and is not repeatedly advanced by the supervisor.

### Agents

- The runtime MUST render agent prompts and validate agent outputs against node output schemas.
- The runtime MUST execute command-backed agent definitions through `@acpus/agent-executor`.
- Command-backed agents MUST receive rendered prompt and attempt metadata through the execution request.
- The runtime MUST execute built-in mock provider requests deterministically from the rendered prompt.
- The runtime MUST resolve provider-backed agent command mappings from `ACPUS_AGENT_PROVIDER_COMMANDS`.
- Provider command mappings MUST receive prompt, provider id, optional model, and attempt metadata through the execution request environment.

### Controls, Fork, Signal, And Replay

- Pause MUST transition pending or running runs to `paused` and append a durable control event.
- Resume MUST transition paused runs to `pending` and append a durable control event.
- Retry MUST transition failed runs to `pending`, clear run output and node error/output projections, and append a durable control event.
- Node retry MUST clear only the selected failed node projection while preserving unrelated completed node outputs.
- Fork MUST create a new run from frozen source run data without reading live workflow source.
- Fork MAY freeze a replacement prepared workflow and/or input override for the new run.
- Fork MUST copy completed source node projections and artifacts only when the forked frozen IR contains a matching node id with the same frozen node definition.
- Fork MUST verify copied artifacts and frozen run files before writing fork rows.
- Signal commands MUST store normalized signal node output and continue execution from frozen SQLite state.
- Replay MUST re-evaluate frozen root outputs from recorded completed node outputs without side effects.
- Replay MUST verify artifact registry rows against run-local artifact file digest and size.
- Replay MUST report missing/mismatched artifacts or projection mismatches without mutating runtime state.

### Read APIs And Supervisor

- `listRuns`, `getRun`, and replay APIs MUST read SQLite projections rather than live workflow source.
- Read-only inspection MUST NOT create runtime state when no runtime store exists.
- The runtime store MUST support SQLite-backed supervisor leases with generation fencing, heartbeat updates, stale takeover, and release by current generation only.
- The detached supervisor MUST heartbeat under its current lease generation.
- The detached supervisor MUST consume pending durable command rows for pause, resume, retry, fork, signal, and shutdown.
- The detached supervisor MUST release its lease and exit after applying a durable shutdown command.
- The detached supervisor MUST NOT process later commands or advance runnable runs in the same tick after applying shutdown.
- The detached supervisor MUST recover stale running command rows for its current lease generation before consuming commands.
- The detached supervisor MUST NOT recover foreground CLI-owned commands or commands owned by a different supervisor generation.
- The detached supervisor MUST advance runnable pending runs from frozen SQLite state without reading live workflow source.

## Verification

- Tests MUST cover prepared workflow admission, persisted frozen input, IR digest, source graph digest, event count, node count, and task bundle count.
- Tests MUST cover workflow input and signal payload normalization.
- Tests MUST cover read-only list/show/status APIs without live source reads or state creation for missing stores.
- Tests MUST cover scheduler execution of assert, if, switch, parallel, fanout, and loop nodes.
- Tests MUST cover expression evaluation, template rendering, operator errors, and boolean operand failures.
- Tests MUST cover task execution, task bundle loading, task invocation options, retry, timeout, artifact writes, and timeout artifact rejection.
- Tests MUST cover command-backed agent integration, built-in mock provider integration, missing provider mapping, and durable agent output validation.
- Tests MUST cover pause, resume, retry, node retry, fork, signal, replay, durable command rows, and fork artifact verification.
- Tests MUST cover supervisor lease acquisition, active lease rejection, stale takeover, heartbeat fencing, release fencing, durable command consumption, and shutdown.
