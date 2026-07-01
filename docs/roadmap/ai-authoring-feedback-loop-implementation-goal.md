# AI Authoring Feedback Loop Implementation Goal

This document turns the AI-authoring ergonomics evaluation into an executable
implementation goal. It is a roadmap execution aid, not current product truth.
Current implemented behavior lives in `specs/`.

**Implements with Clean Code and Good Test @AGENTS.md**

## Background

### The real authoring bottleneck is the Expr-as-value gap

An LLM authors Acpus workflows by emitting TypeScript against the DSL in
`packages/core` and `packages/expression`. The hardest thing for a model to get
right is not declaring nodes; it is that node outputs and inputs are deferred
expression tokens, not values. `tests.output.passed` has the static type
`OutputAccessor<boolean>` (an `Expr<boolean>`), so it looks like a boolean, but
it is a proxy that lowers property access into reference IR
(`packages/expression/src/internal/expr.ts`).

The strongest LLM priors therefore produce code that is wrong here:

- `if (tests.output.passed)` - always truthy; an `Expr` object is never falsy.
- `reviews.output && other` / `a.output === b.output` - JS operators over
  `Expr`.
- `` `${prepare.output.diff}` `` - untagged template; must be
  `` template`...` ``.
- `items.output.map(...)` - a useful friendlier diagnostic, though typed
  workflows often already reject this through TypeScript because accessors do
  not expose array methods.

JavaScript cannot overload operators, so no surface-syntax change (decorators
included) can make `===`/`&&`/`if` work on `Expr`. The expression helpers
(`where`, `every`, `ifElse`, `not`, `max`, `coalesce`, and others) exist because
of this.

The lever that raises first-pass correctness is therefore the **feedback loop**:
when the AI runs the Acpus CLI, it must read precise, actionable diagnostics and
self-correct. The loop must run through the same path the AI already uses:
`acpus run` and `acpus run --dry-run`.

### TypeScript and lint have different jobs

TypeScript MUST remain the type-safety checker: it enforces what the workflow
program can type-safely do. Acpus typed lint rules MUST enforce authoring
semantics that TypeScript permits but Acpus considers wrong, such as using an
`Expr` token in JavaScript truthiness or comparison positions.

The workflow preflight path therefore needs a single static check pipeline, not
a replacement of TypeScript by lint. `prepareWorkflow(...)` SHOULD run:

1. `check` - stable TypeScript diagnostics plus Acpus-only typed lint
   diagnostics, both converted to `DiagnosticIR`.
2. `compile` - import/lower/bundle the workflow module.
3. `validate` - run structural IR validation.

The repository MAY keep `tsgo` as build/typecheck tooling for the repo itself,
but runtime workflow preflight MUST use stable `typescript` rather than
`@typescript/native-preview`.

### Task analysis has separate products

Task provenance MUST NOT remain a compiler pass that both decides rule
violations and feeds bundling metadata. Phase C extracts a shared,
diagnostic-free task authoring analysis module inside
`@acpus/workflow-compiler`. There is no separate analyzer package in this goal:
the only lint entrypoint is `acpus run` / `acpus run --dry-run`, so the compiler
package owns the complete check -> compile -> validate pipeline.

The task analysis module produces structured facts and metadata only:

- **Authoring facts**: task callsites, static ids, task spec shape, imports,
  exports, inline free identifiers, and join keys.
- **Bundle metadata**: for admissible task callsites, the source file and
  normalized join data the compiler/bundler needs to attach bundled task assets.

The task analysis module MUST NOT emit `DiagnosticIR`, rule codes, or hint text.
The internal preflight lint adapter maps task facts into Acpus authoring
diagnostics such as `TB004`, `TB005`, `TB006`, and `TB007`. Compile/bundle code
consumes metadata only; it must not run lint and must not duplicate lint-rule
wording. Direct `compileWorkflowModule(...)` safety failures caused by missing
metadata remain compile/bundle guard diagnostics, not the primary AI feedback
channel.

### Workflow compiler stays one package with domain modules

Not splitting packages does not mean flattening implementation files under
`packages/workflow-compiler/src`. Phase C MUST keep the external package
interface small while introducing internal modules at domain seams:

- `src/check/`: owns the `check` phase orchestration, TypeScript diagnostic
  collection, Acpus lint execution, and conversion to `DiagnosticIR`.
- `src/check/acpus-lint/`: owns Acpus authoring lint rules, rule codes, hints,
  and lint-unit tests.
- `src/task-analysis/`: owns diagnostic-free task authoring facts and bundle
  metadata shared by lint and compile/bundle code.
- `src/compiler/`: owns workflow module import/lowering and task bundling, and
  consumes task metadata without owning lint rule text.
- `src/preflight/` or the existing preflight entry module: owns
  `prepareWorkflow(...)` sequencing across check, compile, and validate.

Avoid new root-level catch-all files such as `src/analyzer.ts`, `src/lint.ts`,
or `src/check.ts` once the implementation grows past a thin entrypoint. The
deep module interfaces should stay small: the check runner returns
`DiagnosticIR[]`; task analysis returns facts/metadata; bundler consumes
metadata. Tests should cross those same interfaces rather than reaching through
their implementations.

### Same-file reusable tasks use module import semantics

Phase D intentionally chooses a simple same-file reusable task model instead of
building a dependency-closure extractor. A workflow module may declare exported
top-level reusable tasks in the same file as the default workflow. The compiler
may bundle such tasks by importing the workflow module export and re-exporting
the task function:

```ts
import { checkVersion } from "./workflow.js";
export default checkVersion.fn;
```

This is an explicit runtime semantic, not an implementation accident: when a
same-file task bundle runs, the workflow module top level may be evaluated by
the task runtime. Workflow modules therefore MUST keep top-level code
side-effect-light. The workflow build callback is still not executed by merely
importing the workflow module; IR graph lowering remains owned by
`compileWorkflowDefinition(...)`.

This goal does not require proving top-level purity or extracting only the task
dependency closure. The lint layer only rejects reusable tasks declared inside
workflow build/nested scopes or values that cannot be joined to task metadata.
Top-level third-party imports used by exported same-file reusable tasks are
allowed.

### Why not decorators

Evaluated and rejected: dynamic `step(\`review_${id}\`)` generation and
composite-callback `step()` cannot be expressed as static class-method
decorators (`packages/workflow-compiler/test/fixtures/workflows/release.workflow.ts`,
`orchestration.workflow.ts`); class instances are exactly the runtime handles
barred from `WorkflowIR` (`AGENTS.md:21`); the high-frequency TS decorator priors
are DI/ORM (NestJS/TypeORM), which would misdirect a model rather than help.
The DSL deliberately uses plain typed function/builder calls plus generic
inference, which is the correct training-data shape (`vitest`-style
`step("id").kind(spec)`, named helpers, tagged templates).

### Two concrete defects to fix alongside the loop

1. **`Expr.ir` field collision (silent shadowing).** `OutputAccessor<T>` excludes
   `keyof Expr<any>` (`EXPR | __type | ir`) from reachable fields and the proxy
   passes the property name `"ir"` through to the internal `ExprIR`. Any user
   output-schema field named `ir` is therefore unreachable and silently aliases
   the internal IR. Renaming the internal field to `__ir` frees the common user
   field name `ir` and reserves only `__ir`/`__type`.

2. **The hint channel is half-built.** `DiagnosticIR.hint` exists and is
   allow-listed by the validator, but only `ID001` sets it today, and the CLI
   text renderer drops it. Even existing guidance is invisible in the channel
   the AI reads.

## Goal

Close the AI-authoring correction loop across five coherent workstreams landed
in order A -> B -> C -> D -> E:

- **A. Diagnostic enrichment** - render `DiagnosticIR.hint` in CLI text output
  and attach LLM-actionable hints to high-frequency authoring error codes.
- **B. `Expr.ir` -> `Expr.__ir` rename** - eliminate silent shadowing of user
  output fields named `ir`, scoped strictly to the `Expr` accessor chain.
- **C. Workflow check pipeline + internal Acpus lint** - make
  `prepareWorkflow(...)` run a pre-compile `check` phase that aggregates stable
  TypeScript diagnostics and Acpus-only typed lint diagnostics as `DiagnosticIR`.
- **D. Same-file reusable tasks** - allow exported top-level reusable tasks in
  `workflow.ts` through explicit whole-module import bundling semantics.
- **E. Specs and verification** - align specs, cleanup, and verification with
  the delivered behavior.

The merged state has: hints visible in both `text` and `--json` CLI output; no
authoring field-name collision on `ir`; `run`/`run --dry-run` automatically
report TypeScript and Acpus authoring diagnostics through phase `"check"` using
an internal workflow-compiler check engine; exported top-level same-file
reusable tasks work with explicit whole-module import bundling semantics; and
specs/roadmap are updated to match.

## Completion Gates

- [ ] CLI text output prints `diagnostic.hint` when present; `--json` output
  continues to include `hint` unchanged.
- [ ] Core-owned diagnostics `O001`, `W001`, `B001`, `G002`, `G003`, and `A001`
  carry stable, actionable hints asserted by core contract tests.
- [ ] Acpus task-authoring lint diagnostics `TB004`, `TB005`, `TB006`, and
  `TB007` carry stable, actionable hints asserted by workflow-compiler lint
  tests and preserved when converted to preflight `DiagnosticIR`.
- [ ] A shared task authoring analysis module exists inside
  `@acpus/workflow-compiler` as a diagnostic-free API. It
  returns facts and bundle metadata only; lint owns rule violations and hints,
  while compile/bundler code consumes metadata.
- [ ] `@acpus/workflow-compiler` keeps one package with domain-organized
  internal modules. Check orchestration, Acpus lint rules, task analysis, and
  compiler/bundler code live behind small internal interfaces rather than
  accumulating as flat root-level `src/*.ts` files.
- [ ] A user workflow whose output schema declares a field named `ir` can read
  and wire `ref.output.ir`; a regression test proves it lowers to the expected
  `ref` path.
- [ ] The internal expression IR field is `__ir` everywhere in the Expr accessor
  chain, including proxy `target.ir` reads; `PreparedWorkflow.ir`,
  `compiled.ir`, `prepared.ir`, `workflow.ir.json`, and `SecretToken.ir` are
  untouched unless they are actual Expr unwrap sites.
- [ ] `prepareWorkflow(...)` reports TypeScript and Acpus lint errors as
  `WorkflowPreparationError` phase `"check"` with `DiagnosticIR[]`.
- [ ] TypeScript diagnostics are converted to existing `DiagnosticIR` without a
  schema expansion: `code: "TS####"`, flattened `message`, and `source` file,
  line, and column when available.
- [ ] `compileWorkflowModule(...)` remains lower-level and does not run check.
- [ ] Runtime workflow preflight uses stable `typescript`; `tsgo` remains only
  repo build/typecheck tooling.
- [ ] The workflow-compiler check engine runs only Acpus rules. It does not load
  user lint config, editor config, or broad third-party recommended lint
  presets.
- [ ] Internal Acpus lint covers: `Expr` in JS truthiness positions; JS logical and
  comparison operators over `Expr`; untagged template interpolation containing
  `Expr`; `.map()`/array methods over Expr accessors as a friendlier diagnostic
  or escape-hatch rule; and Expr-derived node ids. Compile-time generated string
  ids such as `step(\`review_${id}\`)` remain valid where task metadata can
  handle them.
- [ ] Non-literal task ids MUST NOT silently skip task metadata/lint checks. If a
  task id cannot be joined to task metadata, preflight lint emits the Acpus
  authoring diagnostic through `acpus run`; direct compile emits only the metadata
  safety diagnostic needed to avoid admitting an unchecked task bundle.
- [ ] Exported top-level reusable tasks in `workflow.ts` are valid. Task analysis
  returns `{ sourceFile: workflow.ts, exportName }` metadata, and the bundler
  imports that workflow module export rather than extracting a dependency
  closure.
- [ ] Same-file reusable task semantics are explicit: task runtime may evaluate
  workflow module top-level code; workflow build callbacks are not executed by
  module import; graph IR remains unchanged except task bundle source/digest and
  source graph digest.
- [ ] Specs and roadmap reflect delivered behavior without a standalone
  `acpus lint` command in this goal.
- [ ] `pnpm typecheck` and `pnpm test` pass, or any unavailable command is
  explicitly recorded in the handoff.

## Non-Goals

- [ ] No decorator-based or class-based authoring syntax.
- [ ] No new step-declaration shape (no flat `task("id", spec)`); the
  `step("id").kind(spec)` surface stays.
- [ ] No re-export of `@acpus/expression` helpers from `@acpus/core` in this goal
  (single-import convenience is a separate candidate).
- [ ] No source maps for bundled task assets (tracked separately in
  `docs/roadmap/core-roadmap.md` Phase 2).
- [ ] No compatibility shim for the old `Expr.ir` accessor field; the rename is a
  clean break (the package is unpublished).
- [ ] No standalone `acpus lint` or `acpus check` command in this goal. The AI
  loop closes through `run` and `run --dry-run`.
- [ ] No public `@acpus/eslint-plugin`, editor lint integration, or generic CI
  lint product in this goal. The AI authoring feedback channel is the CLI run
  path.
- [ ] No replacement of TypeScript typechecking with lint. Typed lint may use
  TypeScript type information, but TypeScript remains the type-safety checker.
- [ ] No user lint config, autofix, or broad third-party recommended rules in
  workflow preflight.
- [ ] No dependency-closure extraction for same-file reusable tasks in this
  goal. Whole workflow module import is the chosen first implementation.

## Non-Negotiable Constraints

- [ ] Keep `WorkflowIR` serializable; hints and check diagnostics are plain
  serialized data.
- [ ] Keep `@acpus/expression` independent from `@acpus/core`/`@acpus/runtime`.
- [ ] Do not add lint-engine or TypeScript compiler dependencies to
  `@acpus/expression`.
- [ ] Hints are stable contract text: assert their presence and intent, not
  brittle full-string snapshots (`docs/development-testing.md`).
- [ ] Match house style: terse, no migration/deprecation prose, current behavior
  only in `specs/`.

## Implementation Phases

### Phase 0: Preflight

- [ ] Re-read this goal and `docs/roadmap/core-roadmap.md:27-30`.
- [ ] Confirm worktree status; avoid unrelated staged changes.
- [ ] Confirm `.ir` readers split into true Expr internals
  (`packages/expression/**`, `packages/core/src/template/template.ts`, and test
  unwrap sites) versus unrelated wrapper fields such as `PreparedWorkflow.ir`,
  `compiled.ir`, `prepared.ir`, and `workflow.ir.json`.
- [ ] Confirm current executable verification commands use root Vitest
  path-filter scripts, not nonexistent package-local `test` scripts.

Exit criteria:

- [ ] The Phase B blast radius is enumerated and separated from non-Expr wrapper
  `.ir` fields.
- [ ] The Phase C package/dependency plan names the owner package, internal
  modules, runtime dependencies, and verification commands.
- [ ] The Phase D same-file reusable task plan names the accepted source shapes,
  whole-module import semantics, expected IR effects, and verification commands.

### Phase A: Diagnostic Enrichment

- [ ] Render `hint` in the CLI text path: in the diagnostics loop in
  `packages/cli/src/output.ts`, append the hint on its own indented line when
  `diagnostic.hint` is set. Leave the `--json` branch unchanged.
- [ ] Attach actionable `hint` text at core emit sites:
  - `O001` excess scope-output field: remove the returned field or add it to the
    node `outputSchema`.
  - `W001` workflow build returned no output object and `B001` composite scope
    returned no output object: every `.build`/composite callback must
    `return { ... }`.
  - `G002`/`G003` if/switch with `outputSchema` missing `else`/`default`:
    provide a fallback branch when the node declares outputs.
  - `A001` reference to an undeclared agent: declare under
    `defineWorkflow({ agents })` and reference via `agents.<key>`.
- [ ] Do not attach task-authoring rule hints in task-bundler. `TB004`,
  `TB005`, `TB006`, and `TB007` hint ownership moves to the Phase C lint rules
  that consume task analysis facts.
- [ ] Keep `ID001`'s existing hint as the CLI rendering format reference.

Exit criteria:

- [ ] Core contract tests assert hint presence and intent for `O001`, `W001`,
  `B001`, `G002`, `G003`, and `A001`.
- [ ] Workflow-compiler tests cover task metadata propagation separately from
  task-authoring rule hints; task-authoring hint assertions live with the
  internal lint rule tests in Phase C.
- [ ] CLI output contract/e2e tests assert text renders hint lines on the correct
  stream and JSON preserves the `hint` key.

### Phase B: `Expr.ir` -> `Expr.__ir` Rename

- [ ] `packages/expression/src/internal/expr.ts`: rename the interface field,
  `ExprImpl` field, `valueToExprIR` read, proxy passthrough guard, and all proxy
  body `target.ir` reads to `__ir`.
- [ ] `packages/expression/src/index.ts`: update `RESERVED_ACCESSOR_KEYS` to
  `["__ir", "__type"]` and update `isObjectTyped` to read `value.__ir`.
  Type-level accessor and `where` reserved-key behavior should update through
  `keyof Expr<any>`.
- [ ] `packages/core/src/template/template.ts`: update Expr template unwrap reads
  to `.__ir`.
- [ ] Tests: replace Expr inspection reads with `.__ir` across expression unit
  tests and update type tests so `ir` is a reachable user field while `__ir` and
  `__type` remain reserved.
- [ ] Include runtime tests that unwrap expression IR, such as runtime evaluator
  tests, in the blast radius.
- [ ] Do NOT touch unrelated wrapper fields such as `PreparedWorkflow.ir`,
  `compiled.ir`, `prepared.ir`, or `workflow.ir.json`, and do not touch
  `SecretToken.ir` unless a test proves it is an Expr unwrap.

Exit criteria:

- [ ] New `packages/expression/test/reserved-field.regression.test.ts`: a ref
  whose type declares a field `ir` (for example
  `refExpr<{ ir: string }>(["input", "user"])`) exposes `ref.ir` as an accessor,
  and `ref.ir.__ir` equals `{ kind: "ref", path: ["input", "user", "ir"] }`.
- [ ] Expression, core, and runtime tests that inspect Expr IR pass against
  `__ir`.

### Phase C: Workflow Check Pipeline + Internal Acpus Lint

- [ ] In `@acpus/workflow-compiler`, replace runtime workflow typecheck from
  `@typescript/native-preview`/`tsgo` to stable `typescript`.
- [ ] Keep repo package build/typecheck scripts free to use `tsgo`; remove
  `@typescript/native-preview` from workflow-compiler runtime dependencies if it
  is no longer used outside repo tooling.
- [ ] Implement a workflow check runner owned by `@acpus/workflow-compiler`.
  It writes or reuses the scratch tsconfig policy currently owned by
  `typecheckWorkflow`: NodeNext, no emit, strict, workspace `development`
  condition, and live `@acpus/core` source path mapping in workspace
  development.
- [ ] Organize workflow-compiler internals by domain before wiring more logic:
  `src/check/` for check orchestration and TypeScript diagnostic conversion,
  `src/check/acpus-lint/` for Acpus lint rules and hints, `src/task-analysis/`
  for diagnostic-free facts/metadata, and `src/compiler/` for lowering and
  bundling. Root `src/` files should remain thin entrypoints or compatibility
  shims only.
- [ ] Extract the current task provenance logic into an internal
  diagnostic-free task analysis module under `@acpus/workflow-compiler`. It owns
  parser/source traversal and returns task callsite facts, static-id/join facts,
  import/export facts, inline free-identifier facts, and bundle metadata for
  valid task callsites.
- [ ] Keep task analysis APIs split by product:
  - `analyzeTaskAuthoring(...)` or equivalent returns facts for lint rules.
  - `resolveTaskBundleMetadata(...)` or equivalent returns source-file/join
    metadata for compiler and bundler use.
  The APIs MUST NOT return `DiagnosticIR`, rule codes, or hint text.
- [ ] Convert TypeScript compiler diagnostics to `DiagnosticIR` with `TS####`
  codes, flattened messages, and `source` locations. Do not expand
  `DiagnosticIR`.
- [ ] Aggregate TypeScript diagnostics and Acpus typed lint diagnostics in one
  `"check"` failure phase. Run Acpus typed lint even when semantic TS errors
  exist if usable type information is available; skip lint only for syntax,
  config, or module-resolution failures that prevent a Program.
- [ ] Implement Acpus typed lint as an internal workflow-compiler check module,
  not as a public plugin package. The module owns Acpus typed rules, task
  authoring diagnostics, hint text, and unit tests.
- [ ] Preflight MUST run only Acpus rules through the check runner. It MUST NOT
  load user lint config, editor config, or broad third-party recommended presets.
- [ ] Implement rules:
  - `no-expr-in-condition`: `Expr` directly used in `if`, `while`, `for`,
    ternary tests, `!expr`, or truthiness short-circuit positions.
  - `no-logical-operators-over-expr`: JS logical operators over `Expr` where the
    operator relies on JavaScript truthiness.
  - `no-comparison-operators-over-expr`: `==`, `!=`, `===`, `!==`, `<`, `<=`,
    `>`, and `>=` over `Expr`; authors use expression helpers such as `eq`,
    `ne`, `lt`, `lte`, `gt`, and `gte`.
  - `no-untagged-template-with-expr`: template literal interpolation containing
    an `Expr` unless produced by the `template` tag.
  - `no-runtime-map-over-expr`: `.map()` and related array methods over an Expr
    accessor as a friendlier diagnostic or escape-hatch guard.
  - `no-expr-derived-node-id`: node ids derived from Expr/runtime workflow
    values. Compile-time generated strings such as `step(\`review_${id}\`)`
    remain valid when task metadata can resolve the resulting task
    callsites.
  - `no-nested-or-unexported-reusable-task`: `TB004`.
  - `no-invalid-reusable-task-export`: `TB005`.
  - `no-unsupported-task-import`: `TB006`.
  - `no-inline-task-capture`: `TB007`.
- [ ] Wire task authoring rules through task analysis facts. The lint adapter maps
  task facts to `TB004`-`TB007` preflight `DiagnosticIR` with hints. The task
  analysis module itself remains diagnostic-free.
- [ ] Wire compile/bundler through task metadata. `compileWorkflowModule(...)`
  and `bundleWorkflowTasks(...)` consume source-file/join metadata only; they do
  not run lint and do not duplicate authoring-rule messages or hints.
- [ ] Address task metadata interaction explicitly. If a task callsite uses an
  id/spec shape the task analysis module cannot join to the lowered task node,
  preflight lint emits a stable Acpus authoring diagnostic through `acpus run`.
  Direct `compileWorkflowModule(...)` emits only the minimal metadata safety
  diagnostic needed to avoid silently admitting an unchecked task bundle.
- [ ] Update `prepareWorkflow(...)` to run the check runner before compile and
  fail with phase `"check"` when any check diagnostic has `severity: "error"`.
  Warning diagnostics do not block compile.
- [ ] Keep `compileWorkflowModule(...)` as the lower-level compile API; it MUST
  NOT run check.

Exit criteria:

- [ ] Workflow-compiler tests cover TypeScript errors converted to
  `DiagnosticIR`, Acpus lint errors converted to `DiagnosticIR`, mixed TS + lint
  aggregation when type information is usable, warning-only check diagnostics
  not blocking compile, and `compileWorkflowModule(...)` not running check.
- [ ] Workflow-compiler task analysis tests cover facts and metadata separately:
  reusable task direct imports, nested or unexported workflow-local task values,
  invalid exports, unsupported imports/barrels, inline captures, non-literal task
  ids, non-literal task specs, and successful metadata for reusable and inline
  tasks.
- [ ] Workflow-compiler tests cover metadata consumption without lint:
  `compileWorkflowModule(...)` uses task metadata for bundling, does not execute
  the lint runner, and emits a metadata safety diagnostic only when metadata is
  unavailable.
- [ ] Workflow-compiler lint unit tests cover valid/invalid cases for every
  Acpus rule.
- [ ] Workflow-compiler lint unit tests assert `TB004`, `TB005`, `TB006`, and
  `TB007` diagnostics and hints from task analysis facts.
- [ ] Valid lint cases include `step(\`review_${id}\`).agent(...)` and JS arrays
  of `NodeRef` values.
- [ ] Invalid lint cases include Expr conditions, comparisons, untagged
  templates, Expr array methods, Expr-derived node ids, and task authoring rule
  violations.

### Phase D: Same-File Reusable Task Chain

- [ ] Extend task analysis facts to recognize exported top-level reusable task
  declarations in a workflow module:
  - `export const check = task.define(...)`
  - `const check = task.define(...); export { check }`
  - default workflow export remains the workflow definition, not the task.
- [ ] Keep unsupported same-file forms intentionally narrow in this goal:
  nested `task.define(...)` inside `.build(...)` or composite callbacks,
  non-exported workflow-local task values passed to `run.task`, computed exports,
  re-exported same-file tasks, and task values whose callsite cannot be joined
  to task metadata.
- [ ] Define same-file metadata returned by task analysis as source-file/export
  metadata, not extracted source:
  `{ sourceFile: workflow.ts, exportName: "check", sourceKind: "workflow-module" }`
  or an equivalent shape.
- [ ] Update task-authoring lint rules so top-level exported same-file reusable
  tasks are valid, while nested or unexported workflow-local reusable tasks still
  report `TB004` with an actionable hint.
- [ ] Update compiler/bundler metadata consumption for same-file tasks. For a
  workflow-module task export, the generated virtual entry imports that workflow
  module export and re-exports `token.fn`; it does not attempt dependency
  closure extraction.
- [ ] Make whole-module import semantics explicit in code comments and specs:
  task runtime may evaluate workflow module top-level code; workflow authors
  should keep top-level code side-effect-light; importing the module does not
  execute the workflow build callback.
- [ ] Keep graph IR stable for same-file reusable tasks. The allowed behavioral
  changes are task bundle `source`, task bundle `digest`, task run digest, and
  source graph digest.
- [ ] Add fixtures that prove same-file reusable tasks may use third-party
  imports at workflow top level without requiring a separate task module.

Exit criteria:

- [ ] Workflow-compiler task analysis unit tests cover accepted same-file
  top-level exported task forms and rejected nested/unexported forms.
- [ ] Workflow-compiler lint tests cover same-file valid cases, `TB004` invalid
  cases, and hints that explain top-level export as the fix.
- [ ] Workflow-compiler integration tests compile a workflow with a same-file
  reusable task using a third-party import, verify task bundle source exists,
  verify task bundle digest/source graph digest are stable-shaped, and verify
  graph nodes/outputs match the equivalent separate task-module workflow.
- [ ] Runtime or task-executor integration coverage proves the bundled same-file
  task can execute and resolve its third-party dependency.
- [ ] A regression test proves importing the same-file task bundle does not
  execute the workflow build callback.

### Phase E: Specs, Cleanup, Verification

- [ ] Update `specs/expression-spec.md`: reserved accessor keys are `__ir` and
  `__type`; user field `ir` is reachable.
- [ ] Update `specs/workflow-compiler-spec.md`: `prepareWorkflow(...)` runs
  `check -> compile -> validate`; check uses stable TypeScript, aggregates
  TypeScript and Acpus lint diagnostics as `DiagnosticIR`, and fails with phase
  `"check"` on errors; `compileWorkflowModule(...)` remains no-check and
  consumes task metadata only. Same-file exported reusable tasks in
  workflow modules are supported through explicit whole-module import bundling
  semantics. The spec also defines the internal task analysis boundary: facts
  and bundle metadata are separate products, lint owns task authoring
  diagnostics, and compile/bundler owns metadata consumption.
- [ ] Update `specs/cli-spec.md`: `run` and `run --dry-run` expose check
  failures through phase `"check"` and render `DiagnosticIR` fields including
  `hint` and `source` in text/json output.
- [ ] Update task/runtime specs only if same-file reusable task execution changes
  observable runtime behavior beyond ordinary bundled task execution. Otherwise
  keep the semantic contract in workflow-compiler specs.
- [ ] Update `docs/roadmap/core-roadmap.md`: remove implemented lint error rules
  and any hint/feedback gap, but keep unrelated future warnings or source-map
  work.
- [ ] Run narrow checks during development; broader checks before handoff.

Suggested verification:

- [ ] `pnpm test:unit packages/expression`
- [ ] `pnpm test:contract packages/expression`
- [ ] `pnpm test:regression packages/expression`
- [ ] `pnpm test:contract packages/core`
- [ ] `pnpm test:integration packages/core`
- [ ] `pnpm test:unit packages/workflow-compiler`
- [ ] `pnpm test:integration packages/workflow-compiler`
- [ ] `pnpm test:contract packages/cli`
- [ ] `pnpm test:e2e packages/cli`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`

Exit criteria:

- [ ] Specs describe the delivered hint/rename/check/lint behavior without
  documenting old behavior as compatibility.
- [ ] The handoff records every verification command that passed or could not be
  run.
