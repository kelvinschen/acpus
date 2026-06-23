# @acpus/core

## 0.5.6

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

## 0.5.5

### Patch Changes

- 7e9ec7d: refactor: extract keys module, consolidate test projects, add agent-overrides CLI layer
  - Extract run keys (forkID, resume replay strategy) into standalone keys module
  - Consolidate vitest projects under unified test runner config
  - Add agent-overrides CLI surface with contract tests
  - Simplify agent-ensure integration tests: remove redundant assertions
  - Clean up compiler, expression-scope, interpreter, store modules
  - Expand hash unit tests with edge cases
  - Compress store fields from address/port to host/port tuple

## 0.5.4

### Patch Changes

- 7313e8e: Delegate CEL expression validation to cel-js and share Acpus CEL environment registration between compiler lint and runtime evaluation.

## 0.5.3

### Patch Changes

- 0ee059f: Use short generated workflow node keys and clean up generated pipeline display.

## 0.5.2

### Patch Changes

- f3e99c3: Remove unused helpers and consolidate internal validation and activity-formatting code.

## 0.5.1

### Patch Changes

- 6448339: Add the Acpus hook system with YAML configuration, command handlers, injector and event payload types, frozen per-run hook config, hook journaling, and `acpus hooks` inspection commands. Workflows can now be submitted with `--skip-hooks` to disable hook loading and execution for a single new run.
- b93c0de: Migrate package build and typecheck scripts to TypeScript 7 native preview via `tsgo`.

## 0.5.0

### Minor Changes

- cda81af: Remove source path root directory restriction: Workflow Spec source/include paths are no longer restricted to workspace/global catalog roots

  - `@acpus/core`: `workflowSourcePolicy` renamed to `workflowSourceResolver`. `WorkflowSourcePolicy` type renamed to `WorkflowSourceResolver`. `allowedSourceRoots` and `isAllowedSourcePath` removed. `createIncludeResolver` no longer takes `allowedSourceRoots` parameter. `realPathOrUndefined` is now exported. Source and include paths are validated for existence and readability only, not restricted by root directory.
  - `@acpus/runtime`: `allowedSourceRoots` removed from `InterpreterOptions`. Subworkflow and include path validation no longer restricts to workspace/global catalog roots — any readable filesystem path is accepted.
  - `acpus`: Internal update to use `workflowSourceResolver`. Dead `createIncludeResolver` re-export removed from `io.ts`.

## 0.4.1

### Patch Changes

- 23b50c5: Add workflow source context

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

## 0.3.0

### Minor Changes

- Generalize the Approval Gate into a first-class Signal Node and add step-level working directories.

  - **Signal Node (`run: signal`)**: replaces the Approval Gate with a general human-in-the-loop / external-control node. A Signal Node blocks as `awaiting` until an external payload is delivered (`acpus runs signal --node <key> --payload <value>`), enabling arbitrary branching and guards driven by outside instructions. Payloads are validated against the node's declared `output` schema, with friendly rejection messages on mismatch.
  - **Step-level `cwd`**: agent and program steps accept a `cwd` that overrides the agent-definition default (falling back to the agent cwd, then the process cwd). Composite child nodes (loop/fanout/switch/parallel) are now validated for unknown fields by lint.
  - **Agent telemetry**: propagate `acpxRecordId` and `cwd` through agent telemetry; surface agent cwd in the TUI Execution tab.
  - **`runs show`**: display rendered Signal Node prompts, expected payload schema, and a copy-pasteable deliver command; show workflow output in the compact format.
  - **TUI**: signal decision controls and updated node-kind legend glyphs (Agent `✦`, Signal `◌`).

## 0.2.1

### Patch Changes

- Add submit-time Agent Overrides for workflow runs and forks, including CLI support, persisted audit metadata, fork inheritance, and documentation.
