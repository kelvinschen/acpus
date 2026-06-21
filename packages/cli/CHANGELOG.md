# acpus

## 0.4.9

### Patch Changes

- 7e9ec7d: refactor: extract keys module, consolidate test projects, add agent-overrides CLI layer
  - Extract run keys (forkID, resume replay strategy) into standalone keys module
  - Consolidate vitest projects under unified test runner config
  - Add agent-overrides CLI surface with contract tests
  - Simplify agent-ensure integration tests: remove redundant assertions
  - Clean up compiler, expression-scope, interpreter, store modules
  - Expand hash unit tests with edge cases
  - Compress store fields from address/port to host/port tuple
- Updated dependencies [7e9ec7d]
  - @acpus/core@0.5.5
  - @acpus/runtime@0.6.5
  - @acpus/tui@0.5.8

## 0.4.8

### Patch Changes

- Updated dependencies [7313e8e]
  - @acpus/core@0.5.4
  - @acpus/runtime@0.6.4
  - @acpus/tui@0.5.7

## 0.4.7

### Patch Changes

- 0ee059f: Use short generated workflow node keys and clean up generated pipeline display.
- Updated dependencies [0ee059f]
  - @acpus/core@0.5.3
  - @acpus/runtime@0.6.3
  - @acpus/tui@0.5.6

## 0.4.6

### Patch Changes

- 73ee3ad: Bind Acpus-owned runtime counters as CEL integers.

## 0.4.5

### Patch Changes

- f3e99c3: Remove unused helpers and consolidate internal validation and activity-formatting code.
- Updated dependencies [f3e99c3]
  - @acpus/core@0.5.2
  - @acpus/runtime@0.6.2
  - @acpus/tui@0.5.5

## 0.4.4

### Patch Changes

- 6448339: Add the Acpus hook system with YAML configuration, command handlers, injector and event payload types, frozen per-run hook config, hook journaling, and `acpus hooks` inspection commands. Workflows can now be submitted with `--skip-hooks` to disable hook loading and execution for a single new run.
- b93c0de: Migrate package build and typecheck scripts to TypeScript 7 native preview via `tsgo`.
- Updated dependencies [6448339]
- Updated dependencies [b93c0de]
  - @acpus/core@0.5.1
  - @acpus/runtime@0.6.1
  - @acpus/tui@0.5.4

## 0.4.3

### Patch Changes

- 704b813: Align follow-mode output with `runs show` format and fix two bugs:

  - **Bug fix**: Terminal summary for completed runs now includes the workflow `Output:` section (was silently discarded in human-readable mode).
  - **Bug fix**: Duration formatting in terminal summary now matches `runs show` exactly (hours < 48 show as `Xh`, not `XhYm`).
  - Extract shared `computeRunDurationMs` and `formatDurationFromMs` into `runs-show.ts` to eliminate duplicate duration logic.
  - Export `formatWorkflowOutput` from `runs-show.ts` so follow-mode can render the output section.
  - `--poll` now accepts duration strings (`2s`, `1m`, `500ms`, `1h`) using `parseDurationMs`, aligned with workflow spec timeout syntax.
  - Follow observations use `formatNodeLines` and `STATE_GLYPH` from `runs-show.ts` for consistent formatting.
  - Container filtering and activity dedup added to follow loop.
  - Richer JSON observations: node events include `kind`, `startedAt`, `completedAt`, `attempt`, `agentTelemetry`, `artifactRefs`, `output`; run events include `workflowName`, `workflowRef`, `createdAt`; summary events include `runDuration` and `output`.

## 0.4.2

### Patch Changes

- e7cc11e: Add opt-in agent token telemetry: display token usage in run status and TUI detail pane

  - `@acpus/runtime`: Add `AgentTokenUsage` type and `tokenUsage` field on `AgentAttemptTelemetry`. Token usage is opt-in — only populated when the agent adapter reports it.
  - `acpus`: Display token counts in `acpus runs show` agent activity summaries.
  - `@acpus/tui`: Show token usage in the detail pane. Fix field label indentation in definition and context sections.

- cda81af: Remove source path root directory restriction: Workflow Spec source/include paths are no longer restricted to workspace/global catalog roots

  - `@acpus/core`: `workflowSourcePolicy` renamed to `workflowSourceResolver`. `WorkflowSourcePolicy` type renamed to `WorkflowSourceResolver`. `allowedSourceRoots` and `isAllowedSourcePath` removed. `createIncludeResolver` no longer takes `allowedSourceRoots` parameter. `realPathOrUndefined` is now exported. Source and include paths are validated for existence and readability only, not restricted by root directory.
  - `@acpus/runtime`: `allowedSourceRoots` removed from `InterpreterOptions`. Subworkflow and include path validation no longer restricts to workspace/global catalog roots — any readable filesystem path is accepted.
  - `acpus`: Internal update to use `workflowSourceResolver`. Dead `createIncludeResolver` re-export removed from `io.ts`.

- Updated dependencies [e7cc11e]
- Updated dependencies [cda81af]
  - @acpus/runtime@0.6.0
  - @acpus/tui@0.5.3
  - @acpus/core@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies [23b50c5]
  - @acpus/core@0.4.1
  - @acpus/runtime@0.5.1
  - @acpus/tui@0.5.2

## 0.4.0

### Minor Changes

- 23b50c5: Add workflow metadata to CEL and template contexts through `workflow.name`,
  `workflow.description`, `workflow.source_path`, and `workflow.source_dir`, and
  preserve source paths from compilation through runtime evaluation.

  Fork inheritance now includes workflow metadata in node definition hashes when a
  node references `workflow.*`, preventing source-directory-dependent steps from
  being incorrectly inherited across forks. The CLI catalog also discovers bundled
  `workflow.spec.yaml` entries, and the project catalog now includes a
  `swarm-intelligence` workflow bundle with spec-local helper scripts.

### Patch Changes

- Updated dependencies [23b50c5]
  - @acpus/core@0.4.0
  - @acpus/runtime@0.5.0
  - @acpus/tui@0.5.1

## 0.3.2

### Patch Changes

- Updated dependencies [57cd479]
  - @acpus/tui@0.5.0

## 0.3.1

### Patch Changes

- ac9318d: Add run-before-run static validation of CEL expressions in Workflow Specs.

  `acpus workflows lint` / `--dry-run` now catch common expression mistakes at
  compile time instead of at runtime: field paths checked against declared
  output/input/fanout-item schemas (`EXPR_UNKNOWN_FIELD`), out-of-scope `loop`/
  `item` roots and not-yet-visible step references (`EXPR_ROOT_OUT_OF_SCOPE`,
  `EXPR_UNKNOWN_STEP`), and non-scalar values spliced into a Program Step `cmd`
  (`EXPR_NONSCALAR_IN_CMD`). Validation is fail-quiet — anything whose shape
  cannot be determined statically is accepted silently and never throws — and a
  single composite contract is the source of truth for each Node kind's output
  projection and body-local scope, consumed by both the compiler and the
  validator.

- Updated dependencies [ac9318d]
  - @acpus/core@0.3.1
  - @acpus/runtime@0.4.1
  - @acpus/tui@0.4.1

## 0.3.0

### Minor Changes

- Generalize the Approval Gate into a first-class Signal Node and add step-level working directories.

  - **Signal Node (`run: signal`)**: replaces the Approval Gate with a general human-in-the-loop / external-control node. A Signal Node blocks as `awaiting` until an external payload is delivered (`acpus runs signal --node <key> --payload <value>`), enabling arbitrary branching and guards driven by outside instructions. Payloads are validated against the node's declared `output` schema, with friendly rejection messages on mismatch.
  - **Step-level `cwd`**: agent and program steps accept a `cwd` that overrides the agent-definition default (falling back to the agent cwd, then the process cwd). Composite child nodes (loop/fanout/switch/parallel) are now validated for unknown fields by lint.
  - **Agent telemetry**: propagate `acpxRecordId` and `cwd` through agent telemetry; surface agent cwd in the TUI Execution tab.
  - **`runs show`**: display rendered Signal Node prompts, expected payload schema, and a copy-pasteable deliver command; show workflow output in the compact format.
  - **TUI**: signal decision controls and updated node-kind legend glyphs (Agent `✦`, Signal `◌`).

### Patch Changes

- Updated dependencies
  - @acpus/core@0.3.0
  - @acpus/runtime@0.4.0
  - @acpus/tui@0.4.0

## 0.2.4

### Patch Changes

- Updated dependencies
  - @acpus/runtime@0.3.0
  - @acpus/tui@0.3.2

## 0.2.3

### Patch Changes

- Updated dependencies [1842614]
  - @acpus/runtime@0.2.2
  - @acpus/tui@0.3.1

## 0.2.2

### Patch Changes

- Add submit-time Agent Overrides for workflow runs and forks, including CLI support, persisted audit metadata, fork inheritance, and documentation.
- Updated dependencies
- Updated dependencies [d897023]
  - @acpus/core@0.2.1
  - @acpus/runtime@0.2.1
  - @acpus/tui@0.3.0

## 0.2.1

### Patch Changes

- Fix the CLI version command to read the published package version.
