# @acpus/runtime

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
