# Runtime Spec

## Purpose

`@acpus/runtime` owns workspace-scoped durable runs in private user-level shards, frozen workflow execution, controls, inspection, pruning, an embeddable Workspace Runtime, and the local daemon Adapter. Prepared workflow data comes from the [Workflow Compiler](workflow-compiler-spec.md); IR/value semantics come from [Core](core-spec.md) and [Expression](expression-spec.md); authoring modules load through the [Loader](loader-spec.md); Agent turns delegate to the [Agent Executor](agent-executor-spec.md), which uses [ACP](acp-spec.md); side-effect observation delegates to [Runtime Hooks](hooks-spec.md).

## Requirements

### Workspace Shards, Store Repair, And Archived Summaries

- Runtime MUST canonicalize the workspace through its real path and derive the workspace key as the first 32 lowercase hexadecimal characters of `sha256("acpus-workspace-v1\0" + platform + "\0" + canonicalRealpath)`. The CLI shard location is `$HOME/.acpus/workspaces/<workspace-key>/`; an explicitly rooted Host Runtime uses `<stateRoot>/workspaces/<workspace-key>/`.
- Runtime MUST NOT create, read, migrate, or delete workspace-local `.acpus/.local` runtime state.
- A layout-v2 shard MUST use this layout.

| Coordinate | Shard-relative path |
| --- | --- |
| Manifest | `workspace.json` |
| Daemon socket when the platform path fits | `daemon.sock` |
| Repair intent while repair is incomplete | `runtime-store-transition.json` |
| Store metadata | `generations/<id>/generation.json` |
| Optional archived-run index | `generations/<id>/run-index.json` |
| Mutable store root | `generations/<id>/store/` |
| Database | `generations/<id>/store/runtime.db` |
| Run capsule | `generations/<id>/store/runs/<run-id>/` |
| Workflow snapshots | `generations/<id>/store/sources/snapshots/` |
| Interrupted deletion | `generations/<id>/store/trash/` |

- `workspace.json` MUST be the closed record `{ manifestVersion: 2, workspaceKey, canonicalPath, platform, createdAt, activeGenerationId }`; `activeGenerationId` is the sole authority for current-store access.
- A store id MUST be `gen_<randomUUID()>`. `generation.json` MUST contain only `schemaVersion: 1`, matching `id`, nullable non-negative `storageVersion`, canonical `createdAt`, and optional canonical `archivedAt`.
- Every complete store other than `activeGenerationId` is archived and immutable except for whole-store pruning.
- `run-index.json`, when present, MUST be the closed `{ schemaVersion: 1, runs }` record; each run summary contains exactly `id`, `name`, `status`, `createdAt`, and `updatedAt`, ordered by `updatedAt DESC`, `createdAt DESC`, then `id ASC`.
- The active database MUST use the Acpus SQLite `application_id` and `user_version = 19`.
- Runtime-owned roots, manifests, databases, run capsules, sources, and trash MUST reject symbolic-link substitution. Existing run/file identity fencing remains scoped to opened store data and MUST fail visibly on an observable replacement.
- A read-only open MUST NOT create the Acpus home, shard, manifest, database, or store directories.
- A current-store read session MUST resolve the manifest generation, hold shared ownership of that generation, re-read the manifest before opening SQLite, and fail if the active generation changed. It MUST validate the application and storage versions through that connection's SQLite PRAGMAs so committed WAL state remains visible. Every read performed through that session MUST reuse its one read-only SQLite connection and MUST NOT switch generations.
- Platform-global daemon endpoints MUST combine the workspace key with a stable Acpus-home scope; filesystem socket parents and sockets MUST remain private and reject unsafe substitution.
- `listKnownWorkspaces(cwd)` MUST enumerate only direct shard manifests beneath the same Acpus home and MUST always include the current workspace. Entries expose only workspace key, canonical path, optional run count, and optional latest run update; a fresh workspace reports `runCount: 0`, while an unreadable store omits run metadata.
- Invalid or unavailable shards MUST be omitted from `workspaces`, reported independently in `failures`, and MUST NOT prevent valid candidates from being listed.
- `resolveKnownWorkspace(cwd, workspaceKey)` MUST accept only a canonical key and return a tagged invalid, not-found, or unavailable result without accepting a browser-supplied path.

#### Store Inspection And Repair

- The Runtime package root lifecycle surface MUST expose `inspectRuntimeStore(cwd)`, `repairRuntimeStore(cwd)`, and `awaitRuntimeStoreOffline(cwd)`.
- `inspectRuntimeStore` MUST be read-only; a successful inspection returns exactly `ready`, `repairable` with a user-facing message, or `unsupported` with a user-facing message. A missing store is `ready` because ordinary first use initializes it.
- `repairRuntimeStore` MUST return only `{ changed: boolean }` or a `busy | unsupported | unreadable | failed` error. It MUST be a no-op for a missing or already-ready store.
- `awaitRuntimeStoreOffline` MUST acquire exclusive workspace ownership and prove that Runtime authority, run-lease, and ACP ownership are absent without modifying store data; it returns only success or a `busy | unavailable` error.
- Repair MUST remain isolated to one resolved workspace and state root, including that target's daemon endpoint, lock, manifest, journal, generations, and store. It MUST request graceful shutdown only through that endpoint, serialize through the workspace-exclusive lock, re-inspect under that lock, preserve repairable bytes, create and verify a storage-v18 store, and publish the v2 manifest atomically. It MUST never force-kill a daemon or delete source data.
- A durable repair intent MUST contain only the information needed to resume. Repeating repair after interruption MUST converge without caller-supplied planning state.
- Concurrent repair callers MUST converge on one publication. A caller that observes the resulting ready store returns unchanged success; unresolved exclusive ownership contention remains `busy`.
- Concurrent first use MUST serialize initialization, re-inspect, and adopt the one store named by the manifest before acquiring normal shared-store ownership.
- Format inspection and predecessor summary export MUST observe committed WAL contents without mutating the inspected source. A newer format, foreign SQLite application, or unrecognized database remains unsupported and unchanged; a probe whose database or WAL source changes during inspection MUST be reported as unavailable rather than unsupported.
- Store-backed public read APIs MUST return `Effect.Effect<..., RuntimeReadFailure>`, where `RuntimeReadFailure` is exactly `runtime-store-repair-required`, `runtime-store-unsupported`, or `runtime-store-unavailable`. They MUST preserve local absence inside the success value and MUST NOT serialize Effect or Result wrappers.
- Repairing layout v1 MUST preserve its `runtime/` and complete `archives/` entries as archived stores. Valid storage v9 receives a portable run index; storage v1 through v8 remains catalog-only. Runtime MUST NOT migrate or use storage-v9 `daemon_lease` rows as Runtime authority, and current-store access MUST NOT add old-schema row readers.
- Archived history is an internal run-oriented lookup, not a public store catalog. Generic run inspection MAY return one closed archived-run summary; detail and observation queries return `archived-run-detail-unavailable`, and catalog-only uncertainty returns `archived-run-lookup-unavailable` rather than `run-not-found`.
- Store status, repair messages, Doctor, Web, inspection, and prune output MUST NOT expose store ids, repair-journal mechanics, or archived-store layout as user concepts.
- Health, control, inspection, and pruning adapters encountering repairable storage MUST remain read-only and direct the user to `acpus doctor --fix`.
- Each run row MUST maintain a monotonically increasing `observation_version` and optional `observation_updated_at`.
- The active schema MUST index bounded Agent semantic observation through `agent_observation_attempts`, keyed by `(run_id, attempt_id)`, `agent_observation_turns`, keyed by `(run_id, attempt_id, turn_no)`, and `agent_observation_entries`, keyed by `(run_id, attempt_id, entry_id)`.
- A non-null observation fence event sequence MUST be unique within its run.
- An observation-attempt row MUST store its latest observation version, retention-omitted count, and retention-floor version.
- An observation-turn row MUST store turn identity, prompt kind, `recording | settled | incomplete` state, gap/unknown/provider-event counts, fence metadata, provider status/timing, and one bounded current-activity projection.
- An observation-entry row MUST store turn identity, deterministic entry id, observation version, source sequence, event time, semantic kind, bounded JSON payload, and exact payload byte count.
- Observation rows MUST NOT store an exact prompt, steering instruction, final response, or raw provider frame.
- Each durable turn start, coalesced current checkpoint, semantic-entry batch, fence, gap, terminal, or reconciliation mutation MUST increment the run observation version exactly once.
- Activation of a fresh generation MUST initialize the complete current schema.
- Reopening a current-version database MUST preserve its rows.
- Control, inspection, and pruning adapters that encounter repairable storage MUST remain read-only and return repair-required guidance.
- Current-store access MUST NOT migrate or read rows from a sealed incompatible generation.
- Runtime-triggered loading of `node:sqlite` MUST NOT emit Node.js's SQLite experimental warning.
- Runtime-triggered loading of `node:sqlite` MUST leave every other process warning observable.
- An existing-store open MUST return absence only for `ENOENT` or `ENOTDIR`; permission, symlink-loop, I/O, and SQLite failures MUST remain system failures.
- Every repair activity probe and SQLite open MUST reject symbolic-link or non-file database, WAL, and shared-memory paths before reading them.
- Runtime-generated run ids MUST combine local `YYYYMMDDHHmmss` time with 20 uppercase hexadecimal random characters.
- `RuntimeStore.admitRun` MUST return `Effect.Effect<RunRecord, AdmitRunFailure>` and validate compiler-prepared workflow data, normalize input against the frozen input schema, strictly validate Agent injections, resolve referenced Agent Presets, and finalize every Agent binding before mutation.
- Admission with a request id MUST use `admission-request:<requestId>` as the `run.admitted` event idempotency key and persist a SHA-256 fingerprint of prepared identity, normalized input, and the validated unexpanded Agent injections. Repeating the same request id and fingerprint MUST return the original run before loading or resolving the current Preset catalog, without another capsule, admitted event, or execution session; reusing it with a different fingerprint MUST return `CONTROL_CONFLICT` without mutation.
- `AdmitRunFailure` MUST be the union of `PreparedRunValidationFailure`, `SchemaNormalizationFailure`, `AgentBindingFailure`, `AgentPresetCatalogFailure`, and the tagged `admission-request-conflict` failure; workspace mismatch, path publication conflicts, filesystem, SQLite, invariant, and unknown failures MUST reject.
- `PreparedRunValidationFailure.reason` MUST distinguish `invalid-ir-json`, `invalid-ir`, `ir-mismatch`, `ir-digest-mismatch`, `source-graph-mismatch`, `source-bundle-mismatch`, `package-lock-mismatch`, and `entry-mismatch`.
- New-run and replacement-fork admission MUST validate the closed preparation-lock v2 shape, canonical frozen IR, matching lock metadata, and compiler-owned workflow source reference before mutation; daemon failures use `INVALID_REQUEST`.
- Successful prepared-workflow validation MUST return a Runtime-owned detached value so caller mutation cannot change source, bundle, lock, or IR data after validation and before durable publication.
- A missing, changed, escaping, symbolic-link, or non-regular workspace entry is `entry-mismatch`; runtime-workspace and other filesystem or system failures MUST reject rather than become a prepared-workflow validation failure.
- Canonical frozen-IR admission MUST delegate to Core `validateWorkflowIR(...)`, reject validator errors or existing error diagnostics as `invalid-ir`, accept warning-only diagnostics, and MUST NOT append to or mutate prepared diagnostics.
- A workspace source reference MUST resolve its portable entry and reusable-task referrers beneath the canonical workspace root.
- A snapshot source reference MUST contain exactly its portable entry and `sha256:<hex>` source-graph digest.
- A snapshot prepared workflow MUST contain one canonical `acpus_workflow_source_bundle` v1; workspace prepared workflows MUST NOT contain a source bundle.
- Bundle file paths MUST be safe portable POSIX relative paths in ascending ordinal order, with no duplicates, file/directory prefix conflicts, or NFC/case-folded path or directory-segment collisions, and the exact entry MUST be present.
- Runtime MUST recompute the snapshot source graph through the canonical [Core content identity](core-spec.md#content-identity) contract; it MUST equal both the source reference digest and prepared `sourceGraphDigest`.
- Runtime MUST verify the lock entry digest against the corresponding bundle file for snapshots and the live regular non-symbolic-link workspace entry for workspace sources.
- A source bundle is admission-only: Runtime MUST NOT persist it in SQLite, run capsules, locks, events, fork fingerprints, or public run metadata.
- Admission MUST publish a verified snapshot through a private staging directory, `0700` directories, `0600` files, and atomic rename beneath the current store's `store/sources/snapshots/<sha256-hex>/`; an existing digest path MUST have its private modes, manifest, inventory, and contents fully verified before reuse on POSIX platforms.
- A durable snapshot manifest MUST use a closed versioned shape containing the entry, source-graph digest, and ordered file digest inventory; recovery MUST verify its canonical bytes, private modes on POSIX platforms, exact file inventory, and file contents before resolving reusable-task source from `files/`.
- Recovery MUST reject persisted source metadata unless `source_json` agrees with the run workflow entry, source-graph digest, and digest-verified preparation lock source, source-graph, and IR metadata.
- Runtime execution MUST use the run workspace as cwd and fallback dependency authority for bare imports originating in a frozen snapshot.
- `packageLockDigest`, when present, is environment metadata only and MUST NOT contribute to source-graph or fork identity.
- Admission MUST persist exact `workflow.ir.json` and `lock.json` bytes beneath the current store's `store/runs/<run-id>/`, with run-relative file coordinates and `sha256:<hex>` byte digests.
- Admission MUST initially materialize only `workflow.ir.json` and `lock.json` in a committed run directory.
- Runtime-owned top-level run-directory entries MUST be limited to `workflow.ir.json`, `lock.json`, the optional `artifacts/` tree, and the optional private `acp/` tree.
- Admission and fork publication MUST fail without removing or replacing a pre-existing staging or final run path.
- A failed admission or fork MUST remove only a staging or final run path created by that operation; concurrent operation and owned-path cleanup failures MUST both remain observable.
- Frozen files and registered artifacts MUST be regular non-symlinks beneath the current store's non-symlinked runs root; missing, escaping, or mismatched files fail visibly rather than appearing absent.
- Admission MUST atomically persist `run.admitted`, run/public node projections, scheduler bootstrap state, and `agent_bindings_json` before Runtime-owned advancement. Workflow source and run-capsule publication MUST happen only after every recoverable validation and Agent-binding failure has passed.
- Execution MUST use frozen IR instead of live workflow source and MUST NOT copy reusable task source or dependencies into the run directory; snapshot reusable source lives only in the Runtime source store.
- Completed runs MUST persist normalized root output and `run.completed`; runtime failures after admission persist failed state and `run.failed`.
- A run row without its required frozen input/files MUST fail as durable corruption rather than appear absent.
- `deleteRun` MUST return `Effect.Effect<RunRecord | undefined, RunDeleteFailure>`, with `undefined` for an absent store/run and `run-delete-active` as its only recoverable error.
- Run deletion MUST move the run capsule into the current store's `store/trash/` before deleting its database rows in the same transaction as the active-lease check.
- Run deletion MUST reject an unexpired unreleased lease even when the run projection is already terminal.
- A successful run-deletion commit MUST remove its trashed capsule.
- A failed run-deletion transaction MUST restore its trashed capsule before returning or rejecting.
- On writable open, Runtime MUST restore a trashed capsule whose run row remains and finish deleting a trashed capsule whose run row is absent.
- Trash reconciliation MUST accept only regular non-symbolic-link directories as trashed capsules.
- A trash reconciliation collision or filesystem failure MUST fail visibly instead of discarding either path.

### Pruning

- `pruneRuns(cwd, options)` MUST select only current-store runs whose status is `completed`, `failed`, or `canceled`, and complete archived stores that are not current.
- With `olderThanMs`, pruning MUST select terminal runs whose `updatedAt` and archived stores whose `archivedAt`, or `createdAt` when absent, are strictly earlier than the runtime-computed cutoff.
- Without `olderThanMs`, pruning MUST select every eligible terminal run and archived store in scope.
- Runtime MAY receive an internal canonical `selectionCutoff` from the CLI to fence a confirmed prune; when present it MUST replace the runtime-computed selection boundary without changing whether `PruneReport.cutoff` is exposed.
- Pruning MUST default to the current workspace shard. `allWorkspaces: true` MUST enumerate workspace shards beneath the same Acpus home.
- Ordinary read APIs MUST remain scoped to the canonical workspace passed by their trusted server-side caller. Known-workspace catalog metadata MUST NOT expose run records, and an explicit resolved workspace path is required before reading another shard's runs.
- `dryRun: true` MUST perform selection and size accounting without changing databases, manifests, or files.
- Pruning MUST validate and snapshot its candidates before confirmation. It MUST NOT repair, rebuild, or select the current store.
- Real pruning MUST delete selected current-store runs through the Runtime-owned trash protocol and delete a selected archive only as one whole directory.
- Real pruning MUST serialize through the workspace maintenance lock and MUST fail while another process holds the selected state for writable use.
- After acquiring that lock, real pruning MUST revalidate every previewed run against the same absolute cutoff and terminal-status rule. A run that disappeared, became active, or was updated beyond the cutoff after preview MUST be skipped and MUST NOT contribute to deleted counts or bytes.
- After selected run deletion, Runtime MUST delete only current-store workflow snapshots whose digest no remaining run references.
- A shard MUST be removed only when it has no runs, archives, workflow snapshots, unresolved trash, or live daemon.
- Empty-shard removal MUST reject a `daemon.sock` entry unless the active layout uses that path and the entry is a Unix socket.
- Removing an empty shard MUST remove its empty current store, manifest, stores root, and workspace-shard directory.
- One malformed or failed shard MUST NOT prevent pruning of other selected shards.
- A prune failure after one or more successful deletions MUST retain those completed counts and bytes in the final report.
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
- Pure recoverable runtime decisions MUST use native Effect v4 `Result.Result`; effectful recoverable runtime boundaries MUST use a typed `Effect.Effect`. Local absence uses `undefined`, while invariant, durable-corruption, unknown execution, SQLite, and non-absence filesystem failures remain defects.
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
- Process-local Runtime storage MUST be exposed through the scoped Effect v4 `RuntimeStore` service keyed as `acpus/runtime/RuntimeStore`; opening a writable store or bound read session MUST require `Scope`, and that Scope's one finalizer MUST close its SQLite connection and release its owned Runtime lock.
- RuntimeStore operations MUST return direct success values in `Effect.Effect` and carry existing domain failures plus recognized SQLite busy/locked identity in the typed error channel. They MUST NOT return `Promise<Result>`, `Effect<Result>`, or expose `close()` as a second lifetime protocol; unknown SQLite, filesystem, durable-corruption, and invariant failures remain defects.
- Recoverable scheduler-store operations MUST use the RuntimeStore service's typed Effect channel with `SchedulerStoreError`; deterministic retry, cancel, steer, and admission planners remain pure native `Result.Result` values, while invariant and unknown store failures remain defects.
- `applySchedulerControlIntent` MUST return a tagged Result and report ambiguous retry/cancel aliases with deterministic `candidateKeys`; unknown store, frozen-data, and invariant failures MUST propagate.
- Workspace Runtime startup MUST capture `ACPUS_RUNTIME_RUN_MAX_LEAF_CONCURRENCY`, default it to 32, and reject non-canonical positive safe integers before creating store or Adapter state.
- Workspace Runtime startup MUST initialize a missing store through exclusive, lock-scoped first-use initialization. It MUST then inspect again under its shared Runtime lock and open exactly the current store named by the manifest.
- Public writable Workspace Runtime startup through `openWorkspaceRuntime` MUST automatically complete every lifecycle-classified repairable state before acquiring shared store ownership. It MUST repair only the Host-supplied `stateRoot`; a live target authority or unproven activity blocks mutation, and newer, foreign, or unrecognized storage remains unsupported and unchanged.
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
- Each active `RunExecution` owner epoch MUST limit its physical leaf count to executor invocations that it has launched and that have not settled.
- The scheduler MUST start a Task or Agent leaf only while both the logical run-wide cap and the claiming `RunExecution` owner epoch's physical leaf cap have capacity.
- The daemon ceiling MUST remain owner configuration rather than frozen IR or a persisted scheduler fact.
- The production run-execution seam MUST be `createRuntimeRunScheduler(...).start({runId,ownerId})`.
- `start({runId,ownerId})` MUST return a `RunExecution` exposing `ownerEpoch`, `result`, `wake()`, and `stop()`.
- `RunExecution.ownerEpoch` MUST resolve to the claimed scheduler owner epoch, or to `undefined` if execution ends before claiming the run.
- `RunExecutionExit.status` MUST use the closed set `completed`, `failed`, `canceled`, `paused`, `awaiting`, and `lease_lost`; this set excludes `idle`.
- `RunExecution.result` MUST resolve to `Result<RunExecutionExit, RunExecutionFailure>`; only errors carrying SQLite busy/locked identity are recoverable `store-busy` failures, and unknown failures reject with their original value.
- Workspace Runtime heartbeat and tick boundaries MUST tolerate recognized store-busy failures; every other global store or maintenance failure MUST close that Runtime authority instead of being swallowed.
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
- After a production execution rejects, the Workspace Runtime MUST quarantine that run in memory by `(runId, eventCount)` and report one execution incident for that version.
- A run execution quarantine MUST clear after its durable event count changes and MUST NOT survive Workspace Runtime restart.
- One run's rejected production execution MUST NOT stop or prevent the Workspace Runtime from advancing other runs.
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
- Recorded Task attempt env MUST contain only evaluated Acpus-authored overrides; the process environment may additionally inherit host values.
- Runtime MUST evaluate a Task's complete authored input expression once and normalize the result as one WorkflowData value before recording attempt metadata or starting the Task process.
- Evaluated Task input MUST preserve its exact WorkflowData shape, including a top-level primitive, `null`, array, or object and every own object field such as `__proto__`, without changing an input object's ordinary prototype.
- Task input artifact binding MUST recursively accept an `ArtifactRef` at the input root, in an object field, or in an array element.
- Runtime output normalization MUST treat Task top-level `undefined` as no output, reject scope/array `undefined`, omit undefined object properties, and reject non-WorkflowData values without adding business schemas.
- Task output MUST be normalized immediately before child-process IPC and again at durable result commit; the parent node-executor layer MUST NOT add another cloning or normalization pass.
- Recoverable Task attempt failure MUST contain only `failed`, `cancelled`, or `timed_out` status plus a complete display message; cwd, errno, exit code, signal, and bounded process output details MUST be folded into that message when applicable.
- A Task return value MUST persist through durable scheduler state without creating run-local files unless the Task calls `artifact.write(...)`.
- Attempt deadlines MUST be persisted once before executor invocation and remain authoritative through the complete Task or Agent lifecycle, including named Agent resolution, worker and ACP session startup, and every turn. Executors MUST consume the one remaining budget without re-evaluating or restarting authored timeout expressions.
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

#### Agent Presets, Injections, And Frozen Bindings

- Runtime MUST own Agent Preset catalog composition, persistence, resolution, admission expansion, and durable binding freeze. Presentation adapters MAY discover choices and mutate project/global presets only through Runtime APIs.
- Project/global Presets MUST use the `presets` sections owned by the
  [Configuration](configuration-spec.md) contract; a Host MAY supply a
  process-local `AgentPresetProvider` through
  `WorkspaceRuntimeHostDependencies`.
- The effective catalog precedence MUST always be Host, then project, then global for an exact id, independent of requested scope order. A scope request MUST contain only unique `host | project | global` values, and project scope requires a workspace.
- Catalog choice data exposed to an orchestrator MUST contain only `{ id, guidance, scope }`; command, `use`, model, permission, config, cwd, env, and definition digest MUST remain behind explicit resolution at admission.
- A Preset id MUST match `^[a-z0-9][a-z0-9_-]{0,63}$`; each scope MUST contain at most 50 entries; guidance MUST contain 1 through 2,000 trimmed characters; project/global MUST reject the Host-reserved `dsh` id. Preset definitions MUST be closed concrete named or command Agent specs and MUST NOT contain Slots or nested Preset references.
- Project/global Preset persistence MUST mutate only the unified
  configuration's `presets` section through the secure, section-preserving
  write contract in [Configuration](configuration-spec.md).
- `AgentInjectionMap` MUST be a closed map keyed only by declared Agent names. Each value MUST be exactly a direct injection containing only `use`, `command`, `model`, `permissionMode`, `config`, non-empty `cwd`, and `env`, or exactly `{ preset: string }`; it MUST reject unknown declarations, unknown fields, and mixed direct/Preset shapes.
- Finalization MUST produce exactly one concrete effective definition and one frozen binding for every declaration. Every Slot without a direct, Preset, or inherited frozen identity MUST fail with `agent-bindings-unresolved` and stable code-unit-sorted names; Scheduler and execution boundaries MUST receive only `AdmittedWorkflowIR`.
- Direct and frozen injections MUST replace complete `config` and `env` maps when those fields are present. An injected identity replaces `use | command`, clears inherited `model` and `config` unless supplied with that identity, and preserves declaration/inherited permission, cwd, and env unless supplied. Selectorless fields alone MUST preserve the current identity provenance.
- A frozen binding MUST contain `source` and optional `injection`. `source` MUST record identity provenance as exactly workflow, direct, or `{ kind: "preset", id, scope }`; Preset provenance identifies the selected Preset without authenticating its contents. A field-only direct injection MUST preserve the source kind and Preset id/scope.
- Admission MUST resolve every referenced Preset against the current catalog and freeze its concrete definition as the binding injection. Frozen-run decode MUST derive every effective definition from the authored declarations plus frozen injections and reject missing names, impossible provenance, or non-canonical bindings as corruption.
- Ordinary `RunDetails`, admission receipts, daemon frames, and run events MUST NOT expose expanded definitions, frozen injections, Preset definitions, or binding provenance. Narrow Forensics MUST NOT expose frozen injections or Preset definitions, but MAY expose binding provenance alongside the derived effective definition.
- A fork without an Agent injection MUST reapply only the source binding's frozen injection to the selected child declarations; it MUST NOT inherit superseded authored declaration fields. An explicit Preset injection MUST re-resolve the current catalog; an idempotent replay of the same fork request MUST return the existing child before catalog loading.
- Fork request identity MUST be a SHA-256 digest of the validated unexpanded request, while semantic fork reuse MUST include the finalized frozen bindings. Neither event fingerprint MAY embed command, config, env, or other expanded binding material.

- Agent execution MUST render frozen prompt, cwd, env, permission, session, model, and static Agent `config` values, resolving a directly interpolated ArtifactRef to its verified absolute path.
- Runtime MUST call the [Agent Executor](agent-executor-spec.md) through one exact Agent Session lease for normalized ACP execution and progress; Runtime MUST not parse raw ACP transport or child topology for decisions, summaries, or progress.
- Runtime MUST translate each effective named or command Agent definition into the corresponding Session intent; absent permission defaults to `approve-all`.
- Static Agent `config` is a frozen string-to-string desired ACP option map for a reusable Agent profile; it is not an ACP `configOptions` snapshot or cross-session mutable state and MUST NOT contain secrets.
- The effective model MUST be `config.model ?? model`; `config.model` uses the ACP session model path rather than the generic config-option loop.
- Runtime MUST pass `config` only on the first request of an authored Agent Attempt; response-repair and steering turns MUST omit it.
- Before each provider request, Runtime MUST atomically persist one `agent_invocation` metadata record with that request's dispatch intent.
- Each `agent_invocation` MUST contain the final prompt sent on that request, including output-schema instructions.
- `agent_invocation` MUST classify prompt origin as `authored`, `steering`, or `repair`.
- `agent_invocation` env MUST contain only frozen profile env plus resolved node env.
- `agent_invocation` MUST NOT contain inherited host env or Runtime-injected `ACPUS_RUNTIME_*` values.
- `agent_invocation` MUST omit internal session names, provider identity, ACP
  record identity, backend session identity, partial responses, tools, usage,
  and artifacts.
- Failure to persist `agent_invocation` MUST reject the execution boundary before provider dispatch.
- Every execution metadata record MUST identify an exact started Attempt and its active owner epoch; stale, terminal, mismatched, released, or expired ownership MUST reject without inserting metadata.
- Agent Session scope MUST be the SHA-256 digest of the versioned canonical local identity `{ runId, kind: "node", value: nodeKey }` or explicit-shared identity `{ runId, kind: "key", value: renderedSessionKey }`; raw `sessionKey` MUST NOT appear in the durable Session id.
- `agentSessionId` MUST be `acpus-<scope-digest-hex>-g<generation>` using the complete already-computed scope digest.
- A materialized Agent Session MUST have one durable row with lifecycle `active` or `abandoned`, one closed current checkpoint, and at most one active generation for each run and scope. Run deletion cascades those rows; Turn/Run terminal state and Runtime shutdown do not abandon continuity.
- A current Agent Session row MUST hold nullable `ready_at`. Null means the
  generation has never reached ready and MUST prohibit invocation/dispatch.
  Runtime MUST atomically record the first ready time after lease acquisition
  and before invocation; repeated ready writes MUST preserve that first time.
- The same ready write MUST refresh nullable `reported_version` with the
  Provider-reported version from that lease, or null when absent. This value is
  bounded observational metadata, not immutable Session identity, checkpoint
  evidence, or binding input.
- Each admitted Agent Attempt binding MUST be immutable and record its exact Session, operation (`start`, `continue`, or `safe_retry`), open mode, predecessor, prompt origin/digest, checkpoint origin, and optional Steer lineage. The first binding and Session row MUST commit together; deleting reconstructible `node_attempts` projection rows MUST NOT delete historical bindings.
- Agent Session Store mutations MUST validate the exact started Attempt and active owner, except that post-fence settlement requires current Workspace Runtime authority plus the exact persisted Attempt, Turn, lease, and expected checkpoint tuple.
- A new binding MUST initialize `not_dispatched`. The only accepted checkpoint evidence graph is repair terminal to `not_dispatched`; dispatch intent to owned in-flight; dispatch intent or owned in-flight to provider observed or terminal observed; provider observed to terminal observed; pre-evidence loss to acceptance unknown; post-evidence loss to terminal unknown; and inbound local failure to terminal unknown. A late weaker write MUST NOT overwrite stronger evidence.
- The `agent_invocation` metadata row and exact `dispatch_intent(attemptId, turnId, sessionLeaseId)` checkpoint MUST commit atomically before Provider dispatch.
- Explicit Retry MUST use one two-phase Runtime transaction: the pure planner resolves scheduler topology and exact affected Agent Sessions, the Supervisor proves physical neutralization for every affected implicit-local Session, and Store commit atomically revalidates owner epoch, idempotency, scheduler version, topology, frozen Agent scope, and the exact neutralized Session set before abandoning those generations and appending standard Retry events.
- Retry planning or commit that encounters any affected explicit shared `sessionKey` MUST reject without Store writes and direct the operator to fork the same target.
- Retry commit MUST NOT create a Session, Attempt, or pending generation assignment. Admission after an abandoned local generation MUST create the next generation with operation `start` and prompt origin `authored`; an Agent that failed before Session identity MUST still create generation one.
- Scheduler replay MUST use persisted operation, checkpoint, binding, assignment, and control facts and MUST NOT reclassify historical Attempts with the current operation planner.
- The active storage schema MUST use unified Retry and structured Session bindings. Retry and Steer are the only Agent-applicable external control wire variants; Continue and Restart MUST NOT be accepted as product controls, and run-level Retry MUST NOT be accepted.
- Runtime MUST persist an Agent session below that run's private `acp/sessions/` tree and MUST not retain an ACP worker process after its Session lease settles.
- Runtime MUST serialize Agent execution and Retry neutralization with the Agent Executor's exact Session guard.
- Runtime MUST NOT admit a steering replacement until the superseded executor using that session has settled.
- Steering replacement settlement gating MUST include draining the superseded executor.
- An authored explicit-shared `sessionKey` MUST retain one continuity domain. Direct Retry of that Agent or a frame whose reexecution set intersects it MUST reject without Store writes; Fork is the product operation for rerunning that conversation.
- Schema-less Agents MUST return the completed turn's `finalResponse` verbatim
  with zero response repairs.
- A steering turn MUST use exactly `<steering>${instruction}</steering>` as its Agent-visible information update before any schema-backed output contract.
- A steering turn MUST NOT expose its Runtime steering identity to the Agent.
- A steering turn MUST NOT add explanatory continuation or interruption prose to the Agent-visible information update.
- Every schema-backed Agent prompt, including authored, steering, and response-repair turns, MUST state the Tagged JSON output contract.
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
- Response repair MUST remain inside one scheduler-visible attempt, reuse the ACP session, avoid generic config-option reapplication, and never process backend failures as output failures.
- Runtime MUST execute every response-repair Turn in the same Agent Session lease and Process Capsule as its initial Turn. Natural shared-session continuation, safe retry, and Steer replacement Attempts acquire a later lease according to their durable Session plan.
- A response-repair prompt MUST request a complete replacement Tagged JSON frame.
- A response-repair prompt MUST repeat the Tagged JSON output contract.
- A response-repair prompt MUST repeat the declared Result Shape.
- A response-repair prompt MUST identify only the bounded failure phase.
- A response-repair prompt MUST omit the rejected response and its dynamic error text.
- A settled Agent turn whose attempt still owns result/artifact/progress writes MUST register `artifacts/<nodeKey>/attempt-<n>/<attempt-id>/agent/turn-<NNN>.json` using schema version 2 and containing identities, exact prompt, ordered responses, normalized summary/timing, status, and structured terminal detail.
- A completed turn artifact MUST contain `finalResponse`.
- A failed or cancelled turn artifact MUST NOT contain `finalResponse`.
- When the normalized summary contains `sessionProjectionPath`, that turn artifact MUST prefix it with `acp/` and store the resulting run-relative path only as its top-level `sessionProjectionPath`, such as `acp/sessions/<percent-encoded-record-id>.json`; its embedded summary and turn metadata MUST omit `sessionProjectionPath`, and the artifact MUST reference rather than embed the [ACP session projection](acp-spec.md#session-projection).
- The ACP session projection is session-wide and mutable across turns. It MUST NOT be treated as an exact per-event log or as a source for precise event timing, tool-update ordering, latency, or concurrency analysis.
- A fenced Agent turn MUST NOT register a new ordinary turn or stderr artifact after the fence.
- Turn metadata MUST reference a registered canonical artifact when one exists and otherwise retain only its bounded summary and terminal disposition; non-empty stderr for a writable attempt uses a separate artifact.
- The daemon MUST accept an optional `ACPUS_AGENT_ACP_INACTIVITY_FAIL_AFTER_MS` at startup; it MUST be a canonical positive decimal integer no greater than the native timer limit or daemon startup MUST fail with `invalid-agent-acp-inactivity-fail-after-ms`.
- When configured ACP inactivity elapses, Runtime MUST settle the Agent attempt as the retryable runtime failure `agent_acp_inactivity_stale` and retain the reported silence evidence in the durable failure.
- Runtime MUST map a named Agent configuration failure to the non-retryable
  runtime diagnostic `agent_config_resolution_failed`.
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
- Runtime MUST consume the same parent-enveloped raw ACP event delta for
  checkpoint evidence, bounded progress, semantic observation, and terminal
  artifacts. It MUST NOT accept a second cumulative observation stream.
- The first admitted Provider event MUST monotonically advance the exact
  Session/Attempt/Turn/lease checkpoint to `provider_observed` before optional
  business projections. A matched Provider result or Provider error response
  MUST advance it to `terminal_observed`; a local failure MUST use its
  boundary-assigned Provider evidence and MUST NOT be reclassified from its
  message or error tag.
- Runtime MUST fold raw provider events into bounded current activity and closed semantic entries when they are received.
- Runtime MUST merge consecutive assistant chunks into one response segment and consecutive thought or plan chunks into the corresponding intent segment.
- Runtime MUST fold calls and updates sharing one tool-call id into one tool entry.
- A tool-call update MUST retain its previously resolved non-generic name unless
  it supplies an explicit tool name. An unresolved or generic name MUST prefer
  an explicit tool name, then a standard ACP tool kind. An ACP title MUST remain
  a separately bounded human-readable title and MUST NOT become the name. Known
  generic placeholder titles MUST remain absent. An unavailable name and kind
  MUST project as `Tool`.
- Runtime MUST mark an omitted prefix or suffix at that edge when projecting bounded Agent activity text for inspection.
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
- An ordinary Agent turn MUST use the `starting` current phase only before its first recognized semantic activity.
- After a terminal tool observation and before the next semantic activity, Runtime MUST retain bounded telemetry and the recent tool in current projection with the internal `between` phase.
- A usage checkpoint received during `between` MUST preserve that phase.
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
- Terminal-run reconciliation MUST occur only after Workspace Runtime startup owns durable Runtime authority.
- Exact settled turn prompt, ordered responses, and completed-turn
  `finalResponse` data MUST remain in the registered turn artifact.
- Session-wide Agent history MUST remain in the run-local ACP session projection.

### Controls And Daemon

- `@acpus/runtime/host` MUST expose `openWorkspaceRuntime(location, dependencies?)` as `Effect.Effect<WorkspaceRuntime, WorkspaceRuntimeOpenFailure>`. `WorkspaceRuntimeLocation` MUST contain only `workspace` and the Host-supplied absolute `stateRoot`; opening MUST NOT infer the CLI home. `WorkspaceRuntimeHostDependencies` MAY carry immutable named Agent launches and an `AgentPresetProvider`; both remain process-local Host behavior, while a selected Preset's resolved definition and provenance enter only the admitted frozen binding.
- `WorkspaceRuntimeOpenFailure` MUST expose only `runtime-store-unsupported`, `runtime-store-unavailable`, `runtime-authority-busy`, `runtime-configuration-invalid`, and `runtime-open-failed`. Repair `busy`, `unreadable`, and `failed` outcomes map to `runtime-store-unavailable`; Host failures MUST NOT direct callers to CLI-store Doctor commands.
- `WorkspaceRuntime` MUST expose only its canonical workspace, prepared-workflow admission, typed run control, inspection and inspection observation, artifact listing/reading, admission lookup, and orderly `close()`.
- Every opened Workspace Runtime MUST retain one Effect Scope as its lifetime owner. Store/shared-lock ownership, Runtime authority, Hook and Agent Supervisor child Scopes, repeating heartbeat/tick Fibers, run sessions, and semantic shutdown MUST be descendants of that lifetime; `close()` and direct owner-Scope closure MUST converge on the same cached settlement.
- Every Workspace Runtime store operation MUST remain bound to its owned store and storage generation; it MUST NOT reopen or re-resolve the workspace from `cwd`.
- Runtime owner identity, heartbeat, daemon protocol, idle-stop, incident reporting, Supervisor injection, and authority-loss policy MUST remain internal Adapter concerns. Runtime execution MUST use `AgentSessionSupervisor` as its sole Agent process-lifecycle interface.
- The CLI-owned daemon executable MUST scope one `startDaemonLoop` handle and
  invoke its `shutdown` operation as the Scope finalizer. Process-signal
  handling and Effect Runtime execution belong to that executable composition
  root, not to Runtime application or daemon-loop modules.
- Workspace Runtime startup MUST atomically claim the workspace's one durable `runtime_authority` row before recovery or scheduling. A live unreleased owner MUST return the typed `runtime-authority-busy` failure without replacing that owner. Authority persistence and errors MUST NOT classify or name the embedding product.
- When the platform can obtain a process-start token, Runtime authority and workspace-lock liveness MUST require that token to match; a reused PID MUST NOT retain ownership. An unavailable token MUST preserve conservative PID-based ownership.
- Runtime authority epochs MUST increase across release and reacquisition. Heartbeat, idle-state update, and release MUST be fenced by workspace, owner id, and epoch; release MUST retain the row's epoch history.
- Workspace heartbeat and scheduling ticks MUST be separate Scope-owned serial Fibers driven by the Effect Clock. The first tick MUST start immediately; a long tick MUST NOT stop heartbeat progress, and shutdown MUST await an in-progress tick before releasing Runtime authority or storage.
- Workspace Runtime owns store readiness, Runtime authority heartbeat, ACP ownership recovery, Agent Session Supervisor construction and closure, run sessions, admission, scheduler ticks, observation, and orderly shutdown. Orderly shutdown MUST stop admission and periodic Fibers, drain mutations, request run-session stop and Supervisor cleanup before awaiting either, await both, drain Hooks, then release Runtime authority before closing storage. Every independent cleanup stage MUST be attempted, and multiple failures MUST remain observable as one aggregate failure.
- `findAdmission(requestId)` MUST read the durable admission selected by `admission-request:<requestId>` from the Runtime's bound store, return the same `RunDetails` receipt as `submit`, and return local absence as `undefined`.
- The daemon MUST be a scoped Adapter over one Workspace Runtime. One Deferred shutdown request MUST converge protocol, idle, authority-loss, signal-finalizer, and explicit shutdown paths; server admission and request Fibers MUST close before the Workspace Runtime. The daemon owns socket binding and cleanup, wire protocol translation, active-connection accounting, Effect-Clock idle-stop and process policy, but MUST NOT independently own scheduling, execution sessions, ACP recovery, or store reads used to serve Runtime operations.

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
  delivery: "interrupt_continue";
  fencedAttemptId: string;
  continuation: "queued";
};
```

- A steer instruction MUST contain non-whitespace text.
- Apart from validating non-whitespace content, Runtime MUST persist a steer instruction without trimming or normalization.
- The daemon MUST expose unary `status`, `shutdown`, and `control` methods plus streaming `submitAndObserve` over a workspace-derived Unix socket or equivalent named pipe, never an HTTP port.
- The current daemon protocol version MUST be `10`, Runtime ABI version MUST be `5`, layout version MUST remain `2`, and storage version MUST be `19`. Package version is diagnostic metadata and MUST NOT determine compatibility.
- Daemon status MUST expose one closed `RuntimeAuthorityIdentity` containing `workspaceKey`, `runtimeAbi`, `layoutVersion`, `storageVersion`, the Store claim's owner UUID as `authorityId`, and positive `leaseGeneration`.
- Unary requests and responses MUST use closed JSON shapes; responses are `{ ok: true, result }` or `{ ok: false, error: { code, message, ambiguity?: true } }`.
- A rejected control response MUST set `ambiguity: true` only when target resolution was ambiguous, so a presentation client can replace raw candidate-key diagnostics with an occurrence-reference candidate view.
- Prepared workflow requests MUST accept only the current workspace-or-snapshot union, lock v2, and bundle v1 shapes; Runtime MUST NOT parse protocol-v1 prepared workflow fields.
- A submission request MUST contain the complete expected authority, one admission request id, prepared workflow, input, optional strict Agent injections, and exactly one stop policy: `admitted`, `subject-terminal`, or `decision-boundary`.
- Before any mutation, submission MUST compare every expected-authority field with the daemon authority and return `AUTHORITY_MISMATCH` with a definite not-admitted outcome on any difference.
- Submission output MUST be strict NDJSON containing only an `admitted` frame, zero or more `observation` frames, or one terminal `error` frame with phase, admission outcome, optional run id, and daemon error. Frames and their nested run and inspection documents MUST use closed validated shapes; invalid or truncated frames are protocol failures, and an error frame MUST be followed by EOF.
- The daemon MUST emit `admitted` only after durable idempotent admission and execution-session start. The `admitted` stop policy then closes; blocking policies observe through a separate read-only connection bound to the daemon generation and close after Runtime observation closes.
- The daemon MUST honor socket backpressure. A client disconnect MUST NOT cancel admission or the run; after admission it terminates only that observer.
- A client MAY re-handshake and replay the same admission request id only until the admitted outcome is known. After an admitted frame, loss of the stream authority MUST remain `RUNTIME_AUTHORITY_LOST`; Runtime MUST NOT switch the observer to another authority.
- Daemon submission clients MUST NOT impose a unilateral admission deadline because disconnecting cannot prove that a durable mutation did not commit; idempotent controls MAY retain their bounded transport timeout, and status and shutdown probes MAY retain shorter bounded transport timeouts.
- Unary daemon clients MUST return typed `Effect.Effect` values with `rejected`, `transport`, and `protocol` failures. The submission client MUST incrementally expose `Stream.Stream<DaemonRunStreamFrame, DaemonRunStreamClientFailure>` without buffering the complete stream.
- Daemon client sockets MUST be scoped resources. Unary deadlines and endpoint/offline polling MUST use the Effect Clock, interruption MUST close the socket, and no client-local Promise or raw timer may own request lifetime.
- Successful control responses and admitted frames MUST validate the closed required `RunDetails`, `RunStatus`, execution-state, JSON-value, and control-result shapes; a control result type MUST match the requested intent, and malformed success data is a protocol failure.
- Materialized Agent Session inspection MUST NOT expose readiness timestamps,
  binding values, or raw launch/cwd/model/options; binding failures MAY expose
  only safe mismatch categories.
- Materialized Agent Session inspection MAY expose the latest bounded
  `reportedVersion` persisted by a successful ready write. Clients MUST treat
  it as informational and MUST NOT infer binding compatibility from it.
- Public daemon errors MUST use only `INVALID_REQUEST`, `AUTHORITY_MISMATCH`, `RUN_NOT_FOUND`, `RUN_NOT_CONTROLLABLE`, `CONTROL_CONFLICT`, `EXECUTION_UNAVAILABLE`, `STORE_BUSY`, `STORE_ERROR`, and `INTERNAL_ERROR`, with actionable text but no lease/SQLite/projection internals.
- Unknown daemon handler failures MUST become sanitized `INTERNAL_ERROR` responses and MUST NOT be classified as business control failures.
- Socket binding MUST arbitrate one daemon endpoint per workspace; durable Runtime authority MUST arbitrate every daemon or embedded Runtime owner. A valid daemon response proves endpoint liveness, while stale socket removal requires local evidence of a dead/expired owner.
- A current compatible authority MUST be accepted without lifecycle inspection. A recognized protocol-v3 predecessor MAY receive only strict status and graceful shutdown requests; when idle it MUST release its endpoint, authority, and shared ownership before offline store handling and v4 startup, while any active user, conflict, or timeout MUST return `RUNTIME_UPDATE_BLOCKED` without changing the process, run, manifest, journal, or generation.
- A future or unrecognized daemon MUST NOT receive shutdown or mutation requests and MUST return `RUNTIME_UPDATE_BLOCKED` without kill or spawn-around behavior.
- With no daemon, workflow admission MAY initialize an absent store or automatically complete recoverable generation rollover before starting the current daemon. A future, foreign, or unrecognized store MUST remain unchanged and return `RUNTIME_STORE_UNSUPPORTED`.
- Automatic rollover MUST gracefully retire the old daemon, acquire exclusive ownership, revalidate offline, durably record intent, preserve and archive the source generation, create and verify the current generation, atomically publish the manifest, verify publication, and then remove intent. Valid intent replay MUST converge; corrupt intent or changed source identity MUST return `RUNTIME_STORE_UNREADABLE` without guessed recovery.
- Graceful retirement MUST poll through the Effect Clock for at most 30 seconds and MUST treat only a definitively absent or refused endpoint as offline; timeout or an unknown response leaves the daemon and store unchanged and reports the existing busy/update-blocked outcome.
- Admission-side rollover failure MUST retain intent and source data and return `RUNTIME_STORE_REPAIR_FAILED`. Pause, resume, retry, cancel, signal, steer, and fork MUST NOT automatically roll over an outdated schema and MUST instead return `RUNTIME_STORE_REPAIR_REQUIRED`.
- The Workspace Runtime MUST host one serialized-write execution session per active/recoverable run, permit different runs concurrently, and keep long executor waits from blocking controls.
- A Runtime tick MUST NOT dispatch a run's hook backlog through a second store writer after that tick started or found an active execution session for the same run; the execution session owns checkpoint hook dispatch until it settles.
- After acquiring Runtime authority and before scheduling, the Workspace Runtime MUST create the [Agent Executor](agent-executor-spec.md#session-supervisor) Supervisor, which performs bounded ownership recovery before becoming usable.
- Session start MUST distinguish `started`, `already-active`, `terminal`, and `quarantined`; Runtime tick activity counts only `started` executions and dispatched hook work.
- Pause/cancel MUST durably fence their effect and abort only applicable active attempt controllers; late executor results cannot overwrite control state.
- Agent target inspection MUST expose one materialized `agentSession`, optional `steer`, and `availableControls` limited to `retry | steer | cancel`. It MUST expose lifecycle only as `active | abandoned` and MUST NOT expose pending Session assignments. A shared-session Agent Retry MUST be absent. Clients MUST NOT reconstruct control legality from status.
- Runtime MUST use the same pure retry topology and Session-impact planners for mutation, inspection, and run visualization. A Retry plan MUST return a deterministic sorted, deduplicated `reexecutedNodeKeys` set containing every node whose execution is reset, including restored `parent_failed` completion dependencies.
- `tryPlanRetry` MUST return the resolved target, expected scheduler version, and exact Session refs requiring neutralization. `tryCommitRetry` MUST re-plan within one SQLite transaction and commit only when every authoritative fact and neutralization proof remains exact; every mismatch MUST produce zero Store writes.
- Steer MUST resolve an exact started Agent attempt from an exact attempt id, exact dynamic node key, `@ref`, `@ref#attemptNo`, or unambiguous authored Agent id within the control transaction.
- An ambiguous authored steer target or colliding occurrence reference MUST return `CONTROL_CONFLICT` with deterministically sorted exact candidate keys.
- A steer target that is absent, non-Agent, no longer started, lacks current Runtime ownership, lacks the exact in-process `agentSessionId + attemptId + turnId + sessionLeaseId` registry tuple, or has a checkpoint other than `owned_in_flight | provider_observed` MUST return `RUN_NOT_CONTROLLABLE`.
- A rejected steer target MUST append no events.
- An accepted Steer MUST atomically persist `control.agent_steer_requested(delivery="interrupt_continue")` and supersede the exact Attempt as `operator_steered`; the instance MUST remain non-ready in `draining` until old Turn settlement.
- Only after commit may Runtime signal the exact existing Turn AbortController. Acceptance MUST NOT acquire a second Session guard or invoke a Session-wide interrupt API.
- An accepted steer MUST fence the superseded attempt's result commits before returning its receipt.
- An accepted steer MUST fence the superseded attempt's artifact commits before returning its receipt.
- An accepted steer MUST fence the superseded attempt's progress commits before returning its receipt.
- A `terminal_observed` old Turn settlement and `instance.requeued(reason="steered")` MUST commit atomically. Acceptance/terminal unknown MUST instead commit blocked lifecycle plus instance failure and MUST NOT dispatch the instruction.
- The replacement Attempt MUST use operation `continue`, prompt origin `steering`, the same Agent Session generation, and the requested event sequence as its admission lineage.
- Pause, cancel, and owner-loss handling MUST add a fallback semantic fence for each affected active Agent turn.
- Runtime MUST NOT roll back external side effects already performed by a superseded Agent turn.
- A steering replacement MUST reuse the frozen run, input, node configuration, concrete Agent bindings, and output schema.
- A steering replacement MUST reuse the effective ACP session.
- A steering replacement MUST receive a newly resolved full attempt timeout.
- Startup reconciliation MUST converge every accepted-but-unsignalled `draining` directive from durable checkpoint and ownership evidence; uncertainty blocks rather than re-delivering the instruction.
- Completion, failure, timeout, or explicit cancellation of a steering replacement MUST consume its pending steering directive.
- A later Steer is a new idempotent directive against the then-current exact active Turn; it MUST NOT overwrite an earlier directive in memory.
- Replaying a steer with the same request identity, target, and instruction MUST return its original receipt without appending events.
- Replaying a steer request identity with a different target or instruction MUST return `CONTROL_CONFLICT`.
- A successful steer result MUST NOT expose the instruction.
- A shared Agent Session does not itself reject Steer because the delivery targets one exact active Turn; lack of an exact tuple still rejects without session-wide cancellation.
- Pause and resume MUST be idempotent, with pause requeueing eligible canceled work and resume clearing the durable gate.
- A paused run session MUST finish bounded executor cleanup before returning `paused`.
- Resume MUST advance a run only through a new session with a newly claimed `ownerEpoch`.
- Retry MUST advance a run only through a new execution session with a newly claimed `ownerEpoch`.
- A no-op or idempotently replayed control MUST NOT stop the active execution, start another session, or claim another `ownerEpoch`.
- Retry MUST require an unambiguous failed or timed-out Task, Agent, or frame exact key, occurrence reference, or authored alias. Run-level Retry MUST NOT exist; a root frame remains a normal explicit target when the planner accepts it.
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
- A fork child MUST inherit the source workflow, input, and frozen Agent bindings except where the request supplies a replacement workflow or Agent injections.
- A fork child MUST execute its selected workflow from initial run state rather than continue the source execution state.
- Fork reuse MUST consider only accepted completed Agent, Task, and Signal results from the direct source run.
- A source result MUST be reusable only for the same child occurrence when its effective Agent, Task, or Signal definition and every resolved workflow value it reads are unchanged.
- Ambient host files, network state, wall-clock state, Provider behavior, random values, and authored callback purity MUST NOT affect reuse eligibility.
- Runtime MUST complete a reusable child occurrence from its source result without execution and execute every non-reusable occurrence normally.
- Outside an explicit-session group, a changed predecessor MUST NOT invalidate a later result when the later occurrence's own definition and resolved input values remain unchanged.
- Materialized direct-source Agent occurrences resolving the same explicit `sessionKey` MUST form one replay group, eligible only when every member satisfies ordinary reuse and checkpoint rules and the child can reproduce exactly the same closed occurrence set.
- A session group MUST either replay every member in direct-source accepted order without a child Agent attempt or ACP session, or execute every member in one fresh child session; fresh-child admission order does not affect that choice.
- If child execution reveals different group membership, Runtime MUST rerun the whole group if no member has replayed and otherwise fail before executing a member or completing a partial replay.
- Source-run artifacts inherited by the child MUST be exactly those referenced by reused results, with unchanged content.
- Without a fork target, every otherwise reusable direct-source result or complete session group MUST remain eligible.
- A fork target MUST resolve before child creation to one materialized source Agent, Task, or Signal occurrence.
- A missing, ambiguous, non-materialized, or attempt-suffixed fork target MUST fail without creating a child run.
- A targeted fork MUST NOT reuse the selected occurrence or source work completed after that occurrence first became eligible to run.
- Generic inspection MUST identify only the direct source run for a fork child.
- Signal control MUST target one open dynamic wait by exact node key, occurrence reference without an attempt suffix, or unambiguous authored alias, normalize payload, consume idempotently, and resume the recovered session from persisted state.
- `shutdown()` MUST stop only without active sessions, otherwise return `CONTROL_CONFLICT`; shutdown/idle-stop never mutates runs and no force-shutdown control exists.

### Read APIs And Runtime Operation

- `listRuns`, `getRun`, `resolveArtifact`, `readArtifact`, inspection, health, and visualization overlays MUST read durable projections/frozen data without live workflow source or daemon startup.
- Store-backed one-shot reads MUST use one bound read session. Workspace Runtime inspection MUST use a read-only connection bound to its owned generation rather than its scheduler write connection. Observation MUST bind one generation and one read-only connection at attachment, derive every token, view, and Timeline projection from that connection, and close rather than re-resolve when that authority becomes unavailable.
- Read-only inspection MUST validate persisted frozen IR, lock, and source metadata without resolving or hashing a workflow snapshot; execution and explicit frozen-run source resolution MUST fully verify the snapshot before returning its source root.
- `getRuntimeHealth` MUST expose the current workspace shard root as `persistence.path` even when the shard is not initialized.
- `getRuntimeHealth` MUST inspect ACP ownership read-only and add an `acp` warning only when degraded or orphaned ownership evidence exists.
- `getRuntimeHealth` MUST derive store health from `inspectRuntimeStore` without repair. A repairable state MUST remain a warning and name `acpus doctor --fix` as the next command.
- `getRuntimeHealth` MUST retain a `store` failure for unsupported storage, an unreadable layout, and every other database-open failure.
- `listRuns` MUST order by `updatedAt DESC, createdAt DESC`; `getRun` omits `dynamic` only when every dynamic collection is empty and fails visibly on decode/invariant errors.
- `getRunVisualizationSnapshot` MUST return run details, the frozen workflow name, description, and effective Agent definitions, visualization overlay, useful run-cancel applicability, and every exact planner-approved retry target, including targets accepted during a non-terminal failure-propagation window.
- Visualization control targets MUST contain only exact target, node/frame kind, and optional authored node id; they MUST NOT contain display labels, scheduler Result values, or group-member identities.
#### Inspection

Runtime owns generic inspection semantics and public shape.

- Generic inspection MUST provide one coherent run, target Summary, target
  Timeline, target Forensics, or candidate view. Concurrent inspections through
  one Workspace Runtime MUST be serialized at the store snapshot boundary and
  MUST NOT overlap transactions on its SQLite connection.
- Generic current-store inspection against repairable storage MUST fail without repair using `runtime-store-repair-required` and `acpus doctor --fix`.
- Generic current-store inspection against unsupported storage MUST fail before reading run data using `runtime-store-unsupported`; one-shot and observation paths MUST NOT collapse it into a generic read failure.
- Read-only observation MUST accept only run, target Summary, and target Timeline queries; target Forensics is a one-shot read.
- Summary and Timeline expose only views, candidates, observations, and public errors. They omit internal metadata and provider, steering, resource, hook, and raw-identity data; narrow node, Agent-execution, artifact, and Forensics reads remain separate.
- A target is `root`, an authored id, `@<8-lowercase-hex>`, or that reference with `#<positive-attempt-number>`. Malformed, absent, and colliding references MUST respectively return `invalid-query`, `target-not-found`, and a non-leaking `read-failed` result.
- A one-shot ambiguous authored target MUST return every public candidate in deterministic occurrence-path order and never select an occurrence; observation MUST reject it before attachment. Each row contains selector, status, and breadcrumb.
- Before attachment, observation MUST resolve and pin its subject. An authored id or occurrence reference follows replacement within its occurrence; an exact attempt closes when fenced, superseded, or terminal and never retargets.
- A run view includes run context, counts, semantic tree, and present terminal output. A target view includes its resolved subject and state plus relevant Summary/Timeline attention or activity. Counts include materialized occurrences even when folded.
- A non-terminal target Summary MAY include current Pulse and ACP silence. A `completed`, `failed`, `timed_out`, `cancelled`, or `not_selected` Summary MUST omit both; historical activity belongs only to Timeline.
- A target Summary MAY include `result` only as `{ status: "accepted", value }`, `{ status: "completed_without_output" }`, or `{ status: "not_accepted" }`. Failed, timed-out, and cancelled targets continue to use state and failure rather than a Result surrogate.
- The shared target Result projection MUST use a completed run's root output, a completed Task/Agent/Signal occurrence's durable instance output, or a completed If/Switch/Parallel/Fanout/Loop/Assert frame result. Undefined output MUST become `completed_without_output`, while JSON null remains an accepted value.
- An exact completed attempt MUST return accepted durable instance output only when its id equals the instance's `acceptedAttemptId`; a superseded or replaced attempt MUST return `not_accepted`. Summary, Forensics, and narrow node inspection MUST NOT infer accepted output from attempt result, execution metadata, progress, or provider response.
- Every Agent item in a run tree MUST identify a named `use` backend by that authored name and a raw command backend as `custom`. This identity MUST be independent of Agent activity and MUST NOT expose the command, model, config, environment, or provider data.
- A started Agent item MAY expose its current or latest-turn telemetry as optional input, output, and total token counts plus Context-window used and size. Missing counters MUST remain absent. Tree telemetry MUST omit usage source, cached or thought tokens, model, provider, pricing, content, and internal identity.
- A narrow node read MUST expose the same resolved-target state timing as a generic target view and MUST omit target duration when the selected target has no completed materialized boundary.
- A narrow node read's existing Summary output MUST be present only when the shared target Result is `accepted` and MUST contain that accepted value.
- A target Forensics view MUST contain the selected subject and state alongside `definition`, `invocation`, and `result` projections.
- Forensics Definition MUST come only from the run's frozen effective IR and frozen Agent binding provenance; it MUST NOT read current workflow source, resolve the current Preset catalog, expose frozen injections, or evaluate an expression.
- Forensics Definition MUST render frozen expressions in one stable, complete human-readable form.
- Forensics Invocation MUST come only from durable scheduler decisions, persisted Signal state, or attempt-scoped `task_attempt`/`agent_invocation` metadata.
- Forensics Result MUST expose output only from the scheduler-accepted occurrence or root output; it MUST NOT infer output from attempt metadata, provider response, progress, or expression evaluation.
- Forensics Invocation's unavailable reason MUST be exactly `not_started`, `not_selected`, `not_yet_resolved`, `resolution_failed`, or `not_recorded`.
- Forensics Result status MUST be exactly `accepted`, `completed_without_output`, `pending`, `not_started`, `not_selected`, `failed`, `timed_out`, `cancelled`, or `not_accepted`.
- A failed or timed-out Forensics Result MUST contain only optional code plus message.
- An occurrence Forensics read MUST use its latest attempt for Invocation while using only the occurrence's accepted durable output for Result; an exact attempt read MUST return `not_accepted` instead of that attempt's candidate output when the occurrence did not accept it.
- A static frozen node without a materialized occurrence MUST still expose Definition, MUST omit target duration, and MUST report Invocation/Result as not started or not selected according to durable branch choice.
- Forensics MUST project conditional branch choice, effective Parallel concurrency, materialized Fanout items/quorum/concurrency, and Loop index/round/state/transition from durable scheduler state without re-evaluating authored expressions; a Switch Definition's case ids MUST match its durable `selectedBranch` values.
- A dynamic Forensics Invocation MAY include its ordered branch, Fanout item/index, and Loop index/round/state context stack.
- Root Forensics Definition MUST include workflow metadata, complete input schema, root child ids/output expression, and every Agent's frozen effective definition plus binding provenance.
- Root Forensics Invocation MUST contain the complete run input.
- Agent Forensics Definition MUST include its complete effective definition, frozen binding provenance, node expressions, and output schema.
- Agent Forensics Invocation MUST contain only the selected attempt's first actual request prompt/origin, cwd, Acpus-managed env, model, permission, shared-session key when present, applied config, and deadline; origin MUST be `authored`, `steering`, or `repair`.
- Task Forensics Definition MUST render an inline Task as `implementation: inline` without source, preview, or digest, or identify a module by specifier/export.
- Task Forensics Invocation MUST contain its complete input, effective cwd, Acpus-managed env, and effective timeout values.
- Signal Forensics Invocation MUST use its persisted rendered prompt and deadline.
- Assert Forensics Invocation MUST use its durable assertion outcome; an assertion expression failure reports Invocation as unavailable, and a successful Assert Result MUST use the completed frame result.
- Forensics input, output, prompt, config, and env values MUST remain complete and untruncated; config and Acpus-managed env values MUST NOT be redacted.
- Missing historical invocation metadata MUST report `not_recorded` without fallback or reconstruction.
- A run view MUST read Agent activity in one coherent bounded projection containing at most the latest Observation Turn per started attempt and no semantic Timeline entries.
- Generic inspection MUST derive a running Agent's Tree pulse, Summary pulse, and Timeline current from the exact latest-turn Observation current.
- Generic inspection MUST NOT infer Agent activity from scheduler progress, an older turn, or the absence of an exact latest-turn current.
- When the exact latest-turn Observation current is `between`, the Tree and Summary MUST omit pulse and Timeline MUST omit current.
- A tool closed before `between` MUST remain eligible for Timeline Recent activity.
- A provider-settled Agent current whose occurrence remains non-terminal MUST project as `settling`; a terminal Agent occurrence MUST project as `settled`.
- A Tree Agent pulse MUST omit thought and response bodies; an active tool pulse MAY include its bounded name, optional human-readable title, and status.
- A Summary for a running Agent target with a durable ACP activity timestamp MUST include the elapsed duration since that activity; it MUST not include an inactivity threshold or predicted failure time.
- The tree MUST omit unselected conditional subtrees and completed empty branches while retaining their materialized occurrences in Counts.
- A run inspection MAY request `structure: "materialized"`; the default tree MUST collapse a sole-child branch, `if`, or `switch` wrapper only when it has the same state as its child and carries no attention, failure, progress, or pulse, while the materialized tree MUST retain those wrappers and every already-materialized occurrence after applying the same unselected and empty-branch pruning.
- The default tree MUST fold two or more contiguous equivalent Fanout items or Loop rounds, while a materialized tree MUST NOT repeat-fold occurrences. Equivalence ignores occurrence identity, duration, and per-occurrence Agent telemetry but preserves visible state, Agent identity, progress, pulse, failure, attention, and shared subtree shape.
- A fold MUST show one shared subtree without representative selectors or durations and MUST NOT contain actionable attention.
- A fold MUST omit per-occurrence Agent telemetry rather than present one occurrence's counters as shared facts.
- Observation emits attachment, zero or more updates, then closure; an initial stop emits closure only, abort is silent, and error ends without closure.
- The daemon's closed target Summary protocol MUST strictly validate the optional Result union, including JSON compatibility of an accepted value, and reject missing fields, unknown statuses, and extra fields.
- Decision updates MUST expose the smallest coherent next-action delta that caused them; Agent pulse or current activity, time, liveness aging, usage, hooks, and silence MUST NOT emit alone.
- An Agent Tree pulse MAY expose only the latest active tool, otherwise its latest closed tool, as bounded `name`, optional ACP `title`, and normalized `running`, `completed`, `failed`, or `canceled` state. It MUST retain that recent tool between semantic phases and after Agent settlement, and MUST NOT expose tool-call identity, arguments, paths, input, output, Prompt, response, thought, usage, model, configuration, environment, or provider data.
- Observation MAY opt into activity updates. In that mode a change to the bounded Tree pulse, Summary pulse, or Timeline current MUST emit an update marked `activity: true` without embedding provider bodies, thought, response, Prompt, or raw identity data. Tree telemetry MAY accompany the next emitted view or closure but MUST NOT emit an activity update by itself. Time and silence alone MUST NOT emit an activity update, and the default observation mode MUST retain decision-update behavior.
- Reasons MAY clarify transitions when state is insufficient; event-history gaps MUST NOT prevent a readable current view.
- `subject-terminal` closes only when the fixed subject is terminal. `decision-boundary` closes for a terminal or paused run, actionable run Signal, or an actionable Signal required by the target. Evaluate boundaries after settlement; absorbed Race/Quorum failures and unrelated siblings do not close a target.
- A one-shot Timeline MUST expose only the latest 12 durable closed entries. Timeline observation appends only newly visible durable closed entries to that bounded activity view; it preserves gaps, shares the observation stop policy, and never closes observation independently.

- Read-only liveness MUST derive `active`, `inactive`, `stale`, `terminal`, or `unknown` from durable state plus local Runtime-authority and run-lease evidence without persisting that classification or performing recovery.
- Workspace Runtime lifecycle MUST heartbeat every 1s and use a 5s observational stale threshold distinct from the 30s run-lease window. The daemon Adapter MUST idle-stop after 30s without active connections, active Runtime work, or locally continuable durable work.
- After acquiring Runtime authority and before its first scheduling tick, the Workspace Runtime MUST remove `.staging-*` run directories that have been stale for at least 60 seconds.
- Stale staging cleanup MUST leave ordinary run directories unchanged regardless of whether they have a database row.
- An ordinary run directory with a valid run id but no database row MUST fail Workspace Runtime startup visibly and remain unchanged for operator inspection.
- Stale staging cleanup MUST ignore only paths that disappear during inspection; other directory read/stat failures MUST abort Workspace Runtime startup.
- Paused runs and untimed Signal waits alone MUST not keep the daemon resident; a non-terminal run with an immediately derivable transition, an expired owner's started attempt, or an admissible ready node MUST receive one recovery drive even when another branch is awaiting an untimed Signal. Derivable transitions include due attempt settlement, group terminalization, and leaf/frame/ancestor propagation. Timed waits keep the daemon resident until durably settled, and startup recovery is targeted rather than a whole-store repair sweep.
- A recovered owner MUST settle already-due attempt deadlines before superseding remaining expired-owner `started` attempts.
- A recovered owner MUST durably supersede expired-owner `started` attempts before admitting replacement leaf work.
- Superseded attempts MUST NOT consume logical leaf capacity after their superseding transition commits.
- The physical leaf cap MUST apply independently to each owner epoch.
- Lease failover MUST NOT require proof that a stale external process has stopped before the recovered owner admits replacement work.

## Verification

- `pnpm test:unit packages/runtime`: covers prepared-workflow closed validation and workspace referrer containment, read-only store inspection, prune selection, fork compatibility, selector resolution, semantic trees/folding, Forensics projections, privacy, and stop policies.
- `pnpm test:integration packages/runtime`: covers layout-v2 publication, serialized repair and first use, repair resumption, canonical snapshot-manifest recovery, database/sidecar fencing, archived summaries, WAL-visible preservation, durable execution/recovery, read-only inspection, and safe known-workspace discovery.
- `pnpm test:contract packages/cli`: covers the exact compact text distinction between initial Agent activity and intervals without current activity.
- `pnpm --filter @acpus/runtime typecheck`: verifies the Runtime package implementation; `pnpm test:type packages/runtime` verifies its exported function and DTO contracts and their compiler, Core, Expression, and ACP execution type relationships.
