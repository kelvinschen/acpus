# @acpus/agent-executor

## 0.5.1

### Patch Changes

- 63203bf: Update the bundled acpx dependency to 0.13.0 and preserve structured Agent argv
  through resolution, worker startup, and session persistence.

## 0.5.0

### Minor Changes

- 0a9355c: Separate exact Agent response segments from the completed turn response used
  for node output and schema conformance.

### Patch Changes

- 8a5c380: Resolve named Agent commands from the pinned Acpx global and project
  configuration for each managed attempt while keeping explicit commands and
  other Acpx configuration domains outside the integration.

## 0.4.0

### Minor Changes

- 387dfe7: Run each ACP Agent attempt in an owned worker process, with bounded best-effort
  cleanup and startup recovery for recorded worker ownership. Runtime now exposes
  optional ACP silence information, can fail an attempt after a configured
  inactivity boundary, and reports only unresolved ACP ownership through Doctor.

  Daemon lease and status metadata now report the installed CLI package version
  instead of a stale alpha value.

- 898831e: Remove opt-in raw Agent Trace authoring and storage. Settled Agent turn
  artifacts now reference the run-local acpx session projection, whose compact
  messages, thinking, tool calls, and tool-result content are retained without
  the optional full tool output.

  Use short run-local ACP session identities, and treat only known routine acpx
  status metadata as observation noise so unsupported provider activity remains
  visible as degraded evidence.

## 0.3.0

### Minor Changes

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

## 0.2.1

### Patch Changes

- 1318af2: Update the bundled acpx dependency to 0.12.1.

## 0.2.0

### Minor Changes

- c809bff: Add static Agent ACP config profiles, including model and adapter-specific session options, across authoring, IR, execution, and Agent configuration guidance.

## 0.1.1

### Patch Changes

- 93560c5: Support Node.js 22.18+ within the Node.js 22 line and Node.js 24 or newer. Acpus-triggered SQLite initialization now suppresses only Node.js's SQLite experimental warning, leaving unrelated warnings visible.

## 0.1.0

### Minor Changes

- c162856: Expose honest Agent telemetry availability, direct fork lineage, compact run-level Agent usage, aggregate repeated targets, and rate-limited non-TTY follow omissions for long-running workflow operation.
- 7f3f186: Unify run inspection behind a compact runtime projection with structural text views, target and raw modes, durable follow updates, shared CLI/Web semantics, live Agent telemetry summaries, and lossless structured acpx failure causes.
- cd35e5b: Release the TypeScript-first Acpus package graph with the CLI, authoring
  facades, compiler, durable runtime, task library, and Web inspector aligned on
  the same public dependency contract.
- aae74a6: Replace authored duration strings in agent turn requests with validated resolved
  millisecond budgets, including monotonic shared deadlines, safe long-timeout
  scheduling, acpx rounding, and race-safe subprocess cancellation.

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
- Require Node.js 24.15 or newer so every supported runtime provides the
  unflagged `node:sqlite` API used by durable runs.

## 0.1.0-alpha.4

### Patch Changes

- 108d06e: Republish the alpha package graph so runtime consumers resolve an
  `@acpus/expression/ir` entrypoint that exports `isJsonValue`.

## 0.1.0-alpha.3

### Minor Changes

- c162856: Expose honest Agent telemetry availability, direct fork lineage, compact run-level Agent usage, aggregate repeated targets, and rate-limited non-TTY follow omissions for long-running workflow operation.
- 7f3f186: Unify run inspection behind a compact runtime projection with structural text views, target and raw modes, durable follow updates, shared CLI/Web semantics, live Agent telemetry summaries, and lossless structured acpx failure causes.
- aae74a6: Replace authored duration strings in agent turn requests with validated resolved
  millisecond budgets, including monotonic shared deadlines, safe long-timeout
  scheduling, acpx rounding, and race-safe subprocess cancellation.

### Patch Changes

- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.

## 0.1.0-alpha.2

### Patch Changes

- Fix installed workflow typechecking for Acpus authoring facade imports.

## 0.1.0-alpha.1

### Patch Changes

- Republish the alpha package graph with built loader artifacts included.

## 0.1.0-alpha.0

### Minor Changes

- cd35e5b: Prepare the TypeScript-first Acpus alpha release.

  This prerelease publishes the current CLI runtime dependency graph under the
  `alpha` dist-tag while leaving legacy `latest` releases unchanged.
