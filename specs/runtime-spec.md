# Runtime Spec

## Purpose

`@acpus/runtime` owns workspace-scoped durable runs in private user-level shards, frozen workflow execution, controls, inspection, pruning, and the local daemon. Prepared workflow data comes from the [Workflow Compiler](workflow-compiler-spec.md); IR/value semantics come from [Core](core-spec.md) and [Expression](expression-spec.md); authoring modules load through the [Loader](loader-spec.md); Agent turns delegate to the [Agent Executor](agent-executor-spec.md); side-effect observation delegates to [Runtime Hooks](hooks-spec.md).

## Requirements

### Workspace Shards, Admission, And Store

- Runtime MUST canonicalize the workspace through its real path before deriving runtime storage.
- Runtime MUST resolve the Acpus home as `.acpus` beneath the running user's operating-system home directory without an environment-variable override.
- A workspace key MUST be the first 32 lowercase hexadecimal characters of `sha256("acpus-workspace-v1\0" + platform + "\0" + canonicalRealpath)`.
- Runtime MUST store a workspace shard at `$HOME/.acpus/workspaces/<workspace-key>/`.
- Runtime MUST NOT create, read, migrate, or delete workspace-local `.acpus/.local` runtime state.
- The active shard MUST use the following closed layout.

| Coordinate | Shard-relative path |
| --- | --- |
| Manifest | `workspace.json` |
| Daemon socket when the platform path fits | `daemon.sock` |
| Active database | `runtime/runtime.db` |
| Run capsule | `runtime/runs/<run-id>/` |
| Durable global-catalog source | `runtime/sources/catalog/<name>/<digest>/` |
| Interrupted deletion | `runtime/trash/` |
| Archived storage generation | `archives/<utc>-v<storage-version>/` |

- Runtime MUST coordinate destructive shard maintenance through a workspace-keyed lock beneath `$HOME/.acpus/tmp/runtime-locks/` that survives active-generation replacement.
- Concurrent maintenance owners MUST serialize for a bounded maintenance wait; a live shared Runtime user MUST remain a distinct blocker, and new-run preparation MAY reuse a compatible generation completed by the competing owner.
- Platform-global daemon endpoints (Windows named pipes, Linux abstract sockets, and temporary-directory Unix-socket fallbacks) MUST combine the fixed workspace key with a stable Acpus-home scope so different users or injected test homes cannot share an endpoint.
- A temporary-directory Unix-socket fallback MUST live beneath a user-scoped private directory; every filesystem socket parent MUST reject symbolic-link or non-directory substitution and use mode `0700`, and the bound Unix socket MUST reject symbolic-link substitution and use mode `0600`.
- Workspace-shard path and layout helpers MUST remain internal to Runtime rather than be exported from its package root.
- The workspace manifest MUST have exactly `manifestVersion: 1`, `workspaceKey`, `canonicalPath`, `platform`, `createdAt`, and optional `filesystemIdentity`.
- Manifest `createdAt` MUST be a canonical UTC ISO timestamp.
- Manifest `filesystemIdentity`, when available, MUST be the decimal `device:inode` identity with an optional decimal birth-time component.
- A writable open MUST create a missing shard and manifest with private user-only permissions where the platform supports POSIX modes.
- Fresh database initialization MUST accept only an absent generation or a generation whose existing runtime directories are all empty.
- A generation with `runtime.db` but a missing runtime child, or with durable run/source/trash state but no `runtime.db`, MUST fail as incomplete storage instead of being repaired in place.
- A missing manifest beside a non-empty active generation MUST NOT cause that generation to be adopted under a newly written manifest.
- Only new-run preparation and real pruning MAY archive an incomplete generation as one unit and rebuild current storage; read/control access and dry-run pruning MUST leave it unchanged.
- Runtime-owned layout roots, manifests, databases, run capsules, sources, trash, and archives MUST reject symbolic-link substitution instead of following it.
- An existing manifest whose key, canonical path, platform, or available filesystem identity disagrees with the current workspace MUST fail visibly instead of being adopted or rewritten.
- A read-only open MUST locate only the current workspace shard.
- A read-only open MUST NOT create the Acpus home, shard, manifest, database, or runtime directories.
- The active database MUST use a fixed nonzero Acpus SQLite `application_id`.
- The active database MUST use SQLite `user_version = 1` as the current storage version.
- A first writable open MUST initialize the complete current schema.
- Reopening a current-version database MUST preserve its rows.
- New-run preparation and real pruning of an incompatible active database MUST archive every child of `runtime/` under one new `archives/<utc>-v<observed-storage-version>/` generation before creating an empty current database.
- Control and single-delete access to an incompatible active database MUST fail without archiving or rebuilding it.
- Runtime MUST NOT migrate or read rows from an archived incompatible storage generation.
- A read-only open of an incompatible active database MUST fail visibly without archiving or rebuilding it.
- Runtime-triggered loading of `node:sqlite` MUST NOT emit Node.js's SQLite experimental warning.
- Runtime-triggered loading of `node:sqlite` MUST leave every other process warning observable.
- An existing-store open MUST return absence only for `ENOENT` or `ENOTDIR`; permission, symlink-loop, I/O, and SQLite failures MUST remain system failures.
- Runtime-generated run ids MUST combine local `YYYYMMDDHHmmss` time with 20 uppercase hexadecimal random characters.
- `RuntimeStore.admitRun` MUST return `ResultAsync<RunRecord, AdmitRunFailure>` and validate compiler-prepared workflow data, normalize input against the frozen input schema, and validate Agent overrides before mutation.
- `AdmitRunFailure` MUST be the union of `PreparedRunValidationFailure`, `SchemaNormalizationFailure`, and `AgentOverrideValidationFailure`; workspace mismatch, path publication conflicts, filesystem, SQLite, invariant, and unknown failures MUST reject.
- `PreparedRunValidationFailure.reason` MUST distinguish `invalid-ir-json`, `invalid-ir`, `ir-mismatch`, `ir-digest-mismatch`, `source-graph-mismatch`, `package-lock-mismatch`, and `entry-mismatch`.
- New-run and replacement-fork admission MUST validate the closed preparation-lock shape, canonical frozen IR, matching digests, compiler-owned workflow source reference, and `sha256([sourceDigest, packageLockDigest ?? ""].join("\n"))` source-graph digest before mutation; daemon failures use `INVALID_REQUEST`.
- Canonical frozen-IR admission MUST delegate to Core `validateWorkflowIR(...)`, reject validator errors or existing error diagnostics as `invalid-ir`, accept warning-only diagnostics, and MUST NOT append to or mutate prepared diagnostics.
- A workspace source reference MUST resolve its portable entry and reusable-task referrers beneath the canonical workspace root.
- A global-catalog source reference MUST identify its catalog name, package digest, and portable entry without persisting a temporary absolute source path.
- Admission of a global-catalog source MUST verify the supplied package snapshot against its package digest before publishing or reusing `runtime/sources/catalog/<name>/<digest>/`.
- Runtime execution MUST resolve frozen global-catalog reusable-task referrers from the Runtime-owned durable source snapshot.
- Runtime execution MUST use the run workspace as the fallback dependency authority for bare imports originating in a frozen global-catalog source.
- Admission MUST persist exact `workflow.ir.json` and `lock.json` bytes beneath `runtime/runs/<run-id>/`, with run-relative file coordinates and `sha256:<hex>` byte digests.
- Admission MUST initially materialize only `workflow.ir.json` and `lock.json` in a committed run directory.
- Runtime-owned top-level run-directory entries MUST be limited to `workflow.ir.json`, `lock.json`, and the optional `artifacts/` tree.
- Admission and fork publication MUST fail without removing or replacing a pre-existing staging or final run path.
- A failed admission or fork MUST remove only a staging or final run path created by that operation; concurrent operation and owned-path cleanup failures MUST both remain observable.
- Frozen files and registered artifacts MUST be regular non-symlinks beneath the current shard's non-symlinked runtime runs root; missing, escaping, or mismatched files fail visibly rather than appearing absent.
- Admission MUST atomically persist `run.admitted`, run/public node projections, scheduler bootstrap state, and separately stored Agent overrides before daemon-owned advancement.
- Execution MUST use frozen IR instead of live workflow source and never copy reusable task source or dependencies into the run directory.
- Completed runs MUST persist normalized root output and `run.completed`; runtime failures after admission persist failed state and `run.failed`.
- A run row without its required frozen input/files MUST fail as durable corruption rather than appear absent.
- `deleteRun` MUST return `ResultAsync<RunRecord | undefined, RunDeleteFailure>`, with `undefined` for an absent store/run and `run-delete-active` as its only recoverable error.
- Run deletion MUST move the run capsule into `runtime/trash/` before deleting its database rows in the same transaction as the active-lease check.
- Run deletion MUST reject an unexpired unreleased lease even when the run projection is already terminal.
- A successful run-deletion commit MUST remove its trashed capsule.
- A failed run-deletion transaction MUST restore its trashed capsule before returning or rejecting.
- On writable open, Runtime MUST restore a trashed capsule whose run row remains and finish deleting a trashed capsule whose run row is absent.
- Trash reconciliation MUST accept only regular non-symbolic-link directories as trashed capsules.
- A trash reconciliation collision or filesystem failure MUST fail visibly instead of discarding either path.

### Pruning

- `pruneRuns(cwd, options)` MUST select only runs whose status is `completed`, `failed`, or `canceled`.
- With `olderThanMs`, pruning MUST select terminal runs whose `updatedAt` and archives whose creation time are strictly earlier than the runtime-computed cutoff.
- Without `olderThanMs`, pruning MUST select every terminal run and every archive in scope.
- Runtime MAY receive an internal canonical `selectionCutoff` from the CLI to fence a confirmed prune; when present it MUST replace the runtime-computed selection boundary without changing whether `PruneReport.cutoff` is exposed.
- Pruning MUST default to the current workspace shard.
- `allWorkspaces: true` MUST enumerate workspace shards beneath the same Acpus home.
- Ordinary read APIs MUST NOT expose runs from another workspace shard.
- `dryRun: true` MUST perform selection and size accounting without changing databases or files.
- Pruning MUST snapshot pre-existing archive candidates before generation validation or recovery, include those candidates in a failing dry-run report, and MUST NOT select an archive created by recovery during that same invocation.
- Real pruning MUST delete selected runs through the Runtime-owned trash protocol.
- Real pruning and generation archival MUST fail while another process holds the workspace runtime for writable use.
- After selected run deletion, Runtime MUST delete only global-catalog source snapshots that no remaining run references.
- A shard MUST be removed only when it has no runs, archives, catalog snapshots, unresolved trash, or live daemon.
- Empty-shard removal MUST reject a `daemon.sock` entry unless the active layout uses that path and the entry is a Unix socket.
- Removing an empty shard MUST remove its empty active database, manifest, and workspace-shard directory.
- One malformed or failed shard MUST NOT prevent pruning of other selected shards.
- A prune failure after one or more successful deletions MUST retain those completed counts and bytes in the final report.
- For the current workspace, real pruning MAY archive and rebuild a generation whose available filesystem identity proves that the workspace path was recreated; dry-run MUST report that mismatch without mutation.
- `PruneReport` MUST use the following closed shape.

```ts
type PruneReport = {
  dryRun: boolean;
  cutoff?: string;
  selected: { workspaces: number; runs: number; archives: number; bytes: number };
  deleted: { workspaces: number; runs: number; archives: number; sources: number; bytes: number };
  removedWorkspaces: number;
  failures: Array<{ workspaceKey: string; message: string }>;
};
```

- `PruneReport.cutoff` MUST contain the runtime-computed canonical UTC ISO cutoff when `olderThanMs` is present and be omitted otherwise.

### Values, Deadlines, And Scheduler

- `tryNormalizeWorkflowInput` MUST validate against `WorkflowIR.inputSchema`; Signal control accepts raw strings without a schema and normalized schema-backed payloads otherwise, with invalid values rejected before mutation.
- Runtime schema normalization MUST inspect object fields through own properties so inherited names never satisfy a declared field.
- Runtime schema normalization MUST apply defaults as own data properties without mutating an object's prototype.
- Runtime schema normalization MUST accept `null` for unknown, nullable, matching literal or enum, and matching union schemas.
- Recoverable runtime boundaries MUST use tagged `Result` or `ResultAsync`; local absence uses `undefined`, while invariant, durable-corruption, unknown execution, SQLite, and non-absence filesystem failures throw or reject.
- Result wrappers MUST NOT be written into WorkflowIR, Task IPC, daemon wire data, SQLite rows, runtime events, or public JSON.
- Runtime expressions MUST adapt the canonical [Expression evaluator](expression-spec.md) to durable `input`, `workflow.input`, `nodes`, `meta`, `fanout`, and `loop` scope.
- Ref resolution MUST use own properties and canonical non-negative array indexes; runtime `meta` exposes run id, relative workflow path, workflow name, and absolute workspace directory.
- Runtime Result helpers MUST convert only canonical `ExpressionEvaluationError` failures; formatter failures, unsupported ref roots, malformed IR, and other adapter/invariant failures MUST throw.
- Configuration resolution MUST return tagged Result errors that distinguish evaluation, type, and field-constraint failures while keeping Result objects out of durable/public data.
- Duration resolution MUST use Core syntax/range rules and canonical four-digit-year ISO deadlines; malformed or unrepresentable persisted deadlines fail before lexical comparison or executor invocation.
- Concurrency resolution MUST treat missing/zero Parallel or Fanout caps as unbounded locally, accept positive integers, and require positive quorum counts.
- The scheduler MUST use durable scheduler events as decision facts and atomically fence ownership/version, append events, update derived projections, and publish public state.
- Scheduler recovery MUST produce the same state from persisted facts, reject corrupt/ahead checkpoints, and keep projection drift from changing decisions; checkpoint/cache/write strategy remains internal.
- Scheduler event replay MUST apply persisted targeted-retry facts without re-running the current command-admission policy against historical events.
- A missing scheduler-checkpoint row MUST mean no checkpoint; a missing checkpoint table or unreadable checkpoint state MUST remain a store failure.
- Recoverable store operations MUST return tagged `SchedulerStoreError` results; invariant or store failures may throw from `advanceRun(input): Promise<AdvanceRunSummary>`.
- `applySchedulerControlIntent` MUST return a tagged Result and report ambiguous retry/cancel aliases with deterministic `candidateKeys`; unknown store, frozen-data, and invariant failures MUST propagate.
- The daemon MUST capture `ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY` at startup, default it to 32, and reject non-canonical positive safe integers before creating store or socket state.
- A Parallel or Fanout local concurrency cap MUST count distinct direct active members by `(groupKey, memberKey)` identity.
- Multiple ready or running descendant leaves of one direct member MUST consume one local slot in that member's group.
- Each nested Parallel or Fanout group MUST apply its local concurrency cap independently of every ancestor and descendant group.
- The scheduler MUST order ready leaf instances by ascending durable readiness sequence, using ascending ordinal code-unit `nodeKey` order as the tie-breaker.
- When multiple ready leaves exist, the scheduler MUST start the oldest leaf that satisfies the run gate and every applicable group cap.
- A ready leaf blocked by an applicable group cap MUST NOT prevent a later ready leaf that satisfies every applicable cap from starting.
- A ready Signal instance MUST satisfy every applicable group cap before entering `awaiting`.
- An awaiting Signal member MUST continue to occupy its direct-member slot in every applicable group.
- A ready or awaiting Signal instance MUST NOT count toward the run-wide logical leaf cap.
- A Signal instance MUST NOT acquire an owner-local physical executor slot.
- The logical run-wide leaf cap MUST count every durable attempt whose status is `started`.
- The current owner MUST limit its physical leaf count to executor invocations that it has launched and that have not settled.
- The scheduler MUST start a Task or Agent leaf only while both the logical run-wide cap and the current owner's physical leaf cap have capacity.
- The daemon ceiling MUST remain owner configuration rather than frozen IR or a persisted scheduler fact.
- The production run-execution seam MUST be `createRuntimeRunScheduler(...).start({runId,ownerId})`.
- `start({runId,ownerId})` MUST return a `RunExecution` exposing `ownerEpoch`, `result`, `wake()`, and `stop()`.
- `RunExecution.ownerEpoch` MUST resolve to the claimed scheduler owner epoch, or to `undefined` if execution ends before claiming the run.
- `RunExecutionExit.status` MUST use the closed set `completed`, `failed`, `canceled`, `paused`, `awaiting`, and `lease_lost`; this set excludes `idle`.
- `RunExecution.result` MUST resolve to `Result<RunExecutionExit, RunExecutionFailure>`; only errors carrying SQLite busy/locked identity are recoverable `store-busy` failures, and unknown failures reject with their original value.
- Daemon heartbeat and tick boundaries MUST retry recognized store-busy failures; every other global store or maintenance failure MUST initiate fatal daemon shutdown instead of being swallowed.
- Calling `RunExecution.wake()` MUST make the execution reconsider durable scheduler state.
- Calling `RunExecution.stop()` MUST request owner-local executor cleanup and wake the execution.
- A progressing `RunExecution` MUST observe a stop request at its next cooperative scheduling checkpoint before appending further derived transitions or admitting another leaf.
- After an attempt settles durably, the scheduler MUST reconsider ready work without waiting for unrelated active attempts to settle.
- After a durable control mutation changes scheduler state, an active run session MUST reconsider ready work without waiting for an unrelated active attempt to settle.
- Pause and untargeted run cancel MUST commit their durable fence without first draining unrelated derived transitions.
- After a successful durable control mutation commits against an active `RunExecution`, the daemon MUST increment that execution's owner-local monotonic wakeup version.
- Before sleeping, an active `RunExecution` MUST compare its previously observed owner-local wakeup version with the current owner-local wakeup version.
- An active `RunExecution` MUST continue scheduling instead of sleeping when the current owner-local wakeup version is newer than its previously observed wakeup version.
- Before resolving `RunExecution.result`, an active execution MUST reload durable state when its owner-local wakeup version changed after the snapshot being considered.
- A production `RunExecution` MUST stop admitting new leaves after observing terminal, paused, or lease-lost state.
- `RunExecution.result` MUST resolve with `awaiting` only when the execution has no owner-local physical leaf, has no admissible ready work, and durable progress is blocked by an open Signal wait.
- A non-terminal production execution with no owner-local active executor and no durable wake source MUST reject `RunExecution.result` as an invariant failure.
- A production `RunExecution` MUST release any held run lease before settling `RunExecution.result`.
- When a production execution fails while its owner lease remains active, it MUST finish owner-local executor abort cleanup before releasing that lease.
- If execution and lease cleanup both fail, the rejection MUST preserve both failures in an `AggregateError` rather than replace the execution failure.
- After a production execution rejects, the daemon MUST quarantine that run in memory by `(runId, eventCount)` and report one execution incident for that version.
- A run execution quarantine MUST clear after its durable event count changes and MUST NOT survive daemon restart.
- One run's rejected production execution MUST NOT stop or prevent the daemon from advancing other runs.
- An attempt-start mutation MUST compare against the scheduler snapshot version from which its admission decision was made.
- Attempt-start replay identity MUST include the scheduler snapshot version that produced the original admission.
- On an attempt-start version mismatch, the scheduler MUST reload durable state and recompute admission before starting that leaf.
- A progressing scheduler MUST NOT fail a run solely because the number of scheduler drives or derived-transition batches reaches an internal count.
- A long progressing production `RunExecution` transition drain MUST yield cooperatively.
- After a production `RunExecution` transition drain yields, it MUST recheck run ownership before appending more events.
- Scheduler intent keys MUST be run-scoped and replay only the same control identity; successful no-op controls record identity atomically, while conflicting reuse returns `idempotency-conflict`. Signal replay MUST remain bound to the wait recorded by its command idempotency key even when the same static alias later names another open wait. A fresh request identity MAY durably record a successful no-op only for that same command key and payload; another command key MUST NOT bind itself to an already consumed wait.
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

- A running `parallel all` or `fanout all` group with a canceled required member MUST fail instead of remaining non-terminal.
- Failure of a running `parallel all` or `fanout all` group MUST cancel each remaining ready or running member as `parent_failed`.
- Group concurrency/quorum MUST resolve once at materialization and persist the effective policy needed for deterministic recovery.
- Materialization MUST return ordinary failed transitions only for authored expression, type, and constraint failures; missing or inconsistent frozen nodes, frame identity, scope ancestry, group membership, accepted winners, and quorum state are durable corruption and MUST reject advancement.
- Scope completion MUST expose only its normalized `output: ExprIR` result to its parent; arbitrary WorkflowData values remain valid outputs.

### Task, Signal, And Artifact Execution

- Task runs MUST execute the frozen inline or reusable target; reusable module resolution delegates to the [Loader](loader-spec.md) from the recorded source-root-relative workflow referrer.
- Frozen inline Task functions MUST use the serialized-function execution environment owned by the [Expression spec](expression-spec.md).
- Every Task attempt MUST use a fresh Node process; module caching is attempt-local and separate tasks/retries share no module globals.
- Task cwd MUST default to workspace, resolve relative values from workspace, and be observed by process code, filesystem access, module initialization, and the default command wrapper without changing module resolution.
- Task environment MUST start from host environment plus evaluated overrides and remain live for process code, task context, modules, and later command invocations.
- Task input/cwd/env and default command timeout MUST resolve once before invocation and be recorded as effective attempt metadata where applicable.
- Evaluated Task input MUST preserve every own WorkflowData field, including `__proto__`, without changing the input object's ordinary prototype.
- Runtime output normalization MUST treat Task top-level `undefined` as no output, reject scope/array `undefined`, omit undefined object properties, and reject non-WorkflowData values without adding business schemas.
- Task output MUST be normalized immediately before child-process IPC and again at durable result commit; the parent node-executor layer MUST NOT add another cloning or normalization pass.
- Recoverable Task attempt failure MUST contain only `failed`, `cancelled`, or `timed_out` status plus a complete display message; cwd, errno, exit code, signal, and bounded process output details MUST be folded into that message when applicable.
- A Task return value MUST persist through durable scheduler state without creating run-local files unless the Task calls `artifact.write(...)`.
- Attempt deadlines MUST be persisted once; Task and Agent executors consume remaining budgets without re-evaluating authored timeout expressions.
- Timeout and cancellation MUST remain authoritative across startup/result races, reject late output/artifacts, propagate Task `abortSignal`, and terminate the isolated process tree after bounded cooperative cleanup.
- An attempt result commit MUST match an attempt that is still `started`, its `attemptId`, and its active `ownerEpoch`.
- An exact attempt-result idempotency replay by the original still-active owner MAY return the current snapshot without creating a new result commit.
- Attempt-scoped artifact registration MUST match an attempt that is still `started`, its `attemptId`, and its active `ownerEpoch`.
- Attempt-scoped progress writes MUST match an attempt that is still `started`, its `attemptId`, and its active `ownerEpoch`.
- A rejected stale attempt result MUST NOT change durable scheduler state.
- A rejected stale artifact registration MUST NOT add an artifact registry row.
- A rejected stale progress write MUST NOT change node progress.
- A rejected stale progress write MUST NOT advance the progress version.
- A recognized Task or Agent attempt failure MAY commit ordinary failure events; an unknown executor rejection or metadata, artifact, registry, filesystem, or store failure MUST reject before ordinary attempt/instance failure events are committed.
- Task runtime artifact filesystem or registration failures MUST cross child-process IPC as a plain system-rejection message and reject the scheduler boundary rather than become `TaskAttemptFailure`.
- Execution metadata MUST remain append-only attempt history outside scheduler admission, attempt-result acceptance, and authoritative public attempt status.
- Inspection MUST derive authoritative attempt status and accepted output from durable scheduler projection rather than execution metadata.
- Artifact writes MUST use attempt-local run paths while the runtime parent exclusively registers SQLite records and rejects registration after timeout/cancellation.
- ArtifactRef resolution MUST return tagged failures for malformed/cross-run/unregistered refs and missing, symlink, or non-regular registered files.
- Artifact registry escape, SQLite, permission, and I/O failures MUST propagate rather than become ArtifactRef validation failures.
- Signal prompt, timeout message, and deadline MUST resolve once on awaiting entry; the persisted wait resumes durably from normalized input or fails ancestors with `signal_timeout` on expiry.
- Pause/resume MUST suspend and restore Signal timeout budgets atomically; an unrepresentable restored deadline returns `deadline-out-of-range` without state change.

### Agents

- Agent execution MUST render frozen prompt, cwd, env, permission, session, model, and static Agent `config` values, resolving a directly interpolated ArtifactRef to its verified absolute path.
- Runtime MUST call the [Agent Executor](agent-executor-spec.md) for normalized acpx execution/progress and never parse raw ACP JSON for decisions, summaries, or progress.
- Runtime MUST translate each effective named or command Agent definition into the corresponding [Agent Executor](agent-executor-spec.md) request variant; absent permission defaults to `approve-all`.
- Static Agent `config` is a frozen string-to-string desired ACP option map for a reusable Agent profile; it is not an ACP `configOptions` snapshot or cross-session mutable state and MUST NOT contain secrets.
- The effective model MUST be `config.model ?? model`; `config.model` uses the Agent Executor model path rather than the generic config-option loop.
- Runtime MUST pass `config` only on an initial normal Agent turn; response-repair and plain-continuation turns MUST omit it.
- Overrides MUST allow only `use`, `command`, `model`, `permissionMode`, `config`, `cwd`, and `env`; an override `config` replaces the complete inherited map, including with `{}`, identity replacement clears inherited model/config, preserves permission, and never accepts `trace`.
- Session identity MUST be run-local and deterministic from explicit non-empty `sessionKey` or dynamic `nodeKey`; repair/retry/resume turns reuse it according to continuation policy.
- Nodes that explicitly share one `sessionKey` MUST resolve to the same effective Agent backend, model, and config; Runtime documents this unsupported-conflict constraint without coordinating or detecting conflicts.
- Schema-less Agents MUST return raw text with zero response repairs.
- Every schema-backed Agent prompt, including task, continuation, and response-repair turns, MUST state the Tagged JSON output contract.
- Every schema-backed Agent prompt MUST include the declared output as JSON Schema.
- A schema-backed Agent response MUST end with one `<ACPUS_OUTPUT>...</ACPUS_OUTPUT>` frame whose payload is one JSON value.
- Text before the opening marker MAY contain commentary.
- Only whitespace MAY follow the terminal closing marker.
- The two Tagged JSON protocol markers MUST NOT appear in prefix text.
- Marker text inside the payload MUST be treated as data only when the payload parses directly as one JSON value.
- Tagged JSON framing MUST use the first opening marker and the terminal closing marker without depending on line boundaries.
- A response containing more than one protocol frame MUST be rejected as ambiguous framing rather than selecting one frame.
- Runtime MUST parse the framed payload as strict JSON first.
- Runtime MAY make at most one local JSON-repair attempt on the payload after strict parsing fails.
- Local JSON repair MUST NOT recover missing or ambiguous framing.
- Local JSON repair MUST reject multiple root values rather than combine or select them.
- A direct or locally repaired payload MUST be a durable JSON value.
- A direct or locally repaired payload MUST conform to the declared schema.
- Schema-backed Agents MUST accept extra object keys during conformance.
- Runtime MUST project stored schema-backed Agent output to the declared shape.
- Agent output-processing metadata MUST distinguish framing, JSON, and schema rejection.
- Agent output-processing metadata MUST record whether accepted or schema-rejected JSON was parsed directly or locally repaired.
- Agent output-processing metadata MUST NOT embed raw output.
- The daemon MUST capture `ACPUS_AGENT_RESPONSE_REPAIR_MAX` at startup, default additional repair turns to two, accept canonical non-negative safe integers, and expose invalid configuration as `invalid_agent_response_repair_max` before provider invocation.
- Response repair MUST remain inside one scheduler-visible attempt, reuse the acpx session, avoid generic config-option reapplication, and never process backend failures as output failures.
- A response-repair prompt MUST request a complete replacement Tagged JSON frame.
- A response-repair prompt MUST repeat the Tagged JSON output contract.
- A response-repair prompt MUST repeat the declared output schema.
- A response-repair prompt MUST identify only the bounded failure phase.
- A response-repair prompt MUST omit the rejected response and its dynamic error text.
- Each scheduler-backed turn MUST register `artifacts/<nodeKey>/attempt-<n>/agent/turn-<NNN>.json` containing schema version, identities, exact prompt/response, normalized summary/timing, status, and structured terminal detail.
- Turn metadata MUST reference the canonical artifact and compact summary without embedding prompt, response, timing, complete tools, or filesystem paths; non-empty stderr uses a separate artifact.
- `ACPUS_AGENT_RAW_ACP_DEBUG=1` MUST be captured at daemon startup and optionally persist exact wire output without affecting execution or repair.
- Top-level Agent `trace: true` MUST request one schema-versioned, ordered normalized trace artifact per turn that excludes prompt/control frames; a missing captured trace or trace persistence/registration failure is a system rejection and MUST NOT be recorded as an ordinary Agent failure.
- A recognized Agent failure MUST write terminal progress/metadata once; if that write also fails, the rejection MUST retain both the recognized failure and persistence failure.
- Node progress MUST remain latest-state observation outside scheduler decisions, clear on new attempts, use typed bounded channels, and advance an independent progress version.

### Controls And Daemon

- Runtime control intents MUST use closed `pause`, `resume`, `retry`, `cancel`, `fork`, and `signal` variants with run-scoped request identity.
- The daemon MUST expose `admitRun(prepared, input, agentOverrides?)`, `control(intent)`, `shutdown()`, and `status()` over a workspace-derived Unix socket or equivalent named pipe, never an HTTP port.
- Requests and responses MUST use closed JSON shapes; responses are `{ ok: true, result }` or `{ ok: false, error: { code, message } }`.
- Daemon client functions MUST return `ResultAsync` with `rejected`, `transport`, and `protocol` failures while the socket wire remains ordinary JSON.
- Successful admission and control responses MUST validate the closed required `RunDetails`, `RunStatus`, execution-state, JSON-value, and control-result shapes; a control result type MUST match the requested intent, and malformed success data is a `protocol/result` failure.
- Public errors MUST use only `INVALID_REQUEST`, `RUN_NOT_FOUND`, `RUN_NOT_CONTROLLABLE`, `CONTROL_CONFLICT`, `EXECUTION_UNAVAILABLE`, `STORE_BUSY`, `STORE_ERROR`, and `INTERNAL_ERROR`, with actionable text but no lease/SQLite/projection internals.
- Unknown daemon handler failures MUST become sanitized `INTERNAL_ERROR` responses and MUST NOT be classified as business control failures.
- Socket binding MUST arbitrate one daemon per workspace; a valid response proves liveness, while stale removal requires local evidence of a dead/expired owner.
- The daemon MUST host one serialized-write execution session per active/recoverable run, permit different runs concurrently, and keep long executor waits from blocking controls.
- Session start MUST distinguish `started`, `already-active`, `terminal`, and `quarantined`; daemon tick activity counts only `started` executions and dispatched hook work.
- Pause/cancel MUST durably fence their effect and abort only applicable active attempt controllers; late executor results cannot overwrite control state.
- Pause and resume MUST be idempotent, with pause requeueing eligible canceled work and resume clearing the durable gate.
- A paused run session MUST finish bounded executor cleanup before returning `paused`.
- Resume MUST advance a run only through a new session with a newly claimed `ownerEpoch`.
- Retry MUST advance a run only through a new session with a newly claimed `ownerEpoch`.
- A no-op or idempotently replayed Resume or Retry MUST NOT stop the active execution, start another session, or claim another `ownerEpoch`.
- Retry MUST support run-level reset or an unambiguous failed `nodeKey`, `frameKey`, or static alias; omitted target is run-level while explicit `root` remains a normal alias.
- Targeted retry MUST define its target path as the failed target plus each failed ancestor frame, group, and member required to propagate that target's completion.
- A direct sibling of a target-path member that was canceled as `parent_failed` MUST be treated as a completion dependency and MUST NOT be treated as another failed target.
- Targeted retry MUST NOT reopen a failed member outside the target path.
- Before appending targeted-retry events, Runtime MUST reject the request if a required ancestor frame, group, or member is completed or canceled.
- Before appending targeted-retry events, Runtime MUST reject the request if the run is paused or if the prospective reopened state would immediately fail under an ancestor group's persisted strategy, quorum, or a preserved failure inside a completion-dependency subtree.
- A rejected targeted retry MUST append no events and leave the durable projection unchanged.
- Pending derived transitions used to validate a targeted retry MUST commit atomically with an accepted retry and MUST NOT commit when that retry is rejected.
- An accepted targeted retry MUST atomically reopen the target path and every direct `parent_failed` completion dependency at each ancestor composite.
- Reopening a completion dependency MUST recursively restore only descendants canceled as `parent_failed` while preserving completed descendants, failed descendants outside the target path, and every other cancellation.
- Retrying a failed leaf MUST preserve its previously resolved execution timeout; a leaf that failed before execution because configuration resolution failed MUST be retried through its containing frame or run instead.
- An accepted targeted retry MUST leave at least one reopened leaf eligible for admission or one reopened frame eligible to materialize work without another control.
- Restored work MUST remain governed by each composite's persisted strategy, quorum, and concurrency policy.
- Cancel MUST support run-level or unambiguous non-terminal dynamic/static targeting; run cancel yields `canceled`, targeted cancel yields `operator_cancelled`, and repeated run cancel is idempotent.
- Fork MUST create an idempotently identified child from verified frozen source data, optionally replacing prepared workflow, input, Agent overrides, or target without reading live source.
- Fork MUST materialize only the child's frozen files and reachable registered artifacts selected for inheritance.
- Fork MUST NOT copy unregistered or otherwise unknown source-run filesystem entries into the child.
- Run reads and inspection MUST project the child's direct fork source, requested target, and unsafe-reuse flag from the durable `run.forked` event without deriving recursive ancestry.
- Safe targeted fork MUST reuse only compatible completed prerequisite facts/artifacts, preserve target closure, avoid inherited attempt events/active state, and reject missing, ambiguous, or impossible replacement targets before admission.
- Changed input MUST disable completed-output reuse; explicit `unsafeReuse` permits it across input/signature changes while retaining target, materialization, artifact, and completed-only safety boundaries.
- Race/quorum fork reuse MUST preserve only scheduler-accepted winners/members when replacement order/identity is compatible; otherwise eligible prerequisite work executes normally.
- Signal control MUST target one open dynamic wait (directly or by unambiguous static alias), normalize payload, consume idempotently, and resume the recovered session from persisted state.
- `shutdown()` MUST stop only without active sessions, otherwise return `CONTROL_CONFLICT`; shutdown/idle-stop never mutates runs and no force-shutdown control exists.

### Read APIs And Daemon Lifecycle

- `listRuns`, `getRun`, `readArtifact`, inspection, health, and visualization overlays MUST read durable projections/frozen data without live workflow source or daemon startup.
- `getRuntimeHealth` MUST expose the current workspace shard root as `persistence.path` even when the shard is not initialized.
- `listRuns` MUST order by `updatedAt DESC, createdAt DESC`; `getRun` omits `dynamic` only when every dynamic collection is empty and fails visibly on decode/invariant errors.
- `getRunInspection(cwd, query)` MUST return tagged `ResultAsync` results in the following modes.

| Mode | Projection |
| --- | --- |
| overview | Versioned compact occurrence tree, exact status counts, cursors, sparse items, actions, omitted counts, terminal output. |
| all | Complete occurrence-expanded execution tree without exposing raw tables. |
| target | Static aggregate or exact node/frame/attempt context with history, progress, Signal, execution metadata, and artifact references. |
| raw | Unbounded run details, complete frozen `WorkflowIR`, and artifact registry. |

- Snapshot items MUST form a unique-keyed, parent-before-child preorder tree whose `parentKey` values resolve within the same snapshot.
- Snapshot item keys MUST remain stable for the same authored node or dynamic scope occurrence across follow polls and MUST be treated as opaque by consumers.
- `RunInspectionItem.scope` MUST use the following closed additive shape while inspection documents retain `schemaVersion: 1`.

```ts
type RunInspectionScopeState =
  | { kind: "branch"; ownerKind: "if" | "switch"; branchId: string; selection: "undecided" | "selected" | "not_selected"; empty: boolean }
  | { kind: "branch"; ownerKind: "parallel"; branchId: string; empty: boolean }
  | { kind: "fanout_item"; itemIndex: number; empty: boolean }
  | { kind: "loop_iteration"; iteration: number; round: number; empty: boolean };
```

- A scope state's `empty` field MUST be true exactly when its frozen authored scope contains no nodes.
- Occurrence-targeted inspect, Signal, and retry actions MUST carry the corresponding snapshot `itemKey`; a fork action MAY carry that `itemKey`, while an inspect-all action remains run-wide without one.
- Inspection MUST parent repeated nodes and scopes by exact dynamic occurrence identity rather than by static `nodeId` alone.
- Inspection preorder MUST retain authored node order within each scope, authored If/Switch route and Parallel branch order, Switch case-before-default order, ascending Fanout `itemIndex`, and ascending Loop `iteration`.
- For each materialized If or Switch occurrence, all-mode inspection MUST emit every authored route in authored order, mark its selection state, and expand only the selected route.
- For each materialized Parallel occurrence, all-mode inspection MUST emit every authored branch in authored order and expand only branches whose durable member or scope frame is materialized.
- All-mode inspection MUST emit every persisted Fanout item and Loop iteration, including an empty scope.
- Within each materialized scope, all-mode inspection MUST represent each authored but unmaterialized direct node once as a `not_started` placeholder.
- All-mode inspection MUST NOT invent a future Fanout item or Loop iteration.
- All-mode inspection MUST contain neither fold items nor omitted-context metadata.
- Overview and all-mode inspection MUST expose the same compact fields for the same occurrence; they differ only in occurrence visibility, folds, and omitted metadata.
- Overview MUST count every dynamic leaf context, represent an unmaterialized authored leaf once, and exclude grouping rows.
- Overview MUST bound ordinary expanded dynamic leaf contexts to 20 while retaining every failed, timed-out, awaiting, or retried occurrence and its ancestry outside that budget.
- Overview MUST compact repeated completed or cancelled occurrences when needed to preserve its bounded presentation and MUST retain valid parent links after compaction. Each fold MUST replace one contiguous run of hidden sibling occurrences under the same parent and MUST NOT aggregate across an outer occurrence.
- Inspection run summaries MUST expose `agentUsage` for workflows containing Agent nodes, including zero values before materialization; instances count materialized Agent nodes, attempts count all scheduler attempts for those nodes, and turns use durable attempt metadata supplemented by newer active progress without double counting.
- A failed inspection run summary MUST expose the compact failure from its persisted root frame when that frame contains an error.
- A root-frame failure MUST NOT create a synthetic overview/all item.
- Target `root` MUST retain the exact root-frame failure detail.
- A static target matching multiple dynamic contexts MUST expose aggregate status and exact status counts while omitting instance-specific input, output, failure, keys, prompt, attempt, Agent, and Signal detail; a single matching context retains its detailed projection and zero matches remain `not_started`.
- Public artifact records MUST expose absolute `path` without exposing internal relative storage coordinates.
- `listArtifacts` MUST return registry metadata without reading file bodies.
- `listArtifacts` MUST return `[]` for an empty existing run and `undefined` for a missing run or store.
- `readArtifact(cwd, runId, artifactId): Promise<{ artifact: ArtifactRecord; bytes: Buffer } | undefined>` MUST return the artifact record and bytes after verifying the registered file's run containment, non-symlink regular-file identity, recorded size, and digest.
- `readArtifact` MUST return `undefined` for a missing store, run, or artifact registry row.
- A registered artifact that is missing, escapes its run, is a symlink or non-regular file, or fails its recorded size or digest MUST make `readArtifact` reject as durable corruption.
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
- After acquiring the workspace lease and before its first scheduling tick, the daemon MUST remove `.staging-*` run directories that have been stale for at least 60 seconds.
- Stale staging cleanup MUST leave ordinary run directories unchanged regardless of whether they have a database row.
- Stale staging cleanup MUST ignore only paths that disappear during inspection; other directory read/stat failures MUST abort daemon startup.
- Paused runs and untimed Signal waits alone MUST not keep the daemon resident; a non-terminal run with an immediately derivable transition, an expired owner's started attempt, or an admissible ready node MUST receive one recovery drive even when another branch is awaiting an untimed Signal. Derivable transitions include due attempt settlement, group terminalization, and leaf/frame/ancestor propagation. Timed waits keep the daemon resident until durably settled, and startup recovery is targeted rather than a whole-store repair sweep.
- A recovered owner MUST settle already-due attempt deadlines before superseding remaining expired-owner `started` attempts.
- A recovered owner MUST durably supersede expired-owner `started` attempts before admitting replacement leaf work.
- Superseded attempts MUST NOT consume logical leaf capacity after their superseding transition commits.
- The physical leaf cap MUST apply independently to each owner epoch.
- Lease failover MUST NOT require proof that a stale external process has stopped before the recovered owner admits replacement work.

## Verification

- `pnpm test:unit -- packages/runtime`: proves oldest-admissible FIFO, direct-member identity, continuous refill, all-group canceled-member terminalization, targeted-retry completion closure and atomic blocker rejection, versioned wakeup, stop/cleanup checkpoints, dual leaf caps, daemon session wiring, and progress beyond internal count limits.
- `pnpm test:integration -- packages/runtime`: proves the production execution seam, nested Parallel/Fanout and Signal admission, active-session Signal wakeup, immediate pause/run-cancel fencing, pause/resume/retry completion and session epochs, retry replay behavior, rejection of non-terminal execution without a durable wake source, attempt/artifact/progress fences, due-Signal scale, execution-metadata authority, and lease recovery ordering.
- `pnpm --filter @acpus/runtime typecheck`: verifies the scheduler, store, session, executor, artifact, and progress interfaces agree.
- Pure unit tests own workspace-key/endpoint derivation, manifest validation, runtime-generation classification, prune selection/cutoff, and maintenance-lock timing/concurrent initialization; integration tests MUST NOT reproduce those rule matrices through fresh databases.
- Storage integration uses one tracer per cross-layer risk: shard isolation, catalog-source publication/reuse, preview-to-delete pruning, archive/rebuild, delete rollback/trash reconciliation, and verified artifact reads.
- Database tests assert current format markers and persisted Runtime semantics; they MUST NOT snapshot table/column inventories or assert the absence of fields from historical schemas.
- A fresh-process Runtime integration test verifies that SQLite initialization is quiet while an unrelated experimental warning remains observable.
- Cover workspace-key and manifest validation, private shard creation, database version archive/reset, frozen-file integrity, run-directory entry limits, prepared source consistency, durable global-catalog sources, collision-safe atomic admission, trash reconciliation, pruning, selective fork artifact materialization, startup staging cleanup, normalization, and mutation-free rejection.
- Prove deterministic scheduler recovery and every node/composite strategy, identity, resource, deadline, cancellation, retry, and projection rule.
- Exercise isolated Tasks, reusable loading, artifacts, Agents, response repair, progress, canonical turn records, and optional captures.
- Cover control idempotency/targeting, fork safety, daemon fencing, sessions, socket ownership, heartbeat, idle-stop, and public error sanitization.
- Verify inspection modes, verified artifact reads, health persistence projection, follow fidelity/resync, liveness, terminal output once, and read-only operation without daemon startup or shard creation.
