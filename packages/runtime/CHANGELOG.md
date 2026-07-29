# @acpus/runtime

## 0.12.1

### Patch Changes

- ae93e6c: Keep compact run inspection operational by retaining up to three active
  executable leaves and their tree context outside the ordinary overview budget.
- 117b4f1: Render compact TypeScript-like Agent result shapes instead of JSON Schema,
  with bounded output recovery. Preserve advisory numeric constraints and Zod 4
  default-factory and numeric-enum semantics when lowering graph-boundary
  schemas.
- 90eda1f: Simplify durable run inspection with short occurrence references, numbered
  current-view pages, exact command rendering, privacy-safe ordinary output,
  explicit Evidence reads, and canonical deep Web inspection targets.
  Make settled Agent pulse headlines prefer meaningful intent and label response
  tails whose retained text is missing its prefix.
- Updated dependencies [117b4f1]
  - @acpus/core@0.10.1
  - @acpus/loader@0.2.1

## 0.12.0

### Minor Changes

- efbb24c: Accept workflow sources outside the workspace and from standard input without
  writing generated source into the project. Capture their static local module
  closure as a content-addressed bundle, persist it during Runtime admission, and
  restore reusable Tasks from the durable snapshot while retaining the workspace
  as the command and package-dependency authority.
- 9d24c58: Add a closed Runtime-owned Agent execution inspection mode that resolves one
  occurrence and attempt, preserves scheduler-authoritative status, reads one
  bounded semantic observation page without reading artifact bodies, and reports
  when retained recent tool details may be incomplete. Project that document
  field by field through Web, reject unknown browser payload fields, and avoid
  presenting a partial empty tool list as proof that no tools ran.
- f5ee270: Allow inline and reusable Tasks to receive any durable value directly while
  preserving precise materialized input types. Lower and execute Task input as one
  expression, expose its complete authored shape in workflow visualization, and
  accept interface-shaped durable results from `lift`.

  Advance frozen workflow IR and Runtime storage generations so existing
  generation isolation rejects the previous Task-input representation without a
  compatibility shim.

- e531936: Add compact Private Turn Evidence for exact prompt, fence, and terminal
  boundaries; bounded write-time semantic projection for inspection; and
  opt-in full normalized Trace spooling without relaxing attempt fencing.

  Replace target inspection with a high-density decision summary, add a unified
  bounded Timeline with opaque pagination and connection-local incremental follow, and
  expose Evidence/Trace metadata only for exact Agent attempts. Keep rich node
  details available to the Web operator surface without adding a Web Timeline.
  Keep resource telemetry in explicit diagnostics, reserve Attention for hard
  operator needs, and present steer as an available last-resort correction rather
  than a recommendation.

- d6ebc84: Move durable runtime state into private per-workspace shards under the Acpus
  home, archive incompatible or partial storage generations before rebuilding,
  preserve global-catalog source references for execution, and centralize
  verified artifact reads in Runtime. Add `runs prune` with fixed confirmed
  selection cutoffs and relocate CLI-owned cache, snapshot, import, and
  report-draft data out of workspace runtime storage. Keep frozen catalog
  sources separate from the workspace dependency authority during preparation
  and reusable Task execution, and isolate daemon fallback endpoints and
  temporary directories per Acpus home. Show the current workspace shard path
  in Doctor text and JSON output without initializing it, highlighting the text
  form on color-capable terminals.
- d5dde51: Add durable Agent steering with attempt fencing, same-session correction,
  crash-safe redelivery, CLI receipts, and redacted inspection/follow guidance.
- 625cae9: Restore frozen functions through one serialized-function environment so lift
  callbacks and inline Tasks support compiler-emitted name helpers consistently.
  Expose persisted root-frame failures in inspection summaries and surface direct
  run-level failures in overview Attention and text follow output.

### Patch Changes

- 7e65dee: Make Core boundary failures deterministic and accurately observable:

  - report the zx-rendered command for array and complex Task command interpolation;
  - return `invalid-default` for cyclic or uncloneable Zod defaults instead of
    throwing, while using native structured-clone semantics for shared values;
  - preserve own object-map fields named `__proto__` throughout Core lowering
    instead of treating them as prototype mutation;
  - reject POSIX, Windows drive-relative, rooted, UNC, and device paths wherever
    reusable Task referrers require a portable workspace-relative path;
  - reject unknown workflow reference roots, unknown run metadata fields, and
    malformed values in otherwise allowed frozen-IR fields; and
  - inspect schemas only through the supported Zod 4 `def`, `type`, and
    `description` interfaces.

  Classify structured agent configuration failures by JSON-RPC code rather than
  by the command that emitted them: numeric or string `-32602` remains `config`,
  while every other structured JSON-RPC failure is now `provider_exit`.
  Unstructured rejected configuration commands remain `config`.

  Make reusable Task compilation produce complete IR in one pass:

  - accept source links before Core graph construction instead of publishing
    empty module targets for the compiler to mutate afterward;
  - accept the shared reusable-Task referrer as one path fact instead of an
    input object shaped like the eventual IR descriptor;
  - return typed Core compilation failures for missing or invalid reusable Task
    links, including when ordinary IR validation is disabled;
  - fail malformed Task specs instead of returning an empty inline executable;
  - retain ordinary build/lowering causes in the typed failure while preserving
    the throwing convenience API's original exception identity; and
  - run compiler Task analysis and source-containment checks before invoking the
    workflow build callback. Successful compiled IR and runtime behavior are
    unchanged.

  Make expression graph boundaries total and preserve authored data:

  - return tagged lowering failures for cyclic or uninspectable values instead of
    leaking recursion or Proxy trap exceptions;
  - reject cyclic callback inputs with `ExpressionEvaluationError` and use native
    structured cloning, which preserves shared-reference identity while
    isolating callback mutation;
  - preserve ordinary object fields named `__proto__` during lowering and
    evaluation; and
  - validate missing and non-JSON template values before an adapter formatter can
    handle them.

  Resolve lazy bare imports from overlapping authoring source roots through the
  most specific registered dependency authority, independent of registration
  order, and propagate symlink-loop or I/O failures while canonicalizing an
  authority instead of treating them as a missing path.

  Reject self-consistent but structurally invalid prepared workflow IR before
  Runtime admission or fork mutation. Core validator errors and pre-existing
  error diagnostics now return the typed `invalid-ir` preparation failure;
  warning-only IR remains admissible.

  Preserve an authored Task input field named `__proto__` as ordinary own
  WorkflowData instead of silently installing it as the temporary input object's
  prototype and dropping it before execution.

  Make prepared workflow source identity single-owned:

  - preparation inputs identify a workspace or global catalog but no longer
    repeat the workflow entry;
  - CLI catalog resolution carries that input identity directly instead of
    constructing an entry that its preparation adapter immediately discarded;
  - the compiler derives the portable entry from the workflow path and selected
    source root exactly once;
  - missing global roots, inconsistent workspace roots, and workflow paths
    lexically outside the selected root now fail before check or compilation
    with the typed `source-invalid` failure;
  - existing workflow symlinks that resolve outside the selected source root are
    rejected in the same source phase before source checking or execution;
  - contained workflow names beginning with `..` remain valid unless `..` is an
    actual parent path segment; and
  - CLI and Web workflow-visualization output expose the corresponding `source`
    phase as part of their closed result unions.

  Restrict the followed workflow run NDJSON admission record to the public `RunRecord`
  projection. This removes previously exposed normalized input, Agent overrides,
  hook history, execution state, dynamic details, and internal event/node counts;
  subsequent follow records are unchanged.

- 9d24c58: Bind Runtime storage roots, run capsules, resolved ArtifactRefs, Task and Agent
  artifacts, Private Turn Evidence, and Trace files to their observed filesystem
  identities. Fail closed on same-path replacement, missing stable inode identity,
  or an orphan run capsule requiring operator inspection instead of adopting or
  deleting an ambiguous path. Keep Agent artifact paths isolated by attempt id,
  fence verified reads around their open file descriptor, and retain a durably
  registered artifact when a later identity checkpoint fails.
- 9d24c58: Project runtime node inspection into a closed Web-owned response before sending
  it to the browser. Remove Runtime document markers, raw collections, internal
  Agent telemetry, and registry artifact fields from the one-second Overview
  poll; expose only a normalized unambiguous Signal action; and preserve exact
  verified prompt text, structured failures, public artifacts, and existing
  Inspector behavior. Keep context-scoped repeated Signal inspection
  occurrence-exact so another occurrence's wait cannot supply its action target.
- 9d24c58: Project retry and cancel applicability from the Runtime control planner so Web
  and inspection no longer advertise targets that control admission will reject.
  Return exact retry targets with the runtime visualization snapshot and expose an
  exact selected cancel target only through Runtime target inspection. Run-level
  cancel now also handles a paused run whose root frame has not materialized, and
  historical attempts no longer inherit controls for a later execution of the
  same node. Read-side retry planning now performs the same pure failure
  settlement as mutation admission without writing it, identity collisions fail
  closed, and Web rejects blank control targets at its boundary.
- 9d24c58: Report older Acpus Runtime storage as a recoverable Doctor warning. Doctor now
  explains that the workspace remains usable and reports successful checks with
  warnings while preserving failures for invalid or newer database formats.
- Updated dependencies [7e65dee]
- Updated dependencies [efbb24c]
- Updated dependencies [f5ee270]
- Updated dependencies [e531936]
- Updated dependencies [d6ebc84]
- Updated dependencies [be0e46a]
- Updated dependencies [625cae9]
  - @acpus/agent-executor@0.3.0
  - @acpus/core@0.10.0
  - @acpus/expression@0.2.0
  - @acpus/loader@0.2.0

## 0.11.1

### Patch Changes

- Updated dependencies [1318af2]
  - @acpus/agent-executor@0.2.1

## 0.11.0

### Minor Changes

- c809bff: Add static Agent ACP config profiles, including model and adapter-specific session options, across authoring, IR, execution, and Agent configuration guidance.

### Patch Changes

- Updated dependencies [c809bff]
  - @acpus/agent-executor@0.2.0
  - @acpus/core@0.9.0
  - @acpus/loader@0.1.4

## 0.10.0

### Minor Changes

- 152303a: Parse schema-backed Agent results from terminal Tagged JSON frames advertised by a concise mandatory output contract, retain one bounded local JSON repair pass, and render complete nullable/default/description metadata in output JSON Schema prompts. `AgentOutputProcessing` now reports `outcome`, failure `phase`, parsing mode, and projection changes instead of the previous recovery/conformance fields.
- 079e1ee: Add occurrence-aware run inspection trees and bounded live Agent pulses while keeping the default operator view compact and actionable.

### Patch Changes

- Updated dependencies [152303a]
  - @acpus/core@0.8.0
  - @acpus/loader@0.1.3

## 0.9.2

### Patch Changes

- 93560c5: Support Node.js 22.18+ within the Node.js 22 line and Node.js 24 or newer. Acpus-triggered SQLite initialization now suppresses only Node.js's SQLite experimental warning, leaving unrelated warnings visible.
- Updated dependencies [93560c5]
  - @acpus/agent-executor@0.1.1
  - @acpus/core@0.7.2
  - @acpus/expression@0.1.1
  - @acpus/loader@0.1.2

## 0.9.1

### Patch Changes

- Updated dependencies [07f4e6b]
  - @acpus/core@0.7.1
  - @acpus/loader@0.1.1

## 0.9.0

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
- cd35e5b: Release the TypeScript-first Acpus package graph with the CLI, authoring
  facades, compiler, durable runtime, task library, and Web inspector aligned on
  the same public dependency contract.
- 3df9b55: Allow optional runtime expressions to configure Parallel and Fanout concurrency,
  and treat missing or zero limits as no authored local cap while keeping quorum
  counts and invalid concurrency values strict.

### Patch Changes

- 108d06e: Align the package graph so runtime consumers resolve an
  `@acpus/expression/ir` entrypoint that exports `isJsonValue`.
- 9686cda: Include built loader artifacts in the published package graph.
- 0a842d4: Fix installed workflow typechecking for Acpus authoring facade imports.
- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.
- aae74a6: Remove redundant direct dependencies on `@acpus/tasks`; dynamic authoring facade resolution remains owned by `@acpus/loader`.
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
- aae74a6: Use the Core typed duration parser for runtime and hook configuration, reject
  unsafe or non-persistable deadlines with typed failures, and preserve long hook
  and task timeouts with cancellable chunked timers and deadline-first process
  settlement. Surface corrupted persisted deadlines by stopping a permanently
  failing daemon loop with complete teardown, journal synchronous hook spawn
  failures, and make run-scoped control idempotency exact for successful no-op
  controls, state-stable retry/cancel aliases, and explicit `root` node targets.
  Preserve cooperative Task cleanup when cancellation races child-process startup
  by delivering start before the already-pending abort.
- Require Node.js 24.15 or newer so every supported runtime provides the
  unflagged `node:sqlite` API used by durable runs.
- aae74a6: Consolidate runtime stable JSON and scheduler scope bindings, preserve existing
  persisted byte framing, and make unsupported stable-JSON roots fail explicitly.
- aae74a6: Propagate malformed durable scheduler and projection read failures from
  run-detail APIs instead of silently omitting dynamic state.
- Updated dependencies [e3a75f4]
- Updated dependencies [61bbf86]
- Updated dependencies [b8fef84]
- Updated dependencies [c1f09ae]
- Updated dependencies [c162856]
- Updated dependencies [7f3f186]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [cd35e5b]
- Updated dependencies [108d06e]
- Updated dependencies [958779b]
- Updated dependencies [9686cda]
- Updated dependencies [85b3b7d]
- Updated dependencies [0a842d4]
- Updated dependencies [aae74a6]
- Updated dependencies [c902db5]
- Updated dependencies [c5b897b]
- Updated dependencies [aae74a6]
- Updated dependencies [6ef7549]
- Updated dependencies [3df9b55]
- Updated dependencies
- Updated dependencies [d92f9f9]
- Updated dependencies [c14e800]
  - @acpus/expression@0.1.0
  - @acpus/core@0.7.0
  - @acpus/agent-executor@0.1.0
  - @acpus/loader@0.1.0

## 0.9.0-alpha.8

### Patch Changes

- 108d06e: Republish the alpha package graph so runtime consumers resolve an
  `@acpus/expression/ir` entrypoint that exports `isJsonValue`.
- Updated dependencies [108d06e]
  - @acpus/agent-executor@0.1.0-alpha.4
  - @acpus/core@0.7.0-alpha.7
  - @acpus/expression@0.1.0-alpha.6
  - @acpus/loader@0.1.0-alpha.7

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
