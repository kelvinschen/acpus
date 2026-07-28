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
| Private Turn Evidence | `runtime/runs/<run-id>/evidence/agents/` |
| Durable workflow snapshot | `runtime/sources/snapshots/<sha256-hex>/manifest.json` and `files/` |
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
- An opened Runtime store MUST bind its runs, sources, and trash roots, and every accessed run capsule, to the device/inode identity with a nonzero inode, resolved location, and available birth time observed by that store. Whenever one of those paths is accessed again, any observable identity or resolved-location mismatch MUST fail visibly rather than be followed or adopted.
- Long-lived Runtime-owned Evidence, Trace, and artifact writes MUST bind created files to the same observable identity. Runtime MUST revalidate the relevant bound run, parent, and file identities at checkpoints surrounding sealing, publication, registration, and cleanup, and any observable mismatch MUST fail visibly.
- Opening a Runtime-owned root, run capsule, or long-lived file that does not expose a device/inode identity with a nonzero inode MUST fail visibly instead of degrading to path-only verification. Identity fencing detects only changes distinguishable through values reported by the host filesystem; those values may be recycled, so equality is not proof of uninterrupted path ownership.
- An existing manifest whose key, canonical path, platform, or available filesystem identity disagrees with the current workspace MUST fail visibly instead of being adopted or rewritten.
- A read-only open MUST locate only the current workspace shard.
- A read-only open MUST NOT create the Acpus home, shard, manifest, database, or runtime directories.
- The active database MUST use a fixed nonzero Acpus SQLite `application_id`.
- The active database MUST use SQLite `user_version = 4` as the current storage version.
- Each run row MUST maintain a monotonically increasing `observation_version` and optional `observation_updated_at`.
- The active schema MUST index private Agent evidence and bounded semantic inspection through `agent_observation_attempts`, keyed by `(run_id, attempt_id)`, `agent_observation_turns`, keyed by `(run_id, attempt_id, turn_no)`, and `agent_observation_entries`, keyed by `(run_id, attempt_id, entry_id)`.
- A non-null observation fence event sequence MUST be unique within its run.
- An observation-attempt row MUST store its latest observation version, retention-omitted count, and retention-floor version.
- An observation-turn row MUST store turn identity and prompt kind, Evidence and optional Trace lifecycle/integrity metadata, gap/unknown/provider-event counts, byte/digest metadata for prompt and response boundaries, fence metadata, provider status/timing, and one bounded current-activity projection.
- Trace lifecycle metadata MUST use `none`, `recording`, `sealed`, `published`, or `partial`.
- A trace-enabled turn MUST progress from `none` to `recording` and become `sealed` after complete provider settlement.
- Only a sealed Trace belonging to a writable attempt MAY become `published`.
- An incomplete or failed private Trace MUST become `partial` instead of `published`.
- An observation-entry row MUST store turn identity, deterministic entry id, observation version, source sequence, event time, semantic kind, bounded JSON payload, and exact payload byte count.
- Observation index rows MUST NOT store an exact prompt, steering instruction, response-at-fence, final response, or raw provider frame.
- Each durable turn-start, coalesced current checkpoint, semantic-entry batch, fence, gap, terminal, or recovery mutation MUST increment the run observation version exactly once.
- Persisting a Trace frame MUST NOT increment the run observation version.
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
- `PreparedRunValidationFailure.reason` MUST distinguish `invalid-ir-json`, `invalid-ir`, `ir-mismatch`, `ir-digest-mismatch`, `source-graph-mismatch`, `source-bundle-mismatch`, `package-lock-mismatch`, and `entry-mismatch`.
- New-run and replacement-fork admission MUST validate the closed preparation-lock v2 shape, canonical frozen IR, matching lock metadata, and compiler-owned workflow source reference before mutation; daemon failures use `INVALID_REQUEST`.
- Successful prepared-workflow validation MUST return a Runtime-owned detached value so caller mutation cannot change source, bundle, lock, or IR data after validation and before durable publication.
- A missing, changed, escaping, symbolic-link, or non-regular workspace entry is `entry-mismatch`; runtime-workspace and other filesystem or system failures MUST reject rather than become a prepared-workflow validation failure.
- Canonical frozen-IR admission MUST delegate to Core `validateWorkflowIR(...)`, reject validator errors or existing error diagnostics as `invalid-ir`, accept warning-only diagnostics, and MUST NOT append to or mutate prepared diagnostics.
- A workspace source reference MUST resolve its portable entry and reusable-task referrers beneath the canonical workspace root.
- A snapshot source reference MUST contain exactly its portable entry and `sha256:<hex>` source-graph digest.
- A snapshot prepared workflow MUST contain one canonical `acpus_workflow_source_bundle` v1; workspace prepared workflows MUST NOT contain a source bundle.
- Bundle file paths MUST be safe portable POSIX relative paths in ascending ordinal order, with no duplicates, file/directory prefix conflicts, or NFC/case-folded path or directory-segment collisions, and the exact entry MUST be present.
- Runtime MUST recompute the snapshot source graph as `sha256(stableJsonLine({ kind: "acpus_workflow_source_graph", version: 1, entry, files: [{ path, digest: sha256(utf8Content) }] }))`; it MUST equal both the source reference digest and prepared `sourceGraphDigest`.
- Runtime MUST verify the lock entry digest against the corresponding bundle file for snapshots and the live regular non-symbolic-link workspace entry for workspace sources.
- A source bundle is admission-only: Runtime MUST NOT persist it in SQLite, run capsules, locks, events, fork fingerprints, or public run metadata.
- Admission MUST publish a verified snapshot through a private staging directory, `0700` directories, `0600` files, and atomic rename to `runtime/sources/snapshots/<sha256-hex>/`; an existing digest path MUST have its private modes, manifest, inventory, and contents fully verified before reuse on POSIX platforms.
- A durable snapshot manifest MUST use a closed versioned shape containing the entry, source-graph digest, and ordered file digest inventory; recovery MUST verify its canonical bytes, private modes on POSIX platforms, exact file inventory, and file contents before resolving reusable-task source from `files/`.
- Recovery MUST reject persisted source metadata unless `source_json` agrees with the run workflow entry, source-graph digest, and digest-verified preparation lock source, source-graph, and IR metadata.
- Runtime execution MUST use the run workspace as cwd and fallback dependency authority for bare imports originating in a frozen snapshot.
- `packageLockDigest`, when present, is environment metadata only and MUST NOT contribute to source-graph or fork identity.
- Admission MUST persist exact `workflow.ir.json` and `lock.json` bytes beneath `runtime/runs/<run-id>/`, with run-relative file coordinates and `sha256:<hex>` byte digests.
- Admission MUST initially materialize only `workflow.ir.json` and `lock.json` in a committed run directory.
- Runtime-owned top-level run-directory entries MUST be limited to `workflow.ir.json`, `lock.json`, the optional `artifacts/` tree, and the optional private `evidence/` tree.
- Admission and fork publication MUST fail without removing or replacing a pre-existing staging or final run path.
- A failed admission or fork MUST remove only a staging or final run path created by that operation; concurrent operation and owned-path cleanup failures MUST both remain observable.
- Frozen files and registered artifacts MUST be regular non-symlinks beneath the current shard's non-symlinked runtime runs root; missing, escaping, or mismatched files fail visibly rather than appearing absent.
- Admission MUST atomically persist `run.admitted`, run/public node projections, scheduler bootstrap state, and separately stored Agent overrides before daemon-owned advancement.
- Execution MUST use frozen IR instead of live workflow source and MUST NOT copy reusable task source or dependencies into the run directory; snapshot reusable source lives only in the Runtime source store.
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
- After selected run deletion, Runtime MUST delete only workflow snapshots whose digest no remaining run references.
- A shard MUST be removed only when it has no runs, archives, workflow snapshots, unresolved trash, or live daemon.
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
- Runtime MUST evaluate a Task's complete authored input expression once and normalize the result as one WorkflowData value before recording attempt metadata or starting the Task process.
- Evaluated Task input MUST preserve its exact WorkflowData shape, including a top-level primitive, `null`, array, or object and every own object field such as `__proto__`, without changing an input object's ordinary prototype.
- Task input artifact binding MUST recursively accept an `ArtifactRef` at the input root, in an object field, or in an array element.
- Runtime output normalization MUST treat Task top-level `undefined` as no output, reject scope/array `undefined`, omit undefined object properties, and reject non-WorkflowData values without adding business schemas.
- Task output MUST be normalized immediately before child-process IPC and again at durable result commit; the parent node-executor layer MUST NOT add another cloning or normalization pass.
- Recoverable Task attempt failure MUST contain only `failed`, `cancelled`, or `timed_out` status plus a complete display message; cwd, errno, exit code, signal, and bounded process output details MUST be folded into that message when applicable.
- A Task return value MUST persist through durable scheduler state without creating run-local files unless the Task calls `artifact.write(...)`.
- Attempt deadlines MUST be persisted once; Task and Agent executors consume remaining budgets without re-evaluating authored timeout expressions.
- Timeout and cancellation MUST remain authoritative across startup/result races, reject late output/artifacts, propagate Task `abortSignal`, and terminate the isolated process tree after bounded cooperative cleanup.
- An attempt result commit MUST match an attempt that is still `started`, its `attemptId`, and its active `ownerEpoch`.
- An exact attempt-result idempotency replay by the original still-active owner MAY return the current snapshot without creating a new result commit.
- Attempt-scoped artifact registration MUST match an attempt that is still `started`, its `attemptId`, and its active `ownerEpoch`.
- A post-registration artifact checkpoint failure MUST reject as a system failure without removing the durably registered file.
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
- ArtifactRef path resolution MUST NOT read file bodies or verify recorded size/digest.
- Artifact registry escape, SQLite, permission, and I/O failures MUST propagate rather than become ArtifactRef validation failures.
- Signal prompt, timeout message, and deadline MUST resolve once on awaiting entry; the persisted wait resumes durably from normalized input or fails ancestors with `signal_timeout` on expiry.
- Pause/resume MUST suspend and restore Signal timeout budgets atomically; an unrepresentable restored deadline returns `deadline-out-of-range` without state change.

### Agents

- Agent execution MUST render frozen prompt, cwd, env, permission, session, model, and static Agent `config` values, resolving a directly interpolated ArtifactRef to its verified absolute path.
- Runtime MUST call the [Agent Executor](agent-executor-spec.md) for normalized acpx execution/progress and never parse raw ACP JSON for decisions, summaries, or progress.
- Runtime MUST translate each effective named or command Agent definition into the corresponding [Agent Executor](agent-executor-spec.md) request variant; absent permission defaults to `approve-all`.
- Static Agent `config` is a frozen string-to-string desired ACP option map for a reusable Agent profile; it is not an ACP `configOptions` snapshot or cross-session mutable state and MUST NOT contain secrets.
- The effective model MUST be `config.model ?? model`; `config.model` uses the Agent Executor model path rather than the generic config-option loop.
- Runtime MUST pass `config` only on an initial normal Agent turn; response-repair, plain-continuation, and steering turns MUST omit it.
- Overrides MUST allow only `use`, `command`, `model`, `permissionMode`, `config`, `cwd`, and `env`; an override `config` replaces the complete inherited map, including with `{}`, identity replacement clears inherited model/config, preserves permission, and never accepts `trace`.
- Session identity MUST be run-local and deterministic from explicit non-empty `sessionKey` or dynamic `nodeKey`; repair/retry/resume/steering turns reuse it according to continuation policy.
- Runtime MUST serialize Agent executor admission by effective session identity within one run.
- Runtime MUST NOT admit a steering replacement until the superseded executor using that session has settled.
- Steering replacement settlement gating MUST include draining and sealing the superseded turn's Private Turn Evidence.
- Nodes that explicitly share one `sessionKey` MUST resolve to the same effective Agent backend, model, and config; Runtime does not validate that compatibility constraint.
- Schema-less Agents MUST return raw text with zero response repairs.
- A steering turn MUST use exactly `<steering>${instruction}</steering>` as its Agent-visible correction before any schema-backed output contract.
- A steering turn MUST NOT expose its Runtime steering identity to the Agent.
- A steering turn MUST NOT add explanatory continuation or interruption prose to the Agent-visible correction.
- Every schema-backed Agent prompt, including task, continuation, steering, and response-repair turns, MUST state the Tagged JSON output contract.
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
- A settled Agent turn whose attempt still owns result/artifact/progress writes MUST register `artifacts/<nodeKey>/attempt-<n>/<attempt-id>/agent/turn-<NNN>.json` containing schema version, identities, exact prompt/response, normalized summary/timing, status, and structured terminal detail.
- A fenced Agent turn MUST NOT register a new ordinary turn, stderr, raw, or trace artifact after the fence.
- Turn metadata MUST reference a registered canonical artifact when one exists and otherwise count sealed Private Turn Evidence without embedding prompt, response, timing, complete tools, or filesystem paths; non-empty stderr for a writable attempt uses a separate artifact.
- `ACPUS_AGENT_RAW_ACP_DEBUG=1` MUST be captured at daemon startup and MAY persist exact wire output for a writable turn without affecting execution or repair.
- Top-level Agent `trace: true` MUST enable complete schema-versioned, ordered normalized Trace spooling per turn without requesting an in-memory Runtime trace result from the Agent Executor.
- A recognized Agent failure MUST write terminal progress/metadata once; if that write also fails, the rejection MUST retain both the recognized failure and persistence failure.
- Node progress MUST remain latest-state observation outside scheduler decisions, clear on new attempts, use typed bounded channels, and advance an independent progress version.
- Agent progress MUST retain a bounded response, at most one latest plan or provider-reported-thought intent, bounded tool input/output, and observation completeness for the active owned attempt.

### Private Turn Evidence And Semantic Observation

- Runtime MUST capture each Agent turn through one observation module that owns Private Turn Evidence, bounded semantic projection, optional Trace spooling, fencing, sealing, publication, and recovery.
- Runtime MUST persist each turn's Evidence beneath `runtime/runs/<run-id>/evidence/agents/<attempt-id>/turn-<NNN>.evidence.jsonl.partial`.
- After persisting the provider terminal boundary, Runtime MUST atomically create the corresponding `.evidence.jsonl` path without replacing a different entry, then remove the partial path; retry MAY accept an existing final path only when it has the same opened file identity.
- Runtime MUST persist a trace-enabled turn's private spool beside its Evidence as `turn-<NNN>.trace.jsonl.partial`.
- The `evidence/` tree MUST remain private Runtime data and MUST NOT enter artifact listing, ArtifactRef resolution, Hooks, expressions, workflow output, fork inheritance, or another Agent prompt.
- Runtime MUST create Evidence directories with mode `0700` and files with mode `0600` where POSIX modes are supported.
- Evidence paths MUST use the same containment, real-path, regular-file, and symbolic-link protections as other private Runtime run data.
- Run deletion and pruning MUST delete private Evidence, private Trace spools, and their indexes.
- Fork MUST NOT copy private Evidence or Trace spools into the child run.
- Private Turn Evidence MUST contain only `turn_start`, `fence`, `gap`, and `turn_end` boundary records.
- A `turn_start` record MUST use sequence zero and contain run/node/attempt/turn identity, Agent/session/cwd, prompt kind, exact Agent-visible prompt, Trace-enabled state, and start time.
- A `fence` record MUST contain its reason and, when available, scheduler event sequence/time plus the exact response observed at that fence.
- A fence without an available response snapshot MUST mark that response unavailable and the Evidence degraded.
- A `gap` record MUST identify a real persistence, corruption, queue-overflow, or recovery loss by scope, count, bytes, and reason.
- Semantic-retention eviction MUST NOT create a gap or mark Evidence degraded.
- A `turn_end` record MUST contain the exact final observed response, provider outcome, timing, bounded failure, and a bounded summary without a complete tool-call array.
- The semantic entry/current budgets MUST NOT truncate the exact prompt, response-at-fence, or final response stored in Private Turn Evidence.
- Evidence records and provider requests MUST NOT contain a Runtime steering identity.
- Evidence prompts MUST preserve the steering prompt rules in [Agents](#agents), including the complete schema contract when present and no explanatory prefix.
- A response-repair turn MUST preserve only its repair prompt as Evidence and MUST NOT repeat the steering instruction.
- Runtime MUST durably persist `turn_start`, its Evidence index row, and the optional Trace header before dispatching the provider.
- Runtime MUST revalidate attempt identity and its abort/fence after durable turn start and before provider dispatch.
- Runtime MUST continue observing a superseded provider until its process settles.
- Runtime MUST seal Evidence and any Trace spool after provider settlement and before evaluating whether the attempt may register artifacts or commit a result.
- Runtime MUST revalidate attempt ownership before artifact registration and again before output conformance, repair, or scheduler result commit.
- A late provider success MAY set the private provider outcome to `completed` but MUST NOT change a superseded scheduler disposition from discarded.
- A superseded attempt's late output, ordinary artifact registration, progress writes, and result commit MUST remain fenced.
- An artifact registered before a fence MAY remain registered.
- Cleanup of an unregistered post-fence artifact file MUST NOT delete Private Turn Evidence or a private Trace spool.
- Runtime MUST fold normalized provider observations into bounded current activity and closed semantic entries when they are received.
- Runtime MUST merge consecutive assistant chunks into one response segment and consecutive thought or plan chunks into the corresponding intent segment.
- Runtime MUST fold calls and updates sharing one tool-call id into one tool entry.
- Runtime MUST retain usage observations in node progress, terminal turn summaries, Private Turn Evidence, and opt-in Trace diagnostics without adding them to semantic current activity or Timeline entries.
- Runtime MUST exclude unknown-provider payload bodies from semantic persistence while counting unknown events and marking observation completeness degraded.
- A tool, channel change, fence, gap, or turn terminal boundary MUST close the applicable open semantic segment.
- Runtime MUST close pre-fence segments before the steer control marker and order subsequent late provider activity after that marker.
- An open semantic segment MUST exist only in a turn's bounded current projection.
- A closed semantic segment MUST exist only in `agent_observation_entries`.
- A trace-disabled turn MUST NOT persist normalized provider frames.
- One attempt MUST retain at most 128 closed semantic entries and at most 128 KiB of their JSON payloads.
- A turn's serialized current projection MUST contain at most 16 KiB.
- Inserting semantic entries and evicting the oldest entries required by either retention limit MUST occur in one SQLite transaction.
- Retention eviction MUST increment the attempt's retention-omitted count and advance its retention-floor version.
- Retention eviction MUST NOT increment the Evidence gap count or reduce observation completeness.
- Runtime MUST checkpoint response or intent growth after at least 512 additional bytes or ten seconds since the preceding checkpoint.
- Runtime MUST checkpoint phase changes, tool start/terminal, fence, gap, and turn terminal immediately.
- A usage-only observation MUST NOT advance the inspection-visible observation version.
- A trace-enabled turn MUST spool every normalized observation in arrival order without persisting those provider frames in Private Turn Evidence or the SQLite semantic projection.
- A Trace spool MUST start with `turn_start` at sequence zero, assign each observation `event.sequence + 1`, and end with `turn_end`.
- A Trace spool MUST NOT contain a prompt, fence, steering instruction, or Runtime steering identity.
- Runtime MUST use a fixed 64 KiB Trace write buffer and flush it when full and at fence or terminal boundaries.
- Runtime MUST synchronize and seal a complete Trace spool after the provider process settles.
- Runtime MUST atomically create the corresponding private `.trace.jsonl` path without replacing a different entry, then remove the partial path; retry MAY accept an existing final path only when it has the same opened file identity.
- After revalidating artifact ownership, Runtime MUST copy a sealed Trace spool to `artifacts/<nodeKey>/attempt-<n>/<attempt-id>/agent/turn-<NNN>.trace.jsonl` and register it with the spool's size and digest.
- Runtime MUST remove the private Trace spool after successful artifact registration on a best-effort basis.
- A failed Trace registration MUST remove only its unregistered public copy and retain the private spool.
- A missing Trace spool or Trace copy/registration failure for a writable attempt MUST reject execution as a system failure.
- A fence that wins before Trace registration MUST retain the private spool without registering a public trace artifact.
- A Trace artifact registered before a later fence MUST remain registered.
- Failure to seal Evidence or Trace for an active writable attempt MUST reject execution as a system failure.
- Failure to seal Evidence or Trace for a fenced attempt MUST preserve the durable control and replacement admission while marking the private record partial/degraded.
- Evidence sealing means the provider terminal boundary is durable; Runtime MAY append one idempotent post-settlement fence annotation and recompute Evidence metadata.
- Writable-store recovery MUST index complete unindexed Evidence boundary records.
- Recovery MUST represent an incomplete Evidence trailing record as a gap rather than inventing its content.
- Recovery MUST seal partial Evidence containing a valid `turn_end`.
- Recovery MUST mark open Evidence for a terminal or superseded attempt as partial without inventing a provider outcome or final response.
- Recovery MUST close a recoverable bounded current checkpoint with a deterministic semantic entry id.
- Recovery MUST seal a partial Trace only when its sequence is complete and it contains a terminal record.
- Recovery MUST retain an incomplete Trace as partial without inventing a terminal record.
- Recovery MAY remove an orphan partial file with no index when provider dispatch was never admitted.
- Recovery MAY remove a private Trace spool when the deterministic registered trace artifact has the same size and digest.
- Opening a Runtime store MUST NOT trigger Evidence recovery.
- Runtime MUST NOT recover Evidence while its indexed scheduler attempt remains `started`.
- Executable-run Evidence recovery MUST occur only after the daemon has claimed that run and superseded attempts owned by expired epochs.
- Terminal-run Evidence recovery MUST occur only after daemon startup owns both its endpoint and durable daemon lease.
- Evidence recovery MUST NOT participate in scheduler decisions.

### Controls And Daemon

- The steer control wire variants MUST use the following closed shapes.

```ts
type DaemonSteerControlIntent = {
  requestId: string;
  type: "steer";
  runId: string;
  target: string;
  instruction: string;
};

type DaemonSteerControlResult = {
  type: "steer";
  state: "applied";
  run: RunDetails;
  steerId: string;
  requestedTarget: string;
  target: string;
  fencedAttemptId: string;
  continuation: "queued";
};
```

- A steer instruction MUST contain non-whitespace text.
- Apart from validating non-whitespace content, Runtime MUST persist a steer instruction without trimming or normalization.
- The daemon MUST expose `admitRun(prepared, input, agentOverrides?)`, `control(intent)`, `shutdown()`, and `status()` over a workspace-derived Unix socket or equivalent named pipe, never an HTTP port.
- The daemon protocol version MUST be exactly `2`, exposed through the public `DAEMON_PROTOCOL_VERSION` constant and daemon status/lease metadata.
- Requests and responses MUST use closed JSON shapes; responses are `{ ok: true, result }` or `{ ok: false, error: { code, message } }`.
- Prepared workflow requests MUST accept only the current workspace-or-snapshot union, lock v2, and bundle v1 shapes; Runtime MUST NOT parse protocol-v1 prepared workflow fields.
- Daemon clients MUST NOT impose a unilateral response deadline on admission because disconnecting cannot prove that a durable mutation did not commit; idempotent controls MAY retain their bounded transport timeout, and status and shutdown probes MAY retain shorter bounded transport timeouts.
- Daemon client functions MUST return `ResultAsync` with `rejected`, `transport`, and `protocol` failures while the socket wire remains ordinary JSON.
- Successful admission and control responses MUST validate the closed required `RunDetails`, `RunStatus`, execution-state, JSON-value, and control-result shapes; a control result type MUST match the requested intent, and malformed success data is a `protocol/result` failure.
- Public errors MUST use only `INVALID_REQUEST`, `RUN_NOT_FOUND`, `RUN_NOT_CONTROLLABLE`, `CONTROL_CONFLICT`, `EXECUTION_UNAVAILABLE`, `STORE_BUSY`, `STORE_ERROR`, and `INTERNAL_ERROR`, with actionable text but no lease/SQLite/projection internals.
- Unknown daemon handler failures MUST become sanitized `INTERNAL_ERROR` responses and MUST NOT be classified as business control failures.
- Socket binding MUST arbitrate one daemon per workspace; a valid response proves liveness, while stale removal requires local evidence of a dead/expired owner.
- The daemon MUST host one serialized-write execution session per active/recoverable run, permit different runs concurrently, and keep long executor waits from blocking controls.
- Session start MUST distinguish `started`, `already-active`, `terminal`, and `quarantined`; daemon tick activity counts only `started` executions and dispatched hook work.
- Pause/cancel MUST durably fence their effect and abort only applicable active attempt controllers; late executor results cannot overwrite control state.
- Steer MUST resolve an exact started Agent attempt from an `attemptId`, dynamic `nodeKey`, or unambiguous static Agent id within the control transaction.
- An ambiguous static steer target MUST return `CONTROL_CONFLICT` with deterministically sorted candidate node keys.
- A steer target that is absent, non-Agent, or no longer started MUST return `RUN_NOT_CONTROLLABLE`.
- A rejected steer target MUST append no events.
- An accepted steer MUST atomically persist `control.agent_steer_requested`, supersede the targeted attempt as `operator_steered`, and requeue its node instance as `steered`.
- The accepted steer transaction MUST return the committed control event sequence and time to the Runtime Evidence layer.
- In the same control call stack, Runtime MUST snapshot the exact response observed at that committed fence and idempotently enqueue one private fence record before waking the scheduler.
- A replayed steer request MUST NOT create a duplicate private fence record.
- When no active observation handle is available, inspection MUST retain the durable fence and report unavailable response-at-fence evidence as degraded.
- Runtime MUST best-effort flush the private fence record before returning the existing steer receipt.
- An accepted steer MUST fence the superseded attempt's result commits before returning its receipt.
- An accepted steer MUST fence the superseded attempt's artifact commits before returning its receipt.
- An accepted steer MUST fence the superseded attempt's progress commits before returning its receipt.
- An accepted steer MUST request best-effort abort of the superseded Agent turn.
- Pause, cancel, and owner-loss handling MUST add a fallback private fence for each affected active Agent turn.
- Runtime MUST NOT roll back external side effects already performed by a superseded Agent turn.
- A steering replacement MUST reuse the frozen run, input, node configuration, Agent mapping, and output schema.
- A steering replacement MUST reuse the effective ACP session.
- A steering replacement MUST receive a newly resolved full attempt timeout.
- When pause, owner loss, or daemon recovery interrupts a steering attempt, Runtime MUST preserve its steering identity and instruction for requeue.
- Completion, failure, timeout, or explicit cancellation of a steering attempt MUST consume its pending steering directive.
- Steering recovery MUST provide at-least-once instruction delivery and MAY redeliver the same instruction after an interruption.
- A later steer of an active steering attempt MUST replace the earlier pending steering directive.
- Replaying a steer with the same request identity, target, and instruction MUST return its original receipt without appending events.
- Replaying a steer request identity with a different target or instruction MUST return `CONTROL_CONFLICT`.
- A successful steer result MUST NOT expose the instruction.
- Runtime MUST reject steer when another started attempt shares the target's effective session identity.
- A rejected shared-session steer MUST NOT issue session-wide cancellation.
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
- Run-level cancel MUST remain applicable before root-frame materialization, including after such a pending run has been paused.
- Runtime MUST use one pure retry/cancel planner for mutation admission and read-side applicability; Web, CLI, and inspection projections MUST NOT reconstruct target legality from statuses or dynamic-table rows.
- A read-side retry target MUST be an exact planner-approved `nodeKey` or public node/loop `frameKey`, MUST NOT be a group-member identity, and MUST be ordered by exact target key with duplicates rejected as corruption.
- Read-side retry applicability MUST use the same pure frozen-workflow settlement that mutation admission performs before planning, without persisting its derived events; read-side cancel applicability MUST remain based on the durable pre-settlement snapshot used by cancel mutation.
- Read-side cancel applicability MUST distinguish a useful run cancellation from an idempotently accepted terminal no-op and MUST expose a selected target only as an exact planner-approved dynamic key.
- Read-side control applicability is advisory; every submitted control MUST resolve and validate again inside the control transaction.
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
- Read-only inspection MUST validate persisted frozen IR, lock, and source metadata without resolving or hashing a workflow snapshot; execution and explicit frozen-run source resolution MUST fully verify the snapshot before returning its source root.
- `getRuntimeHealth` MUST expose the current workspace shard root as `persistence.path` even when the shard is not initialized.
- When an active database has the Acpus application id and a positive storage version older than the current version, `getRuntimeHealth` MUST return `ok: true`, `state: "unreadable"`, and a `store` warning.
- That warning MUST use `Runtime storage version <observed> is older than the supported version <expected>. Doctor made no changes. This workspace remains usable; starting a new workflow run will prepare compatible storage automatically.`
- `getRuntimeHealth` MUST retain a `store` failure for storage version zero, a newer storage version, a mismatched application id, and every other database-open failure.
- `listRuns` MUST order by `updatedAt DESC, createdAt DESC`; `getRun` omits `dynamic` only when every dynamic collection is empty and fails visibly on decode/invariant errors.
- `getRunVisualizationSnapshot` MUST return run details, visualization overlay, useful run-cancel applicability, and every exact planner-approved retry target from one SQLite read snapshot, including targets accepted during a non-terminal failure-propagation window.
- Visualization control targets MUST contain only exact target, node/frame kind, and optional authored node id; they MUST NOT contain display labels, scheduler Result values, or group-member identities.
- `getRunInspection(cwd, query)` MUST return tagged `ResultAsync` results in the following modes.

| Mode | Projection |
| --- | --- |
| overview | Versioned compact occurrence tree, exact status counts, sparse items, available operations, omitted counts, terminal output. |
| all | Complete occurrence-expanded execution tree without exposing raw tables. |
| target | Bounded decision summary for one static node, dynamic node, frame, or attempt; an exact Agent attempt includes a bounded evidence capsule. |
| timeline | Bounded current activity plus the latest closed semantic history for one resolved target. |
| details | Rich node/frame/attempt dossier with history, progress, Signal, execution metadata, artifact references, and exact applicable retry/cancel controls for explicit Web/operator consumers. |
| execution | Closed, bounded Agent execution telemetry for one resolved occurrence and selected attempt. |
| raw | Unbounded run details, complete frozen `WorkflowIR`, and artifact registry. |

```ts
type RunInspectionQuery =
  | { runId: string; mode: "overview" }
  | { runId: string; mode: "all" }
  | { runId: string; mode: "target"; target: string; context?: RunInspectionContext; view?: "summary" }
  | {
      runId: string;
      mode: "timeline";
      target: string;
      context?: RunInspectionContext;
      page?: { limit?: number; before?: string };
    }
  | { runId: string; mode: "details"; target: string; context?: RunInspectionContext }
  | { runId: string; mode: "execution"; target: string; context?: RunInspectionContext }
  | { runId: string; mode: "raw" };
```

Execution mode MUST use this closed document shape.

```ts
type RunInspectionAgentExecutionToolCall = {
  turn: number;
  toolCallId?: string;
  toolName?: string;
  status?: string;
  durationMs?: number;
  inputPreview?: string;
};

type RunInspectionSubject = {
  targetKind: "static-node" | "dynamic-node" | "frame" | "attempt";
  id: string;
  label: string;
  kind: string;
  nodeId?: string;
  nodeKey?: string;
  attemptId?: string;
  attemptNo?: number;
};

type RunInspectionAgentExecutionDocument = ({
  available: true;
  reason?: never;
} | {
  available: false;
  reason: "not-agent" | "not-started";
}) & {
  schemaVersion: 2;
  kind: "execution";
  run: {
    id: string;
    status: RunStatus;
    updatedAt: string;
  };
  subject: RunInspectionSubject;
  summary: {
    status: RunInspectionStatus;
    sessionName?: string;
    turnCount?: number;
    message?: string;
  };
  lastObservedAt?: string;
  contextWindow?: {
    used?: number;
    size?: number;
    percent?: number;
    updatedAt?: string;
  };
  tokenUsage?: {
    source?: "prompt_response" | "usage_update";
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  output?: {
    tail: string;
    totalBytes: number;
    truncated: boolean;
  };
  toolCallCount?: number;
  lastToolCalls: RunInspectionAgentExecutionToolCall[];
  recentToolsIncomplete: boolean;
};
```

- Details mode MUST NOT include timeline entries or Private Turn Evidence bodies.
- Execution mode MUST return `available: false` with `reason: "not-agent"` for a resolved non-Agent target and `reason: "not-started"` for a resolved Agent occurrence without an attempt.
- Execution mode MUST require one resolved occurrence. A static target with multiple occurrences MUST return typed `target-ambiguous` with deterministically sorted candidate node keys unless `context` disambiguates it.
- An exact-attempt execution query MUST select that attempt. An unambiguous node, frame, or static-occurrence query MUST select its latest matched attempt by descending attempt number, then descending start time and attempt id.
- Execution metadata, progress, and observations MUST be filtered to the selected attempt before projection; an exact historical attempt MUST NOT inherit telemetry from an earlier or later attempt on the same node.
- Execution `summary.status` MUST come from the durable scheduler target state. Execution metadata, progress, and observations MAY supply supplementary telemetry but MUST NOT override scheduler lifecycle status.
- Execution mode MUST perform at most one observation-projection read for the selected attempt and MUST request only the latest semantic page under the fixed 50-entry and 8 KiB page budgets.
- That observation read MUST push the exact attempt filter into SQLite and materialize at most its latest durable turn evidence; it MUST NOT scan or materialize unrelated attempts or the selected attempt's complete turn history.
- Execution mode MUST NOT read registered Agent turn artifacts, Private Turn Evidence bodies, Trace bodies, or any other artifact body.
- Execution mode MUST exclude post-fence current activity and semantic tool entries from projected telemetry.
- Execution `lastToolCalls` MUST contain at most three normalized calls.
- For an available execution document, `recentToolsIncomplete` MUST be true whenever retention, pagination, observation gaps, post-fence exclusion, omitted or malformed activity, or a known tool-call count prevents Runtime from proving that `lastToolCalls` is complete. It MUST be false only when Runtime can prove completeness; unavailable documents MUST return an empty `lastToolCalls` and `recentToolsIncomplete: false`.
- Raw mode MUST NOT append Private Turn Evidence, private Trace bodies, or provider raw payloads.
- The public query union MUST use `context` only for target, timeline, details, and execution resolution; target accepts only `view?: "summary"`, while timeline accepts only `page?: { limit?: number; before?: string }`.
- Inspection schema version 2 MUST replace prior inspection schemas without a compatibility shim.
- A timeline page cursor MUST be opaque and bind the run, resolved target, ordering version, and page boundary.
- Opaque encodings MUST bind authored target identities through fixed-size fingerprints rather than copy unbounded authored text into bounded inspection documents.
- A timeline page cursor used with a different run or resolved target MUST return typed `invalid-cursor`.
- An unsupported timeline page-cursor encoding version MUST return typed `invalid-cursor`.
- A timeline page cursor whose boundary has expired from semantic retention MUST return typed `invalid-cursor`.
- Ambiguous target resolution MUST return typed `target-ambiguous` with deterministically sorted candidate node keys when the requested view requires one occurrence.
- `target-ambiguous` MUST contain the run id, requested target, sorted `candidateKeys`, and message.
- `invalid-cursor` MUST contain the run id, optional requested target, and message.
- A target summary MUST use this closed top-level shape.

```ts
type RunInspectionTargetSummaryDocument = {
  schemaVersion: 2;
  kind: "target";
  run: { id: string; status: RunStatus; updatedAt: string };
  subject: {
    targetKind: "static-node" | "dynamic-node" | "frame" | "attempt";
    id: string;
    label: string;
    kind: string;
    nodeId?: string;
    nodeKey?: string;
    attemptId?: string;
    attemptNo?: number;
  };
  state: {
    status: RunInspectionStatus;
    reason?: string;
    startedAt?: string;
    finishedAt?: string;
    deadlineAt?: string;
    durationMs?: number;
  };
  pulse?: RunInspectionPulse;
  attention?: RunInspectionAttention;
  visibility?: RunInspectionVisibility;
  availableActions: RunInspectionAction[];
  occurrence?: { total: number; counts: RunInspectionStatusCounts };
  evidence?: AgentAttemptEvidenceCapsule;
};

type RunInspectionPulse = {
  phase: "starting" | "responding" | "reported-thought" | "planning" | "tool" | "output-repair" | "settling" | "settled";
  headline?: string;
  turn?: number;
  updatedAt: string;
};

type RunInspectionAttention = {
  code: "terminal_failure" | "timed_out" | "awaiting_input";
  summary: string;
};

type RunInspectionVisibility = {
  state: "degraded";
  reason:
    | "boundary-evidence-unavailable"
    | "observation-gap"
    | "unrecognized-provider-activity";
};

type RunInspectionAction =
  | { kind: "inspect-timeline"; target: string }
  | { kind: "follow-target"; target: string }
  | { kind: "steer"; target: string }
  | { kind: "signal"; target: string; schemaSummary?: string }
  | { kind: "retry"; target?: string }
  | { kind: "fork"; target?: string };

type RunInspectionExcerpt = {
  text: string;
  originalBytes: number;
  truncated: boolean;
};
```

- A target summary MUST omit instance, frame, attempt, Signal-wait, execution-metadata, progress, and artifact arrays and complete input/output bodies.
- A target summary's `availableActions` MUST contain only `RunInspectionAction` values.
- A target summary pulse MUST use one phase from `starting`, `responding`, `reported-thought`, `planning`, `tool`, `output-repair`, `settling`, or `settled`, one optional headline, optional turn, and update time.
- A pulse headline MUST contain no more than 240 visible characters.
- Runtime MUST choose at most one pulse headline in this order: active tool; latest meaningful plan or provider-reported thought; response tail; starting state.
- A terminal pulse MUST NOT select a stale failed tool from progress.
- A settled pulse without an evidence-backed headline MUST omit its headline rather than report `starting`.
- Runtime MUST NOT infer thought that the provider did not report.
- A target summary MUST contain at most one attention item.
- Attention MUST use a summary of no more than 160 visible characters and one code from `terminal_failure`, `timed_out`, or `awaiting_input`.
- Runtime MUST select attention only for terminal failure/timeout or an awaiting Signal.
- Context or usage metrics, elapsed observation age, an isolated tool failure, visibility degradation, and an available control MUST NOT create attention.
- Runtime MUST NOT classify an Agent as stalled from elapsed update time, classify drift from repeated tools, judge semantic correctness, or prescribe steering.
- A target summary MUST expose `visibility` only while inspection completeness is degraded.
- When multiple visibility reasons apply, Runtime MUST select `boundary-evidence-unavailable`, then `observation-gap`, then `unrecognized-provider-activity`.
- Visibility MUST describe inspection completeness without asserting an Agent execution fault or prescribing steering.
- A target summary MUST contain no more than two available actions.
- Available actions MUST be ordered by operator value: a started Agent exposes timeline then exact-attempt steer; a running Task/composite exposes timeline then follow; an awaiting Signal exposes signal then timeline; a failed/timed-out target exposes planner-approved retry then fork, or fork alone when targeted retry is not applicable.
- A steer action MUST target the exact started attempt id.
- Retry and targeted-fork actions MUST use identities accepted by their control resolvers rather than scheduler attempt ids; fork MUST omit its optional target when no safe replacement-workflow target is available.
- Completed and cancelled target summaries MUST expose no available actions.
- An available action MUST express applicability without asserting that the operator ought to execute it.
- Details `availableControls` MUST contain only exact retry/cancel targets accepted by the shared planner on that inspection snapshot and MUST be empty for aggregate, missing, completed/cancelled, ambiguous, or otherwise inapplicable targets.
- When an untyped inspection target resolves to an exact scheduler identity that collides with an authored node id for a different entity, details controls MUST fail closed.
- An exact historical attempt MUST NOT inherit controls for a later attempt with the same node key. The latest exact started attempt MAY expose cancel, and the latest exact failed/timed-out attempt MAY expose retry; completed, cancelled, superseded, and non-latest attempts MUST expose no controls.
- An exact Agent attempt summary MUST include this evidence capsule.
- Every other target summary MUST NOT include an evidence capsule.

```ts
type AgentAttemptEvidenceCapsule = {
  directory: string;
  state: "recording" | "sealed" | "partial";
  completeness: "complete" | "degraded";
  turnCount: number;
  omittedTurns: number;
  gapCount: number;
  providerOutcome?: "completed" | "failed" | "cancelled" | "timed_out";
  schedulerDisposition: "pending" | "committed" | "discarded";
  dispositionReason?: string;
  records: Array<{
    turn: number;
    file: string;
    prompt: {
      kind: "task" | "continuation" | "steer" | "repair";
      bytes: number;
      digest: string;
    };
    lastDurableResponseBytes: number;
    responseAtFenceBytes?: number;
    finalObservedResponseBytes?: number;
    trace?: {
      state: "recording" | "sealed" | "partial" | "published";
      file?: string;
      bytes?: number;
      digest?: string;
    };
  }>;
};
```

- An evidence capsule MUST include at most the first and latest distinct turn records.
- `omittedTurns` MUST report turns excluded from the capsule.
- `directory` plus each `file` MUST identify the exact Private Turn Evidence path without repeating a long absolute path.
- A private Trace `file` MUST be present only while its private spool exists.
- An evidence capsule MUST NOT include prompt, response, thought, tool, steering instruction, or steering identity content.
- A timeline document MUST use this closed top-level shape.

```ts
type RunInspectionTimelineDocument = {
  schemaVersion: 2;
  kind: "timeline";
  run: { id: string; status: RunStatus; updatedAt: string };
  subject: RunInspectionTargetSummaryDocument["subject"];
  state: RunInspectionTargetSummaryDocument["state"];
  visibility?: RunInspectionVisibility;
  current?: RunInspectionCurrentActivity;
  recent: {
    entries: RunInspectionTimelineEntry[];
    returned: number;
    omittedBefore: number;
    hasOlder: boolean;
    olderCursor?: string;
    retentionOmittedBefore?: number;
  };
};

type AgentCurrentActivity = {
  kind: "agent";
  attemptId: string;
  attemptNo?: number;
  postFence?: true;
  turn?: number;
  turnKind?: "task" | "continuation" | "steer" | "repair";
  phase: RunInspectionPulse["phase"];
  updatedAt: string;
  response?: RunInspectionExcerpt;
  intent?: {
    kind: "plan" | "reported-thought";
    excerpt: RunInspectionExcerpt;
  };
  tools?: {
    active: RunInspectionToolActivity[];
    omittedActive: number;
  };
};
```

- Agent current activity MUST contain the exact attempt id, optional attempt number and post-fence disposition, optional turn and turn kind, phase, update time, optional bounded response, at most one latest plan or provider-reported-thought intent, and bounded active-tool state.
- Agent current activity MUST include no more than two active tools.
- Task, Signal, and composite current activity MUST use corresponding small discriminated variants without Agent-only empty fields.
- Agent current activity MUST use its persisted semantic current projection when available.
- When that projection is unavailable, Agent current activity MAY fall back to bounded node progress when present.
- A timeline entry MUST use exactly one of these four semantic forms.

```ts
type RunInspectionTimelineEntry =
  | { id: string; kind: "transition"; at: string; action: RunInspectionChangeAction; status?: RunInspectionStatus; attemptId?: string; attemptNo?: number; summary?: RunInspectionExcerpt }
  | { id: string; kind: "activity"; at: string; attemptId?: string; attemptNo?: number; postFence?: true; turn?: number; channel: "response" | "reported-thought" | "plan" | "tool"; summary: RunInspectionExcerpt; tool?: RunInspectionToolActivity }
  | { id: string; kind: "control"; at: string; action: "steered" | "paused" | "resumed" | "retried" | "cancelled"; attemptId?: string; attemptNo?: number; responseAtFenceBytes?: number }
  | { id: string; kind: "gap"; at: string; dropped: number; reason: string };
```

- An open tool or response segment MUST appear only in `current`.
- A segment MUST move into `recent` after a tool, control, or turn-terminal boundary closes it.
- Runtime MUST merge consecutive assistant chunks into one response segment and consecutive thought or plan chunks into the corresponding intent segment.
- Runtime MUST fold calls and updates sharing one tool-call id into one upsertable item.
- Runtime MUST fold the control request, supersede, requeue, and fence for one accepted steer into one control entry.
- An observation-backed steer control MUST retain the durable scheduler event identity while closing pre-fence response, intent, and tool segments before that control, including when their timestamps share the same millisecond.
- A superseded provider's late response MUST order after its steer control entry.
- A superseded provider's post-fence current activity and Timeline entries MUST carry `postFence: true`; replacement activity MUST NOT.
- Usage MUST NOT create a Timeline entry or semantic current-activity change.
- Unknown provider events MUST affect omitted/degraded accounting instead of creating one entry per event.
- Inspection MUST read Agent current activity, semantic entries, retention state, and Evidence metadata from SQLite without reading Private Turn Evidence or Trace bodies.
- A timeline is an operational projection and MUST NOT expose a raw transcript, Private Turn Evidence body, or Trace frame.
- Target resolution MUST prefer exact attempt id, dynamic node key, frame key, then static node id.
- An exact attempt timeline MUST contain only that attempt lifecycle and its observations.
- A dynamic-node timeline MUST join that node's attempts, including a steering replacement.
- A frame/root timeline MUST contain only directly owned scheduler transitions and MUST NOT recursively expand descendants.
- A static node that has not run MUST return `not_started` with an empty timeline.
- A static target with multiple occurrences MAY return aggregate counts in summary mode.
- A static target with multiple occurrences MUST return `target-ambiguous` for timeline mode unless `context` disambiguates it.
- Non-Agent targets MUST remain valid timeline subjects without Agent current activity.
- A serialized target-summary document MUST fit within 4 KiB, except an exact-attempt evidence capsule MAY increase it to 6 KiB.
- Timeline current response MUST contain no more than 1536 UTF-8 bytes.
- Timeline current intent MUST contain no more than 768 UTF-8 bytes.
- The combined input/output excerpt for one current tool MUST contain no more than 768 UTF-8 bytes.
- Timeline MUST default to 12 recent entries and accept limits from 1 through 50.
- One recent entry body MUST contain no more than 512 UTF-8 bytes.
- One recent page MUST contain no more than 8 KiB of entry bodies and MAY return fewer than the requested limit to preserve that budget.
- Timeline `returned` MUST equal the number of returned entries and `omittedBefore` MUST count older entries excluded from that page.
- Timeline `hasOlder` MUST be true only while older retained entries remain readable.
- A timeline with readable older entries MUST expose an opaque `olderCursor`.
- Timeline `retentionOmittedBefore` MUST count entries expired from the fixed semantic-retention window and MUST be omitted when zero.
- Every truncated excerpt MUST preserve valid UTF-8 and report exact `originalBytes` plus `truncated`.
- Inspection byte and entry budgets MUST be fixed Runtime policy rather than caller-selected byte, token, or verbosity configuration.
- Snapshot items MUST form a unique-keyed, parent-before-child preorder tree whose `parentKey` values resolve within the same snapshot.
- Snapshot item keys MUST remain stable for the same authored node or dynamic scope occurrence across follow polls and MUST be treated as opaque by consumers.
- `RunInspectionItem.scope` MUST use the following closed additive shape while inspection documents retain `schemaVersion: 2`.

```ts
type RunInspectionScopeState =
  | { kind: "branch"; ownerKind: "if" | "switch"; branchId: string; selection: "undecided" | "selected" | "not_selected"; empty: boolean }
  | { kind: "branch"; ownerKind: "parallel"; branchId: string; empty: boolean }
  | { kind: "fanout_item"; itemIndex: number; empty: boolean }
  | { kind: "loop_iteration"; iteration: number; round: number; empty: boolean };
```

- A scope state's `empty` field MUST be true exactly when its frozen authored scope contains no nodes.
- Overview snapshots and patches MUST expose applicable operations only through `availableActions`.
- Occurrence-targeted inspect, Signal, and retry entries in `availableActions` MUST carry the corresponding snapshot `itemKey`; a fork entry MAY carry that `itemKey`, while an inspect-all entry remains run-wide without one.
- Inspection MUST parent repeated nodes and scopes by exact dynamic occurrence identity rather than by static `nodeId` alone.
- Inspection preorder MUST retain authored node order within each scope, authored If/Switch route and Parallel branch order, Switch case-before-default order, ascending Fanout `itemIndex`, and ascending Loop `iteration`.
- For each materialized If or Switch occurrence, all-mode inspection MUST emit every authored route in authored order, mark its selection state, and expand only the selected route.
- For each materialized Parallel occurrence, all-mode inspection MUST emit every authored branch in authored order and expand only branches whose durable member or scope frame is materialized.
- All-mode inspection MUST emit every persisted Fanout item and Loop iteration, including an empty scope.
- Within each materialized scope, all-mode inspection MUST represent each authored but unmaterialized direct node once as a `not_started` placeholder.
- All-mode inspection MUST NOT invent a future Fanout item or Loop iteration.
- All-mode inspection MUST contain neither fold items nor omitted-context metadata.
- Overview and all-mode inspection MUST expose the same compact fields for the same occurrence; they differ only in occurrence visibility, folds, and omitted metadata.
- Overview and all-mode Agent items MUST use this closed decision state:

```ts
type AgentDecisionState = {
  key: string;
  turn?: number;
  activeTool?: { command: string; status?: string };
};
```

- Overview and all-mode Agent items MUST NOT expose backend, model, telemetry availability, context, token usage, aggregate Agent usage counters, stop reason, or observation time. Current turn identity remains lifecycle attribution, not a usage counter.
- Overview MUST count every dynamic leaf context, represent an unmaterialized authored leaf once, and exclude grouping rows.
- Overview MUST bound ordinary expanded dynamic leaf contexts to 20 while retaining every failed, timed-out, awaiting, or retried occurrence and its ancestry outside that budget.
- Overview MUST compact repeated completed or cancelled occurrences when needed to preserve its bounded presentation and MUST retain valid parent links after compaction. Each fold MUST replace one contiguous run of hidden sibling occurrences under the same parent and MUST NOT aggregate across an outer occurrence.
- Overview and all-mode run summaries MUST NOT expose aggregate Agent usage counts.
- A failed inspection run summary MUST expose the compact failure from its persisted root frame when that frame contains an error.
- A root-frame failure MUST NOT create a synthetic overview/all item.
- Target `root` MUST retain the bounded root-frame failure in its decision summary.
- A static target matching multiple dynamic contexts MUST expose aggregate status and exact status counts while omitting instance-specific input, output, failure, keys, prompt, attempt, Agent, and Signal detail; a single matching context retains its resolved summary and zero matches remain `not_started`.
- Inspection static topology nodes MUST NOT duplicate Task input expressions.
- Task details MUST expose the exact normalized runtime input when attempt metadata exists and otherwise expose one rendering of the complete authored input expression.
- Public artifact records MUST expose absolute `path` without exposing internal relative storage coordinates.
- `listArtifacts` MUST return registry metadata without reading file bodies.
- `listArtifacts` MUST return `[]` for an empty existing run and `undefined` for a missing run or store.
- `readArtifact(cwd, runId, artifactId): Promise<{ artifact: ArtifactRecord; bytes: Buffer } | undefined>` MUST return the artifact record and bytes after verifying the registered file's run containment, non-symlink regular-file identity, recorded size, and digest.
- A verified artifact read MUST NOT consume or wait on a non-regular replacement target before validating its descriptor type and bound identity.
- `readArtifact` MUST return `undefined` for a missing store, run, or artifact registry row.
- A registered artifact that is missing, escapes its run, is a symlink or non-regular file, or fails its recorded size or digest MUST make `readArtifact` reject as durable corruption.
- Runtime details inspection MUST represent a persisted canonical turn prompt as an artifact descriptor with `field: "prompt"` and MUST NOT embed the prompt body.
- Attempt details inspection MUST select attempt-scoped prompt, metadata, and progress from that exact attempt.
- Node details inspection MUST select attempt-scoped prompt, metadata, and progress from its latest matched attempt.
- Repeated composite details inspection MUST associate group membership by dynamic `nodeKey` and MUST NOT reuse a group matched only by static `nodeId`.
- Rich Agent details MUST use the authored Agent key, typed effective backend/counters, `lastObservedAt`, explicit context/token availability, and at most three bounded normalized tool commands without command text or payloads.
- Rich Agent turn count MUST use the greatest value from persisted attempt metadata, Private Turn Evidence, and live progress so polling cannot regress.
- Compact Signal details MUST bound prompt/schema summaries, preserve complete target/raw values, and expose inspect/retry/fork rather than signal actions after `signal_timeout`.
- Failure inspection MUST preserve stable origin/code and bounded upstream acpx/RPC cause without raw ACP lines or broad text-prefix reclassification.
- `followRunInspection` MUST be a read-only async iterable that terminates only on terminal state, caller abort, or tagged error.
- Follow emissions MUST use the following closed schema-version-2 union.

```ts
type RunInspectionEmission =
  | { schemaVersion: 2; kind: "snapshot"; document: FollowableInspectionDocument }
  | { schemaVersion: 2; kind: "delta"; changes: RunInspectionDelta[] }
  | { schemaVersion: 2; kind: "resync"; reason: "cursor-gap" | "projection-drift"; document: FollowableInspectionDocument }
  | { schemaVersion: 2; kind: "done"; run: { id: string; status: RunStatus }; output?: JsonValue };
```

- Follow MUST begin with a bounded snapshot.
- A cursor gap or projection drift MUST emit a bounded `resync`.
- Follow MUST emit status, control, fence, tool-start, tool-terminal, failure, and gap changes immediately.
- Follow MUST emit phase changes immediately.
- Follow MUST emit accumulated response or intent after at least 512 additional bytes or ten seconds since its preceding emission.
- A phase change, fence, or terminal boundary MUST flush an open current segment.
- Follow MUST NOT emit context, token usage, aggregate Agent resource/usage counters, or observation-age changes in overview, target, or Timeline documents.
- Clock-only `updatedAt` changes MUST NOT emit a delta.
- Timeline recent changes MUST append or upsert semantic entries and carry the exact bounded page order plus page metadata so consumers can discard entries displaced by the entry-count or 8 KiB body budget.
- Current-activity deltas MUST use a full replacement only when current identity changes or clears; otherwise they MUST contain only changed fields, using `null` to clear an optional field.
- An Agent current-activity patch MUST carry its attempt id and optional attempt/turn identity independently of a preceding snapshot.
- A target available-operation change MUST use `kind: "available-actions"` and the `availableActions` field.
- Visibility degradation and restoration MUST emit an immediate semantic delta.
- Ordinary coalescing MUST NOT be represented as an observation gap.
- A 30-second checkpoint MUST NOT repeat activity bodies.
- A target or timeline `done` emission MUST NOT include workflow output.
- Overview/all `done` MUST include workflow output exactly once when present.
- Follow updates MUST project an accepted steer as one `steered` semantic change.
- Follow updates MUST NOT expose a steering instruction or Runtime steering identity.
- Follow updates MUST suppress the supersede/requeue/fence bookkeeping represented by that accepted steer.
- Read-only liveness MUST derive `active`, `inactive`, `stale`, `terminal`, or `unknown` from durable state plus local daemon/lease evidence without persisting that classification or performing recovery.
- Daemon lifecycle MUST heartbeat every 1s, use a 5s observational stale threshold distinct from the 30s run-lease window, and idle-stop after 30s without active or locally continuable work.
- After acquiring the workspace lease and before its first scheduling tick, the daemon MUST remove `.staging-*` run directories that have been stale for at least 60 seconds.
- Stale staging cleanup MUST leave ordinary run directories unchanged regardless of whether they have a database row.
- An ordinary run directory with a valid run id but no database row MUST fail daemon startup visibly and remain unchanged for operator inspection.
- Stale staging cleanup MUST ignore only paths that disappear during inspection; other directory read/stat failures MUST abort daemon startup.
- Paused runs and untimed Signal waits alone MUST not keep the daemon resident; a non-terminal run with an immediately derivable transition, an expired owner's started attempt, or an admissible ready node MUST receive one recovery drive even when another branch is awaiting an untimed Signal. Derivable transitions include due attempt settlement, group terminalization, and leaf/frame/ancestor propagation. Timed waits keep the daemon resident until durably settled, and startup recovery is targeted rather than a whole-store repair sweep.
- A recovered owner MUST settle already-due attempt deadlines before superseding remaining expired-owner `started` attempts.
- A recovered owner MUST durably supersede expired-owner `started` attempts before admitting replacement leaf work.
- Superseded attempts MUST NOT consume logical leaf capacity after their superseding transition commits.
- The physical leaf cap MUST apply independently to each owner epoch.
- Lease failover MUST NOT require proof that a stale external process has stopped before the recovered owner admits replacement work.

## Verification

- `pnpm test:unit packages/runtime`: proves oldest-admissible FIFO, direct-member identity, continuous refill, all-group canceled-member terminalization, exact retry/cancel control planning, deterministic target ordering, high-cardinality failed-group projection, targeted-retry completion closure and atomic blocker rejection, versioned wakeup, stop/cleanup checkpoints, dual leaf caps, shared-Agent-session admission, exact Task input normalization/metadata and authored inspection fallback, ArtifactRef identity binding/content-integrity separation, verified-read replacement fencing, fixed inspection/semantic-retention budgets, write-time timeline folding, target resolution, exact bounded Agent execution projection without artifact reads, honest recent-tool incompleteness, Timeline cursor binding, and progress beyond internal count limits.
- `pnpm test:integration packages/runtime`: proves the production execution seam, arbitrary durable Task input over real process IPC, nested Parallel/Fanout and Signal admission, active-session Signal wakeup, immediate pause/run-cancel fencing, read/write parity for projected control targets, pause/resume/retry completion and session epochs, atomic steer targeting/idempotency/recovery, exact steering prompts, root/nested ArtifactRef binding and replacement fencing, exact public verified artifact reads, storage-generation archive/rebuild, post-registration Agent/Trace file retention, durable Evidence start-before-dispatch, exact fence/final boundaries, normal versus fenced Trace publication, superseded attempt fencing/sealing/settle gating, Evidence recovery, retry replay behavior, execution-metadata authority, and lease recovery ordering.
- `pnpm --filter @acpus/runtime typecheck`: verifies the scheduler, store, session, executor, artifact, and progress interfaces agree.
- Pure unit tests own workspace-key/endpoint derivation, manifest validation, runtime-generation classification, prune selection/cutoff, and maintenance-lock timing/concurrent initialization; integration tests MUST NOT reproduce those rule matrices through fresh databases.
- Storage integration uses one tracer per cross-layer risk: shard isolation, workflow-snapshot publication/reuse, preview-to-delete pruning, archive/rebuild, delete rollback/trash reconciliation, and verified artifact reads.
- Database tests assert current format markers and persisted Runtime semantics; they MUST NOT snapshot table/column inventories or assert the absence of fields from historical schemas.
- A fresh-process Runtime integration test verifies that SQLite initialization is quiet while an unrelated experimental warning remains observable.
- Cover workspace-key and manifest validation, private shard creation, database version archive/reset, frozen-file integrity, run-directory entry limits, prepared source consistency, durable workflow snapshots, collision-safe atomic admission, trash reconciliation, pruning, selective fork artifact materialization, startup staging cleanup, normalization, and mutation-free rejection.
- Prove deterministic scheduler recovery and every node/composite strategy, identity, resource, deadline, cancellation, retry, and projection rule.
- Exercise isolated Tasks, reusable loading, artifacts, Agents, response repair, progress, Private Turn Evidence, bounded semantic projection, conditional canonical turn records, and optional captures.
- Cover control idempotency/targeting, fork safety, daemon fencing, sessions, socket ownership, heartbeat, idle-stop, and public error sanitization.
- Verify summary/timeline/details modes, evidence capsules, verified artifact reads, health persistence projection, incremental follow fidelity/resync, target-scoped terminal output, and read-only operation without daemon startup or shard creation.
