# @acpus/dsh

## 0.2.0

### Minor Changes

- f921e64: Add reusable Agent Presets, unbound workflow Agent Slots, and invocation-time Agent binding that Runtime expands into compact source-plus-injection bindings for durable execution and Forks. Unify named Agents, Agent Presets, and Hooks in project/global `.acpus/config.json`, expose default listing plus scoped add/remove through `acpus agent presets`, and let Runtime provide per-Session configured Agent resolution to Agent Executor.
- bf6b49f: Expose scheduler-accepted terminal target results consistently across Runtime inspection, CLI summaries, and DSH tools while keeping historical activity in Timeline.
- 289cb45: Replace acpx with the Acpus-owned stable ACP v1 runtime, including named Agent shell-command configuration, durable Agent Session checkpoints, generic Session-aware Retry, Interrupt & Continue Steer, SessionSupervisor process ownership, delta event transport, structured Session bindings, readable local identities, and natural-language-only CLI presentation.

### Patch Changes

- 4c74672: Support the DeepSeek Harness 0.1.1-rc.2 checkpoint, show concrete Agent/model/config details with Agent-specific icons in the human Preset UI, and keep AI-facing catalogs limited to Preset ids and guidance.
- 525ef0d: Complete the workspace-wide Effect v4 migration with typed failures, Scope-owned resources, structured concurrency, deterministic time, and explicit Promise adapters. Add `@acpus/owned-process` as the shared child-process ownership and recovery boundary, and expose scoped ACP transport and cancellation capabilities.
- Updated dependencies [f921e64]
- Updated dependencies [bf6b49f]
- Updated dependencies [525ef0d]
- Updated dependencies [ad28502]
- Updated dependencies [289cb45]
  - @acpus/workflow-compiler@0.4.0
  - @acpus/runtime@0.18.0
  - @acpus/expression@0.3.0

## 0.1.1

### Patch Changes

- fab4a61: Publish the generated Host Typert contribution so DSH RPC discovery remains reliable across separate protocol module instances.

## 0.1.0

### Minor Changes

- 3218b23: Make DSH tool omission semantics model-safe, require explicit control and fork scopes, and preserve explicit null run and fork inputs.

### Patch Changes

- d756c29: Use the DSH host dependency seam and document explicit `esbuild` approval so plugin installation activates the profile in one command.
- Updated dependencies [3218b23]
  - @acpus/runtime@0.17.1

## 0.0.2

### Patch Changes

- 1e0e39e: Publish the embedded Workspace Runtime with state-root-isolated automatic store
  repair, host-neutral Runtime and ACP ownership, and the DeepSeek Harness Acpus
  Supervisor bundle with a natural-language managed Agent catalog with a built-in DSH Profile
  backed by package-owned ACP launch, durable admission recovery, controls,
  notices, bounded live projections, native Client surfaces, session workflow
  history with explicit readable task selectors, managed preset installation,
  and packed ACP execution.
- Updated dependencies [1e0e39e]
  - @acpus/runtime@0.17.0
