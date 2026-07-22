# acpus

## 0.7.1

### Patch Changes

- 079e1ee: Add occurrence-aware run inspection trees and bounded live Agent pulses while keeping the default operator view compact and actionable.
- Updated dependencies [152303a]
- Updated dependencies [079e1ee]
  - @acpus/core@0.8.0
  - @acpus/runtime@0.10.0
  - @acpus/loader@0.1.3
  - @acpus/tasks@0.1.3
  - @acpus/web@0.1.3
  - @acpus/workflow-compiler@0.1.3

## 0.7.0

### Minor Changes

- 944878b: Simplify bundled Skill installation to fixed project or global `.agents` and `.claude` targets with interactive terminal selection and explicit non-interactive scope and Agent options.

## 0.6.2

### Patch Changes

- 93560c5: Support Node.js 22.18+ within the Node.js 22 line and Node.js 24 or newer. Acpus-triggered SQLite initialization now suppresses only Node.js's SQLite experimental warning, leaving unrelated warnings visible.
- Updated dependencies [93560c5]
  - @acpus/core@0.7.2
  - @acpus/expression@0.1.1
  - @acpus/loader@0.1.2
  - @acpus/runtime@0.9.2
  - @acpus/tasks@0.1.2
  - @acpus/web@0.1.2
  - @acpus/workflow-compiler@0.1.2

## 0.6.1

### Patch Changes

- Updated dependencies [07f4e6b]
  - @acpus/core@0.7.1
  - @acpus/loader@0.1.1
  - @acpus/runtime@0.9.1
  - @acpus/tasks@0.1.1
  - @acpus/web@0.1.1
  - @acpus/workflow-compiler@0.1.1

## 0.6.0

### Minor Changes

- e3a75f4: Model every executable scope as one arbitrary WorkflowData output expression in
  IR v5, preserve composite aggregation envelopes, and expose syntax-derived
  output shape across runtime, CLI, and Web inspection.
- b8fef84: Add arithmetic and string join expression helpers, clarify workflow check node count text, and expand the Acpus authoring skill reference.
- c1f09ae: Add strict scalar comparison, numeric comparison, and boolean predicate helpers over the existing expression callback primitives.
- c162856: Expose honest Agent telemetry availability, direct fork lineage, compact run-level Agent usage, aggregate repeated targets, and rate-limited non-TTY follow omissions for long-running workflow operation.
- 7f3f186: Unify run inspection behind a compact runtime projection with structural text views, target and raw modes, durable follow updates, shared CLI/Web semantics, live Agent telemetry summaries, and lossless structured acpx failure causes.
- 76c788f: Allow the bundled Acpus skill to be installed into an existing custom skills root with `acpus skill install --dir`.
- cd35e5b: Release the TypeScript-first Acpus package graph with the CLI, authoring
  facades, compiler, durable runtime, task library, and Web inspector aligned on
  the same public dependency contract.
- 958779b: Flatten Agent, Task, and Signal workflow authoring specs by moving execution
  fields out of the author-facing `run` wrapper. Keep the frozen WorkflowIR
  `node.run` envelopes unchanged while updating task source analysis, bundled
  examples, and authoring guidance to the single flat syntax.
- 85b3b7d: Make the running CLI's resolved authoring packages the single declaration
  authority, expose their absolute paths through Doctor, version bundled and
  installed Acpus skills with the CLI, and verify the complete packed-install
  authoring environment.
- c902db5: Allow non-empty homogeneous Zod tuples at graph boundaries by lowering them to
  arrays while preserving native TypeScript tuple inference.
- d6dbf96: Remove the workflow init commands and bundled starter. Author workflows directly from the closest bundled example, where import comments expose every public runtime authoring helper, then validate with `acpus workflow check`.
- 3df9b55: Allow optional runtime expressions to configure Parallel and Fanout concurrency,
  and treat missing or zero limits as no authored local cap while keeping quorum
  counts and invalid concurrency values strict.
- 684b2d0: Allow `--input` to read strict JSON from `.json` file paths for workflow check, run, and fork commands.
- d92f9f9: Require named durable workflow and composite outputs, reject NodeRef handles and
  explicit any authoring, preserve existing composite result envelopes, and leave
  type-expressible output failures to native TypeScript diagnostics.
- aa39b84: Render compact semantic workflow trees directly in the terminal while preserving optional self-contained HTML output through `workflow viz --out`.
- f5892b2: Replace the separate `workflow list` and `workflow show` commands with `workflow catalog [name]`. An omitted name opens an interactive terminal picker or prints a path-free list when piped, while a provided or selected name uses strict entry lookup with concise, semantic-color TTY details that honor `NO_COLOR`.

  Add semantic TTY colors to the aligned Doctor report while keeping piped, `NO_COLOR`, and JSON output unstyled.

### Patch Changes

- 61bbf86: Make authoring diagnostics source-ordered, single-owned, and repair-oriented;
  recognize Acpus types by official declaration provenance; enrich high-confidence
  TypeScript errors; render concise CLI locations; and emit node-id validation once.
- bf959b0: Give Expr authoring failures context-specific repair hints, avoid duplicate
  dynamic Task id diagnostics, distinguish runtime `undefined` from serialized
  closure captures, and document static loop and fanout step identity.
- 108d06e: Align the package graph so runtime consumers resolve an
  `@acpus/expression/ir` entrypoint that exports `isJsonValue`.
- 9686cda: Include built loader artifacts in the published package graph.
- 0a842d4: Fix installed workflow typechecking for Acpus authoring facade imports.
- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.
- 6ef7549: Replace the broad expression helper algebra with `fmap`, `lift2`, `lift3`, `lift`, `template`, and `md`, including expression and bounded block callback authoring checks, runtime guards, and updated Acpus authoring references.
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
- Require Node.js 24.15 or newer so every supported runtime provides the
  unflagged `node:sqlite` API used by durable runs.
- c14e800: Unify expression callbacks behind overloaded `lift`, replacing the separate `fmap`, `lift2`, and `lift3` helpers and their IR operators.
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
- Updated dependencies [85b3b7d]
- Updated dependencies [0a842d4]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [c902db5]
- Updated dependencies [aae74a6]
- Updated dependencies [c5b897b]
- Updated dependencies [6ef7549]
- Updated dependencies [aae74a6]
- Updated dependencies [32cc127]
- Updated dependencies [3df9b55]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies
- Updated dependencies [aae74a6]
- Updated dependencies [d92f9f9]
- Updated dependencies [c14e800]
- Updated dependencies [aae74a6]
- Updated dependencies [120b694]
  - @acpus/expression@0.1.0
  - @acpus/core@0.7.0
  - @acpus/runtime@0.9.0
  - @acpus/workflow-compiler@0.1.0
  - @acpus/web@0.1.0
  - @acpus/loader@0.1.0
  - @acpus/tasks@0.1.0

## 0.6.0-alpha.9

### Patch Changes

- 108d06e: Republish the alpha package graph so runtime consumers resolve an
  `@acpus/expression/ir` entrypoint that exports `isJsonValue`.
- Updated dependencies [108d06e]
  - @acpus/core@0.7.0-alpha.7
  - @acpus/expression@0.1.0-alpha.6
  - @acpus/loader@0.1.0-alpha.7
  - @acpus/runtime@0.9.0-alpha.8
  - @acpus/tasks@0.1.0-alpha.7
  - @acpus/web@0.1.0-alpha.9
  - @acpus/workflow-compiler@0.1.0-alpha.7

## 0.6.0-alpha.8

### Minor Changes

- 76c788f: Allow the bundled Acpus skill to be installed into an existing custom skills root with `acpus skill install --dir`.
- aa39b84: Render compact semantic workflow trees directly in the terminal while preserving optional self-contained HTML output through `workflow viz --out`.
- f5892b2: Replace the separate `workflow list` and `workflow show` commands with `workflow catalog [name]`. An omitted name opens an interactive terminal picker or prints a path-free list when piped, while a provided or selected name uses strict entry lookup with concise, semantic-color TTY details that honor `NO_COLOR`.

  Add semantic TTY colors to the aligned Doctor report while keeping piped, `NO_COLOR`, and JSON output unstyled.

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
- Updated dependencies [32cc127]
  - @acpus/runtime@0.9.0-alpha.7
  - @acpus/web@0.1.0-alpha.8

## 0.6.0-alpha.7

### Minor Changes

- c902db5: Allow non-empty homogeneous Zod tuples at graph boundaries by lowering them to
  arrays while preserving native TypeScript tuple inference.

### Patch Changes

- Updated dependencies [c902db5]
  - @acpus/core@0.7.0-alpha.6
  - @acpus/loader@0.1.0-alpha.6
  - @acpus/runtime@0.9.0-alpha.6
  - @acpus/tasks@0.1.0-alpha.6
  - @acpus/web@0.1.0-alpha.7
  - @acpus/workflow-compiler@0.1.0-alpha.6

## 0.6.0-alpha.6

### Minor Changes

- e3a75f4: Model every executable scope as one arbitrary WorkflowData output expression in
  IR v5, preserve composite aggregation envelopes, and expose syntax-derived
  output shape across runtime, CLI, and Web inspection.
- c1f09ae: Add strict scalar comparison, numeric comparison, and boolean predicate helpers over the existing expression callback primitives.
- c162856: Expose honest Agent telemetry availability, direct fork lineage, compact run-level Agent usage, aggregate repeated targets, and rate-limited non-TTY follow omissions for long-running workflow operation.
- 7f3f186: Unify run inspection behind a compact runtime projection with structural text views, target and raw modes, durable follow updates, shared CLI/Web semantics, live Agent telemetry summaries, and lossless structured acpx failure causes.
- 958779b: Flatten Agent, Task, and Signal workflow authoring specs by moving execution
  fields out of the author-facing `run` wrapper. Keep the frozen WorkflowIR
  `node.run` envelopes unchanged while updating task source analysis, bundled
  examples, and authoring guidance to the single flat syntax.
- 85b3b7d: Make the running CLI's resolved authoring packages the single declaration
  authority, expose their absolute paths through Doctor, version bundled and
  installed Acpus skills with the CLI, and verify the complete packed-install
  authoring environment.
- d6dbf96: Remove the workflow init commands and bundled starter. Author workflows directly from the closest bundled example, where import comments expose every public runtime authoring helper, then validate with `acpus workflow check`.
- 3df9b55: Allow optional runtime expressions to configure Parallel and Fanout concurrency,
  and treat missing or zero limits as no authored local cap while keeping quorum
  counts and invalid concurrency values strict.
- 684b2d0: Allow `--input` to read strict JSON from `.json` file paths for workflow check, run, and fork commands.
- d92f9f9: Require named durable workflow and composite outputs, reject NodeRef handles and
  explicit any authoring, preserve existing composite result envelopes, and leave
  type-expressible output failures to native TypeScript diagnostics.

### Patch Changes

- 61bbf86: Make authoring diagnostics source-ordered, single-owned, and repair-oriented;
  recognize Acpus types by official declaration provenance; enrich high-confidence
  TypeScript errors; render concise CLI locations; and emit node-id validation once.
- bf959b0: Give Expr authoring failures context-specific repair hints, avoid duplicate
  dynamic Task id diagnostics, distinguish runtime `undefined` from serialized
  closure captures, and document static loop and fanout step identity.
- aae74a6: Exclude TypeScript build caches from published tarballs and remove package file
  declarations for README and LICENSE documents that do not exist.
- c5b897b: Move the workspace build to incremental TypeScript 7 project references,
  upgrade the web bundle to Vite 8, and run workflow checks through the pinned
  TypeScript 7 native analysis API.
- c14e800: Unify expression callbacks behind overloaded `lift`, replacing the separate `fmap`, `lift2`, and `lift3` helpers and their IR operators.
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
- Updated dependencies [85b3b7d]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [c5b897b]
- Updated dependencies [aae74a6]
- Updated dependencies [3df9b55]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [aae74a6]
- Updated dependencies [d92f9f9]
- Updated dependencies [c14e800]
- Updated dependencies [aae74a6]
  - @acpus/expression@0.1.0-alpha.5
  - @acpus/core@0.7.0-alpha.5
  - @acpus/runtime@0.9.0-alpha.5
  - @acpus/workflow-compiler@0.1.0-alpha.5
  - @acpus/web@0.1.0-alpha.6
  - @acpus/loader@0.1.0-alpha.5
  - @acpus/tasks@0.1.0-alpha.5

## 0.6.0-alpha.5

### Patch Changes

- 6ef7549: Replace the broad expression helper algebra with `fmap`, `lift2`, `lift3`, `lift`, `template`, and `md`, including callback authoring checks, runtime guards, and updated Acpus authoring references.
- Updated dependencies [6ef7549]
  - @acpus/expression@0.1.0-alpha.4
  - @acpus/workflow-compiler@0.1.0-alpha.4
  - @acpus/core@0.7.0-alpha.4
  - @acpus/runtime@0.9.0-alpha.4
  - @acpus/web@0.1.0-alpha.5
  - @acpus/tasks@0.1.0-alpha.4

## 0.6.0-alpha.4

### Minor Changes

- b8fef84: Add arithmetic and string join expression helpers, clarify workflow check node count text, and expand the Acpus authoring skill reference.

### Patch Changes

- Updated dependencies [b8fef84]
  - @acpus/expression@0.1.0-alpha.3
  - @acpus/core@0.7.0-alpha.3
  - @acpus/runtime@0.9.0-alpha.3
  - @acpus/web@0.1.0-alpha.4
  - @acpus/workflow-compiler@0.1.0-alpha.3
  - @acpus/tasks@0.1.0-alpha.3

## 0.6.0-alpha.3

### Patch Changes

- Make WebUI shutdown idempotent under repeated Ctrl-C signals.
- Updated dependencies
  - @acpus/web@0.1.0-alpha.3

## 0.6.0-alpha.2

### Patch Changes

- Fix installed workflow typechecking for Acpus authoring facade imports.
- Updated dependencies
  - @acpus/core@0.7.0-alpha.2
  - @acpus/expression@0.1.0-alpha.2
  - @acpus/runtime@0.9.0-alpha.2
  - @acpus/tasks@0.1.0-alpha.2
  - @acpus/web@0.1.0-alpha.2
  - @acpus/workflow-compiler@0.1.0-alpha.2

## 0.6.0-alpha.1

### Patch Changes

- Republish the alpha package graph with built loader artifacts included.
- Updated dependencies
  - @acpus/core@0.7.0-alpha.1
  - @acpus/expression@0.1.0-alpha.1
  - @acpus/runtime@0.9.0-alpha.1
  - @acpus/tasks@0.1.0-alpha.1
  - @acpus/web@0.1.0-alpha.1
  - @acpus/workflow-compiler@0.1.0-alpha.1

## 0.6.0-alpha.0

### Minor Changes

- cd35e5b: Prepare the TypeScript-first Acpus alpha release.

  This prerelease publishes the current CLI runtime dependency graph under the
  `alpha` dist-tag while leaving legacy `latest` releases unchanged.

### Patch Changes

- Updated dependencies [cd35e5b]
  - @acpus/core@0.7.0-alpha.0
  - @acpus/expression@0.1.0-alpha.0
  - @acpus/runtime@0.9.0-alpha.0
  - @acpus/tasks@0.1.0-alpha.0
  - @acpus/web@0.1.0-alpha.0
  - @acpus/workflow-compiler@0.1.0-alpha.0
