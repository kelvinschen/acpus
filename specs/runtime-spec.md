# Runtime Spec

## Purpose

`@acpus/runtime` owns workspace-local durable runs, frozen workflow execution, controls, inspection, and the local daemon. Prepared workflow data comes from the [Workflow Compiler](workflow-compiler-spec.md); IR/value semantics come from [Core](core-spec.md) and [Expression](expression-spec.md); authoring modules load through the [Loader](loader-spec.md); Agent turns delegate to the [Agent Executor](agent-executor-spec.md); side-effect observation delegates to [Runtime Hooks](hooks-spec.md).

## Requirements

### Admission And Store

- The runtime MUST store workspace state in `.acpus/.local/state/runtime.db`, initialize the complete current schema on first writable open, preserve current rows on reopen, and leave read-only opens unchanged.
- Runtime-generated run ids MUST combine local `YYYYMMDDHHmmss` time with 20 uppercase hexadecimal random characters.
- Admission MUST accept normalized input and compiler-prepared workflow data containing frozen IR JSON, deterministic lock metadata, and source graph digest.
- New-run and replacement-fork admission MUST validate the closed preparation-lock shape, canonical frozen IR, matching digests, workspace-relative entry, and `sha256([sourceDigest, packageLockDigest ?? ""].join("\n"))` source-graph digest before mutation; daemon failures use `INVALID_REQUEST`.
- Admission MUST persist exact `workflow.ir.json` and `lock.json` bytes beneath `.acpus/.local/runs/<run-id>/`, with run-relative file coordinates and `sha256:<hex>` byte digests.
- Frozen files MUST be regular non-symlinks contained by the run directory and verified before use; missing, escaping, or mismatched files fail visibly rather than appearing absent.
- Admission MUST atomically persist `run.admitted`, run/public node projections, scheduler bootstrap state, and separately stored Agent overrides before daemon-owned advancement.
- Execution MUST use frozen IR instead of live workflow source and never copy reusable task source or dependencies into the run directory.
- Completed runs MUST persist normalized root output and `run.completed`; runtime failures after admission persist failed state and `run.failed`.
- `deleteRun` MUST return `undefined` for an absent store/run and reject only deletion of an active run.

### Values, Deadlines, And Scheduler

- `normalizeWorkflowInput` MUST validate against `WorkflowIR.inputSchema`; Signal control accepts raw strings without a schema and normalized schema-backed payloads otherwise, with invalid values rejected before mutation.
- Runtime expressions MUST adapt the canonical [Expression evaluator](expression-spec.md) to durable `input`, `workflow.input`, `nodes`, `meta`, `fanout`, and `loop` scope.
- Ref resolution MUST use own properties and canonical non-negative array indexes; runtime `meta` exposes run id, relative workflow path, workflow name, and absolute workspace directory.
- Configuration resolution MUST return tagged Result errors that distinguish evaluation, type, and field-constraint failures while keeping Result objects out of durable/public data.
- Duration resolution MUST use Core syntax/range rules and canonical four-digit-year ISO deadlines; malformed or unrepresentable persisted deadlines fail before lexical comparison or executor invocation.
- Concurrency resolution MUST treat missing/zero Parallel or Fanout caps as unbounded locally, accept positive integers, and require positive quorum counts.
- The scheduler MUST use durable scheduler events as decision facts and atomically fence ownership/version, append events, update derived projections, and publish public state.
- Scheduler recovery MUST produce the same state from persisted facts, reject corrupt/ahead checkpoints, and keep projection drift from changing decisions; checkpoint/cache/write strategy remains internal.
- Recoverable store operations MUST return tagged `SchedulerStoreError` results; invariant or store failures may throw from `advanceRun(input): Promise<AdvanceRunSummary>`.
- The daemon MUST capture `ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY` at startup, default it to 32, and reject non-canonical positive safe integers before creating store or socket state.
- Effective leaf concurrency MUST be the minimum daemon ceiling and applicable durable group caps; the host ceiling is neither frozen into IR nor persisted as a scheduler fact.
- Scheduler intent keys MUST be run-scoped and replay only the same control identity; successful no-op controls record identity atomically, while conflicting reuse returns `idempotency-conflict`.
- Dynamic execution MUST use a recursive frame model, frozen static `nodeId`, derived `nodeKey`, structured instance paths, owner epochs, attempts, groups, members, and Signal waits.
- Public status MUST distinguish `pending` admission from `running` materialization and preserve terminal/awaiting/paused states from durable projection.
- Composite execution MUST implement the following frozen-IR semantics.

| Node | Durable behavior |
| --- | --- |
| `assert` | Continue on true; fail on false. |
| `if` / `switch` | Persist the selected branch; switch identities are `case:<index>` or `default`. |
| `parallel all` | Return keyed branch outputs and fail-fast cancel remaining work. |
| `parallel race` | Return `{ winner, result }` for the first success and cancel remaining work. |
| `fanout all` | Preserve duplicate occurrences and return outputs in ascending zero-based `itemIndex`; empty input returns `[]`. |
| `fanout quorum` | Accept outputs in completion order and cancel remaining work after quorum. |
| `loop` | Execute do-while transitions `{ state, stop }`; expose zero-based `index`, one-based `round`, and final state. |

- Group concurrency/quorum MUST resolve once at materialization and persist the effective policy needed for deterministic recovery.
- Scope completion MUST expose only its normalized `output: ExprIR` result to its parent; arbitrary WorkflowData values remain valid outputs.

### Task, Signal, And Artifact Execution

- Task runs MUST execute the frozen inline or reusable target; reusable module resolution delegates to the [Loader](loader-spec.md) from the recorded workflow referrer.
- Every Task attempt MUST use a fresh Node process; module caching is attempt-local and separate tasks/retries share no module globals.
- Task cwd MUST default to workspace, resolve relative values from workspace, and be observed by process code, filesystem access, module initialization, and the default command wrapper without changing module resolution.
- Task environment MUST start from host environment plus evaluated overrides and remain live for process code, task context, modules, and later command invocations.
- Task input/cwd/env and default command timeout MUST resolve once before invocation and be recorded as effective attempt metadata where applicable.
- Runtime output normalization MUST treat Task top-level `undefined` as no output, reject scope/array `undefined`, omit undefined object properties, and reject non-WorkflowData values without adding business schemas.
- Attempt deadlines MUST be persisted once; Task and Agent executors consume remaining budgets without re-evaluating authored timeout expressions.
- Timeout and cancellation MUST remain authoritative across startup/result races, reject late output/artifacts, propagate Task `abortSignal`, and terminate the isolated process tree after bounded cooperative cleanup.
- Artifact writes MUST use attempt-local run paths while the runtime parent exclusively registers SQLite records and rejects registration after timeout/cancellation.
- ArtifactRef resolution MUST verify current-run canonical regular files, reject malformed/cross-run/escaping/symlink refs, and pass only bound absolute paths to Task code.
- Signal prompt, timeout message, and deadline MUST resolve once on awaiting entry; the persisted wait resumes durably from normalized input or fails ancestors with `signal_timeout` on expiry.
- Pause/resume MUST suspend and restore Signal timeout budgets atomically; an unrepresentable restored deadline returns `deadline-out-of-range` without state change.

### Agents

- Agent execution MUST render frozen prompt, cwd, env, permission, session, model, and mode values, resolving a directly interpolated ArtifactRef to its verified absolute path.
- Runtime MUST call the [Agent Executor](agent-executor-spec.md) for normalized acpx execution/progress and never parse raw ACP JSON for decisions, summaries, or progress.
- Runtime MUST translate each effective named or command Agent definition into the corresponding [Agent Executor](agent-executor-spec.md) request variant; absent permission defaults to `approve-all`.
- Overrides MUST allow only `use`, `command`, `model`, `permissionMode`, `agentMode`, `cwd`, and `env`; identity replacement clears inherited model/mode, preserves permission, and never accepts `trace`.
- Session identity MUST be run-local and deterministic from explicit non-empty `sessionKey` or dynamic `nodeKey`; repair/retry/resume turns reuse it according to continuation policy.
- Schema-less Agents MUST return raw text with zero response repairs; schema-backed Agents append schema instructions, recover one JSON value, accept extra keys for conformance, and project stored output to the declared shape.
- The daemon MUST capture `ACPUS_AGENT_RESPONSE_REPAIR_MAX` at startup, default additional repair turns to two, accept canonical non-negative safe integers, and expose invalid configuration as `invalid_agent_response_repair_max` before provider invocation.
- Response repair MUST remain inside one scheduler-visible attempt, reuse the acpx session, avoid mode reapplication, and never process backend failures as conformance failures.
- Each scheduler-backed turn MUST register `artifacts/<nodeKey>/attempt-<n>/agent/turn-<NNN>.json` containing schema version, identities, exact prompt/response, normalized summary/timing, status, and structured terminal detail.
- Turn metadata MUST reference the canonical artifact and compact summary without embedding prompt, response, timing, complete tools, or filesystem paths; non-empty stderr uses a separate artifact.
- `ACPUS_AGENT_RAW_ACP_DEBUG=1` MUST be captured at daemon startup and optionally persist exact wire output without affecting execution or repair.
- Top-level Agent `trace: true` MUST request one normalized trace artifact per turn; trace persistence is best effort, schema-versioned, ordered, excludes prompt/control frames, and reports capture failure without changing the turn outcome.
- Node progress MUST remain latest-state observation outside scheduler decisions, clear on new attempts, use typed bounded channels, and advance an independent progress version.

### Controls And Daemon

- Runtime control intents MUST use closed `pause`, `resume`, `retry`, `cancel`, `fork`, and `signal` variants with run-scoped request identity.
- The daemon MUST expose `admitRun(prepared, input, agentOverrides?)`, `control(intent)`, `shutdown()`, and `status()` over a workspace-derived Unix socket or equivalent named pipe, never an HTTP port.
- Requests and responses MUST use closed JSON shapes; responses are `{ ok: true, result }` or `{ ok: false, error: { code, message } }`.
- Public errors MUST use only `INVALID_REQUEST`, `RUN_NOT_FOUND`, `RUN_NOT_CONTROLLABLE`, `CONTROL_CONFLICT`, `EXECUTION_UNAVAILABLE`, `STORE_BUSY`, `STORE_ERROR`, and `INTERNAL_ERROR`, with actionable text but no lease/SQLite/projection internals.
- Socket binding MUST arbitrate one daemon per workspace; a valid response proves liveness, while stale removal requires local evidence of a dead/expired owner.
- The daemon MUST host one serialized-write execution session per active/recoverable run, permit different runs concurrently, and keep long executor waits from blocking controls.
- Pause/cancel MUST durably fence their effect and abort only applicable active attempt controllers; late executor results cannot overwrite control state.
- Pause and resume MUST be idempotent, with pause requeueing eligible canceled work and resume clearing the durable gate.
- Retry MUST support run-level reset or an unambiguous failed `nodeKey`, `frameKey`, or static alias; omitted target is run-level while explicit `root` remains a normal alias.
- Cancel MUST support run-level or unambiguous non-terminal dynamic/static targeting; run cancel yields `canceled`, targeted cancel yields `operator_cancelled`, and repeated run cancel is idempotent.
- Fork MUST create an idempotently identified child from verified frozen source data, optionally replacing prepared workflow, input, Agent overrides, or target without reading live source.
- Run reads and inspection MUST project the child's direct fork source, requested target, and unsafe-reuse flag from the durable `run.forked` event without deriving recursive ancestry.
- Safe targeted fork MUST reuse only compatible completed prerequisite facts/artifacts, preserve target closure, avoid inherited attempt events/active state, and reject missing, ambiguous, or impossible replacement targets before admission.
- Changed input MUST disable completed-output reuse; explicit `unsafeReuse` permits it across input/signature changes while retaining target, materialization, artifact, and completed-only safety boundaries.
- Race/quorum fork reuse MUST preserve only scheduler-accepted winners/members when replacement order/identity is compatible; otherwise eligible prerequisite work executes normally.
- Signal control MUST target one open dynamic wait (directly or by unambiguous static alias), normalize payload, consume idempotently, and resume the recovered session from persisted state.
- `shutdown()` MUST stop only without active sessions, otherwise return `CONTROL_CONFLICT`; shutdown/idle-stop never mutates runs and no force-shutdown control exists.

### Read APIs And Daemon Lifecycle

- `listRuns`, `getRun`, inspection, health, and visualization overlays MUST read durable projections/frozen IR without live workflow source or daemon startup.
- `listRuns` MUST order by `updatedAt DESC, createdAt DESC`; `getRun` omits `dynamic` only when every dynamic collection is empty and fails visibly on decode/invariant errors.
- `getRunInspection(cwd, query)` MUST return tagged `ResultAsync` results in the following modes.

| Mode | Projection |
| --- | --- |
| overview | Versioned bounded authored tree, exact status counts, cursors, sparse items, actions, omitted counts, terminal output. |
| all | Every normalized dynamic context without exposing raw tables. |
| target | Static aggregate or exact node/frame/attempt context with history, progress, Signal, execution metadata, and artifact references. |
| raw | Unbounded run details, complete frozen `WorkflowIR`, and artifact registry. |

- Overview MUST count every dynamic leaf context, represent an unmaterialized authored leaf once, exclude grouping rows, and bound expanded dynamic contexts to 20.
- Inspection run summaries MUST expose `agentUsage` for workflows containing Agent nodes, including zero values before materialization; instances count materialized Agent nodes, attempts count all scheduler attempts for those nodes, and turns use durable attempt metadata supplemented by newer active progress without double counting.
- A static target matching multiple dynamic contexts MUST expose aggregate status and exact status counts while omitting instance-specific input, output, failure, keys, prompt, attempt, Agent, and Signal detail; a single matching context retains its detailed projection and zero matches remain `not_started`.
- Public artifacts MUST expose absolute `path` only and never read bodies; `listArtifacts` returns `[]` for an empty existing run and `undefined` for a missing run/store.
- Runtime target inspection MUST represent a persisted canonical turn prompt as an artifact descriptor with `field: "prompt"` and MUST NOT embed the prompt body.
- Repeated composite inspection MUST associate group membership by dynamic `nodeKey` and MUST NOT reuse a group matched only by static `nodeId`.
- Compact Agent inspection MUST use the authored Agent key, typed effective backend/counters/activity, explicit context/token availability, and at most three bounded normalized tool commands without command text or payloads.
- Compact Agent turn count MUST use the greatest value from persisted attempt metadata and live progress so polling cannot regress.
- Compact Signal inspection MUST bound prompt/schema summaries, preserve complete target/raw values, and expose inspect/retry/fork rather than signal actions after `signal_timeout`.
- Failure inspection MUST preserve stable origin/code and bounded upstream acpx/RPC cause without raw ACP lines or broad text-prefix reclassification.
- `followRunInspection` MUST be a read-only async iterable beginning with a compact snapshot, preserving every durable transition in order, and terminating only on terminal state, caller abort, or tagged error.
- Follow updates MUST use independent event/progress cursors and sparse keyed patches, resynchronize on cursor/projection gaps, suppress unchanged/clock-only observations, and emit terminal output exactly once.
- Agent follow MUST emit meaningful attempt/turn/tool/status/failure changes immediately and coalesce counter-only changes to at most once per Agent per ten seconds.
- Read-only liveness MUST derive `active`, `inactive`, `stale`, `terminal`, or `unknown` from durable state plus local daemon/lease evidence without persisting that classification or performing recovery.
- Daemon lifecycle MUST heartbeat every 1s, use a 5s observational stale threshold distinct from the 30s run-lease window, and idle-stop after 30s without active or locally continuable work.
- Paused runs and untimed Signal waits MUST not keep the daemon resident; timed waits do until durably settled, and startup recovery is targeted rather than a whole-store repair sweep.
## Verification

- Cover schema initialization, frozen-file integrity, prepared-workflow consistency, atomic admission, normalization, and mutation-free rejection.
- Prove deterministic scheduler recovery and every node/composite strategy, identity, resource, deadline, cancellation, retry, and projection rule.
- Exercise isolated Tasks, reusable loading, artifacts, Agents, response repair, progress, canonical turn records, and optional captures.
- Cover control idempotency/targeting, fork safety, daemon fencing, sessions, socket ownership, heartbeat, idle-stop, and public error sanitization.
- Verify inspection modes, artifacts, follow fidelity/resync, liveness, terminal output once, and read-only operation without daemon startup.
