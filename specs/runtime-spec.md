# Runtime Spec

## Purpose

`@acpus/runtime` persists and advances prepared workflow runs in a workspace-local durable store. It accepts a prepared workflow and normalized input, writes SQLite state and run-local files, executes supported frozen IR, exposes read APIs, handles signal continuation, and owns the local daemon that controls live run execution sessions. Workflow static checks, module compile, and in-memory workflow preparation belong to `@acpus/workflow-compiler`.

## Requirements

### Admission And Store

- The runtime MUST create `.acpus/.local/state/runtime.db` as the durable runtime store for a workspace.
- A first writable open of a runtime store MUST initialize the complete current SQLite schema directly.
- Reopening a current writable runtime store MUST be idempotent and MUST preserve existing current rows.
- Opening an existing current runtime store for read-only inspection MUST NOT mutate its schema or data.
- The runtime store MUST use SQLite for run admission data, public run events, scheduler events, scheduler projection tables, public run and node projections, daemon lease rows, run lease rows, execution metadata, node progress snapshots, and artifact registry rows.
- Runtime-generated run ids MUST use local time `YYYYMMDDHHmmss` followed by 20 uppercase hexadecimal random characters.
- Run admission MUST accept a prepared workflow containing frozen IR JSON, deterministic lock metadata, and source graph digest.
- Accepted lock metadata MUST use the preparation-lock shape with workflow entry and source digest, IR path and digest, source graph digest, and optional package lock digest. It MUST NOT contain a generation timestamp.
- Daemon requests MUST reject missing or unknown preparation-lock fields before dispatch. The durable store boundary for new-run admission and replacement fork admission MUST canonicalize the supplied IR from its frozen JSON before mutating runtime state. Both paths MUST verify that the frozen IR JSON matches the supplied IR and IR digest; lock and top-level source-graph and optional package-lock digests match in both presence and value; the source-graph digest equals `sha256([workflow.sourceDigest, packageLockDigest ?? ""].join("\n"))`; and the lock workflow entry matches the prepared workflow path relative to the workspace. The daemon MUST report any of these consistency failures as `INVALID_REQUEST`.
- Run admission MUST accept input that has already been normalized against the workflow input schema.
- Run admission MAY accept agent overrides keyed by declared top-level agent
  name. Agent overrides MUST be persisted separately from frozen `WorkflowIR`
  and MUST be applied when reading the effective frozen run for execution.
- Run admission MUST write the exact frozen `WorkflowIR` bytes to `.acpus/.local/runs/<run-id>/workflow.ir.json` and the exact workflow lock bytes to `.acpus/.local/runs/<run-id>/lock.json`.
- Each admitted `run_inputs` row MUST persist non-null `workflow_ir_path`, `workflow_ir_digest`, `lock_path`, `lock_digest`, and `run_dir` values. The two file paths MUST be relative to the recorded run directory, and their digests MUST use `sha256:<hex>` over the exact corresponding file bytes.
- Run admission MUST write a `run.admitted` event and the run projection in the same SQLite transaction.
- Production run admission MUST route through the local daemon. Before returning
  a successful admission response, the daemon MUST register the admitted run in
  its execution-session registry and begin daemon-owned advancement when the run
  is non-terminal.
- Run admission MUST create public `pending` node projection rows for static node summaries and MUST advance executable work from the frozen admitted IR, not from live workflow source.
- Frozen workflow and lock paths MUST resolve to regular, non-symbolic-link files contained beneath the recorded run directory, and runtime operations MUST verify their stored digests before parsing or using those files.
- Missing frozen files, path-containment failures, and digest mismatches MUST fail the requesting operation and MUST NOT be represented as absent static metadata.
- Run admission MUST NOT copy reusable task source or dependency artifacts into the run directory.
- Scheduler attempt ownership MUST use `owner_epoch`. Signal terminal timing MUST use the event-derived `updated_at` projection.
- `deleteRun` MUST return `undefined` when the runtime store or requested run is absent. Only deletion of an active run MUST raise a runtime use-case exception.
- Completed scheduler-backed runs MUST persist root output, bridge completed dynamic node instances into public node projections where unambiguous, and write a `run.completed` event.
- Runtime failures after admission MUST persist failed run state and a `run.failed` event.

### Input And Payload Normalization

- `normalizeWorkflowInput(ir, input)` MUST validate workflow input against `WorkflowIR.inputSchema` and return normalized input.
- Signal control MUST accept schema-less signal payloads only as raw strings and MUST validate schema-backed signal payloads against the target signal node output schema.
- Invalid workflow input or signal payload MUST fail before mutating runtime state for the corresponding operation.

### Expression And Template Evaluation

- The runtime MUST evaluate `ExprIR` by adapting `@acpus/expression/evaluator` to durable execution scope.
- Runtime configuration resolution MUST use typed Result helpers for strings, durations, and constrained integers. Resolution errors MUST distinguish evaluator failure, result type mismatch, and field constraint failure and MUST carry the authored field path or label.
- Runtime duration resolution MUST delegate authored syntax and safe-integer range checks to `@acpus/core/ir`. Deadline construction MUST return a typed constraint error when the result cannot use the persisted, lexically sortable four-digit-year ISO timestamp format.
- Persisted attempt and signal deadlines MUST use canonical four-digit-year ISO timestamps. Durable event decoding, projection reads, and daemon due-work selection MUST fail visibly on malformed deadline values before using lexical timestamp comparisons.
- Runtime Result objects MUST NOT enter events, SQLite rows, workflow output, or public JSON payloads.
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
- `advanceRun(input)` MUST return a `Promise<AdvanceRunSummary>` and MAY throw
  store or invariant failures.
- Internal runtime advancement MUST return an `AdvanceRunSummary` and MAY throw
  store or invariant failures. Recoverable client-facing admission and control
  failures MUST be translated at the daemon boundary to a stable daemon error
  code and message.
- Scheduler advance logic MUST branch on scheduler store error tags and MUST NOT parse exception messages for lease, pause, version, or stale terminal control flow.
- Scheduler store error tags MUST preserve user-facing messages separately from machine-readable fields such as `runId`, `attemptId`, `expectedVersion`, `actualVersion`, and `ownerEpoch`.
- Scheduler store error tags MUST include recoverable idempotency conflicts,
  missing retry targets, and invalid retry targets without requiring callers to
  parse display messages.
- Scheduler intent idempotency keys MUST be scoped by `(runId, key)` and MUST
  replay only the same control identity within that run. Successful controls
  that append no scheduler event MUST still record their intent atomically.
  Retry and cancel identity MUST retain the authored target while execution
  uses the resolved dynamic target key, so state changes after the first
  application cannot break static-alias replay.
  Reusing a run-scoped key for a different control type or target MUST return an
  `idempotency-conflict` error.
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
- `getRunInspection(cwd, query)` MUST expose a typed `ResultAsync` boundary with
  overview, all, target, and raw query modes. Missing-store, missing-run,
  missing-target, invalid-query, and inspection-read failures MUST remain
  tagged inspection errors.
- Overview inspection MUST return a versioned compact projection containing a
  run summary, scheduler-event and progress cursors, exact status counts,
  normalized sparse structural items, operator actions, exact omitted counts,
  and terminal workflow output when recorded.
- Exact status counts MUST count every dynamic leaf execution context,
  including repeated Assert node frames, while counting an unmaterialized
  authored leaf once and excluding composite/grouping rows.
- Overview inspection MUST preserve the authored tree while bounding expanded
  dynamic contexts to 20. All-mode inspection MUST expose every normalized
  dynamic context without reverting to raw scheduler projection tables.
- Target inspection MUST resolve static node ids, dynamic node keys, frame
  keys, and attempt ids. Static node ids MUST aggregate matching dynamic
  instances, while dynamic keys and attempt ids MUST select their exact
  execution context.
- Target inspection MUST include complete matching attempt history,
  status/progress, signal details, execution metadata, and artifact references
  without reading or embedding artifact file contents.
- Raw inspection MUST expose the unbounded run details, complete frozen
  `WorkflowIR`, and artifact registry records without replacing the frozen IR
  with a lossy static-node summary.
- Inspection MUST expose Agent identity by the authored key stored in
  `node.run.agent`, regardless of an effective run override. Compact Agent
  state MUST describe an effective `use` backend by name or a `command`
  backend by kind without embedding the command text; complete command
  definitions MUST remain limited to target or raw inspection.
- Compact Agent state MUST type context-window and token-usage counters and
  MUST include at most the three most recent normalized tool commands in
  chronological order with their statuses. It MUST NOT include tool ids,
  arguments, input previews, output previews, prompts, or responses.
- Tool command normalization MUST prefer the executor tool name, then kind,
  then title. Shell-like tools MUST expose only the first executable basename,
  ignoring environment assignments and wrapper commands such as `env` and
  `sudo`; an unsafe or unparseable preview MUST fall back to the shell tool
  name. Each normalized command MUST be bounded to three words and 32 visible
  characters.
- Compact Signal state MUST bound rendered prompt and schema summaries to 160
  visible characters each. Complete persisted prompts and `SchemaIR` values
  MUST remain available in target and raw inspection only.
- Inspection failure projection MUST prefer a persisted explicit origin and
  otherwise distinguish scheduler expression/deadline/materialization failures
  from provider, Task, and Signal failures using a closed set of stable
  scheduler reasons; provider/Task codes such as `invalid_api_key` or
  `invalid_output` MUST NOT be reclassified by a broad prefix heuristic.
- Compact inspection MUST preserve a bounded upstream acpx summary containing
  operation, exit status, acpx code/origin, and JSON-RPC code/message when
  present, while target inspection MUST preserve the complete parsed
  JSON-RPC error data without embedding raw ACP lines.
- A repeated composite projection MUST select group membership counts by the
  matching dynamic `nodeKey`; it MUST NOT reuse the first group sharing a
  static node id.
- Agent turn count MUST use the greatest available value from persisted attempt
  metadata and current Agent progress so live inspection cannot regress behind
  a running turn.
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
- Fanout `all` strategy MUST materialize item identity rows and aggregate item outputs as an array in ascending `itemIndex` (input) order. Empty input MUST produce an empty array.
- Fanout `quorum` strategy MUST accept outputs in completion order, return the accepted item outputs as `Array<ItemOutput>` after quorum success, and cancel remaining running member subtrees after quorum is reached.
- Parallel/Fanout `maxConcurrency` and Fanout quorum `count` MUST resolve once when the group materializes. Their concrete values MUST be stored in `group.started`, rebuilt into group projection state after recovery, and used by concurrency and completion policy from that projection.
- Fanout item identity MUST use the zero-based `itemIndex` of each array occurrence. Duplicate item values MUST materialize as distinct fanout items.
- Branch group members MUST contain `branchId`; fanout group members MUST contain `itemIndex` and the item payload. A group member MUST NOT combine branch and fanout identity fields.
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
- Every Task attempt MUST execute in a fresh Node process. Normal Node module caching MUST apply within one attempt only; separate tasks and retried attempts MUST reload reusable task modules and MUST NOT share module globals.
- Task `run.cwd` MUST define the Task process's initial working directory. An omitted cwd MUST use the workspace directory, an absolute cwd MUST be used as-is, and a relative cwd MUST resolve against the workspace directory. The directory MUST exist when the attempt starts.
- Task `run.cwd` MUST be observed consistently by `process.cwd()`, relative Node filesystem access, `artifact.fromFile(...)`, module top-level code, and the default `$` command wrapper. It MUST NOT change the module resolution base for reusable task imports.
- A Task process environment MUST start from the runtime host environment with evaluated `run.env` values overriding matching keys. `process.env`, task context `env`, module top-level code, and the default `$` command wrapper MUST observe that effective environment.
- The default Task `$` wrapper MUST inherit the live process cwd and environment at each command invocation so task-local `process.chdir(...)` and `process.env` mutations remain consistent with later commands.
- Task execution MUST evaluate task `run.input`, `run.cwd`, and `run.env` expressions before invoking the task.
- Task and TypeScript-owned composite outputs MUST enter runtime scope without schema normalization. Runtime MUST normalize generic workflow data before values enter scope, events, or durable storage: a Task top-level `undefined` means no output, object properties whose value is `undefined` are omitted recursively, and array-element `undefined` is rejected. The normalizer MUST reject non-plain runtime values such as functions, class instances, `Date`, `Map`, `Set`, `symbol`, `bigint`, non-finite numbers, sparse arrays, and cycles without reintroducing business-shape validation.
- The runtime MUST pass the resolved Task default command timeout to the task `$` command wrapper.
- The runtime MUST pass a per-attempt `abortSignal` into task code for cooperative cancellation. After cancellation or timeout, it MUST reject late successful output and artifact registration, then terminate the isolated Task process tree after a bounded cooperative grace period.
- Cancellation of a scheduler-visible Task attempt before child process spawn
  MUST preserve start-before-abort protocol ordering when the child is spawned:
  the parent MUST deliver the start message and then the abort message, and Task
  code MUST receive an already-aborted `abortSignal` so cooperative cleanup can
  run.
- A Task attempt whose persisted deadline is exhausted before the child process
  reports spawn MUST settle as timed out without receiving the start message or
  invoking Task code.
- A failed scheduler leaf MUST remain failed until an explicit control-plane
  retry reopens its node, frame, or run. Scheduler advance MUST NOT derive retry
  request events or reopen failed work from an attempt budget.
- Agent node `retry.max` MUST be runtime-owned schema-backed response repair
  budget inside one scheduler-visible attempt, not scheduler-visible automatic
  retry.
- Task and Agent timeout expressions MUST resolve once before attempt start and MUST be persisted as scheduler attempt deadlines for scheduler-backed runs. Executors MUST consume the persisted deadline without re-evaluating the timeout expression.
- Scheduler-backed Agent execution MUST pass the persisted deadline's remaining budget to `@acpus/agent-executor` as numeric `timeoutMs`; it MUST NOT reconstruct an authored duration string.
- Agent execution MUST reject a malformed or non-canonical persisted deadline before invoking `@acpus/agent-executor`; durable-state corruption MUST NOT be reclassified as an executor configuration failure.
- Task process timeout enforcement MUST preserve representable deadlines beyond Node's single-timer limit without allowing native timer overflow to trigger an early timeout. It MUST recompute the remaining budget after executor setup immediately before invoking the process runner, count synchronous process startup against that remaining budget, reject malformed persisted deadlines, and recheck monotonic elapsed time before accepting process settlement, Task results, or artifact registration. Abort and an exhausted deadline MUST remain authoritative over a synchronous startup failure.
- Chunked runtime timeout scheduling MUST measure elapsed time with a monotonic clock and MUST NOT extend a timeout when the wall clock moves backward.
- Signal timeout, prompt, and timeout-message expressions MUST resolve once when the instance enters awaiting state. The deadline, rendered prompt, and rendered timeout message MUST be persisted in signal wait projection state.
- Agent response-repair max and Task default command timeout MUST resolve once in attempt scope and MUST be recorded in attempt execution metadata.
- A runtime configuration resolution failure MUST fail its owning frame or attempt with `expression_resolution_failed` and a payload that preserves the evaluation/type/constraint error tag.
- An explicit Agent `sessionKey` that resolves to an empty or whitespace-only string MUST fail its attempt as an `expression_resolution_failed` constraint error.
- A Task executor that observes an already-expired persisted attempt deadline MUST commit `attempt.timed_out`, not a generic failed attempt.
- In-flight task and agent timeout enforcement MAY occur inside the executor attempt, while stale or recovered attempts MUST be derivable from scheduler deadlines.
- Task artifact APIs MUST write run-local artifact files from the Task process while the runtime parent remains the sole owner of SQLite artifact registration.
- Attempt-local output directories, work directories, and task artifacts MUST use dynamic `nodeKey` and attempt-specific subpaths for scheduler-backed task execution.
- Task artifact writes after task timeout MUST be rejected and MUST NOT create artifact registry rows.
- Signal execution that cannot complete immediately MUST leave the durable run in a resumable awaiting state.
- Signal timeout expiration MUST mark the signal wait timed out, fail the signal
  node instance with `signal_timeout`, and fail running ancestor group members so
  composite completion can proceed.
- Pausing a run MUST pause open signal timeout clocks and resuming that run MUST
  restore their remaining timeout budgets as new deadlines.
- If a paused signal's remaining timeout cannot form a supported persisted deadline, resume MUST return a tagged `deadline-out-of-range` store error and MUST NOT append resume events or mutate projection state.
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
  including `policy`, `options`, and raw IR `kind`.
- Agent overrides MUST preserve top-level Agent definition `cwd` and `env`
  string values as declaration-time plain values.
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
- Runtime MUST persist backend Agent failures as structured provider errors
  with stable `code`, actionable `message`, and the normalized upstream acpx
  cause. Scheduler status reasons MUST contain the stable code rather than a
  concatenated `code: message` string.
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
  by `@acpus/agent-executor` without embedding full prompt or response text.
  Turn metadata MUST retain references to the independent prompt and response
  artifacts when those artifacts are present.
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
  present. Turn metadata MUST NOT embed full prompt/response IO or full tool
  parameter previews because dedicated prompt, response, and telemetry
  artifacts hold those details.

### Controls, Daemon, Fork, And Signal

- Pause MUST record a durable pause gate and MUST prevent new scheduler-visible attempts from starting while paused.
- Pause on an already paused run MUST succeed without writing duplicate control
  events.
- Pause control intents and `control.paused` events MUST NOT carry an operator
  reason. Attempt cancellation and eligible-work requeue events MUST retain the
  semantic reason `paused`.
- Runtime control intents MUST use the known discriminated control types
  `pause`, `resume`, `retry`, `fork`, `signal`, and `cancel`, not an open control
  type string.
- Daemon control intent variants MUST use closed shapes: pause and resume carry
  `requestId`, `type`, and `runId`; retry and cancel additionally MAY carry a
  non-empty `target`; fork additionally MAY carry `target`, replacement
  `prepared` workflow, `input`, `agentOverrides`, and `unsafeReuse`; signal
  additionally MUST carry `nodeId` and `payload`.
- The runtime daemon MUST expose a small local request/response interface:
  `admitRun(prepared, input, agentOverrides?)`, `control(intent)`, `shutdown()`,
  and `status()`.
- Runtime control requests from clients MUST route through the local daemon and
  daemon-hosted per-run execution sessions; clients MUST NOT apply scheduler
  controls directly through SQLite or become scheduler run owners.
- Daemon responses MUST use exactly one of the closed envelopes
  `{ ok: true, result }` or `{ ok: false, error: { code, message } }`. Admission
  success MUST return `RunDetails`; control success MUST return
  `{ run, forkRunId? }`; shutdown success MUST return
  `{ status: "shutdown" }`; and status success MUST return daemon pid, lease
  generation, protocol version, and package version.
- Every daemon request shape and each status, shutdown, and control result shape
  MUST accept only its declared fields. Requests received before the daemon has
  claimed its lease generation MUST fail with `EXECUTION_UNAVAILABLE`.
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
- Any valid daemon response envelope from the bound endpoint, including an
  `EXECUTION_UNAVAILABLE` response before lease initialization completes, MUST
  prove that the endpoint is live and MUST prevent stale socket removal.
- Public daemon error codes MUST be limited to `INVALID_REQUEST`,
  `RUN_NOT_FOUND`, `RUN_NOT_CONTROLLABLE`, `CONTROL_CONFLICT`,
  `EXECUTION_UNAVAILABLE`, `STORE_BUSY`, `STORE_ERROR`, and `INTERNAL_ERROR`.
- Daemon public responses MUST NOT expose scheduler/store internals such as
  `lease_lost`, owner epoch mismatch, SQLite constraint names, or projection
  internals as API contract values.
- Daemon failure messages MUST preserve actionable request, target, schema,
  ambiguity, and control-conflict diagnostics, but MUST replace owner epoch,
  lease, SQLite, projection, and invariant details with stable public text.
- The daemon MUST host one execution session per active or recoverable run.
- Different run sessions MAY progress concurrently.
- Within one run session, durable scheduler writes MUST be serialized per run,
  but long task or agent executor waits MUST NOT block control requests from
  entering the same run session.
- A committed event matched by a hook MUST be claimed at most once per daemon
  run session across interleaved executor advancement and control handling, so
  those paths cannot repeat the same external hook side effect.
- `cancel` and `pause` MUST reach a live session promptly, persist the durable
  fenced scheduler effect, and directly abort active attempt controllers before
  returning a successful response.
- Pause and run-level cancel MUST abort every active attempt controller in the
  run session. Targeted cancel MUST abort only active attempts in the selected
  durable subtree and MUST NOT abort unrelated active attempts.
- Late executor results MUST be fenced by attempt identity, owner epoch, and/or
  current projection state so they cannot overwrite committed cancel, pause,
  resume, retry, signal, or fork state changes.
- Pause MUST best-effort cancel started scheduler-visible attempts and requeue eligible dynamic work for a later resume.
- Pausing an active scheduler-backed agent turn MUST abort the executor signal
  and MUST preserve available prompt, response, stderr, telemetry artifacts,
  and cancelled turn metadata.
- Resume MUST clear the durable pause gate and re-drive eligible scheduler work.
- Resume on an already resumed run MUST succeed without writing
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
- An omitted retry target MUST select run-level retry. An explicit target,
  including the legal static node id `root`, MUST use normal targeted alias/key
  resolution rather than the run-level sentinel.
- Node retry from a failed run MUST reopen only the failed node's scheduler
  execution chain instead of resetting the whole run projection.
- Cancel MUST target a scheduler run, a non-terminal dynamic leaf `nodeKey`, a
  non-terminal dynamic composite/control `frameKey`, or a static node alias only
  when that alias resolves to exactly one non-terminal dynamic cancel target.
- An omitted cancel target MUST select run-level cancel. An explicit target,
  including the legal static node id `root`, MUST use normal targeted alias/key
  resolution.
- Run-level cancel MUST terminalize the run as `canceled`.
- Cancel on an already canceled run MUST succeed without writing
  duplicate cancel events.
- Targeted cancel MUST terminalize the selected scheduler subtree with reason
  `operator_cancelled` and MUST NOT reset unrelated runnable work.
- Fork MUST create a new run from frozen source run data without reading live workflow source.
- Fork MUST derive or record stable fork identity at the scheduler commit layer
  so repeated fork requests return the same fork run id instead of creating
  multiple fork runs.
- Fork MAY freeze a replacement prepared workflow and/or input override for the new run.
- A replacement prepared workflow MUST pass the same durable prepared-workflow and lock consistency validation as new-run admission before the fork is created.
- Fork control payloads MAY include a non-empty `target` string. Supplying a
  target MUST select targeted replacement fork semantics, while omitting target
  in targeted replacement fork mode MUST mean the workflow root completion target.
- Fork control payloads MAY include `unsafeReuse: true`. Supplying
  `unsafeReuse` MUST select targeted replacement fork semantics and instruct
  seed planning to reuse scheduler-accepted completed facts without enforcing
  source/replacement semantic signature or changed-input safety checks.
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
  idempotently, and continue execution from persisted scheduler state and
  verified run-local frozen workflow files.
- Signal controls MUST use signal name plus waiting instance identity to consume
  the intended wait exactly once.
- Consumed-signal scheduler events and projections MUST retain the normalized
  payload and command idempotency key. Repeated consumption with the same
  normalized payload MUST be a no-op, while a different payload MUST fail.
  Normalized `signal_waits` rows MUST persist payload JSON without duplicating a
  payload digest or command idempotency key; replayed scheduler events remain
  the source of truth for the latter.
- Signal targeting MUST accept a dynamic `nodeKey` directly or a static signal alias only when that alias resolves to exactly one open signal wait.
- The daemon MUST recover the targeted run session for `resume` and `signal`,
  apply the requested effect, and continue execution if runnable work is
  unlocked.
- `shutdown()` MUST be daemon service lifecycle, not run control.
- `shutdown()` MUST return `{ status: "shutdown" }` and stop the daemon only
  when there are no active run execution sessions.
- `shutdown()` with active sessions MUST fail with `CONTROL_CONFLICT`.
- Runtime MUST NOT provide force shutdown in the daemon control model.
- Daemon shutdown and idle-stop MUST NOT cancel, pause, fail, or otherwise
  mutate runs.
- Daemon host teardown with active execution MUST release run ownership before
  aborting local executors, MUST fence their late results from durable commit,
  and MUST bound the wait before releasing daemon resources.

### Read APIs And Daemon

- `listRuns`, `getRun`, and visualization overlay APIs MUST read SQLite projections rather than live workflow source.
- `listRuns` MUST order runs by `updatedAt DESC` with `createdAt DESC` as a
  deterministic tie-breaker.
- `getRun` MUST omit `dynamic` when frames, node instances, attempts, groups,
  group members, signal waits, execution metadata, and progress are all absent.
  When any of those collections is non-empty, it MUST expose dynamic scheduler
  details including version and effective quorum/concurrency values.
- SQLite read failures, malformed scheduler envelopes, JSON decode failures,
  and projection invariant failures MUST fail the run-detail read operation and
  MUST NOT be represented by omitting `dynamic`.
- Dynamic frame and node-instance read rows MUST include structured
  `instancePath` data when present.
- Dynamic group-member read rows MUST include `childFrameKey` when the member
  owns a child branch or fanout-item frame.
- Dynamic group-member read rows MUST preserve the branch/fanout identity shape of the scheduler projection.
- `getRun` MUST expose runtime execution metadata rows, including agent attempt
  turn metadata, when such rows exist for a run.
- The runtime MUST provide a visualization overlay helper that shows authored `ExprIR` in static detail and combines it with persisted effective group, signal, and attempt values in runtime detail without adding layout-specific state.
- Agent and Task hook contexts MUST read rendered prompt and Task input from persisted attempt execution metadata and MUST NOT re-evaluate authored expressions. Signal-awaiting hook contexts MUST read the persisted rendered prompt from the signal event or projection.
- Fork semantic signatures MUST include complete runtime configuration `ExprIR` so changing a configuration expression invalidates safe reuse.
- Read-only inspection MUST NOT create runtime state when no runtime store exists.
- `followRunInspection(cwd, query)` MUST expose an async iterable of typed
  inspection results and MUST remain a read-only store observer. It MUST NOT
  start or wake the daemon, acquire run ownership, or mutate scheduler state.
- Follow MUST begin with a compact snapshot and MUST convert every durable
  scheduler event after the snapshot cursor into ordered semantic changes.
  Multiple transitions between polling intervals and repeated statuses from a
  new attempt MUST remain observable in event-sequence order.
- Follow MUST use progress version independently from scheduler event sequence
  for latest-state agent telemetry and MUST suppress emissions for clock-only
  or unchanged projection data.
- Follow progress comparison MUST be per Agent. An Agent MUST emit immediately
  for its first state and for attempt, turn, recent-tool command/status,
  stop-reason, or failure changes. Context- or token-only changes MUST expose
  the newest absolute counters at most once per Agent per ten seconds, and a
  last-activity timestamp change by itself MUST NOT emit a runtime update.
- Follow updates MUST carry ordered semantic changes plus one sparse projection
  patch containing item upserts/removals and changed counts, actions, omitted
  summary, or hooks. Changes MUST reference patched items by stable item key
  instead of duplicating complete items.
- A sparse projection patch MUST include `itemOrder` only when structural
  insertion or removal changes deterministic authored-tree order. Applying the
  patch and optional order MUST reproduce the current projected item array
  without requiring a resynchronization snapshot.
- Durable transition status MUST be derived from the transition event rather
  than the latest projection, so multiple transitions within one polling
  interval retain their intermediate statuses.
- A follow read interval MUST obtain the current run projection, artifact
  registry, event cursor, and events after the previous cursor from one
  consistent SQLite read transaction. The emitted cursor MUST NOT advance past
  an event excluded from that read.
- Each follow interval MUST reconcile semantic changes against a current full
  inspection projection. Cursor gaps or projection mismatch MUST emit a
  resynchronization snapshot rather than silently continuing from inconsistent
  state.
- Ordinary overview, all, or target changes MUST use sparse updates and MUST
  NOT cause resynchronization. In particular, target follow MUST NOT repeatedly
  resend complete attempt, frame, progress, execution-metadata, or artifact
  collections.
- Follow MUST continue across paused, awaiting, inactive, and stale states and
  terminate only when the run becomes terminal, the caller aborts observation,
  or a tagged inspection error occurs.
- Follow terminal emission MUST carry the complete recorded workflow output
  exactly once. A terminal run observed initially MUST still produce one
  snapshot followed by one terminal emission.
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
- The runtime store MUST support SQLite-backed daemon leases with generation
  fencing, heartbeat updates, pid metadata, idle metadata, protocol/runtime
  metadata, and release by current generation only.
- The daemon MUST heartbeat under its current lease generation independently of
  long task or agent execution.
- The daemon MUST persist its current idle-since timestamp and configured idle
  window while it is leased.
- The daemon MUST release its lease and exit after a continuous 30,000
  millisecond idle window with no active run sessions and no admitted
  non-terminal run that is currently runnable or otherwise continuable locally.
- Paused runs and signal waits without timeout MUST NOT keep the daemon resident
  solely because future input may resume them.
- Signal waits with timeout deadlines MUST keep the daemon resident until the
  deadline is reached and the timeout is durably settled.
- Daemon startup MAY recover admitted non-terminal runs that are currently
  runnable or otherwise continuable.
- Daemon startup MUST NOT become a whole-store repair sweep.
- Admitted runs MUST be handed to a daemon execution session, and controls MUST
  recover a targeted session even when the run is paused, waiting for signal,
  or otherwise not currently runnable.
- Read-only APIs such as `listRuns`, `getRun`, visualization overlay, and health
  inspection MUST NOT start or wake the daemon.
- The daemon MUST advance runnable pending scheduler-backed runs from persisted
  scheduler state and verified run-local frozen `WorkflowIR` without reading
  live workflow source.
- Daemon loop store-busy failures MAY be retried. A non-busy heartbeat or work
  tick failure, including durable deadline corruption, MUST close the daemon
  instead of being retried indefinitely while the daemon continues reporting
  healthy.
- Daemon shutdown MUST retain and await the active work tick even when another
  interval fires, MUST close the store even if lease release fails, and MUST
  complete its automatic shutdown notification without an unhandled rejection.

## Verification

- Tests MUST cover prepared workflow admission, persisted run-local frozen IR and lock paths, exact file digests, source graph digest, event count, node count, and scheduler-backed public projection bridging.
- Tests MUST cover identical prepared-workflow consistency rejection for new-run and replacement-fork admission, including daemon `INVALID_REQUEST` mapping without a fork row.
- Tests MUST cover fresh current-schema initialization, idempotent writable reopen, and non-mutating read-only open.
- Fresh-schema tests MUST assert the exact current node-attempt and signal-wait projection schemas.
- Tests MUST cover missing frozen files, path-containment failures, and IR and lock digest mismatches.
- Tests MUST cover submit-time agent overrides, fork-time override inheritance
  and replacement, and invalid override rejection.
- Tests MUST cover workflow input and signal payload normalization.
- Tests MUST cover read-only list/show/status APIs without live source reads or state creation for missing stores.
- Tests MUST cover scheduler execution of supported assert, if, switch, parallel, fanout, loop, dynamic identity, durable branch decisions, group completion, cancellation, retry, and timeout transitions.
- Tests MUST cover expression evaluation, duration range and deadline representability, template rendering, operator errors, and boolean operand failures.
- Tests MUST cover malformed persisted attempt and signal deadlines in durable events and projection rows, including daemon due-work selection rejecting corrupted signal deadlines, the daemon closing on that permanent tick failure while retrying transient store-busy failures, active-tick shutdown waiting, and teardown completion after lease-release failure.
- Tests MUST cover persisted Agent deadlines becoming remaining numeric millisecond budgets, malformed Agent deadlines not invoking the executor, distant Task deadlines not overflowing native timers, setup-expired and malformed Task deadlines not starting a runner, synchronous Task startup accounting, deadline-first child result/artifact/error arbitration, and chunked timeout behavior under delayed callbacks and backward wall-clock changes.
- Tests MUST cover atomic rejection when a paused Signal timeout cannot be restored within the persisted deadline range.
- Tests MUST cover isolated Task process execution, inline embedded-source loading, live reusable module loading, package reusable task loading, explicit TypeScript loader ownership, transparent cwd/env behavior, concurrent attempt isolation, attempt-local module caching, abnormal process exit, missing cwd, absence of scheduler-level automatic leaf retry, timeout deadlines, pre-spawn deadline exhaustion without Task startup, task abort signal propagation, artifact writes, attempt-local artifact paths, and timeout artifact rejection.
- Tests MUST cover acpx-backed agent turn integration, named and command agent
  mapping, absence of provider-command env mapping consultation, durable agent
  output conformance, empty-response repair, scheduler runtime identity
  environment, explicit session identity, schema-backed response repair inside
  one scheduler-visible attempt, manual control-plane retry continuation,
  pause/resume continuation, and separation between scheduler-visible attempts
  and agent response repair turns.
- Tests MUST cover scheduler-backed agent turn prompt, response, stderr, and
  telemetry artifacts, including normalized context, token, and tool telemetry,
  absence of duplicated prompt/response text in telemetry, prompt/response
  artifact references, plus `getRun` execution metadata that exposes turn
  history, session context, and compact telemetry summaries.
- Tests MUST cover the `ACPUS_AGENT_RAW_ACP_DEBUG=1` diagnostic switch and the
  default absence of raw ACP debug artifacts.
- Tests MUST cover raw parsed schema-backed agent output artifacts and prove
  they remain diagnostic rather than workflow-visible output.
- Tests MUST cover pause, resume, run retry, dynamic node retry, cancel, signal targeting and idempotency, fork, targeted fork seed planning, unsafe targeted fork reuse, targeted fork missing/dynamic targets, static composite target subtree boundaries, direct daemon control application, and fork artifact reachability.
- Tests MUST cover missing-store and missing-run deletion as no-ops and active-run deletion as the only exceptional delete case.
- Tests MUST cover run-scoped same-control scheduler intent replay,
  cross-control idempotency-key conflicts, and atomic intent recording for
  successful no-op controls. Retry and cancel tests MUST replay a static target
  alias after its resolved dynamic instance changes state without appending a
  second control event, and MUST distinguish an omitted run target from an
  explicit static node alias named `root`.
- Tests MUST cover daemon socket single-instance binding, stale socket handling,
  preservation of a live pre-lease endpoint, daemon lease metadata, heartbeat
  fencing, heartbeat during long execution, release fencing, idle-stop, and
  shutdown.
- Tests MUST cover daemon-hosted run execution session control responsiveness
  while executor work is in flight, active attempt abort, pre-spawn Task
  cancellation with ordered start-then-abort delivery and already-aborted Task
  cleanup, targeted active-attempt isolation, per-run durable write
  serialization, exact-once hook dispatch across interleaved drive and control,
  late executor result fencing, and daemon session teardown.
- Tests MUST cover mapping scheduler/store failures such as lease loss, owner
  epoch mismatch, SQLite constraint failures, and projection inconsistencies to
  stable public daemon error codes and sanitized messages without exposing
  internal details.
- Tests MUST cover read-only inspect stale execution classification without
  daemon startup or store mutation.
- Tests MUST cover compact nested inspection projection, deterministic
  fanout/loop identity, progressive folding and its 20-context bound, all-mode
  expansion, target resolution, and raw detail preservation.
- Tests MUST cover inspection omitting default node IO and raw scheduler tables,
  while preserving complete terminal workflow output and exact omitted counts.
- Tests MUST cover follow event fidelity for rapid transitions and retry,
  progress-only changes including budget-omitted Agents, unchanged and
  clock/liveness-only polling suppression, cursor-gap resync, transactionally
  consistent reads during concurrent commits, terminal output exactly once,
  caller detach, and read-only operation without daemon startup or store
  mutation.
