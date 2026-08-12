# @acpus/web

## 0.3.1

### Patch Changes

- c34af71: Bind reads and streamed admission to one opaque Runtime authority, safely retire an idle predecessor daemon, preserve active or incompatible stores without mutation, and map typed Runtime availability directly in CLI and Web recovery flows.
- Updated dependencies [261912e]
- Updated dependencies [c34af71]
  - @acpus/core@0.12.0
  - @acpus/workflow-compiler@0.3.4
  - @acpus/runtime@0.16.1

## 0.3.0

### Minor Changes

- 8492ee4: Redesign Acpus Web around a Paper Relay Runs workspace with a card-based Runs list, animated Run Monitor navigation, known-workspace switching with read-only browsing, clearer graph and node inspection semantics, and observable runtime values for composite nodes.

  Add full-screen Artifact viewing with complete JSON, Markdown, Mermaid, and sandboxed HTML rendering, and expose Runtime APIs for safely discovering and resolving known workspaces.

### Patch Changes

- d975cb9: some kind of refactor
- Updated dependencies [8492ee4]
- Updated dependencies [d975cb9]
  - @acpus/runtime@0.16.0

## 0.2.7

### Patch Changes

- Updated dependencies [8c01860]
  - @acpus/runtime@0.15.1

## 0.2.6

### Patch Changes

- bb26336: optimize the web ui for better ux
- Updated dependencies [039a328]
- Updated dependencies [bb26336]
- Updated dependencies [44d4dad]
  - @acpus/runtime@0.15.0

## 0.2.5

### Patch Changes

- Updated dependencies [1d6dad0]
- Updated dependencies [a82e969]
  - @acpus/runtime@0.14.2
  - @acpus/workflow-compiler@0.3.3

## 0.2.4

### Patch Changes

- Updated dependencies [cbd73b7]
- Updated dependencies [23421cc]
  - @acpus/runtime@0.14.1

## 0.2.3

### Patch Changes

- Updated dependencies [0a9355c]
- Updated dependencies [a775e12]
- Updated dependencies [4937cc5]
- Updated dependencies [8a5c380]
- Updated dependencies [bcac75e]
  - @acpus/runtime@0.14.0

## 0.2.2

### Patch Changes

- Updated dependencies [43c1df1]
- Updated dependencies [387dfe7]
- Updated dependencies [898831e]
- Updated dependencies [898831e]
  - @acpus/runtime@0.13.0
  - @acpus/core@0.11.0
  - @acpus/workflow-compiler@0.3.2

## 0.2.1

### Patch Changes

- 90eda1f: Simplify durable run inspection with short occurrence references, numbered
  current-view pages, exact command rendering, privacy-safe ordinary output,
  explicit Evidence reads, and canonical deep Web inspection targets.
  Make settled Agent pulse headlines prefer meaningful intent and label response
  tails whose retained text is missing its prefix.
- Updated dependencies [ae93e6c]
- Updated dependencies [117b4f1]
- Updated dependencies [90eda1f]
  - @acpus/runtime@0.12.1
  - @acpus/core@0.10.1
  - @acpus/workflow-compiler@0.3.1

## 0.2.0

### Minor Changes

- 9d24c58: Deepen static workflow visualization around canonical compiler data:

  - replace the HTML renderer's caller-assembled graph, metadata, and contract
    inputs with one `WorkflowIR` plus its source graph digest;
  - derive browser and offline static visualization data through one Web-owned
    projection so those views cannot diverge;
  - retain recoverable source and compiler failures as tagged Results until the
    Hono adapter produces the existing HTTP visualization envelope; and
  - report workflow selections rejected before compiler preparation as
    source-phase failures instead of compile-phase failures while accepting
    contained workflow names that merely begin with two dots.

  CLI HTML visualization output remains unchanged.

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

- 9d24c58: Project runtime node inspection into a closed Web-owned response before sending
  it to the browser. Remove Runtime document markers, raw collections, internal
  Agent telemetry, and registry artifact fields from the one-second Overview
  poll; expose only a normalized unambiguous Signal action; and preserve exact
  verified prompt text, structured failures, public artifacts, and existing
  Inspector behavior. Keep context-scoped repeated Signal inspection
  occurrence-exact so another occurrence's wait cannot supply its action target.
- 9d24c58: Validate every successful browser JSON response against its Web-owned result
  shape before exposing it to React Query, so malformed `2xx` payloads fail with
  the existing typed transport error instead of reaching UI rendering.
- 9d24c58: Project retry and cancel applicability from the Runtime control planner so Web
  and inspection no longer advertise targets that control admission will reject.
  Return exact retry targets with the runtime visualization snapshot and expose an
  exact selected cancel target only through Runtime target inspection. Run-level
  cancel now also handles a paused run whose root frame has not materialized, and
  historical attempts no longer inherit controls for a later execution of the
  same node. Read-side retry planning now performs the same pure failure
  settlement as mutation admission without writing it, identity collisions fail
  closed, and Web rejects blank control targets at its boundary.
- 9d24c58: Keep bundled browser implementation out of the published Node runtime
  dependency surface and prevent embedded static visualization payloads from
  being duplicated in TypeScript declarations.
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
- Updated dependencies [9d24c58]
- Updated dependencies [7e65dee]
- Updated dependencies [efbb24c]
- Updated dependencies [9d24c58]
- Updated dependencies [9d24c58]
- Updated dependencies [f5ee270]
- Updated dependencies [9d24c58]
- Updated dependencies [9d24c58]
- Updated dependencies [9d24c58]
- Updated dependencies [e531936]
- Updated dependencies [d6ebc84]
- Updated dependencies [be0e46a]
- Updated dependencies [d5dde51]
- Updated dependencies [9d24c58]
- Updated dependencies [625cae9]
  - @acpus/workflow-compiler@0.3.0
  - @acpus/core@0.10.0
  - @acpus/expression@0.2.0
  - @acpus/runtime@0.12.0

## 0.1.5

### Patch Changes

- @acpus/runtime@0.11.1

## 0.1.4

### Patch Changes

- c809bff: Add static Agent ACP config profiles, including model and adapter-specific session options, across authoring, IR, execution, and Agent configuration guidance.
- Updated dependencies [c809bff]
  - @acpus/core@0.9.0
  - @acpus/runtime@0.11.0
  - @acpus/workflow-compiler@0.2.0

## 0.1.3

### Patch Changes

- Updated dependencies [152303a]
- Updated dependencies [079e1ee]
  - @acpus/core@0.8.0
  - @acpus/runtime@0.10.0
  - @acpus/workflow-compiler@0.1.3

## 0.1.2

### Patch Changes

- 93560c5: Support Node.js 22.18+ within the Node.js 22 line and Node.js 24 or newer. Acpus-triggered SQLite initialization now suppresses only Node.js's SQLite experimental warning, leaving unrelated warnings visible.
- Updated dependencies [93560c5]
  - @acpus/core@0.7.2
  - @acpus/expression@0.1.1
  - @acpus/runtime@0.9.2
  - @acpus/workflow-compiler@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [07f4e6b]
  - @acpus/core@0.7.1
  - @acpus/runtime@0.9.1
  - @acpus/workflow-compiler@0.1.1

## 0.1.0

### Minor Changes

- e3a75f4: Model every executable scope as one arbitrary WorkflowData output expression in
  IR v5, preserve composite aggregation envelopes, and expose syntax-derived
  output shape across runtime, CLI, and Web inspection.
- 7f3f186: Unify run inspection behind a compact runtime projection with structural text views, target and raw modes, durable follow updates, shared CLI/Web semantics, live Agent telemetry summaries, and lossless structured acpx failure causes.
- cd35e5b: Release the TypeScript-first Acpus package graph with the CLI, authoring
  facades, compiler, durable runtime, task library, and Web inspector aligned on
  the same public dependency contract.

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
- aae74a6: Share Inspector primitives across live and static graphs, prevent stale close
  timers from dismissing new targets, restore the static no-input state layout,
  and keep the Vite API proxy from intercepting the client API module.
- Require Node.js 24.15 or newer so every supported runtime provides the
  unflagged `node:sqlite` API used by durable runs.
- 120b694: Make WebUI shutdown idempotent under repeated Ctrl-C signals.
- Updated dependencies [e3a75f4]
- Updated dependencies [61bbf86]
- Updated dependencies [b8fef84]
- Updated dependencies [bf959b0]
- Updated dependencies [c1f09ae]
- Updated dependencies [aae74a6]
- Updated dependencies [c162856]
- Updated dependencies [7f3f186]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [cd35e5b]
- Updated dependencies [108d06e]
- Updated dependencies [958779b]
- Updated dependencies [9686cda]
- Updated dependencies [0a842d4]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [c902db5]
- Updated dependencies [c5b897b]
- Updated dependencies [6ef7549]
- Updated dependencies [aae74a6]
- Updated dependencies [32cc127]
- Updated dependencies [3df9b55]
- Updated dependencies [aae74a6]
- Updated dependencies
- Updated dependencies [aae74a6]
- Updated dependencies [d92f9f9]
- Updated dependencies [c14e800]
- Updated dependencies [aae74a6]
  - @acpus/expression@0.1.0
  - @acpus/core@0.7.0
  - @acpus/runtime@0.9.0
  - @acpus/workflow-compiler@0.1.0

## 0.1.0-alpha.9

### Patch Changes

- 108d06e: Republish the alpha package graph so runtime consumers resolve an
  `@acpus/expression/ir` entrypoint that exports `isJsonValue`.
- Updated dependencies [108d06e]
  - @acpus/core@0.7.0-alpha.7
  - @acpus/expression@0.1.0-alpha.6
  - @acpus/runtime@0.9.0-alpha.8
  - @acpus/workflow-compiler@0.1.0-alpha.7

## 0.1.0-alpha.8

### Patch Changes

- Updated dependencies [32cc127]
  - @acpus/runtime@0.9.0-alpha.7

## 0.1.0-alpha.7

### Patch Changes

- Updated dependencies [c902db5]
  - @acpus/core@0.7.0-alpha.6
  - @acpus/runtime@0.9.0-alpha.6
  - @acpus/workflow-compiler@0.1.0-alpha.6

## 0.1.0-alpha.6

### Minor Changes

- e3a75f4: Model every executable scope as one arbitrary WorkflowData output expression in
  IR v5, preserve composite aggregation envelopes, and expose syntax-derived
  output shape across runtime, CLI, and Web inspection.
- 7f3f186: Unify run inspection behind a compact runtime projection with structural text views, target and raw modes, durable follow updates, shared CLI/Web semantics, live Agent telemetry summaries, and lossless structured acpx failure causes.

### Patch Changes

- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.
- aae74a6: Share Inspector primitives across live and static graphs, prevent stale close
  timers from dismissing new targets, restore the static no-input state layout,
  and keep the Vite API proxy from intercepting the client API module.
- Updated dependencies [e3a75f4]
- Updated dependencies [61bbf86]
- Updated dependencies [bf959b0]
- Updated dependencies [c1f09ae]
- Updated dependencies [aae74a6]
- Updated dependencies [c162856]
- Updated dependencies [7f3f186]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [958779b]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [c5b897b]
- Updated dependencies [aae74a6]
- Updated dependencies [3df9b55]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [d92f9f9]
- Updated dependencies [c14e800]
- Updated dependencies [aae74a6]
  - @acpus/expression@0.1.0-alpha.5
  - @acpus/core@0.7.0-alpha.5
  - @acpus/runtime@0.9.0-alpha.5
  - @acpus/workflow-compiler@0.1.0-alpha.5

## 0.1.0-alpha.5

### Patch Changes

- Updated dependencies [6ef7549]
  - @acpus/expression@0.1.0-alpha.4
  - @acpus/workflow-compiler@0.1.0-alpha.4
  - @acpus/core@0.7.0-alpha.4
  - @acpus/runtime@0.9.0-alpha.4

## 0.1.0-alpha.4

### Patch Changes

- Updated dependencies [b8fef84]
  - @acpus/expression@0.1.0-alpha.3
  - @acpus/core@0.7.0-alpha.3
  - @acpus/runtime@0.9.0-alpha.3
  - @acpus/workflow-compiler@0.1.0-alpha.3

## 0.1.0-alpha.3

### Patch Changes

- Make WebUI shutdown idempotent under repeated Ctrl-C signals.

## 0.1.0-alpha.2

### Patch Changes

- Fix installed workflow typechecking for Acpus authoring facade imports.
- Updated dependencies
  - @acpus/core@0.7.0-alpha.2
  - @acpus/expression@0.1.0-alpha.2
  - @acpus/runtime@0.9.0-alpha.2
  - @acpus/workflow-compiler@0.1.0-alpha.2

## 0.1.0-alpha.1

### Patch Changes

- Republish the alpha package graph with built loader artifacts included.
- Updated dependencies
  - @acpus/core@0.7.0-alpha.1
  - @acpus/expression@0.1.0-alpha.1
  - @acpus/runtime@0.9.0-alpha.1
  - @acpus/workflow-compiler@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- cd35e5b: Prepare the TypeScript-first Acpus alpha release.

  This prerelease publishes the current CLI runtime dependency graph under the
  `alpha` dist-tag while leaving legacy `latest` releases unchanged.

### Patch Changes

- Updated dependencies [cd35e5b]
  - @acpus/core@0.7.0-alpha.0
  - @acpus/expression@0.1.0-alpha.0
  - @acpus/runtime@0.9.0-alpha.0
  - @acpus/workflow-compiler@0.1.0-alpha.0
