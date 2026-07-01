# Live Task Execution Implementation Goal

This document turns the task execution simplification decision into an
executable implementation goal. It is a roadmap execution aid, not current
product truth. Current implemented behavior lives in `specs/`.

**Implements with Clean Code and Good Test @AGENTS.md**

## Implementation Status

- [x] Phase 1: update current specs to describe live reusable task references
  and embedded inline source instead of task bundles.
- [x] Phase 1 adversarial review: completed; review findings were applied to
  specs and `docs/development-testing.md`.
- [x] Phase 2: implement IR/core/compiler/preflight/admission/runtime changes.
- [x] Phase 2 adversarial review: completed; review findings were applied to
  runtime package loading, referrer containment validation, compiler package
  fixture coverage, and core validation wording/tests.
- [x] Phase 3: add `@acpus/tasks` with `createWorktree` and package-task
  runtime coverage.
- [x] Phase 3 adversarial review: completed; review findings were applied to
  `createWorktree` dirty-repo handling, `forceRemove` safety, detach semantics,
  public export coverage, and type shape cleanup.
- [x] Final cleanup: remove stale bundle-era logic, tests, fixtures, package
  dependencies, and output contracts.
- [x] Final verification: run relevant build/test/search gates.

## Implementation Gaps And Diffs

- Runtime-admissible reusable module targets are completed by
  `@acpus/workflow-compiler`. Core-only `compileWorkflowDefinition(...)`
  lowering can produce an incomplete internal reusable descriptor when compiler
  source metadata is unavailable; `validateWorkflowIR(...)` rejects that shape.
- `@acpus/runtime` owns a direct `tsx` dependency and uses scoped in-process
  `tsx` imports. It includes a development-export fallback for workspace package
  exports so package task source can load even when the process was not started
  with ambient `development` conditions.
- `@acpus/tasks/createWorktree` supports detached worktree creation only in the
  first version. Passing `detach: false` fails clearly instead of implicitly
  creating or naming a branch.
- `createWorktree` rejects dirty source repositories and `forceRemove` only
  removes paths registered as git worktrees for the source repository. It refuses
  arbitrary existing directories.
- Repository cleanup search found no stale bundle-era implementation, spec,
  test, or roadmap wording outside this goal record after replacing the old
  references with live task reference wording.
- The only remaining `esbuild` search hits outside this goal are transitive
  Vite/Vitest lockfile entries in `pnpm-lock.yaml`, not workflow-compiler task
  loading code or package dependencies.

## Background

The current TypeScript-first compiler lowers every task into
`WorkflowIR.assets.taskBundles`. The workflow compiler then statically analyzes
task callsites, rejects reusable tasks imported from bare package specifiers,
uses esbuild to bundle reusable task modules and their reachable npm dependency
graph, writes task bundle files during preflight, copies them during admission,
and has runtime import those run-local bundle files.

That model freezes task JavaScript code, but Acpus task execution is not
hermetic. Task code commonly runs shell commands, touches the workspace,
depends on tools, reads files, and may call external services. Full reusable
task bundling therefore adds substantial compiler/runtime complexity while
still not providing replay-grade execution determinism.

The product direction is to simplify task execution:

- Reusable tasks are live module references. They can come from local modules,
  barrels, same-file exports, `@acpus/tasks`, or third-party packages.
- Reusable tasks may depend on arbitrary third-party packages through normal
  TypeScript/Node module resolution. Acpus does not bundle that dependency graph.
- Inline tasks remain valid for low-friction authoring, but they keep the clear
  self-contained boundary. Inline tasks do not capture workflow-module imports,
  helpers, or constants.
- The only retained task code payload is the self-contained inline `exec` source
  embedded in IR. Runtime executes that inline source without rerunning the
  workflow build callback.

## Goal

Replace the full task bundle model with live reusable task execution plus
embedded inline task source.

The delivered state should make reusable task authoring feel like ordinary
TypeScript module use:

- `run.task` accepts Acpus task tokens imported from local files, re-exported
  barrels, same-file exports, `@acpus/tasks`, or third-party packages.
- The preflight check no longer rejects bare-package reusable task imports.
- The workflow compiler no longer bundles reusable task source or npm
  dependency graphs.
- Runtime loads reusable task modules from the current workspace/package
  environment when the task executes.
- Inline task execution continues to use prepared self-contained `exec` source
  generated from the inline function and embedded in IR.

## Fixed Decisions

- **Execution model:** Acpus task execution is live code plus live environment.
  It does not claim hermetic replay. Existing run/fork behavior may still compare
  frozen IR and recorded metadata, but reusable task implementation code is
  resolved from the current runtime environment.
- **Reusable task loading:** Reusable tasks execute through live module loading,
  not esbuild output. The implementation records enough task reference metadata
  for runtime to import the module and select the exported Acpus task token.
- **Task IR target shape:** Task runs use a closed serialized execution target
  union instead of `bundleId`/bundle digest fields. The target shape should be
  close to:

  ```ts
  type TaskExecutionTargetIR =
    | { kind: "inline"; runtime: "node"; source: string }
    | {
        kind: "module";
        runtime: "node";
        specifier: string;
        exportName: string;
        referrer: { kind: "workflow"; path: string };
      };
  ```

  `TaskRunIR` keeps task input, `cwd`, `env`, timeout, and execution options
  beside this target. Inline and module targets are mutually exclusive.
- **Reusable task reference shape:** Reusable task metadata records source-level
  module references, not resolved absolute files. Imported reusable tasks keep
  the workflow import specifier, the imported export name, and the workflow
  source file as referrer. The referrer path stored in IR is workspace-relative,
  not absolute; runtime combines the admitted workspace directory with that
  referrer path to construct the parent URL for Node/tsx resolution. Same-file
  reusable tasks use the workflow module referrer and the exported task name.
  Runtime resolves these references through the current Node/tsx package
  environment.
- **Reusable dependencies:** Reusable task modules may import any dependencies
  that Node/tsx can resolve from the runtime environment. Acpus does not inline,
  copy, or hash the reusable task dependency graph.
- **Reusable module format:** Live reusable task loading supports ESM modules
  only. The `tsx` loader path may load `.ts`, `.tsx`, `.js`, `.mjs`, workspace
  packages, and package `exports` targets as long as they resolve as ESM. CommonJS
  interop, namespace fallback, and synthetic default export compatibility are not
  part of this goal for the reusable task entry/export. Reusable task modules may
  still depend on CJS packages when normal Node/tsx ESM loading supports that
  dependency shape. Acpus does not add CJS interop guarantees beyond what the
  platform loader already provides.
- **Inline task loading:** Inline tasks keep prepared source generated from
  `exec.toString()` and embedded directly in IR. There are no separate inline
  task artifact files in this goal. Runtime should execute inline source through
  a module-construction path such as a `data:` module wrapping
  `export default ${source}`, verify the default export is a function, and report
  construction or import failures as task attempt failures.
- **Inline capture:** Inline tasks remain self-contained. Capturing workflow
  module imports, top-level helpers, or top-level constants remains an authoring
  error. Authors who need dependencies should move the task into a reusable task
  module or package.
- **Workflow build callback:** Runtime task execution does not rerun the
  workflow build callback just to find task functions.
- **TypeScript loading:** Runtime uses the same TypeScript-first loading posture
  as the CLI/compiler path. The supervisor/runtime task loader runs with `tsx`
  support so local TypeScript workflow task modules remain executable in
  development and user workspaces.
- **Runtime loader boundary:** Reusable task loading uses an in-process scoped
  `tsx` import from the recorded source-level specifier and workflow referrer.
  `@acpus/runtime` owns this loader dependency unless implementation proves the
  CLI/supervisor can provide an equally explicit package boundary; tests should
  not rely on workspace root dev dependencies accidentally making TypeScript
  loading work.
  This goal does not introduce a task worker process. Task invocation remains in
  the runtime process so artifact APIs, abort signals, timeouts, and store writes
  do not require a cross-process protocol.
- **Live-code cache policy:** Acpus does not add its own reusable task module
  cache or cache-busting layer. Reusable task loading uses the normal Node/tsx
  process module cache. A CLI process or supervisor process restart is the
  natural refresh point for changed reusable task code or dependency installs.
- **Diagnostic code reset:** The greenfield compiler does not preserve task
  diagnostic code numbering from the full-bundle model. Remove reusable bundle
  failure diagnostics such as `TB001` and `TB003`, and remove the old `TB006`
  unsupported-import diagnostic. Keep inline self-containment as an explicit
  hard authoring diagnostic with code `TB007`. Re-rank any remaining task
  authoring diagnostics around the new live reusable task model without
  compatibility aliases. The implementation should write down the final task
  diagnostic code table: package imports and barrel exports are no longer
  diagnostics; `unsupported-task-import` is removed; unjoinable task callsites
  remain check-time diagnostics; initial non-task authoring values may still fail
  check/compile where observable, while live module drift such as missing
  modules, missing exports, or changed non-task exports fails the runtime task
  attempt.
- **Lock and source graph digest shape:** Remove `WorkflowIR.lock.taskBundleDigests`
  and preflight lock `taskBundles` entries with the bundle asset model. The new
  `sourceGraphDigest` is based on workflow source digest plus package lock digest
  when present, not task code payloads. Embedded inline source changes are
  reflected by the IR digest because the source lives in serialized IR.
- **Task cwd boundary:** Task `run.cwd` remains an execution option for the task
  context, especially the `$` command wrapper. It is not the module resolution
  base for loading reusable task code. Reusable task modules resolve from their
  source-level specifier and workflow referrer in the current workspace/package
  environment.
- **Package task support:** `@acpus/tasks` is a first-class expected reusable
  task package shape, not a special case. The same live reusable loading path
  should support it and other task packages.
- **Reusable task grammar:** The supported source forms should be explicit in
  specs and tests. At minimum, support direct default imports, named imports with
  aliases, barrel re-exports that resolve through package/module exports,
  same-file `export const`, same-file `export { taskName }`, and package bare
  specifiers for ESM modules. Unsupported forms such as namespace/property
  access or CommonJS-only exports should fail in check when statically
  recognizable, or as clear runtime task-attempt failures when caused by live
  module drift.

## Implementation Checklist

### Specs And Product Wording

- Update `specs/workflow-compiler-spec.md` to replace reusable task bundling
  requirements with live reusable task reference preparation.
- Update `specs/runtime-spec.md` to remove frozen run-local reusable task bundle
  execution and describe live reusable task module loading.
- Update `specs/core-spec.md` to replace `WorkflowIR.assets.taskBundles` as the
  universal task asset model with the new task execution metadata shape.
- Update `specs/cli-spec.md` to remove the `taskBundleCount` output contract
  after the runtime no longer persists task bundle counts.
- Audit package READMEs and testing docs for bundle-era wording that would become
  misleading after this change.
- Keep `specs/` focused on current behavior after the breaking change. Do not
  add migration warnings or compatibility behavior for the removed full bundle
  model.

### IR And Core Lowering

- Replace task run `bundleId`/bundle digest coupling with a direct task execution
  descriptor that distinguishes reusable module tasks from embedded inline
  source tasks.
- Model reusable task descriptors as source-level module references. Do not store
  resolved filesystem paths in IR for imported reusable tasks.
- Store workflow referrer paths as workspace-relative paths and validate that
  module targets include `specifier`, `exportName`, and a workflow referrer.
- Keep task run input, cwd, env, timeout, and execution options on `TaskRunIR`.
- Remove reusable task bundle insertion from core lowering.
- Preserve inline task source capture only for the embedded inline execution
  descriptor.
- Remove `WorkflowIR.assets.taskBundles` and `WorkflowIR.lock.taskBundleDigests`
  unless a later implementation review finds a separate non-bundle need for
  `assets`.
- Update IR validation to validate the new task execution descriptor and remove
  reusable bundle existence/digest diagnostics.

### Workflow Compiler And Check Pipeline

- Remove reusable task esbuild bundling and dependency graph capture.
- Remove the bare-package reusable task import rejection.
- Stop validating reusable task module exports by parsing their source. The
  compiled workflow module already evaluates imports and supplies Acpus task
  tokens at authoring time.
- Keep parser-based task callsite analysis only where it still pays for itself:
  inline self-containment diagnostics, task callsite source locations, and
  reusable task reference metadata needed by runtime.
- Patch compiled task nodes with reusable `specifier`/`exportName`/`referrer`
  metadata by joining parser callsite facts to lowered task nodes by step id.
  Unjoinable task callsites remain check failures and should not produce runtime
  module descriptors.
- Remove `TB006` as an unsupported-import diagnostic because package imports and
  barrel exports are valid reusable task sources.
- Remove reusable bundle guard diagnostics such as `TB001` and `TB003`.
- Keep the inline capture diagnostic as `TB007` and treat it as a hard authoring
  error.
- Re-rank any remaining task authoring diagnostics for source-level reusable
  reference failures or unjoinable task callsites; do not add compatibility
  aliases for removed code meanings.
- Remove `esbuild` from `@acpus/workflow-compiler` if no remaining code path uses
  it after this goal.

### Preflight And Admission Artifacts

- Stop writing reusable task bundles under `.acpus/preflight/<id>/task-bundles/`.
- Do not write task code artifacts during preflight. Inline source lives in the
  serialized IR.
- Remove reusable task bundle digests from lock artifacts and source graph
  digests.
- Remove preflight lock `taskBundles` entries. Compute source graph digest from
  workflow source digest plus package lock digest when present.
- Keep workflow source digest and package lock digest as audit metadata.
- During admission, copy only frozen IR and lock files into the run directory.
- Remove runtime persistence and inspection fields whose only purpose is task
  bundle accounting, including SQLite `task_bundle_count`, public
  `taskBundleCount`, and CLI output of task bundle counts. Because this codebase
  is greenfield, do not add migrations or compatibility shims for old bundle-era
  run rows unless explicitly requested.
- Update fork/replay frozen-file verification to check only current frozen files
  such as `workflow.ir.json` and `lock.json`, not run-local task bundle files.

### Runtime Execution

- Add a reusable task loader that resolves a recorded module reference from the
  run's workflow/workspace context, imports it with TypeScript support, verifies
  the selected export is an Acpus task token, and invokes `token.fn`.
- Resolve reusable task references at execution time so package installation
  paths, package-manager layouts, and package `exports` maps are handled by the
  current runtime environment.
- Implement reusable task imports with scoped in-process `tsx` loading, using the
  workflow source referrer as the parent URL. Do not spawn a task worker for this
  goal.
- Make the `tsx` dependency boundary explicit. Prefer a direct `@acpus/runtime`
  dependency if runtime owns TypeScript task loading.
- Use the same live loader for ESM JavaScript and TypeScript reusable tasks.
  Do not add CommonJS interop branches for this goal.
- Do not add Acpus-owned live module cache invalidation. Let Node/tsx module
  caching define reuse within a runtime process.
- Keep task module resolution separate from task execution `cwd`. Evaluate
  `run.cwd` only when building the task context for invocation; do not let dynamic
  task cwd change which module is imported.
- Keep inline task execution through the prepared inline source embedded in IR.
- Build inline functions from embedded source without writing a run-local bundle
  file; validate the resulting export before invocation and report construction
  failures as task attempt failures.
- Keep task context behavior unchanged: task functions receive `input`, `$`,
  `artifact`, `env`, and `abortSignal`.
- Make missing modules, missing exports, non-task exports, and TypeScript loader
  failures fail the task attempt with clear runtime errors.
- Avoid workflow build callback execution in task runtime.

### Tests

- Update core contract and validator tests for the new task IR shape and removal
  of reusable bundle validation.
- Update workflow-compiler unit tests so bare package imports, barrel exports,
  local direct imports, and same-file reusable tasks are accepted.
- Keep tests proving inline tasks that capture external identifiers fail during
  check/preflight.
- Add integration coverage for compiling and running a workflow that imports a
  reusable task from a package-like bare specifier.
- Build the package-like bare specifier fixture as a real resolvable package in
  the test workspace, with a `package.json`, runtime entry, and package `exports`
  map where applicable. The fixture should be ESM and should not rely only on
  `.d.ts` declarations.
- Add runtime integration coverage proving reusable task execution resolves live
  module exports and that inline tasks execute from embedded IR source.
- Add coverage proving `run.cwd` does not change reusable module resolution.
- Audit tests whose only purpose is to assert removed bundle digests, frozen
  reusable source, or third-party dependency inlining, then rewrite, consolidate,
  replace, or retire them according to the final implementation shape.

### `@acpus/tasks` Package Phase

Add a first-party `@acpus/tasks` package as part of this goal. The package is
both useful product surface and a dogfood target for live reusable task loading
from package exports. Keep the first version intentionally small.

- Create `packages/tasks` as an ESM package with source and dist exports matching
  the workspace package pattern. It should depend on `@acpus/core` and export
  reusable task tokens, not helper classes or runner abstractions.
- Expose git tasks through a subpath such as `@acpus/tasks/git`.
- First version exports only `createWorktree`.
- `createWorktree` input shape:

  ```ts
  {
    repo: string;
    path: string;
    ref?: string;          // default: "HEAD"
    detach?: boolean;      // default: true
    forceRemove?: boolean; // default: false
  }
  ```

- `createWorktree` output shape:

  ```ts
  {
    ok: boolean;
    repoPath: string;
    worktreePath: string;
    ref: string;
    baseSha: string;
    detached: boolean;
    created: boolean;
    dirtyStatus: string;
  }
  ```

- The first implementation treats detached worktrees as the primary supported
  path. `detach` exists to make the behavior explicit, but non-detached branch
  creation is outside this first phase unless the implementation can keep it
  equally small and unambiguous.
- `forceRemove` may remove an existing worktree path before creation, but the
  task should not perform broader cleanup, dependency installation, verification,
  or patch application.
- The task should fail by throwing clear errors for invalid repo/ref, dirty
  source workspace when that would make creation unsafe, failed removal, or
  failed worktree creation. It should not invent a separate diagnostic system.
- Package tests should keep git worktree coverage cheap: create a tiny temporary
  git repository, make one local commit with test-local author/committer env,
  invoke `createWorktree.fn(...)`, and assert the worktree path and commit SHA.
  Avoid large repos, network, package installs, or verification commands.
- Runtime live-loading coverage should include one workflow fixture importing
  `createWorktree` from `@acpus/tasks/git` to prove package reusable tasks
  execute through the live loader. Do not duplicate expensive git worktree setup
  across many runtime tests.

### Test And Fixture Cleanup Audit

This goal should leave no tests or fixtures whose only purpose is to preserve the
old reusable task bundle model. The items below are known cleanup pressure
points, not a mechanical deletion script. The implementation should use the final
IR shape, runtime loader boundary, and diagnostic ranking to decide whether each
test or fixture should be rewritten, merged into a lower-level test, replaced by
new coverage, or retired entirely. The final suite should validate current
behavior with the smallest useful set of tests and no stale bundle-era fixtures.

- `packages/core/test/workflow.integration.test.ts`: rewrite the main workflow
  lowering assertion from "task bundles and lock taskBundleDigests exist" to the
  new task execution descriptors. Retire assertions for missing bundles and
  run/bundle digest coupling once the new descriptor validation covers their
  replacement risks. Keep or move coverage for task nodes, task
  input/cwd/env/timeout lowering, inline source descriptors, and reusable module
  reference descriptors.
- `packages/core/test/validator.contract.test.ts`: migrate validator coverage
  away from `assets.taskBundles`, task bundle source/digest validation, missing
  task bundles, and task run digest mismatch. Rewrite shared fixture builders so
  a valid `WorkflowIR` follows the new current shape. Add or consolidate
  validator cases for the new task execution descriptor shape: inline source
  must be present for inline tasks; reusable module references must include
  source-level specifier/export/referrer metadata; task run options remain closed
  shapes.
- `packages/core/test/diagnostic-hints.contract.test.ts`,
  `packages/runtime/test/visualization-overlay.unit.test.ts`, and
  `packages/runtime/test/scheduler-materialize.unit.test.ts`: update hand-built
  IR fixtures to the new task run descriptor shape. Drop empty
  `assets.taskBundles` / `lock.taskBundleDigests` scaffolding if the final IR
  shape no longer needs it.
- `packages/workflow-compiler/test/task-analysis.unit.test.ts`: replace the
  old "rejects third-party package imports" and "rejects barrel re-export"
  cases with acceptance cases that assert reusable source-level reference
  metadata. Keep and refresh inline capture cases as the `TB007` hard error.
  Retire parser tests whose only remaining purpose is to prove imported module
  source was read for bundle metadata or parser-time export validation.
- `packages/workflow-compiler/test/authoring-rules.unit.test.ts`: migrate away
  from the `unsupported-task-import` fixture and `TB006` expectations. Re-rank
  remaining task authoring diagnostics around the new model. Keep `TB007`
  expectations for inline capture and update paths/hints if the new diagnostic
  shape changes.
- `packages/workflow-compiler/test/eslint-plugin.unit.test.ts`: update expected
  code sets so they no longer rely on `TB006`. Adjust
  `eslint-task-authoring.workflow.ts` if its `external-task` import exists only
  to trigger an unsupported-import rule. Keep or refactor fixture lines that
  exercise local non-exported reusable task diagnostics, unjoinable callsites,
  and inline capture.
- `packages/workflow-compiler/test/compiler.integration.test.ts`: migrate
  assertions away from production bundle existence, dependency inlining into
  bundle source, source graph digest inclusion of task bundle digests, and
  `TB001` bundle metadata conflict handling. Replace that risk coverage with
  assertions that compiled task nodes carry reusable module references or
  embedded inline source. Keep orchestration fixture coverage and add focused
  compile coverage for local imports, barrel imports, same-file exports, and
  package-like bare specifiers when those risks are not already covered lower in
  the stack.
- `packages/workflow-compiler/test/preflight.integration.test.ts`: migrate
  checks away from `.acpus/preflight/<id>/task-bundles/*.mjs`, lock
  `taskBundles` entries, reusable bundle source files, and reusable bundle
  digests. Cover the new preflight contract: frozen IR/lock artifacts only,
  inline source inside serialized IR, and source graph digest excluding task
  bundle digests.
- `packages/runtime/test/support/runtime-fixtures.ts`: simplify synthetic
  workflow preparation after bundle artifacts disappear. Helpers such as
  `runtimeExecutableTaskBundles(...)`, task bundle module-source rewriting, and
  task run digest patching should not survive unless a new current-behavior risk
  justifies them. Prepared synthetic workflows should pass embedded inline source
  and live reusable descriptors directly to runtime.
- `packages/runtime/test/runtime-admission.integration.test.ts`: rename and
  rewrite "copies task bundles and registers artifacts" around the new admission
  contract so it asserts frozen IR/lock admission plus artifact behavior without
  implying task bundle copying. Replace "executes same-file reusable task
  bundles" with live reusable task loading coverage. Add failure coverage for
  missing module, missing export, non-task export, and TypeScript loader errors
  as task-attempt failures.
- `packages/cli/test/output.contract.test.ts` and related CLI e2e tests: update
  output contracts after the runtime store no longer persists
  `taskBundleCount`. Keep IR digest, source graph digest, admitted run id/status,
  and diagnostics output coverage.
- `packages/workflow-compiler/test/fixtures/workflows/shared-bundle.workflow.ts`
  and `packages/workflow-compiler/test/fixtures/workflows/conflicting-bundle-metadata.workflow.ts`:
  retire or repurpose these fixtures only if they no longer describe any
  current-behavior risk beyond bundle-id collision and conflicting bundle
  metadata behavior.
- `packages/workflow-compiler/test/fixtures/workflows/tasks/conflict-first.task.ts`,
  `packages/workflow-compiler/test/fixtures/workflows/tasks/conflict-second.task.ts`,
  and `packages/workflow-compiler/test/fixtures/workflows/tasks/shared-ok.task.ts`:
  retire them if no remaining non-bundle tests use them.
- `packages/workflow-compiler/test/fixtures/workflows/tasks/node-module-dependency.task.ts`:
  keep as a live reusable dependency fixture, but rewrite comments and assertions
  so the dependency is expected to remain a normal runtime module dependency,
  not an inlined bundle dependency.
- `packages/workflow-compiler/test/fixtures/workflows/tasks/local-dependency.task.ts`
  and `packages/workflow-compiler/test/fixtures/workflows/tasks/slug.ts`: keep
  as local reusable dependency fixtures, with assertions focused on source-level
  references and runtime execution rather than bundled source contents.
- `packages/workflow-compiler/test/fixtures/workflows/tasks/not-a-task.task.ts`:
  retire or repurpose if it is only used to prove parser-time imported-module
  validation. Keep compile/check coverage only for authoring values that are
  observably not Acpus task tokens during workflow preparation. Cover live module
  drift to non-task exports as runtime task-attempt failures.
- `packages/workflow-compiler/test/fixtures/workflows/external-task.d.ts`:
  retire if it is only used for the removed unsupported-import diagnostic.
  Replace with a real package-like fixture when testing bare specifier live
  loading. The new fixture should create an actual package directory or symlinked
  package entry in the test workspace so Node/tsx resolves it through normal
  package rules.
- `packages/workflow-compiler/test/fixtures/workflows/inline-capture.workflow.ts`:
  keep as the canonical `TB007` fixture.
- `packages/workflow-compiler/test/fixtures/workflows/same-file-build-callback.workflow.ts`:
  keep but rewrite the assertion. It should prove task runtime does not rerun the
  workflow build callback, not that generated bundle source can be imported.
- `packages/workflow-compiler/test/fixtures/workflows/same-file-reusable.workflow.ts`
  and `packages/runtime/test/fixtures/workflows/same-file-reusable.workflow.ts`:
  keep as same-file exported reusable task coverage, but change expected behavior
  from generated bundle execution to live module export loading.
- After implementation, run a repository search for `taskBundles`,
  `task-bundles`, `bundleId`, `taskBundleDigests`, `taskBundleCount`, `TB001`,
  `TB003`, `TB006`, `unsupported-task-import`, `bundleWorkflowTasks`, and
  `esbuild`. Remaining hits must either belong to this roadmap record, historical
  `legacy/` files, or intentional non-task-bundle uses of the word "bundle".

## Resolved Decision Queue

- Reusable task references use source-level specifier/export/referrer metadata.
- Task execution targets are closed inline/module descriptors on `TaskRunIR`,
  replacing `bundleId` and task bundle digests.
- Runtime loads reusable task modules with in-process scoped `tsx` import.
- Task `run.cwd` affects task execution only, not module resolution.
- Inline task source is embedded in IR.
- Lock artifacts and source graph digests no longer include task bundle entries
  or task bundle digests.
- Acpus does not add a reusable task module cache beyond Node/tsx process module
  caching.
- Reusable bundle diagnostics and unsupported-import diagnostics are removed;
  inline self-containment remains `TB007`.

## Exit Criteria

- `@acpus/tasks`-style package tasks can be imported and executed as reusable
  tasks without special-case code.
- Reusable task execution no longer uses esbuild-generated bundle source.
- Inline tasks remain valid, self-contained, and embedded in IR rather than
  written as separate task files.
- Runtime does not rerun workflow build callbacks for task execution.
- Existing task context, artifact, cwd, env, timeout, and abort behavior remain
  covered by tests.
- Specs describe only the new live reusable task plus embedded inline source
  model.
