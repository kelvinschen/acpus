# Expression Language Implementation Goal

This document turns the expression language design notes into an executable
goal checklist. It is a roadmap execution aid, not current product truth. Current
implemented behavior lives in `specs/`.

Completion review: all gates in this document have been implemented and verified.
No open gap remains in the checklist. The final verification included package
typechecks, `pnpm test`, `pnpm build`, CLI e2e tests, and grep gates for removed
expression entrypoints.

Source decision log: [Expression Language Design Notes](expression-language-design.md).

## Goal

Introduce `@acpus/expression` as the owner of Acpus' typed JSON-value expression
language, replace the current `@acpus/core/expression` surface, and integrate the
new expression package with core workflow authoring and runtime evaluation in one
clean migration.

The final merged state has one expression authoring package, no compatibility
shim for the old core subpath, no old expression behavior, and passing
expression/core/runtime checks.

## Completion Gates

- [x] `@acpus/expression` exists as a workspace package with root, `/ir`,
  `/validator`, and `/evaluator` exports.
- [x] `@acpus/core/expression` is removed from package exports and from current
  non-legacy imports.
- [x] `@acpus/core` root no longer exports `template` or expression helpers.
- [x] Expression types (`ExprIR`, `TypeIR`, `TemplateIR`, `JsonValue`) are owned
  by `@acpus/expression/ir`.
- [x] Core workflow/node IR imports expression IR/value types instead of defining
  them.
- [x] Runtime evaluates expressions through the generic expression evaluator and
  a workflow scope adapter.
- [x] `specs/expression-spec.md` replaces `specs/core-expression-spec.md`, with
  core/runtime specs reduced to package-boundary references.
- [x] Public API contract tests prove the new expression exports and removed core
  exports.
- [x] Expression, core, and runtime typecheck/test commands pass, or any
  unavailable command is explicitly recorded in the handoff.

## Non-Negotiable Constraints

- [x] Keep the final state clean: no compatibility shims, deprecation paths,
  migration diagnostics, or legacy-behavior rejection tests.
- [x] Complete the package split and behavior replacement as one coherent goal;
  avoid a final half-migrated dual-entrypoint state.
- [x] Build the expression package test-first at the seam: contract/type/unit
  test skeletons come before core/runtime migration.
- [x] Keep `@acpus/expression` independent from `@acpus/core` and
  `@acpus/runtime`.
- [x] Keep the root authoring surface semantic and small; put only needed
  advanced helpers on focused subpaths.
- [x] Preserve typed workflow authoring as the primary validation path; runtime
  and validator checks are backstops.

## Phase 0: Preflight

- [x] Read `docs/roadmap/archive/expression-language-design.md`.
- [x] Check current worktree status and avoid touching unrelated user changes.
- [x] Inventory current expression imports:
  `@acpus/core/expression`, expression types from `@acpus/core/ir`, and core root
  `template`.
- [x] Inventory current expression tests across core and runtime.
- [x] Confirm package scripts and test command names before adding new
  verification entries.

Exit criteria:

- [x] Current expression usage sites are known.
- [x] Existing unrelated worktree changes are identified and left alone.

## Phase 1: Package Seam And Test Skeletons

- [x] Create `packages/expression`.
- [x] Add package metadata, tsconfig, build/typecheck scripts, and export map.
- [x] Add root authoring export skeleton.
- [x] Add `/ir`, `/validator`, and `/evaluator` subpath skeletons.
- [x] Add public API contract tests for expression root and subpaths.
- [x] Add type test skeletons for core authoring cases:
  `map`, `filter`, `every`, `some`, `get`, `head`, `where`, `ifElse`,
  `coalesce`, and unknown rejection.
- [x] Add unit test skeletons for lowering, evaluator semantics, template
  formatting, and structural equality.
- [x] Add validator contract test skeletons for diagnostics and `EX###` codes.

Exit criteria:

- [x] New package compiles far enough for empty or placeholder tests to run.
- [x] Public API contract tests encode the intended export boundary before the
  implementation fills it in.

## Phase 2: IR, Value Model, And Accessors

- [x] Move/define `JsonValue`, `JsonObject`, and `JsonArray` in
  `@acpus/expression/ir`.
- [x] Define `TypeIR` with `string`, `number`, `boolean`, `null`, `unknown`,
  `array`, `object`, `record`, and `union`.
- [x] Remove the old `integer` type kind from the expression value model.
- [x] Define `ExprIR` value nodes: `literal`, `ref`, `var`, `call`, `array`,
  `object`, and `template`.
- [x] Define structural `lambda` IR with positional params and a body expression.
- [x] Implement `Expr<T>`, `WorkflowValue<T>`, and expression accessor types.
- [x] Implement advanced `expr`, `valueToExprIR`, and `refExpr` exports.
- [x] Keep literal, raw call, operator registry, and `varExpr` constructors
  internal unless tests/tooling genuinely need them.
- [x] Implement accessor lowering:
  static `ref`/`var` access flattens into paths; computed/static and dynamic
  access lowers to `get`.
- [x] Implement `pick` as static accessor projection sugar.

Exit criteria:

- [x] Type tests prove accessors work for refs, computed expressions, records,
  arrays, optional fields, and lambda vars.
- [x] Unit tests prove deterministic lowering for refs, vars, object projections,
  and generated lambda binding ids.

## Phase 3: Operators And Authoring Helpers

- [x] Implement the closed internal operator registry.
- [x] Implement root authoring helpers:
  `not`, `and`, `or`, `ifElse`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`,
  `coalesce`, `len`, `includes`, `isEmpty`, `startsWith`, `endsWith`,
  `matches`, `get`, `head`, `every`, `some`, `filter`, `map`, `max`, `min`,
  `where`, `pick`, and `template`.
- [x] Remove `nth`.
- [x] Remove `exprOps`.
- [x] Keep `head(array)` as sugar for `get(array, 0)`.
- [x] Keep `isEmpty(value)` as sugar for `eq(len(value), 0)`.
- [x] Keep `coalesce(value, defaultValue)` as the two-argument nullish fallback form.
- [x] Remove `fallback`.
- [x] Remove selector overloads for `max` and `min`; projection is expressed
  with `map`.
- [x] Keep future helpers out of v1: arithmetic, `sum`, `avg`, `count`, `find`,
  `firstWhere`, `countWhere`, `reduce`, `flatMap`, `sortBy`, `groupBy`,
  `distinct`, and string transforms.

Exit criteria:

- [x] Type tests prove helper inference and expected rejections.
- [x] Unit tests prove every public helper lowers to canonical operators.
- [x] No public raw call or fluent/prototype method surface exists.

## Phase 4: Evaluator

- [x] Implement generic `evaluateExpr(expr, adapter)`.
- [x] Implement generic `renderTemplate`.
- [x] Use an adapter with `resolveRef(path)`.
- [x] Keep lambda variable bindings inside evaluator state.
- [x] Implement private missing sentinel normalization.
- [x] Implement `ExpressionEvaluationError`.
- [x] Implement structural equality with SameValueZero primitives.
- [x] Implement safe path/get behavior and unsupported root delegation to host
  adapter.
- [x] Implement JS-style collection iteration for `map`, `filter`, `every`, and
  `some`, with strict expression callback result checks.
- [x] Implement `max` and `min` with numeric item checks and `Math.max/min`
  numeric result semantics.
- [x] Implement template formatting:
  string direct, number/boolean/null via `String`, arrays/objects via
  `JSON.stringify`, missing/undefined error.

Exit criteria:

- [x] Evaluator unit tests cover short-circuiting, empty arrays, JS collection
  iteration shape, `ifElse` branch evaluation, missing sentinel behavior,
  structural equality, `includes`, `max/min`, and template formatting.
- [x] Evaluator tests do not depend on workflow runtime roots.

## Phase 5: Validator

- [x] Implement `validateExprIR(expr)` returning diagnostics.
- [x] Use `EX###` diagnostic code namespace.
- [x] Validate known expression kinds and malformed shapes.
- [x] Validate closed operator ids and arity.
- [x] Validate lambda positions according to operator registry.
- [x] Validate lambda scope stack and bound `var` references.
- [x] Validate `ref` path structure only, not host root policy.
- [x] Validate obvious type metadata conflicts where metadata exists.
- [x] Avoid complete TypeScript inference, union narrowing, schema reflection, or
  hand-authored IR ergonomics.

Exit criteria:

- [x] Validator contract tests cover diagnostics codes, paths, lambda placement,
  unbound vars, unknown operators, and malformed metadata.
- [x] Validator returns diagnostics rather than throwing for malformed IR.

## Phase 6: `where` V2

- [x] Refit `where` as small predicate sugar over canonical helpers.
- [x] Keep leaf operators:
  `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains`, `startsWith`,
  `endsWith`, `matches`, and `length`.
- [x] Support object target as field-wise predicate only.
- [x] Support primitive target shorthand as equality sugar.
- [x] Support `length` for string and array targets.
- [x] Support `contains` for string and array targets.
- [x] Reject empty filters.
- [x] Remove Mongo aliases:
  `$eq`, `$ne`, `$lt`, `$lte`, `$gt`, `$gte`, `$in`, `$nin`, `$regex`,
  `$and`, `$or`, and `$not`.
- [x] Remove `AND`, `OR`, and `NOT` logical object keys.
- [x] Remove `in`, `notIn`, and `isEmpty` from `where`.
- [x] Avoid nested collection query forms such as `some`, `every`, and `none`.

Exit criteria:

- [x] Type tests prove typed unknown keys are rejected.
- [x] Unit tests prove kept sugar lowers to canonical helpers.
- [x] Tests describe only new behavior and do not add legacy rejection cases.

## Phase 7: Core Integration

- [x] Add `@acpus/expression` dependency to `@acpus/core`.
- [x] Update core schema bridge to emit expression `TypeIR`.
- [x] Update WorkflowIR/node IR to import expression `ExprIR`, `TemplateIR`,
  `TypeIR`, and JSON value types.
- [x] Update workflow builder, node builders, graph refs, scope outputs, and
  lowering utilities to consume expression accessors and `valueToExprIR`.
- [x] Keep `NodeRef` in core, with expression accessor output.
- [x] Remove core `./expression` package export.
- [x] Remove core root `template` export.
- [x] Update core public API contract tests.
- [x] Update core type/unit/integration tests and fixtures to import expression
  helpers from `@acpus/expression`.

Exit criteria:

- [x] `@acpus/core` typecheck passes.
- [x] Core tests prove workflow authoring still accepts expression values from
  `@acpus/expression`.
- [x] Core root exports remain focused on workflow/schema/task authoring only.

## Phase 8: Runtime Integration

- [x] Add `@acpus/expression` dependency to `@acpus/runtime`.
- [x] Replace runtime evaluator internals with expression evaluator usage.
- [x] Implement workflow `resolveRef(path)` adapter for runtime roots:
  `input`, `nodes`, `meta`, `fanout`, and `loop`.
- [x] Preserve runtime ownership of workflow-specific root policy.
- [x] Preserve runtime workflow root policy in the adapter and let expression
  errors surface through existing scheduler/task context.
- [x] Update runtime tests to focus on adapter behavior and workflow integration,
  not the full expression operator matrix.

Exit criteria:

- [x] Runtime evaluator adapter tests pass.
- [x] Runtime scheduler/store integration paths evaluate conditions, outputs,
  templates, task inputs, cwd, and env through the new expression evaluator.

## Phase 9: Specs And Docs

- [x] Add `specs/expression-spec.md` for `@acpus/expression`.
- [x] Remove `specs/core-expression-spec.md`.
- [x] Update `specs/INDEX.md` with expression owner and verification commands.
- [x] Update `specs/core-spec.md` to reference expression package boundaries
  without duplicating expression semantics.
- [x] Update `specs/runtime-spec.md` to describe workflow adapter/evaluation
  timing without duplicating operator semantics.
- [x] Update package READMEs and workflow fixtures to use `@acpus/expression`.
- [x] Keep rationale in roadmap docs; specs contain concise current behavior.

Exit criteria:

- [x] Specs and tests describe only the new current behavior.
- [x] No current docs teach `@acpus/core/expression` or core root `template`.

## Phase 10: Final Verification

Run the narrow package checks first, then broader checks.

- [x] `pnpm --filter @acpus/expression typecheck`
- [x] `pnpm --filter @acpus/core typecheck`
- [x] `pnpm --filter @acpus/runtime typecheck`
- [x] `pnpm --filter @acpus/workflow-compiler typecheck`
- [x] `pnpm --filter acpus typecheck`
- [x] `pnpm test:type -- packages/expression`
- [x] `pnpm test:unit -- packages/expression`
- [x] `pnpm test:contract -- packages/expression`
- [x] `pnpm test:type -- packages/core`
- [x] `pnpm test:unit -- packages/core`
- [x] `pnpm test:contract -- packages/core`
- [x] `pnpm test:unit -- packages/runtime`
- [x] `pnpm test:integration -- packages/runtime`
- [x] `pnpm test:integration -- packages/workflow-compiler`
- [x] `pnpm test:e2e -- packages/cli`
- [x] Broader repository checks where practical: `pnpm test`, relevant builds,
  and any package-specific commands discovered during implementation.

Final checklist:

- [x] No final public compatibility shim exists for `@acpus/core/expression`.
- [x] No final core root expression helper or `template` export remains.
- [x] No tests exist solely to document or reject removed legacy behavior.
- [x] Current non-legacy imports use `@acpus/expression` for expression helpers
  and `@acpus/expression/ir` for expression IR/value types.
- [x] Any command that could not be run is recorded with the reason.

## Post-Review Remediation

Adversarial review found several implementation gaps after the initial pass.
These remediation items are part of the same expression-language goal and are
now complete.

- [x] Remove lambda `returnType` from `ExprIR`.
- [x] Harden `validateExprIR` with closed node shapes, required `var.path`,
  dense IR arrays, recursive `TypeIR` validation, template kind validation, and
  zero-arg `coalesce` rejection.
- [x] Keep JavaScript number semantics for `NaN`, `Infinity`, and
  `-Infinity`; do not add finite-number safety gates.
- [x] Wrap invalid `matches` regex patterns in `ExpressionEvaluationError`.
- [x] Make core `SchemaIR` a core-owned recursive union rather than recursively
  casting core schemas to expression `TypeIR`.
- [x] Harden workflow schema validation for unknown schema kinds, unknown
  fields, malformed nested schemas, invalid metadata, and hand-authored
  `kind: "integer"`.
- [x] Tighten runtime ref resolution to own object fields and canonical array
  indexes only.
- [x] Add nullable equality and array `eq`/`ne` operator support to `where`.
- [x] Add focused tests for expression validator/evaluator/type coverage, core
  schema validation, runtime resolver negatives, and public helper lowering.
- [x] Confirm current package/spec/fixture imports do not use
  `@acpus/core/expression`.
