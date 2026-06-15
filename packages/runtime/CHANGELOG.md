# @acpus/runtime

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
