# @acpus/tui

## 0.5.7

### Patch Changes

- Updated dependencies [7313e8e]
  - @acpus/core@0.5.4
  - @acpus/runtime@0.6.4

## 0.5.6

### Patch Changes

- 0ee059f: Use short generated workflow node keys and clean up generated pipeline display.
- Updated dependencies [0ee059f]
  - @acpus/core@0.5.3
  - @acpus/runtime@0.6.3

## 0.5.5

### Patch Changes

- Updated dependencies [f3e99c3]
  - @acpus/core@0.5.2
  - @acpus/runtime@0.6.2

## 0.5.4

### Patch Changes

- b93c0de: Migrate package build and typecheck scripts to TypeScript 7 native preview via `tsgo`.
- Updated dependencies [6448339]
- Updated dependencies [b93c0de]
  - @acpus/core@0.5.1
  - @acpus/runtime@0.6.1

## 0.5.3

### Patch Changes

- e7cc11e: Add opt-in agent token telemetry: display token usage in run status and TUI detail pane

  - `@acpus/runtime`: Add `AgentTokenUsage` type and `tokenUsage` field on `AgentAttemptTelemetry`. Token usage is opt-in — only populated when the agent adapter reports it.
  - `acpus`: Display token counts in `acpus runs show` agent activity summaries.
  - `@acpus/tui`: Show token usage in the detail pane. Fix field label indentation in definition and context sections.

- Updated dependencies [e7cc11e]
- Updated dependencies [cda81af]
  - @acpus/runtime@0.6.0
  - @acpus/core@0.5.0

## 0.5.2

### Patch Changes

- Updated dependencies [23b50c5]
  - @acpus/core@0.4.1
  - @acpus/runtime@0.5.1

## 0.5.1

### Patch Changes

- Updated dependencies [23b50c5]
  - @acpus/core@0.4.0
  - @acpus/runtime@0.5.0

## 0.5.0

### Minor Changes

- 57cd479: Add `Esc` key to navigate back from App (graph view) to RunPicker, allowing users to select a different run without quitting and relaunching the TUI. Footer now shows `Esc back` hint.

## 0.4.1

### Patch Changes

- Updated dependencies [ac9318d]
  - @acpus/core@0.3.1
  - @acpus/runtime@0.4.1

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
  - @acpus/runtime@0.4.0

## 0.3.2

### Patch Changes

- Updated dependencies
  - @acpus/runtime@0.3.0

## 0.3.1

### Patch Changes

- 1842614: Expose persisted run input through the supervisor API and show root workflow input and public outputs in the TUI.
- Updated dependencies [1842614]
  - @acpus/runtime@0.2.2

## 0.3.0

### Minor Changes

- d897023: Persist rendered explicit Agent session keys for display, use persisted rendered Agent prompts in the Prompt tab when compact telemetry is unavailable, and merge Summary, dynamic Context, and Definition details into one Summary tab with subtle subsection headings. The Summary kind field now also mirrors the graph node-type legend and color.

### Patch Changes

- Updated dependencies
- Updated dependencies [d897023]
  - @acpus/core@0.2.1
  - @acpus/runtime@0.2.1
