# acpus

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
