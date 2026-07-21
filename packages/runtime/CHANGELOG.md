# @acpus/runtime

## 0.9.0-alpha.7

### Patch Changes

- 32cc127: Make targeted retry distinguish failed target paths from `parent_failed`
  completion dependencies, restore required canceled work in one event, preserve
  resolved timeouts, and atomically reject terminal, paused, configuration, or
  strategy-blocked retries that cannot schedule progress. Fail and recover
  running `parallel all` and `fanout all` groups whose required work is canceled
  instead of leaving the run non-terminal without schedulable work. After a
  restart, reconcile all immediately derivable composite transitions, resume
  admissible ready work, and recover an expired owner's started attempts even
  beside an untimed Signal wait. Derive wide member cancellation batches without
  rescanning the projection per member.

## 0.9.0-alpha.6

### Patch Changes

- Updated dependencies [c902db5]
  - @acpus/core@0.7.0-alpha.6
  - @acpus/loader@0.1.0-alpha.6

## 0.9.0-alpha.5

### Minor Changes

- e3a75f4: Model every executable scope as one arbitrary WorkflowData output expression in
  IR v5, preserve composite aggregation envelopes, and expose syntax-derived
  output shape across runtime, CLI, and Web inspection.
- aae74a6: Remove the uncontracted `RuntimeStore`, `AdvanceRunSummary`, `SchedulerStorePort`,
  `AgentOverrideSpec`, `RunExecutionMetadata`, `RunDynamicGroup`, `ForkRunRecord`,
  `RuntimeDiagnostics`, and `DaemonDiagnostics` type exports from the
  `@acpus/runtime` package root. Their internal definitions and the durable store
  port remain in use; the obsolete direct interpreter and its store APIs are
  removed so runtime execution has one durable scheduler path.

  Declare `@acpus/workflow-compiler` at the runtime test boundary instead of
  relying on the workspace root to provide fixture compilation transitively.

- c162856: Expose honest Agent telemetry availability, direct fork lineage, compact run-level Agent usage, aggregate repeated targets, and rate-limited non-TTY follow omissions for long-running workflow operation.
- 7f3f186: Unify run inspection behind a compact runtime projection with structural text views, target and raw modes, durable follow updates, shared CLI/Web semantics, live Agent telemetry summaries, and lossless structured acpx failure causes.
- aae74a6: Make run-local `workflow.ir.json` and `lock.json` the sole frozen workflow
  artifacts, persist their required paths and digests in the current SQLite
  schema, and initialize that schema directly.
- 3df9b55: Allow optional runtime expressions to configure Parallel and Fanout concurrency,
  and treat missing or zero limits as no authored local cap while keeping quorum
  counts and invalid concurrency values strict.

### Patch Changes

- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.
- aae74a6: Remove redundant direct dependencies on `@acpus/tasks`; dynamic authoring facade resolution remains owned by `@acpus/loader`.
- aae74a6: Use the Core typed duration parser for runtime and hook configuration, reject
  unsafe or non-persistable deadlines with typed failures, and preserve long hook
  and task timeouts with cancellable chunked timers and deadline-first process
  settlement. Surface corrupted persisted deadlines by stopping a permanently
  failing daemon loop with complete teardown, journal synchronous hook spawn
  failures, and make run-scoped control idempotency exact for successful no-op
  controls, state-stable retry/cancel aliases, and explicit `root` node targets.
  Preserve cooperative Task cleanup when cancellation races child-process startup
  by delivering start before the already-pending abort.
- aae74a6: Consolidate runtime stable JSON and scheduler scope bindings, preserve existing
  persisted byte framing, and make unsupported stable-JSON roots fail explicitly.
- aae74a6: Propagate malformed durable scheduler and projection read failures from
  run-detail APIs instead of silently omitting dynamic state.
- Updated dependencies [e3a75f4]
- Updated dependencies [61bbf86]
- Updated dependencies [c1f09ae]
- Updated dependencies [c162856]
- Updated dependencies [7f3f186]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [958779b]
- Updated dependencies [85b3b7d]
- Updated dependencies [aae74a6]
- Updated dependencies [c5b897b]
- Updated dependencies [aae74a6]
- Updated dependencies [3df9b55]
- Updated dependencies [d92f9f9]
- Updated dependencies [c14e800]
  - @acpus/expression@0.1.0-alpha.5
  - @acpus/core@0.7.0-alpha.5
  - @acpus/agent-executor@0.1.0-alpha.3
  - @acpus/loader@0.1.0-alpha.5

## 0.9.0-alpha.4

### Patch Changes

- Updated dependencies [6ef7549]
  - @acpus/expression@0.1.0-alpha.4
  - @acpus/core@0.7.0-alpha.4
  - @acpus/loader@0.1.0-alpha.4
  - @acpus/tasks@0.1.0-alpha.4

## 0.9.0-alpha.3

### Patch Changes

- Updated dependencies [b8fef84]
  - @acpus/expression@0.1.0-alpha.3
  - @acpus/core@0.7.0-alpha.3
  - @acpus/loader@0.1.0-alpha.3
  - @acpus/tasks@0.1.0-alpha.3

## 0.9.0-alpha.2

### Patch Changes

- Fix installed workflow typechecking for Acpus authoring facade imports.
- Updated dependencies
  - @acpus/agent-executor@0.1.0-alpha.2
  - @acpus/core@0.7.0-alpha.2
  - @acpus/expression@0.1.0-alpha.2
  - @acpus/loader@0.1.0-alpha.2
  - @acpus/tasks@0.1.0-alpha.2

## 0.9.0-alpha.1

### Patch Changes

- Republish the alpha package graph with built loader artifacts included.
- Updated dependencies
  - @acpus/agent-executor@0.1.0-alpha.1
  - @acpus/core@0.7.0-alpha.1
  - @acpus/expression@0.1.0-alpha.1
  - @acpus/loader@0.1.0-alpha.1
  - @acpus/tasks@0.1.0-alpha.1

## 0.9.0-alpha.0

### Minor Changes

- cd35e5b: Prepare the TypeScript-first Acpus alpha release.

  This prerelease publishes the current CLI runtime dependency graph under the
  `alpha` dist-tag while leaving legacy `latest` releases unchanged.

### Patch Changes

- Updated dependencies [cd35e5b]
  - @acpus/agent-executor@0.1.0-alpha.0
  - @acpus/core@0.7.0-alpha.0
  - @acpus/expression@0.1.0-alpha.0
  - @acpus/loader@0.1.0-alpha.0
  - @acpus/tasks@0.1.0-alpha.0
