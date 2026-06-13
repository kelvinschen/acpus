# @acpus/runtime

## 0.2.2

### Patch Changes

- 1842614: Expose persisted run input through the supervisor API and show root workflow input and public outputs in the TUI.

## 0.2.1

### Patch Changes

- Add submit-time Agent Overrides for workflow runs and forks, including CLI support, persisted audit metadata, fork inheritance, and documentation.
- d897023: Persist rendered explicit Agent session keys for display, use persisted rendered Agent prompts in the Prompt tab when compact telemetry is unavailable, and merge Summary, dynamic Context, and Definition details into one Summary tab with subtle subsection headings. The Summary kind field now also mirrors the graph node-type legend and color.
- Updated dependencies
  - @acpus/core@0.2.1
