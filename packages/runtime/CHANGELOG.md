# @acpus/runtime

## 0.7.0

### Minor Changes

- d2cc4d7: Add first-class `if` conditional workflow nodes with `then` and optional `else` branches, selected-branch output propagation, runtime execution/replay/fork support, and CLI/TUI display support.

  Keep `switch` exhaustive by requiring `default`, and update built-in workflow examples plus generated workflow visualization pages to use and render `if` where it replaces two-way routing.

### Patch Changes

- Updated dependencies [d2cc4d7]
- Updated dependencies [40fea23]
  - @acpus/core@0.6.0

## 0.6.6

### Patch Changes

- 487d8e7: Agent and Program output schemas are now open at runtime — extra fields
  beyond the declared schema are accepted and preserved in persisted Node
  state. Workflow expressions and composite parent outputs see only the
  declared fields, enforced by a new expressionOutputForNode projection
  layer in the interpreter.

      Signal output schemas remain strict (additionalProperties: false) and
      reject undeclared extra fields.

      Compiler changes:
      - Agent/Program schemas compiled without additionalProperties: false
      - Signal schemas stay strict
      - Expression validation rejects undeclared fields on open schemas
      - Static string indexes (output["field"]) treated as field references
      - Dynamic indexes rejected on schema objects, accepted only on arrays
        with declared item schemas

      Runtime changes:
      - expressionOutputForNode projects agent/program outputs to declared
        fields for expression context and composite parent outputs
      - Schema prompt updated: extra keys accepted but not available to
        expressions

- Updated dependencies [487d8e7]
  - @acpus/core@0.5.6

## 0.6.5

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

## 0.6.4

### Patch Changes

- 7313e8e: Delegate CEL expression validation to cel-js and share Acpus CEL environment registration between compiler lint and runtime evaluation.
- Updated dependencies [7313e8e]
  - @acpus/core@0.5.4

## 0.6.3

### Patch Changes

- 0ee059f: Use short generated workflow node keys and clean up generated pipeline display.
- Updated dependencies [0ee059f]
  - @acpus/core@0.5.3

## 0.6.2

### Patch Changes

- f3e99c3: Remove unused helpers and consolidate internal validation and activity-formatting code.
- Updated dependencies [f3e99c3]
  - @acpus/core@0.5.2

## 0.6.1

### Patch Changes

- 6448339: Add the Acpus hook system with YAML configuration, command handlers, injector and event payload types, frozen per-run hook config, hook journaling, and `acpus hooks` inspection commands. Workflows can now be submitted with `--skip-hooks` to disable hook loading and execution for a single new run.
- b93c0de: Migrate package build and typecheck scripts to TypeScript 7 native preview via `tsgo`.
- Updated dependencies [6448339]
- Updated dependencies [b93c0de]
  - @acpus/core@0.5.1

## 0.6.0

### Minor Changes

- e7cc11e: Add opt-in agent token telemetry: display token usage in run status and TUI detail pane

  - `@acpus/runtime`: Add `AgentTokenUsage` type and `tokenUsage` field on `AgentAttemptTelemetry`. Token usage is opt-in — only populated when the agent adapter reports it.
  - `acpus`: Display token counts in `acpus runs show` agent activity summaries.
  - `@acpus/tui`: Show token usage in the detail pane. Fix field label indentation in definition and context sections.

- cda81af: Remove source path root directory restriction: Workflow Spec source/include paths are no longer restricted to workspace/global catalog roots

  - `@acpus/core`: `workflowSourcePolicy` renamed to `workflowSourceResolver`. `WorkflowSourcePolicy` type renamed to `WorkflowSourceResolver`. `allowedSourceRoots` and `isAllowedSourcePath` removed. `createIncludeResolver` no longer takes `allowedSourceRoots` parameter. `realPathOrUndefined` is now exported. Source and include paths are validated for existence and readability only, not restricted by root directory.
  - `@acpus/runtime`: `allowedSourceRoots` removed from `InterpreterOptions`. Subworkflow and include path validation no longer restricts to workspace/global catalog roots — any readable filesystem path is accepted.
  - `acpus`: Internal update to use `workflowSourceResolver`. Dead `createIncludeResolver` re-export removed from `io.ts`.

### Patch Changes

- Updated dependencies [cda81af]
  - @acpus/core@0.5.0

## 0.5.1

### Patch Changes

- 23b50c5: Add workflow source context
- Updated dependencies [23b50c5]
  - @acpus/core@0.4.1

## 0.5.0

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

## 0.4.1

### Patch Changes

- Updated dependencies [ac9318d]
  - @acpus/core@0.3.1

## 0.4.0

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

## 0.3.0

### Minor Changes

- Deepen the Forked Run module and fix loop output double-wrapping

  - **Breaking**: `planFork` / `materializeFork` / `applyFork` are removed from the public API. Use `planForkedRun(store, options)` and `materializeForkedRun(store, options)` instead. The new functions encapsulate source Run validation, checkpoint reading, and terminal-state eligibility — callers no longer need to read checkpoints or validate terminal status themselves.
  - **Fix**: Loop node output was double-wrapped (`{output: {output: {...}}}` instead of `{output: {...}}`), causing `steps.<loop>.output.<field>` expressions to fail with "No such key". This now returns the correct single-wrapped shape.
  - **New**: `isRunTerminal()` and `RUN_TERMINAL_STATUSES` replace 5 inline terminal-status checks across the runtime package.

## 0.2.2

### Patch Changes

- 1842614: Expose persisted run input through the supervisor API and show root workflow input and public outputs in the TUI.

## 0.2.1

### Patch Changes

- Add submit-time Agent Overrides for workflow runs and forks, including CLI support, persisted audit metadata, fork inheritance, and documentation.
- d897023: Persist rendered explicit Agent session keys for display, use persisted rendered Agent prompts in the Prompt tab when compact telemetry is unavailable, and merge Summary, dynamic Context, and Definition details into one Summary tab with subtle subsection headings. The Summary kind field now also mirrors the graph node-type legend and color.
- Updated dependencies
  - @acpus/core@0.2.1
