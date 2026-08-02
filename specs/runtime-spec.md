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
| ACP ownership evidence | `runtime/acp/workers/` |
| Run capsule | `runtime/runs/<run-id>/` |
| Run-local ACP sessions | `runtime/runs/<run-id>/acp/sessions/` |
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
- Long-lived Runtime-owned artifact writes MUST bind created files to the same observable identity. Runtime MUST revalidate the relevant bound run, parent, and file identities at checkpoints surrounding publication, registration, and cleanup, and any observable mismatch MUST fail visibly.
- Opening a Runtime-owned root, run capsule, or long-lived file that does not expose a device/inode identity with a nonzero inode MUST fail visibly instead of degrading to path-only verification. Identity fencing detects only changes distinguishable through values reported by the host filesystem; those values may be recycled, so equality is not proof of uninterrupted path ownership.
- An existing manifest whose key, canonical path, platform, or available filesystem identity disagrees with the current workspace MUST fail visibly instead of being adopted or rewritten.
- A read-only open MUST locate only the current workspace shard.
- A read-only open MUST NOT create the Acpus home, shard, manifest, database, or runtime directories.
- The active database MUST use a fixed nonzero Acpus SQLite `application_id`.
- The active database MUST use SQLite `user_version = 8` as the current storage version.
- Each run row MUST maintain a monotonically increasing `observation_version` and optional `observation_updated_at`.
- The active schema MUST index bounded Agent semantic observation through `agent_observation_attempts`, keyed by `(run_id, attempt_id)`, `agent_observation_turns`, keyed by `(run_id, attempt_id, turn_no)`, and `agent_observation_entries`, keyed by `(run_id, attempt_id, entry_id)`.
- A non-null observation fence event sequence MUST be unique within its run.
- An observation-attempt row MUST store its latest observation version, retention-omitted count, and retention-floor version.
- An observation-turn row MUST store turn identity, prompt kind, `recording | settled | incomplete` state, gap/unknown/provider-event counts, fence metadata, provider status/timing, and one bounded current-activity projection.
- An observation-entry row MUST store turn identity, deterministic entry id, observation version, source sequence, event time, semantic kind, bounded JSON payload, and exact payload byte count.
- Observation rows MUST NOT store an exact prompt, steering instruction, final response, or raw provider frame.
- Each durable turn start, coalesced current checkpoint, semantic-entry batch, fence, gap, terminal, or reconciliation mutation MUST increment the run observation version exactly once.
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
- Runtime-owned top-level run-directory entries MUST be limited to `workflow.ir.json`, `lock.json`, the optional `artifacts/` tree, and the optional private `acp/` tree.
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
- Pruning MUST snapshot pre-existing archive candidates before generation validation or recovery and include those candidates in a failing dry-run report.
- An unbounded dry run MUST select a complete active generation with the current `application_id` and a positive `user_version` below the current storage version as one archive candidate without mutating it.
- Real unbounded pruning MUST archive and delete a selected older active generation during the same invocation.
- Pruning with `olderThanMs` MUST NOT select an archive created by recovery during that same invocation.
- Real pruning MUST delete selected runs through the Runtime-owned trash protocol.
- Real pruning and generation archival MUST fail while another process holds the workspace runtime for writable use.
- Generation archival MUST fail while the workspace retains ACP ownership evidence.
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
- `resolveArtifact` MUST accept `artifact://<run-id>/<artifact-id>` and return its registered metadata, canonical URI, and verified absolute local path.
- Artifact registry escape, SQLite, permission, and I/O failures MUST propagate rather than become ArtifactRef validation failures.
- Signal prompt, timeout message, and deadline MUST resolve once on awaiting entry; the persisted wait resumes durably from normalized input or fails ancestors with `signal_timeout` on expiry.
- Pause/resume MUST suspend and restore Signal timeout budgets atomically; an unrepresentable restored deadline returns `deadline-out-of-range` without state change.

### Agents

- Agent execution MUST render frozen prompt, cwd, env, permission, session, model, and static Agent `config` values, resolving a directly interpolated ArtifactRef to its verified absolute path.
- Runtime MUST call the [Agent Executor](agent-executor-spec.md) through one managed attempt for normalized ACP execution and progress; Runtime MUST not parse raw ACP transport for decisions, summaries, or progress.
- Runtime MUST translate each effective named or command Agent definition into the corresponding [Agent Executor](agent-executor-spec.md) request variant; absent permission defaults to `approve-all`.
- Static Agent `config` is a frozen string-to-string desired ACP option map for a reusable Agent profile; it is not an ACP `configOptions` snapshot or cross-session mutable state and MUST NOT contain secrets.
- The effective model MUST be `config.model ?? model`; `config.model` uses the Agent Executor model path rather than the generic config-option loop.
- Runtime MUST pass `config` only on an initial normal Agent turn; response-repair, plain-continuation, and steering turns MUST omit it.
- Overrides MUST allow only `use`, `command`, `model`, `permissionMode`, `config`, `cwd`, and `env`; an override `config` replaces the complete inherited map, including with `{}`, and identity replacement clears inherited model/config while preserving permission.
- Session identity MUST be run-local and deterministic from explicit non-empty `sessionKey` or dynamic `nodeKey`; repair/retry/resume/steering turns reuse it according to continuation policy.
- The effective acpx record id MUST be `acpus-` followed by the unpadded base64url encoding of the first 16 bytes of SHA-256 over the canonical JSON identity `{ runId, key }` for an explicit session key or `{ runId, nodeKey }` otherwise.
- Runtime MUST persist an Agent session below that run's private `acp/sessions/` tree and MUST not retain an ACP worker process after a paused, failed, completed, or canceled Agent attempt.
- Runtime MUST serialize Agent executor admission by effective session identity within one run.
- Runtime MUST NOT admit a steering replacement until the superseded executor using that session has settled.
- Steering replacement settlement gating MUST include draining the superseded executor.
- Nodes that explicitly share one `sessionKey` MUST resolve to the same effective Agent backend, model, and config; Runtime does not validate that compatibility constraint.
- Schema-less Agents MUST return the completed turn's `finalResponse` verbatim
  with zero response repairs.
- A steering turn MUST use exactly `<steering>${instruction}</steering>` as its Agent-visible information update before any schema-backed output contract.
- A steering turn MUST NOT expose its Runtime steering identity to the Agent.
- A steering turn MUST NOT add explanatory continuation or interruption prose to the Agent-visible information update.
- Every schema-backed Agent prompt, including task, continuation, steering, and response-repair turns, MUST state the Tagged JSON output contract.
- Every schema-backed Agent prompt MUST include the declared output as one anonymous Result Shape expression rendered directly from `SchemaIR`, rather than as JSON Schema.
- The Result Shape contract MUST direct the Agent to replace the expression with one JSON value, preserve the literal `ACPUS_OUTPUT` tags without escaping them, and end at the closing tag.
- Result Shape MUST render scalar kinds as TypeScript-shaped scalar expressions, JSON literals and enums as JSON literal expressions or unions, arrays as `T[]`, records as `{ [key: string]: T }`, unions as `A | B`, nullable values as `T | null`, and objects inline with `?` derived from the parent required list.
- Result Shape MUST parenthesize union or nullable array items, quote non-identifier property names with JSON string quoting, preserve valid prototype-named keys, add `[key: string]: unknown` only for open objects, omit defaults, and never introduce `undefined` or an exact-object marker.
- Result Shape MUST render a non-empty `SchemaIR.description` as a flattened, block-comment-safe advisory comment on its type node; comments MUST NOT affect Runtime conformance.
- A schema-backed Agent response MUST end with one `<ACPUS_OUTPUT>...</ACPUS_OUTPUT>` frame whose payload is one JSON value.
- Runtime MUST apply schema-backed output framing and conformance only to the
  current completed turn's `finalResponse`.
- Runtime MUST NOT scan or combine earlier responses or earlier turns while
  processing schema-backed output.
- Text before the opening marker MAY contain commentary.
- Only whitespace MAY follow the terminal closing marker.
- The two Tagged JSON protocol markers MUST NOT appear in prefix text.
- Marker text inside the payload MUST be treated as data only when the payload parses directly as one JSON value.
- Tagged JSON framing MUST use the first opening marker and the terminal closing marker without depending on line boundaries.
- A response containing more than one protocol frame MUST be rejected as ambiguous framing rather than selecting one frame.
- After trailing whitespace is trimmed, Runtime MUST accept the exact terminal `<\/ACPUS_OUTPUT>` spelling as repaired framing; it MUST NOT treat that spelling as a general marker alias.
- Runtime MUST parse the framed payload as strict JSON first.
- After strict parsing fails, Runtime MAY remove exactly one terminal `"` only when it immediately follows the candidate JSON text, removal yields one strict JSON value, and that value conforms after normal projection and schema validation.
- Runtime MAY make at most one bounded generic local JSON-repair attempt on the payload after strict parsing and the terminal-quote canonicalization fail.
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
- Runtime MUST execute every response-repair turn in the same managed ACP worker as its initial turn; retry, resume, and steering start a new managed worker against the persisted session.
- A response-repair prompt MUST request a complete replacement Tagged JSON frame.
- A response-repair prompt MUST repeat the Tagged JSON output contract.
- A response-repair prompt MUST repeat the declared Result Shape.
- A response-repair prompt MUST identify only the bounded failure phase.
- A response-repair prompt MUST omit the rejected response and its dynamic error text.
- A settled Agent turn whose attempt still owns result/artifact/progress writes MUST register `artifacts/<nodeKey>/attempt-<n>/<attempt-id>/agent/turn-<NNN>.json` using schema version 2 and containing identities, exact prompt, ordered responses, normalized summary/timing, status, and structured terminal detail.
- A completed turn artifact MUST contain `finalResponse`.
- A failed or cancelled turn artifact MUST NOT contain `finalResponse`.
- When the normalized summary identifies an acpx record, that turn artifact MUST contain the run-relative `sessionProjectionPath` `acp/sessions/<percent-encoded-acpx-record-id>.json`; it MUST reference rather than embed the session projection.
- The session projection is session-wide and mutable across turns. It MUST NOT be treated as an exact per-event log or as a source for precise event timing, tool-update ordering, latency, or concurrency analysis.
- A fenced Agent turn MUST NOT register a new ordinary turn or stderr artifact after the fence.
- Turn metadata MUST reference a registered canonical artifact when one exists and otherwise retain only its bounded summary and terminal disposition; non-empty stderr for a writable attempt uses a separate artifact.
- The daemon MUST accept an optional `ACPUS_AGENT_ACP_INACTIVITY_FAIL_AFTER_MS` at startup; it MUST be a canonical positive decimal integer no greater than the native timer limit or daemon startup MUST fail with `invalid-agent-acp-inactivity-fail-after-ms`.
- When configured ACP inactivity elapses, Runtime MUST settle the Agent attempt as the retryable runtime failure `agent_acp_inactivity_stale` and retain the reported silence evidence in the durable failure.
- Runtime MUST map a named Agent's Acpx configuration failure to the
  non-retryable runtime diagnostic `agent_acpx_config_resolution_failed`.
- A recognized Agent failure MUST write terminal progress/metadata once; if that write also fails, the rejection MUST retain both the recognized failure and persistence failure.
- Node progress MUST remain latest-state observation outside scheduler decisions, clear on new attempts, use typed bounded channels, and advance an independent progress version.
- Running Agent progress MUST periodically persist a local ACP activity timestamp and MUST clear it when that turn settles.
- Agent progress MUST retain a bounded response, at most one latest plan or provider-reported-thought intent, bounded tool input/output, and observation completeness for the active owned attempt.
- Completed terminal Agent progress MUST derive its bounded response only from
  `finalResponse` and MUST NOT fall back to an earlier response when it is
  empty.
- Failed or cancelled terminal Agent progress MAY display the latest partial
  response without treating it as output.

### Agent Semantic Observation

- Runtime MUST capture each Agent turn through one SQLite-backed observation module that owns bounded semantic projection, fencing, and reconciliation.
- Runtime MUST persist a `recording` observation-turn row before dispatching the provider.
- Runtime MUST revalidate attempt identity and its abort/fence after durable turn admission and before provider dispatch.
- Runtime MUST continue observing a superseded provider until its process settles.
- Runtime MUST mark a normally settled provider turn `settled` with its provider disposition and finish time.
- Runtime MUST revalidate attempt ownership before artifact registration and again before output conformance, repair, or scheduler result commit.
- A superseded attempt's late output, ordinary artifact registration, progress writes, and result commit MUST remain fenced.
- An artifact registered before a fence MAY remain registered.
- Runtime MUST fold normalized provider observations into bounded current activity and closed semantic entries when they are received.
- Runtime MUST merge consecutive assistant chunks into one response segment and consecutive thought or plan chunks into the corresponding intent segment.
- Runtime MUST fold calls and updates sharing one tool-call id into one tool entry.
- Runtime MUST retain usage observations in node progress and terminal turn summaries without adding them to semantic Timeline entries.
- Runtime MUST exclude unknown-provider payload bodies from semantic persistence while counting unknown events and marking observation completeness degraded.
- A tool, channel change, fence, gap, or turn terminal boundary MUST close the applicable open semantic segment.
- Runtime MUST close pre-fence segments before the steer control marker and order subsequent late provider activity after that marker.
- An open semantic segment MUST exist only in a turn's bounded current projection.
- A closed semantic segment MUST exist only in `agent_observation_entries`.
- Runtime MUST NOT persist normalized provider event envelopes as an ordered frame stream.
- One attempt MUST retain at most 128 closed semantic entries and at most 128 KiB of their JSON payloads.
- A turn's serialized current projection MUST contain at most 16 KiB.
- Inserting semantic entries and evicting the oldest entries required by either retention limit MUST occur in one SQLite transaction.
- Retention eviction MUST increment the attempt's retention-omitted count and advance its retention-floor version.
- Retention eviction MUST NOT create a gap or reduce observation completeness.
- Runtime MUST checkpoint response or intent growth after at least 512 additional bytes or ten seconds since the preceding checkpoint.
- Runtime MUST checkpoint phase changes, tool start/terminal, fence, gap, and turn terminal immediately.
- A durable observation fence MUST store only its scheduler event sequence, committed time, and reason.
- Replaying the same durable fence sequence MUST be idempotent.
- A different durable fence sequence for the same turn MUST fail as an invariant violation.
- When an active observation writer receives a fence, Runtime MUST close its current pre-fence semantic segment and attribute subsequent activity as post-fence.
- When a `recording` observation turn has no active writer at a committed fence, Runtime MUST preserve its bounded current activity, add one `observation_boundary_unavailable` gap, clear current, and mark the turn `incomplete`.
- A gap MUST represent a missing observation boundary or provider settlement rather than semantic-retention eviction.
- Reconciliation MUST process only `recording` turns whose scheduler attempt is terminal or superseded.
- Reconciliation MUST use the scheduler attempt's durable finish time.
- Reconciliation MUST preserve a recoverable bounded current checkpoint as a semantic entry with a deterministic id.
- Reconciliation MUST add one `provider_settlement_missing_recovery` gap, clear current, and mark the turn `incomplete`.
- Reconciliation MUST NOT invent a provider outcome or final response.
- Reconciliation MUST leave a scheduler attempt that remains `started` unchanged.
- Reconciliation MUST be idempotent and MUST NOT participate in scheduler decisions.
- Executable-run reconciliation MUST occur only after the daemon has claimed that run and superseded attempts owned by expired epochs.
- Terminal-run reconciliation MUST occur only after daemon startup owns both its endpoint and durable daemon lease.
- Exact settled turn prompt, ordered responses, and completed-turn
  `finalResponse` data MUST remain in the registered turn artifact.
- Session-wide Agent history MUST remain in the run-local ACP session projection.

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
- The daemon protocol version MUST be exactly `3`, exposed through the public `DAEMON_PROTOCOL_VERSION` constant and daemon status/lease metadata.
- Requests and responses MUST use closed JSON shapes; responses are `{ ok: true, result }` or `{ ok: false, error: { code, message, ambiguity?: true } }`.
- A rejected control response MUST set `ambiguity: true` only when target resolution was ambiguous, so a presentation client can replace raw candidate-key diagnostics with an occurrence-reference candidate view.
- Prepared workflow requests MUST accept only the current workspace-or-snapshot union, lock v2, and bundle v1 shapes; Runtime MUST NOT parse protocol-v1 prepared workflow fields.
- Daemon clients MUST NOT impose a unilateral response deadline on admission because disconnecting cannot prove that a durable mutation did not commit; idempotent controls MAY retain their bounded transport timeout, and status and shutdown probes MAY retain shorter bounded transport timeouts.
- Daemon client functions MUST return `ResultAsync` with `rejected`, `transport`, and `protocol` failures while the socket wire remains ordinary JSON.
- Successful admission and control responses MUST validate the closed required `RunDetails`, `RunStatus`, execution-state, JSON-value, and control-result shapes; a control result type MUST match the requested intent, and malformed success data is a `protocol/result` failure.
- Public errors MUST use only `INVALID_REQUEST`, `RUN_NOT_FOUND`, `RUN_NOT_CONTROLLABLE`, `CONTROL_CONFLICT`, `EXECUTION_UNAVAILABLE`, `STORE_BUSY`, `STORE_ERROR`, and `INTERNAL_ERROR`, with actionable text but no lease/SQLite/projection internals.
- Unknown daemon handler failures MUST become sanitized `INTERNAL_ERROR` responses and MUST NOT be classified as business control failures.
- Socket binding MUST arbitrate one daemon per workspace; a valid response proves liveness, while stale removal requires local evidence of a dead/expired owner.
- The daemon MUST host one serialized-write execution session per active/recoverable run, permit different runs concurrently, and keep long executor waits from blocking controls.
- After acquiring its workspace lease and before scheduling, the daemon MUST perform the [Agent Executor](agent-executor-spec.md#ownership-and-cleanup)'s bounded ACP ownership recovery and create the workspace-managed executor.
- Session start MUST distinguish `started`, `already-active`, `terminal`, and `quarantined`; daemon tick activity counts only `started` executions and dispatched hook work.
- Pause/cancel MUST durably fence their effect and abort only applicable active attempt controllers; late executor results cannot overwrite control state.
- Steer MUST resolve an exact started Agent attempt from an exact attempt id, exact dynamic node key, `@ref`, `@ref#attemptNo`, or unambiguous authored Agent id within the control transaction.
- An ambiguous authored steer target or colliding occurrence reference MUST return `CONTROL_CONFLICT` with deterministically sorted exact candidate keys.
- A steer target that is absent, non-Agent, or no longer started MUST return `RUN_NOT_CONTROLLABLE`.
- A rejected steer target MUST append no events.
- An accepted steer MUST atomically persist `control.agent_steer_requested`, supersede the targeted attempt as `operator_steered`, and requeue its node instance as `steered`.
- The accepted steer transaction MUST return the committed control event sequence and time to the Runtime observation module.
- In the same control call stack, Runtime MUST idempotently record the fence control metadata before waking the scheduler.
- A replayed steer request MUST NOT create duplicate fence metadata or a duplicate gap.
- When no active observation writer is available, inspection MUST retain the durable fence and report an observation gap.
- Runtime MUST best-effort flush the semantic fence mutation before returning the existing steer receipt.
- An accepted steer MUST fence the superseded attempt's result commits before returning its receipt.
- An accepted steer MUST fence the superseded attempt's artifact commits before returning its receipt.
- An accepted steer MUST fence the superseded attempt's progress commits before returning its receipt.
- An accepted steer MUST request best-effort abort of the superseded Agent turn.
- Pause, cancel, and owner-loss handling MUST add a fallback semantic fence for each affected active Agent turn.
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
- Retry MUST support run-level reset or an unambiguous failed exact node/frame key, occurrence reference, or authored alias; omitted target is run-level while explicit `root` remains a normal alias.
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
- Cancel MUST support run-level or unambiguous non-terminal exact-key, occurrence-reference, or authored targeting; run cancel yields `canceled`, targeted cancel yields `operator_cancelled`, and repeated run cancel is idempotent.
- Run-level cancel MUST remain applicable before root-frame materialization, including after such a pending run has been paused.
- Runtime MUST use one pure retry/cancel planner for mutation admission and read-side applicability; Web, CLI, and inspection projections MUST NOT reconstruct target legality from statuses or dynamic-table rows.
- An inspection steer capability MUST represent only an exact active Agent attempt accepted by the shared steer planner when addressed by its exact attempt identity.
- Inspection MUST NOT infer steer capability from lifecycle status, Agent progress, or session data outside the shared steer planner.
- A read-side retry target MUST be an exact planner-approved `nodeKey` or public node/loop `frameKey`, MUST NOT be a group-member identity, and MUST be ordered by exact target key with duplicates rejected as corruption.
- Read-side retry applicability MUST use the same pure frozen-workflow settlement that mutation admission performs before planning, without persisting its derived events; read-side cancel applicability MUST remain based on the durable pre-settlement snapshot used by cancel mutation.
- Read-side cancel applicability MUST distinguish a useful run cancellation from an idempotently accepted terminal no-op and MUST expose a selected target only as an exact planner-approved dynamic key.
- Read-side control applicability is advisory; every submitted control MUST resolve and validate again inside the control transaction.
- Fork MUST create a new pending child run from the selected source run.
- Fork MUST leave the source run unchanged.
- A fork child MUST inherit the source workflow, input, and Agent mapping except where the request supplies a replacement.
- A fork child MUST execute its selected workflow from initial run state rather than continue the source execution state.
- Fork reuse MUST consider only accepted completed Agent, Task, and Signal results from the direct source run.
- A source result MUST be reusable only for the same child occurrence when its effective Agent, Task, or Signal definition and every resolved workflow value it reads are unchanged.
- Ambient host files, network state, wall-clock state, and Provider behavior MUST NOT change reuse eligibility.
- A reusable result MUST complete the child occurrence without executing or waiting for it again.
- An occurrence without a reusable result MUST execute normally.
- A changed predecessor MUST NOT invalidate a later result when the later occurrence's own definition and resolved input values remain unchanged.
- An Agent occurrence with an explicit `sessionKey` MUST NOT be reused.
- Source-run artifacts inherited by the child MUST be exactly those referenced by reused results, with unchanged content.
- Without a fork target, every otherwise reusable direct-source result MUST remain eligible.
- A fork target MUST resolve before child creation to one materialized source Agent, Task, or Signal occurrence.
- A targeted fork MUST NOT reuse the selected occurrence or source work completed after that occurrence first became eligible to run.
- A missing, ambiguous, or non-materialized fork target MUST fail without creating a child run.
- Generic inspection MUST identify only the direct source run for a fork child.
- Signal control MUST target one open dynamic wait by exact node key, occurrence reference without an attempt suffix, or unambiguous authored alias, normalize payload, consume idempotently, and resume the recovered session from persisted state.
- `shutdown()` MUST stop only without active sessions, otherwise return `CONTROL_CONFLICT`; shutdown/idle-stop never mutates runs and no force-shutdown control exists.

### Read APIs And Daemon Lifecycle

- `listRuns`, `getRun`, `resolveArtifact`, `readArtifact`, inspection, health, and visualization overlays MUST read durable projections/frozen data without live workflow source or daemon startup.
- Read-only inspection MUST validate persisted frozen IR, lock, and source metadata without resolving or hashing a workflow snapshot; execution and explicit frozen-run source resolution MUST fully verify the snapshot before returning its source root.
- `getRuntimeHealth` MUST expose the current workspace shard root as `persistence.path` even when the shard is not initialized.
- `getRuntimeHealth` MUST inspect ACP ownership read-only and add an `acp` warning only when degraded or orphaned ownership evidence exists.
- When an active database has the Acpus application id and a positive storage version older than the current version, `getRuntimeHealth` MUST return `ok: true`, `state: "unreadable"`, and a `store` warning.
- That warning MUST use `Runtime storage version <observed> is older than the supported version <expected>. Doctor made no changes. This workspace remains usable; starting a new workflow run will prepare compatible storage automatically.`
- `getRuntimeHealth` MUST retain a `store` failure for storage version zero, a newer storage version, a mismatched application id, and every other database-open failure.
- `listRuns` MUST order by `updatedAt DESC, createdAt DESC`; `getRun` omits `dynamic` only when every dynamic collection is empty and fails visibly on decode/invariant errors.
- `getRunVisualizationSnapshot` MUST return run details, visualization overlay, useful run-cancel applicability, and every exact planner-approved retry target, including targets accepted during a non-terminal failure-propagation window.
- Visualization control targets MUST contain only exact target, node/frame kind, and optional authored node id; they MUST NOT contain display labels, scheduler Result values, or group-member identities.
#### Inspection

Runtime owns generic inspection semantics and public shape.

- Generic inspection MUST provide one coherent run, target Summary, target Timeline, or candidate view, and read-only observation of that selected view.
- It exposes only views, candidates, observations, and public errors. It omits internal metadata and provider, steering, resource, hook, and raw-identity data; narrow node, Agent-execution, and artifact reads remain separate.
- A target is `root`, an authored id, `@<12-lowercase-hex>`, or that reference with `#<positive-attempt-number>`. Malformed, absent, and colliding references MUST respectively return `invalid-query`, `target-not-found`, and a non-leaking `read-failed` result.
- A one-shot ambiguous authored target MUST return public candidates, never select an occurrence; observation MUST reject it before attachment. Candidate pagination is one-based, bounded, only for one-shot ambiguous reads; each row contains selector, status, and breadcrumb.
- Before attachment, observation MUST resolve and pin its subject. An authored id or occurrence reference follows replacement within its occurrence; an exact attempt closes when fenced, superseded, or terminal and never retargets.
- A run view includes run context, counts, semantic tree, and present terminal output. A target view includes its resolved subject and state plus relevant Summary/Timeline attention or activity. Counts include materialized occurrences even when folded.
- A Summary for a running Agent target with a durable ACP activity timestamp MUST include the elapsed duration since that activity; it MUST not include an inactivity threshold or predicted failure time.
- The tree MUST omit unselected conditional subtrees and completed empty branches while retaining their materialized occurrences in Counts.
- The tree MUST collapse a sole-child branch, `if`, or `switch` wrapper only when it has the same state as its child and carries no attention, failure, progress, or pulse.
- The tree MUST fold two or more contiguous equivalent Fanout items or Loop rounds. Equivalence ignores occurrence identity and duration but preserves visible state, progress, pulse, failure, attention, and shared subtree shape.
- A fold MUST show one shared subtree without representative selectors or durations and MUST NOT contain actionable attention.
- Observation emits attachment, zero or more state updates, then closure; a subject already at its stop boundary emits closure only. Abort is silent, and an observation error ends without closure.
- Each update MUST provide the smallest coherent change that affects the next valid action. Time, liveness aging, usage, hooks, and silence MUST NOT emit alone.
- Reasons MAY clarify a transition only when state is insufficient. Event-history discontinuity MUST NOT prevent observing a readable current view.
- `subject-terminal` closes only when the fixed subject is terminal. `decision-boundary` closes for a terminal or paused run, actionable run Signal, or an actionable Signal required by the target. Evaluate boundaries after settlement; absorbed Race/Quorum failures and unrelated siblings do not close a target.
- Timeline is a bounded activity view of the selected subject. It shares the observation stop policy, preserves visible gaps, and never independently closes observation.

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

- `pnpm test:unit packages/runtime`: covers fork reuse and rewind boundaries, selector resolution, candidate paging, semantic trees/folding, visible-state diff/frontier selection, privacy, and stop policies.
- `pnpm test:integration packages/runtime`: covers durable fork recovery, observation, pinning/replacement, settled composite outcomes, Signal/pause boundaries, Timeline gaps, reconciliation, and read-only inspection.
- `pnpm --filter @acpus/runtime typecheck`: verifies the exported Runtime contracts and their consumers agree.
