# Runtime Spec

## Purpose

`@acpus/runtime` persists and advances prepared workflow runs in a workspace-local durable store. It accepts a prepared workflow and normalized input, writes SQLite state and run-local files, executes supported frozen IR, exposes read APIs, handles signal continuation, and owns the local daemon that controls live run execution sessions. Workflow static checks, module compile, and in-memory workflow preparation belong to `@acpus/workflow-compiler`.

## Requirements

### Admission And Store

- The runtime MUST create `.acpus/.local/state/runtime.db` as the durable runtime store for a workspace.
- The runtime store MUST use SQLite for run admission data, public run events, scheduler events, scheduler projection tables, public run and node projections, daemon lease rows, run lease rows, execution metadata, node progress snapshots, and artifact registry rows.
- The runtime store MUST NOT store durable command rows, durable command status, command queue counts, control request wait state, daemon endpoint, daemon port, daemon auth token, daemon auth token hash, or daemon service-discovery rows.
- Runtime-generated run ids MUST use local time `YYYYMMDDHHmmss` followed by 20 uppercase hexadecimal random characters.
- Run admission MUST accept a prepared workflow containing frozen IR JSON, lock metadata, and source graph digest.
- Run admission MUST accept input that has already been normalized against the workflow input schema.
- Run admission MAY accept agent overrides keyed by declared top-level agent
  name. Agent overrides MUST be persisted separately from frozen `WorkflowIR`
  and MUST be applied when reading the effective frozen run for execution.
- Run admission MUST persist the `WorkflowIR`, workflow input, lock metadata, workflow entry, IR digest, source graph digest, and run directory path.
- Run admission MUST write a `run.admitted` event and the run projection in the same SQLite transaction.
- Run admission MUST create public `pending` node projection rows for static node summaries and MUST advance executable work from the frozen admitted IR, not from live workflow source.
- Run admission MUST copy only current frozen workflow artifacts such as `workflow.ir.json` and `lock.json` into `.acpus/.local/runs/<run-id>/`. It MUST NOT copy reusable task source or dependency artifacts.
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
- Runtime run detail read APIs MUST expose dynamic frame, node instance, attempt,
  group member, and signal wait timing fields needed for compact status
  rendering.
- Runtime run detail read APIs MUST expose latest node progress snapshots and
  run-level progress version metadata for polling. Progress version changes MUST
  be independent from scheduler event sequence/version changes.
- Public run status MUST distinguish queued admission from active execution:
  `pending` means admitted or reset but no scheduler frame, runnable instance,
  group member, or attempt has started or become ready; public status MUST be
  `running` once scheduler projection contains a root frame, active frame,
  ready/running node instance, ready/running group member, running group, or
  started attempt, unless the run is awaiting, paused, failed, completed, or
  canceled.
- Runtime run detail read APIs MUST expose persisted rendered signal prompts for
  awaiting signal waits so read-only inspection can render operator guidance.
- Runtime run detail read APIs MUST expose consumed signal wait payloads and
  consumption timestamps for consumed signal waits.
- Runtime read APIs used for run inspection MUST expose frozen static node
  metadata, including signal output schemas, so CLI output can render expected
  signal payload guidance without reading live workflow source.
- Node progress snapshots MUST be latest-state observation data and MUST NOT be
  scheduler events or scheduler transition inputs.
- Starting a new attempt for a node MUST clear any previous progress snapshot for
  that node so inspection never shows stale telemetry while the new attempt is
  waiting to emit progress.
- Node progress snapshots MUST use typed channels for status/message, bounded
  output tail, context window, token usage, and tool-call summary where those
  channels are available.
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
- Loop execution MUST use do-while transition semantics: iteration 0 is materialized immediately, each iteration evaluates the body transition `{ state, stop }`, and loop completion returns the final transition `state`.
- Loop runtime scope MUST expose `loop.<nodeId>.index`, `loop.<nodeId>.round`, and `loop.<nodeId>.state`; `index` is 0-based and `round` is 1-based.
- Group member rows MUST point at the child branch or fanout-item frame that
  owns the cancellable member subtree.
- The runtime MUST execute task nodes through the task run target stored in frozen IR.
- For inline task targets, the runtime MUST construct a callable function from the embedded self-contained source without writing a run-local task source file.
- For reusable module task targets, the runtime MUST resolve the recorded source-level module specifier from the workflow referrer in the current workspace/package environment through `@acpus/loader`, verify the selected export is an Acpus task token, and invoke the token's `fn`.
- For supported official authoring facade specifiers such as
  `acpus/tasks/git`, reusable task loading MUST resolve from Acpus-owned
  packages and MUST NOT require a workflow-local Acpus installation.
- Reusable task module loading MUST support ESM JavaScript and TypeScript modules through the same live loader path.
- TypeScript reusable task loading MUST be provided by the internal loader boundary and MUST NOT rely on workspace root development dependencies being ambiently available.
- Reusable task module loading MUST NOT add Acpus-owned cache-busting or dependency graph copying; normal Node module caching behind the authoring loader defines reuse within a runtime process.
- Task `run.cwd` MUST affect task execution context and the `$` command wrapper only. It MUST NOT change the module resolution base for reusable task imports.
- Task execution MUST evaluate task `run.input`, `run.cwd`, and non-secret `run.env` expressions before invoking the task.
- Task and TypeScript-owned composite outputs MUST enter runtime scope without schema normalization. Runtime MUST normalize generic workflow data before values enter scope, events, or durable storage: a Task top-level `undefined` means no output, object properties whose value is `undefined` are omitted recursively, and array-element `undefined` is rejected. The normalizer MUST reject non-plain runtime values such as functions, class instances, `Date`, `Map`, `Set`, `symbol`, `bigint`, non-finite numbers, sparse arrays, and cycles without reintroducing business-shape validation.
- The runtime MUST pass task execution options to the task `$` command wrapper, including default command timeout.
- The runtime MUST pass a per-attempt `abortSignal` into task code for cooperative cancellation.
- Supported task execution values MUST be `commandRunner: "acpus-zx-core"` and `shell: "bash"`.
- Task nodes MUST NOT support workflow-level automatic retry.
- Agent node `retry.max` MUST be runtime-owned schema-backed response repair
  budget inside one scheduler-visible attempt, not scheduler-visible automatic
  retry.
- Task and agent timeout options MUST be persisted as scheduler attempt deadlines for scheduler-backed runs.
- Signal timeout options MUST be persisted as scheduler signal wait deadlines.
- In-flight task and agent timeout enforcement MAY occur inside the executor attempt, while stale or recovered attempts MUST be derivable from scheduler deadlines.
- Task artifact APIs MUST write run-local artifact files and register metadata in SQLite.
- Attempt-local output directories, work directories, and task artifacts MUST use dynamic `nodeKey` and attempt-specific subpaths for scheduler-backed task execution.
- Task artifact writes after task timeout MUST be rejected and MUST NOT create artifact registry rows.
- Signal execution that cannot complete immediately MUST leave the durable run in a resumable awaiting state.
- Signal timeout expiration MUST mark the signal wait timed out, fail the signal
  node instance with `signal_timeout`, and fail running ancestor group members so
  composite completion can proceed.
- Pausing a run MUST pause open signal timeout clocks and resuming that run MUST
  restore their remaining timeout budgets as new deadlines.
- Awaiting signal projection MUST persist the rendered signal prompt so read-only
  inspection can show the exact operator prompt without re-executing workflow
  logic.
- Missing executors, providers, or runner prerequisites MUST fail the scheduler-backed run rather than creating a durable blocked state.

### Agents

- The runtime MUST render agent prompts, cwd, env, permission mode, session
  identity, model, and agent mode from frozen IR and durable execution scope.
- The runtime MUST execute real agent definitions through the acpx-backed
  `executeAgentTurn(...)` API from `@acpus/agent-executor`.
- Scheduler-backed agent execution MUST subscribe to the executor's normalized
  progress callback and persist latest node progress snapshots while the
  scheduler-visible attempt is still running.
- Agent progress snapshots MUST be derived from normalized executor progress.
  Runtime MUST NOT parse raw ACP JSON to produce progress.
- Agent progress output MUST be bounded to a recent tail in SQLite. Full final
  prompt, response, stderr, and telemetry MUST remain artifact-backed.
- Agent progress writes SHOULD be throttled by time and meaningful telemetry or
  tool-call changes so long-running agents remain observable without writing on
  every output chunk.
- Agent progress `updatedAt` MUST represent the last persisted agent stream
  activity time and MAY lag high-frequency stream activity by the progress
  throttle interval.
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
- Explicit agent `sessionKey` values MUST render to non-empty strings and act as
  run-local logical session keys. Runtime MUST include run id in the final acpx
  session identity when present. When no explicit key is declared, runtime MUST
  derive a deterministic session identity from run id and dynamic node key.
- For schema-backed agent nodes, runtime MUST append the schema prompt section
  to the initial turn and to response repair turns.
- For schema-less agent nodes, runtime MUST return raw response text as the node output and MUST NOT run schema conformance repair.
- The schema prompt section MUST ask for exactly one JSON value that conforms to
  the schema, with no Markdown or prose.
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
  response repair or conformance decisions.
- Each scheduler-backed schema-backed acpx turn that parses JSON from the
  agent response MUST write the raw parsed value as a diagnostic artifact and
  expose that artifact reference in turn metadata. Raw parsed output MUST NOT
  replace the schema-projected workflow-visible node output.
- Each scheduler-backed agent attempt MUST write structured execution metadata
  that records the turn list, artifact references, status, encoded acpx session
  name, and rendered explicit `sessionKey` when one was declared. Scheduler
  reducers MUST NOT depend on those artifact contents or metadata rows for
  attempt state transitions.
- Turn metadata MUST include a compact telemetry summary containing event
  count, stop reason when present, context window when present, token usage
  when present, tool call count, cwd when present, and acpx record id when
  present. Turn metadata MUST NOT need to embed full prompt/response IO or full
  tool parameter previews because those live in the telemetry artifact.

### Controls, Daemon, Fork, And Signal

- Pause MUST record a durable pause gate and MUST prevent new scheduler-visible attempts from starting while paused.
- Pause on an already paused run MUST return `applied` without writing duplicate
  control events.
- Runtime control intents MUST use the known discriminated control types
  `pause`, `resume`, `retry`, `fork`, `signal`, and `cancel`, not an open control
  type string.
- Runtime control intent variants MUST expose typed JSON payload shapes for
  known payload fields such as pause reason, retry target, cancel target, fork
  options, and signal node/payload.
- The runtime daemon MUST expose a small local request/response interface:
  `startRun(runId)`, `control(runId, intent)`, `observeRun(runId)`,
  `shutdown()`, and `status()`.
- Runtime control requests from clients MUST route through the local daemon and
  daemon-hosted per-run execution sessions; clients MUST NOT apply scheduler
  controls directly through SQLite or become scheduler run owners.
- Daemon control responses MUST be `applied` or `failed`. Client wait timeouts
  are client outcomes and MUST NOT be persisted as runtime state.
- The daemon API MUST use a workspace-derived local Unix domain socket or
  platform-equivalent named pipe and a small stdlib JSON request/response
  protocol.
- The daemon API MUST NOT use an HTTP localhost port as its control protocol.
- The daemon socket or named pipe path MUST be derived from the workspace and
  MUST NOT be stored in SQLite.
- Daemon single-instance arbitration MUST use fixed socket or named-pipe
  binding. Daemon lease rows MUST NOT act as a startup lock, leader election, or
  distributed ownership protocol.
- A daemon that loses socket binding to a live daemon MUST exit after `status()`
  confirms the live daemon. Stale socket removal MUST require local evidence
  such as a dead daemon pid or expired daemon heartbeat.
- Public daemon error codes MUST be limited to `RUN_NOT_FOUND`,
  `RUN_TERMINAL`, `RUN_NOT_CONTROLLABLE`, `INVALID_CONTROL`,
  `CONTROL_CONFLICT`, `EXECUTION_UNAVAILABLE`, `STORE_ERROR`, and
  `INTERNAL_ERROR`.
- Daemon public responses MUST NOT expose scheduler/store internals such as
  `lease_lost`, owner epoch mismatch, SQLite constraint names, or projection
  internals as API contract values.
- The daemon MUST host one execution session per active or recoverable run.
- Different run sessions MAY progress concurrently.
- Within one run session, durable scheduler writes MUST be serialized per run,
  but long task or agent executor waits MUST NOT block control requests from
  entering the same run session.
- `cancel` and `pause` MUST reach a live session promptly, persist the durable
  fenced scheduler effect, and directly abort active attempt controllers before
  returning an applied response.
- Late executor results MUST be fenced by attempt identity, owner epoch, and/or
  current projection state so they cannot overwrite already-applied cancel,
  pause, resume, retry, signal, or fork outcomes.
- Pause MUST best-effort cancel started scheduler-visible attempts and requeue eligible dynamic work for a later resume.
- Pausing an active scheduler-backed agent turn MUST abort the executor signal
  and MUST preserve available prompt, response, stderr, telemetry artifacts,
  and cancelled turn metadata.
- Resume MUST clear the durable pause gate and re-drive eligible scheduler work.
- Resume on an already resumed run MUST return `applied` without writing
  duplicate control events.
- Retry MUST target a failed scheduler run, failed dynamic leaf `nodeKey`, or
  failed dynamic composite/control `frameKey`.
- Run-level retry MUST reset scheduler projection to a clean pending materialization point while preserving historical event facts.
- Retry MUST derive stable scheduler commit identity from the retry target and
  retry intent so repeated retry requests cannot create duplicate retry
  branches.
- Targeted retry MUST accept a dynamic leaf `nodeKey`, a dynamic
  composite/control `frameKey`, or a static node alias only when that alias
  resolves to exactly one failed dynamic retry target.
- Node retry from a failed run MUST reopen only the failed node's scheduler
  execution chain instead of resetting the whole run projection.
- Cancel MUST target a scheduler run, a non-terminal dynamic leaf `nodeKey`, a
  non-terminal dynamic composite/control `frameKey`, or a static node alias only
  when that alias resolves to exactly one non-terminal dynamic cancel target.
- Run-level cancel MUST terminalize the run as `canceled`.
- Cancel on an already canceled run MUST return `applied` without writing
  duplicate cancel events.
- Targeted cancel MUST terminalize the selected scheduler subtree with reason
  `operator_cancelled` and MUST NOT reset unrelated runnable work.
- Fork MUST create a new run from frozen source run data without reading live workflow source.
- Fork MUST derive or record stable fork identity at the scheduler commit layer
  so repeated fork requests return the same fork run id instead of creating
  multiple fork runs.
- Fork MAY freeze a replacement prepared workflow and/or input override for the new run.
- Fork control payloads MAY include a non-empty `target` string. Supplying a
  target MUST select targeted replacement fork semantics, while omitting target
  in targeted replacement fork mode MUST mean the workflow root completion target.
- Fork control payloads MAY include `unsafeReuse: true`. Supplying
  `unsafeReuse` MUST select targeted replacement fork semantics and instruct
  seed planning to reuse scheduler-accepted completed facts without enforcing
  source/replacement semantic signature or changed-input compatibility.
- Targeted replacement fork MUST seed scheduler-visible replacement-run events
  for compatible completed prerequisites selected by the implicit root
  completion target, an explicitly resolved static leaf target, or a dynamic
  `nodeKey` target whose replacement instance path can be proven, and MUST NOT
  create fork-local `attempt.started` or `attempt.completed` events for
  inherited work.
- For the implicit root completion target, targeted replacement fork MAY reuse
  only the accepted winner branch of a completed `race` parallel group and MAY
  reuse accepted members of a completed `quorum` fanout only when the accepted
  member order matches replacement natural materialization order.
- Before an explicit downstream target, targeted replacement fork MAY
  conservatively skip `race` and `quorum` prerequisite reuse and let the forked
  run execute that group work normally.
- Dynamic `nodeKey` fork targets MUST resolve to a replacement instance path
  before seed planning can inherit prerequisites for them. If unseeded or
  incompatible prerequisites keep the target from materializing during seed
  planning but the replacement control path remains possible, the fork MAY be
  admitted so those prerequisites run normally. If replacement materialization
  proves the dynamic path impossible, the fork MUST fail before admission.
- Targeted replacement fork MUST reject missing static targets, missing dynamic
  `nodeKey` targets, and ambiguous static targets before creating a misleading
  runnable fork. Static composite/control targets MUST seed only compatible
  prerequisites before the target node and MUST NOT seed completed work inside
  the target subtree.
- Static targets inside dynamic fanout or loop expansion MUST be accepted only
  when replacement materialization proves exactly one dynamic target instance.
  Ambiguous fanout aliases and repeating loop aliases MUST fail before
  admission and require a dynamic `nodeKey` target.
- Targeted replacement fork with changed input MUST NOT inherit completed
  source outputs, but SHOULD still initialize replacement scheduler
  materialization so later runtime advancement starts from scheduler-visible
  state.
- Targeted replacement fork with `unsafeReuse: true` MAY inherit completed
  source outputs despite changed input or workflow signature changes, but MUST
  still honor target prerequisite closure, target non-seeding, replacement
  materialization, artifact rewriting, and completed-only inheritance.
- Fork MUST inherit source run agent overrides that still reference declared
  agents in the forked workflow. Fork-time agent overrides MUST merge over the
  inherited overrides using the same identity replacement rules as admission.
- Fork MUST inherit compatible completed accepted outputs and artifacts reachable from inherited outputs.
- Fork MUST NOT inherit active scheduler frames, attempts, signal waits, or artifacts from failed, cancelled, or superseded attempts.
- Fork MUST verify copied artifacts and current frozen run files before writing fork rows.
- Signal controls MUST normalize signal payloads, consume open signal waits
  idempotently, and continue execution from frozen SQLite state.
- Signal controls MUST use signal name plus waiting instance identity to consume
  the intended wait exactly once.
- Signal targeting MUST accept a dynamic `nodeKey` directly or a static signal alias only when that alias resolves to exactly one open signal wait.
- The daemon MUST start or wake for `resume` and `signal` controls, recover the
  targeted run session, apply the requested effect, and continue execution if
  runnable work is unlocked.
- `shutdown()` MUST be daemon service lifecycle, not run control.
- `shutdown()` MUST return `applied` and stop the daemon only when there are no
  active run execution sessions.
- `shutdown()` with active sessions MUST return `failed` with
  `CONTROL_CONFLICT`.
- Runtime MUST NOT provide force shutdown in the daemon control model.
- Daemon shutdown and idle-stop MUST NOT cancel, pause, fail, or otherwise
  mutate runs.

### Read APIs And Daemon

- `listRuns`, `getRun`, and visualization overlay APIs MUST read SQLite projections rather than live workflow source.
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
- Runtime read APIs used by inspection MUST combine durable run projection with
  local liveness evidence such as daemon heartbeat, daemon pid liveness when
  available, run lease expiry, and active owner metadata, and MUST expose
  derived execution states `active`, `inactive`, `stale`, `terminal`, and
  `unknown`.
- Derived execution states MUST NOT be persisted as durable run statuses.
- Read-only inspection MUST report stale non-terminal execution without writing
  recovery events or mutating run status.
- The daemon heartbeat interval MUST be 1,000 milliseconds.
- Runtime inspection MAY classify non-terminal execution as stale after 5,000
  milliseconds without a credible daemon heartbeat or immediately when the
  recorded daemon pid is known dead.
- Runtime inspection MAY classify non-terminal execution as stale when the run
  lease has expired or active owner metadata is no longer credible.
- The 5,000 millisecond daemon stale threshold MUST NOT trigger scheduler
  recovery, run ownership takeover, or durable status mutation.
- Scheduler run lease stale detection MUST remain separate from daemon
  heartbeat staleness and MUST use a 30,000 millisecond stale window.
- The runtime health API MUST report workspace/store status, daemon lease
  metadata, daemon pid liveness when the host can check it, current daemon idle
  age when available, run status counts, runnable run count, stale run leases,
  and idle-stop blockers.
- The runtime health API MUST NOT report command queue counts.
- Daemon request ids, if introduced, MUST be ephemeral logging or tracing values
  and MUST NOT be persisted as command/request state.
- The runtime store MUST support SQLite-backed daemon leases with generation
  fencing, heartbeat updates, pid metadata, idle metadata, protocol/runtime
  metadata, and release by current generation only.
- Daemon lease rows MUST NOT store endpoint, port, auth token, auth token hash,
  or service-discovery fields.
- The daemon MUST heartbeat under its current lease generation independently of
  long task or agent execution.
- The daemon MUST persist its current idle-since timestamp and configured idle
  window while it is leased.
- The daemon MUST release its lease and exit after a continuous 30,000
  millisecond idle window with no active run sessions, no attached observe
  clients, and no admitted non-terminal run that is currently runnable or
  otherwise continuable locally.
- Paused runs and signal waits without timeout MUST NOT keep the daemon resident
  solely because future input may resume them.
- Signal waits with timeout deadlines MUST keep the daemon resident until the
  deadline is reached and the timeout is durably settled.
- Daemon startup MAY recover admitted non-terminal runs that are currently
  runnable or otherwise continuable.
- Daemon startup MUST NOT become a whole-store repair sweep.
- Runs explicitly targeted by `startRun` or `control` MUST be recoverable even
  when they are paused, waiting for signal, or otherwise not currently runnable.
- Read-only APIs such as `listRuns`, `getRun`, visualization overlay, and health
  inspection MUST NOT start or wake the daemon.
- The daemon MUST advance runnable pending scheduler-backed runs from frozen
  SQLite state without reading live workflow source.

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
- Tests MUST cover raw parsed schema-backed agent output artifacts and prove
  they remain diagnostic rather than workflow-visible output.
- Tests MUST cover pause, resume, run retry, dynamic node retry, cancel, signal targeting and idempotency, fork, targeted fork seed planning, unsafe targeted fork reuse, targeted fork missing/dynamic targets, static composite target subtree boundaries, direct daemon control application, and fork artifact reachability.
- Tests MUST cover daemon socket single-instance binding, stale socket handling,
  daemon lease metadata, heartbeat fencing, heartbeat during long execution,
  release fencing, idle-stop, shutdown, and the absence of durable command rows.
- Tests MUST cover daemon-hosted run execution session control responsiveness
  while executor work is in flight, active attempt abort, per-run durable write
  serialization, and late executor result fencing.
- Tests MUST cover mapping scheduler/store failures such as lease loss, owner
  epoch mismatch, SQLite constraint failures, and projection inconsistencies to
  stable public daemon error codes without exposing internal details.
- Tests MUST cover read-only inspect stale execution classification without
  daemon startup or store mutation.
