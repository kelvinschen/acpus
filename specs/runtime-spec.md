# Runtime Spec

## Purpose

`@acpus/runtime` persists and advances prepared workflow runs in a workspace-local durable store. It accepts a prepared workflow and normalized input, writes SQLite state and run-local files, executes supported frozen IR, exposes read APIs and durable controls, handles signal continuation, supports replay checks, and runs a detached supervisor. Workflow static checks, module compile, and preflight preparation belong to `@acpus/workflow-compiler`.

## Requirements

### Admission And Store

- The runtime MUST create `.acpus/state/runtime.db` as the durable runtime store for a workspace.
- The runtime store MUST use SQLite for run admission data, public run events, scheduler events, scheduler projection tables, public run and node projections, command rows, supervisor lease rows, and artifact registry rows.
- Run admission MUST accept a prepared workflow containing frozen IR JSON, lock metadata, source graph digest, and task bundle metadata.
- Run admission MUST accept input that has already been normalized against the workflow input schema.
- Run admission MUST persist the `WorkflowIR`, workflow input, lock metadata, workflow entry, IR digest, source graph digest, task bundle count, and run directory path.
- Run admission MUST write a `run.admitted` event and the run projection in the same SQLite transaction.
- Run admission MUST create public `pending` node projection rows for static node summaries and MUST advance executable work from the frozen admitted IR, not from live workflow source.
- Run admission MUST copy bundled task source into `.acpus/runs/<run-id>/task-bundles/`.
- Completed scheduler-backed runs MUST persist root output, bridge completed dynamic node instances into public node projections where unambiguous, and write a `run.completed` event.
- Runtime failures after admission MUST persist failed run state and a `run.failed` event.

### Input And Payload Normalization

- `normalizeWorkflowInput(ir, input)` MUST validate workflow input against `WorkflowIR.inputSchema` and return normalized input.
- `normalizeSignalPayload(ir, nodeId, payload)` MUST validate signal payloads against the target signal node output schema.
- Invalid workflow input or signal payload MUST fail before mutating runtime state for the corresponding operation.

### Expression And Template Evaluation

- The runtime MUST evaluate `ExprIR` by adapting `@acpus/expression/evaluator` to durable execution scope.
- Runtime refs MUST resolve `input`, `workflow.input`, `nodes`, `meta`, `fanout`, and `loop` paths from durable execution scope.
- Runtime ref resolution MUST read only own object properties and canonical non-negative array indexes. Array prototype properties and non-canonical indexes such as `length`, `map`, or `01` MUST resolve as missing.
- Runtime `meta` refs MUST expose run id, relative workflow path, workflow name, and absolute workspace directory.
- Runtime expression calls MUST support the current `@acpus/expression` evaluator operator set.
- Runtime template rendering MUST use `@acpus/expression` template semantics: strings render directly, scalar non-strings render with `String(value)`, arrays and objects render with `JSON.stringify`, and missing or non-JSON-compatible values fail.
- Runtime expression evaluation MUST fail loudly for unsupported calls or invalid operand types.
- Runtime boolean expression operators MUST require boolean operands and MUST NOT coerce values through JavaScript truthiness.

### Durable Scheduler And Execution

- The runtime MUST advance admitted frozen `WorkflowIR` through an internal durable scheduler.
- The scheduler MUST persist scheduler events in the public event stream using a scheduler envelope and MUST rebuild scheduler projection state from those events.
- The scheduler MUST maintain projection tables for frames, dynamic node instances, attempts, group members, and signal waits.
- Static `nodeId` MUST remain the frozen IR node id. Dynamic execution identity MUST use a derived `nodeKey` from the instance path.
- Scheduler events and projection rows for dynamic work MUST preserve structured instance path data when the dynamic instance is known.
- Dynamic node outputs MUST resolve through lexical execution scope; child scope outputs MUST expose only declared composite outputs to the parent scope.
- The scheduler MUST materialize supported root `assert`, `if`, `switch`, `parallel`, `fanout`, and `loop` nodes from frozen IR.
- The scheduler MUST materialize selected conditional branches, parallel branches, fanout bodies, and loop iteration bodies only for the current supported child-scope shape: scheduler-visible leaf nodes sequenced by durable scope state.
- Unsupported nested composite or pure-before-leaf child-scope shapes MUST remain unmaterialized rather than creating partial scheduler state.
- Assert nodes MUST continue when their condition evaluates true and fail when it evaluates false.
- Conditional nodes MUST persist branch decisions and MUST resume from durable branch decisions instead of re-evaluating already-decided conditions.
- For supported branch bodies, parallel `all` strategy MUST aggregate branch outputs by branch key and MUST fail fast by cancelling remaining running members when one member fails.
- For supported branch bodies, parallel `race` strategy MUST return the first successful branch with `{ winner, result }` and MUST cancel remaining running members after the winner is accepted.
- For supported item bodies, fanout `all` strategy MUST materialize item identity rows and aggregate item outputs as an array.
- For supported item bodies, fanout `quorum` strategy MUST accept outputs in completion order, return `{ accepted, completed }` after quorum success, and cancel remaining running members after quorum is reached.
- For supported iteration bodies, loop execution MUST support iteration index, previous iteration output, result refs, stop conditions, `maxIterations`, and the current exhaustion policy.
- The runtime MUST execute task nodes through frozen run-local task bundles.
- Task execution MUST evaluate task `run.input`, `run.cwd`, and non-secret `run.env` expressions before invoking the task.
- The runtime MUST pass task execution options to the task `$` command wrapper, including default command timeout.
- The runtime MUST pass a per-attempt `abortSignal` into task code for cooperative cancellation.
- Supported task execution values MUST be `commandRunner: "acpus-zx-core"` and `shell: "bash"`.
- Task and agent node retry options MUST be represented as scheduler-visible retryable attempts for scheduler-backed runs.
- Task and agent timeout options MUST be persisted as scheduler attempt deadlines for scheduler-backed runs.
- In-flight task and agent timeout enforcement MAY occur inside the executor attempt, while stale or recovered attempts MUST be derivable from scheduler deadlines.
- Task artifact APIs MUST write run-local artifact files and register metadata in SQLite.
- Attempt-local output directories, work directories, and task artifacts MUST use dynamic `nodeKey` and attempt-specific subpaths for scheduler-backed task execution.
- Task artifact writes after task timeout MUST be rejected and MUST NOT create artifact registry rows.
- Signal execution that cannot complete immediately MUST leave the durable run in a resumable awaiting state.
- Missing executors, providers, or runner prerequisites MUST fail the scheduler-backed run rather than creating a durable blocked state.

### Agents

- The runtime MUST render agent prompts and validate agent outputs against node output schemas.
- The runtime MUST execute command-backed agent definitions through `@acpus/agent-executor`.
- Command-backed agents MUST receive rendered prompt and agent executor attempt metadata through the execution request.
- The runtime MUST execute built-in mock provider requests deterministically from the rendered prompt.
- The runtime MUST resolve provider-backed agent command mappings from `ACPUS_AGENT_PROVIDER_COMMANDS`.
- Provider command mappings MUST receive prompt, provider id, optional model, and attempt metadata through the execution request environment.
- Command-backed scheduler agent attempts MUST receive runtime-owned `ACPUS_RUNTIME_RUN_ID`, `ACPUS_RUNTIME_NODE_ID`, `ACPUS_RUNTIME_NODE_KEY`, and `ACPUS_RUNTIME_ATTEMPT` environment variables when the corresponding scheduler context exists.
- Runtime-owned `ACPUS_RUNTIME_*` environment variables MUST be overwritten or deleted by the runtime wrapper before invoking a command-backed agent so stale host or node environment values cannot create mixed scheduler identity.
- Scheduler-backed command agent attempts MUST run one agent-executor sub-attempt per scheduler-visible attempt.
- Scheduler-backed command agent attempts MUST NOT spend node-level retry inside the agent executor; node-level retry MUST remain scheduler-visible.

### Controls, Fork, Signal, And Replay

- Pause MUST record a durable pause gate and MUST prevent new scheduler-visible attempts from starting while paused.
- Pause MUST best-effort cancel started scheduler-visible attempts and requeue eligible dynamic work for a later resume.
- Resume MUST clear the durable pause gate and re-drive eligible scheduler work.
- Retry MUST target either a failed scheduler run or a failed dynamic node instance.
- Run-level retry MUST reset scheduler projection to a clean pending materialization point while preserving historical event facts.
- Node retry MUST target a dynamic `nodeKey` directly or a static node alias only when that alias resolves to exactly one failed dynamic instance.
- Fork MUST create a new run from frozen source run data without reading live workflow source.
- Fork MAY freeze a replacement prepared workflow and/or input override for the new run.
- Fork MUST inherit compatible completed accepted outputs and artifacts reachable from inherited outputs.
- Fork MUST NOT inherit active scheduler frames, attempts, signal waits, or artifacts from failed, cancelled, or superseded attempts.
- Fork MUST verify copied artifacts and frozen run files before writing fork rows.
- Signal commands MUST store normalized signal payloads, consume open signal waits idempotently, and continue execution from frozen SQLite state.
- Signal targeting MUST accept a dynamic `nodeKey` directly or a static signal alias only when that alias resolves to exactly one open signal wait.
- Replay MUST re-evaluate frozen root outputs from recorded completed node outputs without side effects.
- Replay MUST rebuild scheduler projections from scheduler events and compare them with scheduler projection tables.
- Replay MUST verify artifact registry rows against run-local artifact file digest and size.
- Replay MUST report malformed scheduler event envelopes, unreplayable scheduler event streams, missing or mismatched artifacts, and projection mismatches without mutating runtime state.

### Read APIs And Supervisor

- `listRuns`, `getRun`, replay APIs, and visualization overlay APIs MUST read SQLite projections rather than live workflow source.
- `getRun` MUST expose dynamic scheduler details when scheduler projection rows exist, including version, frames, dynamic node instances, attempts, group members, and signal waits.
- The runtime MUST provide a visualization overlay helper that combines static `WorkflowIR` structure with dynamic scheduler projection state without adding layout-specific state.
- Read-only inspection MUST NOT create runtime state when no runtime store exists.
- The runtime store MUST support SQLite-backed supervisor leases with generation fencing, heartbeat updates, stale takeover, and release by current generation only.
- The detached supervisor MUST heartbeat under its current lease generation.
- The detached supervisor MUST consume pending durable command rows for pause, resume, retry, fork, signal, and shutdown.
- The detached supervisor MUST release its lease and exit after applying a durable shutdown command.
- The detached supervisor MUST NOT process later commands or advance runnable runs in the same tick after applying shutdown.
- The detached supervisor MUST recover stale running command rows for its current lease generation before consuming commands.
- The detached supervisor MUST NOT recover foreground CLI-owned commands or commands owned by a different supervisor generation.
- The detached supervisor MUST advance runnable pending scheduler-backed runs from frozen SQLite state without reading live workflow source.

## Verification

- Tests MUST cover prepared workflow admission, persisted frozen input, IR digest, source graph digest, event count, node count, task bundle count, and scheduler-backed public projection bridging.
- Tests MUST cover workflow input and signal payload normalization.
- Tests MUST cover read-only list/show/status APIs without live source reads or state creation for missing stores.
- Tests MUST cover scheduler execution of supported assert, if, switch, parallel, fanout, loop, dynamic identity, durable branch decisions, group completion, cancellation, retry, and timeout transitions.
- Tests MUST cover expression evaluation, template rendering, operator errors, and boolean operand failures.
- Tests MUST cover task execution, task bundle loading, task invocation options, scheduler-visible retry, timeout deadlines, task abort signal propagation, artifact writes, attempt-local artifact paths, and timeout artifact rejection.
- Tests MUST cover command-backed agent integration, built-in mock provider integration, missing provider mapping, durable agent output validation, scheduler runtime identity environment, one agent-executor sub-attempt per scheduler-visible attempt, and separation between scheduler-visible attempts and agent executor sub-attempt metadata.
- Tests MUST cover pause, resume, run retry, dynamic node retry, signal targeting and idempotency, fork, replay, durable command rows, and fork artifact reachability.
- Tests MUST cover supervisor lease acquisition, active lease rejection, stale takeover, heartbeat fencing, release fencing, durable command consumption, and shutdown.
