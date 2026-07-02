# Runtime Spec

## Purpose

`@acpus/runtime` persists and advances prepared workflow runs in a workspace-local durable store. It accepts a prepared workflow and normalized input, writes SQLite state and run-local files, executes supported frozen IR, exposes read APIs and durable controls, handles signal continuation, supports replay checks, and runs a detached supervisor. Workflow static checks, module compile, and preflight preparation belong to `@acpus/workflow-compiler`.

## Requirements

### Admission And Store

- The runtime MUST create `.acpus/state/runtime.db` as the durable runtime store for a workspace.
- The runtime store MUST use SQLite for run admission data, public run events, scheduler events, scheduler projection tables, public run and node projections, command rows, supervisor lease rows, and artifact registry rows.
- Run admission MUST accept a prepared workflow containing frozen IR JSON, lock metadata, and source graph digest.
- Run admission MUST accept input that has already been normalized against the workflow input schema.
- Run admission MAY accept agent overrides keyed by declared top-level agent
  name. Agent overrides MUST be persisted separately from frozen `WorkflowIR`
  and MUST be applied when reading the effective frozen run for execution.
- Run admission MUST persist the `WorkflowIR`, workflow input, lock metadata, workflow entry, IR digest, source graph digest, and run directory path.
- Run admission MUST write a `run.admitted` event and the run projection in the same SQLite transaction.
- Run admission MUST create public `pending` node projection rows for static node summaries and MUST advance executable work from the frozen admitted IR, not from live workflow source.
- Run admission MUST copy only current frozen workflow artifacts such as `workflow.ir.json` and `lock.json` into the run directory. It MUST NOT copy reusable task source or dependency artifacts.
- Completed scheduler-backed runs MUST persist root output, bridge completed dynamic node instances into public node projections where unambiguous, and write a `run.completed` event.
- Runtime failures after admission MUST persist failed run state and a `run.failed` event.

### Input And Payload Normalization

- `normalizeWorkflowInput(ir, input)` MUST validate workflow input against `WorkflowIR.inputSchema` and return normalized input.
- `normalizeSignalPayload(ir, nodeId, payload)` MUST return schema-less signal payloads as raw strings and MUST validate schema-backed signal payloads against the target signal node output schema.
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
- Scheduler store control-flow failures MUST use stable tagged `SchedulerStoreError` values at the store-port boundary.
- Scheduler store-port `try*` operations for snapshots, event appends,
  attempts, signal consumption, pause, resume, retry, and expired-owner
  recovery MUST return neverthrow `Result<..., SchedulerStoreError>` for
  recoverable store control-flow failures.
- `tryAdvanceRun(input)` MUST return a neverthrow
  `ResultAsync<AdvanceRunSummary, AdvanceRunError>` for typed scheduler advance
  composition. `advanceRun(input)` MAY remain as the throwing compatibility
  adapter.
- `tryAdvanceRuntimeRun(...)`, `tryAdmitWorkflowRun(...)`,
  `trySignalRun(...)`, and `tryMutateRun(...)` MUST return neverthrow
  `ResultAsync` values with tagged runtime use-case errors for recoverable
  runtime boundary failures. The existing non-`try` use-case functions MAY
  remain compatibility adapters that preserve current CLI-facing behavior.
- Scheduler advance logic MUST branch on scheduler store error tags and MUST NOT parse exception messages for lease, pause, version, or stale terminal control flow.
- Scheduler store error tags MUST preserve user-facing messages separately from machine-readable fields such as `runId`, `attemptId`, `expectedVersion`, `actualVersion`, and `ownerEpoch`.
- Scheduler store error tags MUST include recoverable idempotency conflicts,
  missing retry targets, and invalid retry targets without requiring callers to
  parse display messages.
- The scheduler MUST maintain projection tables for frames, dynamic node instances, attempts, group members, and signal waits.
- Root execution, composite/control nodes, conditional branches, parallel
  branches, fanout items, and loop iterations MUST use one recursive durable
  frame model.
- Static `nodeId` MUST remain the frozen IR node id. Dynamic execution identity MUST use a derived `nodeKey` from the instance path.
- Scheduler events and projection rows for dynamic work MUST preserve structured instance path data when the dynamic instance is known.
- Dynamic node outputs MUST resolve through lexical execution scope; child scope outputs MUST expose only declared composite outputs to the parent scope.
- The scheduler MUST materialize valid frozen IR compositions recursively,
  including nested `assert`, `if`, `switch`, `parallel`, `fanout`, and `loop`
  nodes at any supported scope depth.
- Leaf `task`, `agent`, and `signal` nodes MUST create dynamic node instances
  directly under the current frame and MUST NOT create wrapper frames.
- Assert nodes MUST continue when their condition evaluates true and fail when it evaluates false.
- Conditional nodes MUST persist branch decisions and MUST resume from durable branch decisions instead of re-evaluating already-decided conditions.
- Switch branch identity MUST use `case:<index>` for case branches and
  `default` for fallback branches.
- Parallel `all` strategy MUST aggregate branch outputs by branch key and MUST fail fast by cancelling remaining running member subtrees when one member fails.
- Parallel `race` strategy MUST return the first successful branch with `{ winner, result }` and MUST cancel remaining running member subtrees after the winner is accepted.
- Fanout `all` strategy MUST materialize item identity rows and aggregate item outputs as an array.
- Fanout `quorum` strategy MUST accept outputs in completion order, return the accepted item outputs as `Array<ItemOutput>` after quorum success, and cancel remaining running member subtrees after quorum is reached.
- Loop execution MUST use seeded pre-check semantics: `initial` is the first result, `stopWhen` checks before each body execution, `previous` is non-optional, and `maxIterations` counts only body executions.
- Group member rows MUST point at the child branch or fanout-item frame that
  owns the cancellable member subtree.
- The runtime MUST execute task nodes through the task run target stored in frozen IR.
- For inline task targets, the runtime MUST construct a callable function from the embedded self-contained source without writing a run-local task source file.
- For reusable module task targets, the runtime MUST resolve the recorded source-level module specifier from the workflow referrer in the current workspace/package environment, import the module with TypeScript support, verify the selected export is an Acpus task token, and invoke the token's `fn`.
- For supported official authoring facade specifiers such as
  `acpus/tasks/git`, reusable task loading MUST resolve from Acpus-owned
  packages and MUST NOT require a workflow-local Acpus installation.
- Reusable task module loading MUST support ESM JavaScript and TypeScript modules through the same live loader path.
- TypeScript reusable task loading MUST be provided by an explicit runtime or supervisor loader boundary and MUST NOT rely on workspace root development dependencies being ambiently available.
- Reusable task module loading MUST NOT add Acpus-owned cache-busting or dependency graph copying; normal Node/tsx module caching defines reuse within a runtime process.
- Task `run.cwd` MUST affect task execution context and the `$` command wrapper only. It MUST NOT change the module resolution base for reusable task imports.
- Task execution MUST evaluate task `run.input`, `run.cwd`, and non-secret `run.env` expressions before invoking the task.
- Task and TypeScript-owned composite outputs MUST enter runtime scope without schema normalization. Runtime MUST keep generic workflow-data admissibility guards before values enter scope, events, or durable storage; these guards MUST reject non-plain runtime values such as functions, class instances, `Date`, `Map`, `Set`, `symbol`, `bigint`, non-finite numbers, sparse arrays, and cycles without reintroducing business-shape validation.
- The runtime MUST pass task execution options to the task `$` command wrapper, including default command timeout.
- The runtime MUST pass a per-attempt `abortSignal` into task code for cooperative cancellation.
- Supported task execution values MUST be `commandRunner: "acpus-zx-core"` and `shell: "bash"`.
- Task nodes MUST NOT support workflow-level automatic retry.
- Agent node `retry.max` MUST be runtime-owned schema-backed response repair
  budget inside one scheduler-visible attempt, not scheduler-visible automatic
  retry.
- Task and agent timeout options MUST be persisted as scheduler attempt deadlines for scheduler-backed runs.
- In-flight task and agent timeout enforcement MAY occur inside the executor attempt, while stale or recovered attempts MUST be derivable from scheduler deadlines.
- Task artifact APIs MUST write run-local artifact files and register metadata in SQLite.
- Attempt-local output directories, work directories, and task artifacts MUST use dynamic `nodeKey` and attempt-specific subpaths for scheduler-backed task execution.
- Task artifact writes after task timeout MUST be rejected and MUST NOT create artifact registry rows.
- Signal execution that cannot complete immediately MUST leave the durable run in a resumable awaiting state.
- Missing executors, providers, or runner prerequisites MUST fail the scheduler-backed run rather than creating a durable blocked state.

### Agents

- The runtime MUST render agent prompts, cwd, env, permission mode, session
  identity, model, and agent mode from frozen IR and durable execution scope.
- The runtime MUST execute real agent definitions through the acpx-backed
  `executeAgentTurn(...)` API from `@acpus/agent-executor`.
- Named agent definitions MUST map to acpx positional agent tokens.
- Command agent definitions MUST map to acpx `--agent <command>`, not a raw
  shell worker protocol.
- Real runtime agent execution MUST NOT consult `ACPUS_AGENT_PROVIDER_COMMANDS`
  or provider-command env mappings.
- Scheduler-backed agent attempts MUST receive runtime-owned
  `ACPUS_RUNTIME_RUN_ID`, `ACPUS_RUNTIME_NODE_ID`, `ACPUS_RUNTIME_NODE_KEY`, and
  `ACPUS_RUNTIME_ATTEMPT` environment variables when the corresponding
  scheduler context exists.
- Runtime-owned `ACPUS_RUNTIME_*` environment variables MUST be overwritten or
  deleted before invoking acpx so stale host or node environment values cannot
  create mixed scheduler identity.
- Absent effective `permissionMode` MUST default to `approve-all`.
- Agent overrides MUST support only `use`, `command`, `model`,
  `permissionMode`, `agentMode`, `cwd`, and `env`. Overrides MUST reject unknown
  agent names, simultaneous `use` and `command`, fields outside this allowlist,
  legacy `policy`, broad `options`, and raw IR `kind`.
- Agent overrides MUST lower `cwd` and `env` string values to literal
  expressions before execution.
- When an agent override changes identity through `use` or `command`,
  identity-tied fields `model` and `agentMode` MUST be cleared unless the same
  override supplies replacements. `permissionMode` MUST remain inherited across
  identity changes.
- Explicit agent session keys MUST render to non-empty strings and determine the
  acpx session identity for the run. When no explicit key is declared, runtime
  MUST derive a deterministic session identity from run id and dynamic node key.
- For schema-backed agent nodes, runtime MUST append the schema prompt section
  to the initial turn and to response repair turns.
- For schema-less agent nodes, runtime MUST return raw response text as the node output and MUST NOT run schema conformance repair.
- The schema prompt section MUST ask for exactly one JSON value that conforms to
  the schema, with no Markdown or prose. It MUST mention extra-key acceptance
  only for object schemas.
- For schema-backed agent nodes, runtime MUST recover JSON from whole-response
  JSON, prose/Markdown-wrapped balanced JSON candidates, and conservative JSON
  repair before classifying output as non-conforming.
- Schema-backed agent output MUST accept extra object keys for conformance but
  MUST project workflow-visible output to the declared schema shape before
  storing node output or exposing expression scope. Dynamic keys remain
  workflow-visible only where the schema itself admits them, such as record,
  unknown, or explicit additional-properties schemas.
- Successful acpx turns with empty response text on schema-backed nodes MUST be
  classified as `empty_response` and repaired with the same response repair
  budget. Empty response text MUST NOT enter JSON parsing.
- Backend failures from `@acpus/agent-executor` MUST fail directly and MUST NOT
  enter agent response repair.
- Schema-backed agent nodes MUST default to one initial turn plus two response
  repair turns. Explicit `retry.max` overrides the number of repair turns, and
  `retry.max = 0` disables response repair.
- Response repair turns MUST reuse the same acpx session, use the fixed
  continuation prompt plus the schema section, and MUST NOT reapply agent mode.
- Agent response repair failures MUST remain inside one scheduler-visible leaf
  attempt. The scheduler MUST NOT create another attempt solely because
  `retry.max` was declared.
- Manual control-plane retry of a failed agent node MUST reuse the same acpx
  session identity for the dynamic node key and MUST send the fixed continuation
  prompt without appending the schema section for the retried attempt's initial
  turn.
- Pause/resume of a requeued agent node MUST reuse the same acpx session
  identity for the dynamic node key and MUST send the fixed continuation prompt
  without appending the schema section for the restarted attempt's initial turn.
- Each scheduler-backed acpx turn MUST write independent prompt, response,
  stderr when present, and telemetry artifacts under the scheduler attempt's
  run-local artifact path and register those files in SQLite.
- Agent telemetry artifacts MUST persist the full normalized telemetry returned
  by `@acpus/agent-executor`, augmented with prompt and response artifact
  references when those IO previews are present.
- Runtime MUST NOT parse raw ACP JSON to derive telemetry. ACP wire-shape
  interpretation belongs to `@acpus/agent-executor`.
- When host environment variable `ACPUS_AGENT_RAW_ACP_DEBUG` is exactly `1`,
  scheduler-backed agent turns MUST request raw debug capture from the executor
  and write returned raw acpx prompt stdout as an opaque `raw-acp` artifact with
  a turn metadata reference. Other values MUST leave raw ACP debug artifact
  capture disabled. Raw ACP debug artifacts MUST NOT affect scheduling,
  response repair, conformance, or replay decisions.
- Each scheduler-backed schema-backed acpx turn that recovers JSON from the
  agent response MUST write the raw recovered value as a diagnostic artifact
  and expose that artifact reference in turn metadata. Raw recovered output
  MUST NOT replace the schema-projected workflow-visible node output.
- Each scheduler-backed agent attempt MUST write structured execution metadata
  that records the turn list, artifact references, status, encoded acpx session
  name, and rendered explicit session key when one was declared. Scheduler
  reducers MUST NOT depend on those artifact contents or metadata rows for
  attempt state transitions.
- Turn metadata MUST include a compact telemetry summary containing event
  count, stop reason when present, context window when present, token usage
  when present, tool call count, cwd when present, and acpx record id when
  present. Turn metadata MUST NOT need to embed full prompt/response IO or full
  tool parameter previews because those live in the telemetry artifact.

### Controls, Fork, Signal, And Replay

- Pause MUST record a durable pause gate and MUST prevent new scheduler-visible attempts from starting while paused.
- Runtime durable run-command inputs MUST use the known discriminated command
  types `pause`, `resume`, `retry`, `fork`, `signal`, and `cancel`, not an open command
  type string.
- Runtime durable supervisor-command inputs MUST use the known discriminated
  command type `shutdown`.
- Runtime durable command variants MUST expose typed JSON payload shapes for
  known payload fields such as pause reason, retry target, cancel target, fork
  options, and signal node/payload.
- Pause MUST best-effort cancel started scheduler-visible attempts and requeue eligible dynamic work for a later resume.
- Pausing an active scheduler-backed agent turn MUST abort the executor signal
  and MUST preserve available prompt, response, stderr, telemetry artifacts,
  and cancelled turn metadata.
- Resume MUST clear the durable pause gate and re-drive eligible scheduler work.
- Retry MUST target a failed scheduler run, failed dynamic leaf `nodeKey`, or
  failed dynamic composite/control `frameKey`.
- Run-level retry MUST reset scheduler projection to a clean pending materialization point while preserving historical event facts.
- Targeted retry MUST accept a dynamic leaf `nodeKey`, a dynamic
  composite/control `frameKey`, or a static node alias only when that alias
  resolves to exactly one failed dynamic retry target.
- Node retry from a failed run MUST reopen only the failed node's scheduler
  execution chain instead of resetting the whole run projection.
- Cancel MUST target a scheduler run, a non-terminal dynamic leaf `nodeKey`, a
  non-terminal dynamic composite/control `frameKey`, or a static node alias only
  when that alias resolves to exactly one non-terminal dynamic cancel target.
- Run-level cancel MUST terminalize the run as `canceled`.
- Targeted cancel MUST terminalize the selected scheduler subtree with reason
  `operator_cancelled` and MUST NOT reset unrelated runnable work.
- Fork MUST create a new run from frozen source run data without reading live workflow source.
- Fork MAY freeze a replacement prepared workflow and/or input override for the new run.
- Fork MUST inherit source run agent overrides that still reference declared
  agents in the forked workflow. Fork-time agent overrides MUST merge over the
  inherited overrides using the same identity replacement rules as admission.
- Fork MUST inherit compatible completed accepted outputs and artifacts reachable from inherited outputs.
- Fork MUST NOT inherit active scheduler frames, attempts, signal waits, or artifacts from failed, cancelled, or superseded attempts.
- Fork MUST verify copied artifacts and current frozen run files before writing fork rows.
- Signal commands MUST store normalized signal payloads, consume open signal waits idempotently, and continue execution from frozen SQLite state.
- Signal targeting MUST accept a dynamic `nodeKey` directly or a static signal alias only when that alias resolves to exactly one open signal wait.
- Replay MUST re-evaluate frozen root outputs from recorded completed node outputs without side effects.
- Replay MUST rebuild scheduler projections from scheduler events and compare them with scheduler projection tables.
- Replay MUST verify artifact registry rows against run-local artifact file digest and size.
- Replay MUST report malformed scheduler event envelopes, unreplayable scheduler event streams, missing or mismatched artifacts, and projection mismatches without mutating runtime state.

### Read APIs And Supervisor

- `listRuns`, `getRun`, replay APIs, and visualization overlay APIs MUST read SQLite projections rather than live workflow source.
- `listRuns` MUST order runs by `updatedAt DESC` with `createdAt DESC` as a
  deterministic tie-breaker.
- `getRun` MUST expose dynamic scheduler details when scheduler projection rows exist, including version, frames, dynamic node instances, attempts, group members, and signal waits.
- Dynamic frame and node-instance read rows MUST include structured
  `instancePath` data when present.
- Dynamic group-member read rows MUST include `childFrameKey` when the member
  owns a child branch or fanout-item frame.
- `getRun` MUST expose runtime execution metadata rows, including agent attempt
  turn metadata, when such rows exist for a run.
- The runtime MUST provide a visualization overlay helper that combines static `WorkflowIR` structure with dynamic scheduler projection state without adding layout-specific state.
- Read-only inspection MUST NOT create runtime state when no runtime store exists.
- Read-only health checks MUST NOT create runtime state when no runtime store
  exists.
- A missing runtime store MUST be reported as a healthy not-initialized state by
  the runtime health API.
- The runtime health API MUST report workspace/store status, supervisor lease
  metadata, supervisor pid liveness when the host can check it, current
  supervisor idle age when available, command queue counts, run status counts,
  runnable run count, active foreground run leases, stale run leases, and
  idle-stop blockers.
- The runtime store MUST support SQLite-backed supervisor leases with generation fencing, heartbeat updates, stale takeover, and release by current generation only.
- The detached supervisor MUST heartbeat under its current lease generation.
- The detached supervisor MUST persist its current idle-since timestamp and
  configured idle window while it is leased.
- The detached supervisor MUST consume pending durable run-command rows for pause, resume, retry, fork, signal, and cancel.
- The detached supervisor MUST consume pending durable supervisor-command rows for shutdown.
- The detached supervisor MUST release its lease and exit after applying a durable shutdown command.
- The detached supervisor MUST NOT process later commands or advance runnable runs in the same tick after applying shutdown.
- The detached supervisor MUST release its lease and exit after a continuous
  idle window with no processed commands, no advanced runnable runs, and no
  active foreground run leases.
- The default supervisor idle window MUST be 30,000 milliseconds.
- Any tick that processes a command, advances a runnable run, or sees active
  foreground run ownership MUST reset the supervisor idle window.
- The detached supervisor MUST recover stale running command rows for its current lease generation before consuming commands.
- The detached supervisor MUST NOT recover foreground CLI-owned commands or commands owned by a different supervisor generation.
- The detached supervisor MUST advance runnable pending scheduler-backed runs from frozen SQLite state without reading live workflow source.

## Verification

- Tests MUST cover prepared workflow admission, persisted frozen input, IR digest, source graph digest, event count, node count, and scheduler-backed public projection bridging.
- Tests MUST cover submit-time agent overrides, fork-time override inheritance
  and replacement, and invalid override rejection.
- Tests MUST cover workflow input and signal payload normalization.
- Tests MUST cover read-only list/show/status APIs without live source reads or state creation for missing stores.
- Tests MUST cover scheduler execution of supported assert, if, switch, parallel, fanout, loop, dynamic identity, durable branch decisions, group completion, cancellation, retry, and timeout transitions.
- Tests MUST cover expression evaluation, template rendering, operator errors, and boolean operand failures.
- Tests MUST cover task execution, inline embedded-source loading, live reusable module loading, package reusable task loading, explicit TypeScript loader ownership, task invocation options, absence of workflow-level automatic task retry, timeout deadlines, task abort signal propagation, artifact writes, attempt-local artifact paths, and timeout artifact rejection.
- Tests MUST cover acpx-backed agent turn integration, named and command agent
  mapping, absence of provider-command env mapping consultation, durable agent
  output conformance, empty-response repair, scheduler runtime identity
  environment, explicit session identity, schema-backed response repair inside
  one scheduler-visible attempt, manual control-plane retry continuation,
  pause/resume continuation, and separation between scheduler-visible attempts
  and agent response repair turns.
- Tests MUST cover scheduler-backed agent turn prompt, response, stderr, and
  telemetry artifacts, including normalized context, token, tool, and IO
  telemetry, plus `getRun` execution metadata that exposes turn history,
  session context, and compact telemetry summaries.
- Tests MUST cover the `ACPUS_AGENT_RAW_ACP_DEBUG=1` diagnostic switch and the
  default absence of raw ACP debug artifacts.
- Tests MUST cover raw recovered schema-backed agent output artifacts and prove
  they remain diagnostic rather than workflow-visible output.
- Tests MUST cover pause, resume, run retry, dynamic node retry, cancel, signal targeting and idempotency, fork, replay, durable command rows, and fork artifact reachability.
- Tests MUST cover supervisor lease acquisition, active lease rejection, stale takeover, heartbeat fencing, release fencing, durable command consumption, and shutdown.
