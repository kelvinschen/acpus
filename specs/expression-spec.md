# Expression Spec

## Purpose

`@acpus/expression` owns the Acpus expression language: typed authoring helpers, serializable `ExprIR` and `TemplateIR`, expression validation, and generic expression/template evaluation. Workflow packages consume this language; they do not own expression semantics.

## Requirements

### Public API

- The root `@acpus/expression` entrypoint MUST expose the authoring value surface: `fmap`, `lift2`, `lift3`, `lift`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `not`, `and`, `or`, `template`, and `md`.
- The root `@acpus/expression` entrypoint MUST expose the public authoring types `Expr`, `ExprValue`, `WorkflowData`, and `Resolvable`.
- The root and subpath entrypoints MUST NOT expose the removed `WorkflowValue` compatibility name.
- The root `@acpus/expression` entrypoint MUST NOT export raw construction helpers such as `expr`, `isExpr`, `refExpr`, or `valueToExprIR`.
- The root `@acpus/expression` entrypoint MUST NOT export the removed algebra helpers: `ifElse`, `add`, `subtract`, `multiply`, `divide`, `mod`, `coalesce`, `len`, `includes`, `isEmpty`, `startsWith`, `endsWith`, `matches`, `get`, `head`, `every`, `some`, `filter`, `map`, `transform`, `join`, `max`, `min`, `where`, or `pick`.
- `@acpus/expression/ir` MUST expose serializable IR and JSON types plus advanced construction helpers needed by package internals and tests, including `expr`, `isExpr`, `refExpr`, `tryValueToExprIR`, `valueToExprIR`, and shared expression operator metadata.
- `@acpus/expression/evaluator` MUST expose generic expression and template evaluators.
- `@acpus/expression/validator` MUST expose `validateExprIR`.

### IR And Type Model

- `ExprIR` MUST be JSON-serializable and MUST NOT contain functions, Zod objects, processes, symbols, or runtime-only handles.
- `ExprIR` MUST support `literal`, `ref`, `call`, `array`, `object`, and `template` nodes.
- `ExprIR` MUST NOT support `lambda` or `var` nodes.
- `TypeIR` MUST model expression-level values with `unknown`, `string`, `number`, `boolean`, `null`, `array`, `object`, `record`, and `union`.
- `TypeIR` MUST NOT include `integer`; numeric values MUST use `kind: "number"` and follow JavaScript number semantics.
- `TemplateIR` MUST contain text parts and expression parts only.
- `WorkflowData` MUST be JSON-compatible data: string, finite number, boolean, null, arrays, and plain objects with WorkflowData values.
- `WorkflowData` MUST NOT include `undefined`, functions, promises, dates, maps, sets, class instances, symbols, bigint, sparse arrays, cycles, or non-finite numbers.

### Authoring And Lowering

- `Resolvable<T>` MUST be the sole authoring type for values resolved from workflow scope at run time.
- `Resolvable<T>` MUST accept expression tokens, JSON-compatible literals, arrays, and plain objects recursively. Raw literal `undefined` MUST still fail lowering; expression tokens whose value type includes `undefined` are allowed as projection values.
- Runtime lowering MUST reject unsupported raw values such as `undefined`, sparse arrays, non-plain objects, functions, symbols, bigint, and non-finite numbers.
- `tryValueToExprIR(value)` MUST return a neverthrow `Result<ExprIR, ExprLoweringError>` for recoverable expression lowering failures.
- `ExprLoweringError` MUST be a serializable tagged union with stable path fields.
- `valueToExprIR(value)` MAY remain a throwing adapter over `tryValueToExprIR(value)` for authoring helpers.
- Accessors MUST keep `__ir` and `__type` reserved for expression internals.
- Accessors over refs MUST lower property access to extended `ref` paths.
- Accessors over non-ref expressions MUST lower property access to the internal `access` operator.
- Object field access and array index access are projection surface. Array index projection MUST be typed as possibly `undefined`.
- User object fields named `ir` MUST remain reachable as normal output accessors.
- `fmap(value, fn)` MUST accept `Resolvable` input and lower to a `call` expression with operator id `fmap`, the lowered value as arg 0, and `fn.toString()` as a string literal arg 1.
- `lift2(a, b, fn)` MUST lower to operator id `lift2`, deps as args 0 and 1, and callback source as arg 2.
- `lift3(a, b, c, fn)` MUST lower to operator id `lift3`, deps as args 0 through 2, and callback source as arg 3.
- `lift(deps, fn)` MUST accept a plain named dependency object, lower the dependency object as arg 0, and lower callback source as arg 1.
- `lift(deps, fn)` MUST reject non-plain dependency containers such as arrays and class instances at authoring time.
- `eq(a, b)` and `ne(a, b)` MUST accept only string, number, boolean, or null values and MUST lower through `lift2` callbacks using JavaScript strict equality and inequality.
- `lt(a, b)`, `lte(a, b)`, `gt(a, b)`, and `gte(a, b)` MUST accept only number values and MUST lower through `lift2` callbacks using the corresponding JavaScript numeric comparison.
- `not(value)` MUST lower through `fmap`. `and(...values)` and `or(...values)` MUST require at least two boolean operands and lower through `fmap` over the operand array using eager `every` and `some` evaluation.
- Callback helpers MUST be typed as `ExprValue<R>` where callback return type `R` extends `WorkflowData`.
- Callback helpers MUST accept inline synchronous arrow functions with either expression bodies or block bodies; source-level callback complexity and lexical capture policy belong to the workflow compiler authoring rules.
- Callback helpers MUST NOT create workflow nodes, task attempts, task contexts, artifact access, cwd/env boundaries, timeout policies, retry policies, or async execution boundaries.
- `template` MUST accept `Resolvable` interpolations and lower tagged template strings to an `ExprIR.kind: "template"` node containing internal `TemplateIR` while preserving authored whitespace exactly.
- `md` MUST lower tagged template strings to normal `TemplateIR` after removing surrounding blank lines and common indentation from literal text parts. Expression interpolations MUST remain unchanged. Authors SHOULD use `md` for multiline Markdown prompts and messages.

### Operators

- The only supported call operators MUST be `fmap`, `lift2`, `lift3`, `lift`, and internal `access`; predicate helpers MUST lower to those existing operators rather than introduce new call operators.
- `access` MUST project object fields and canonical array indices from evaluated dependency values.
- Missing object fields and out-of-bounds array indices MUST evaluate as `undefined` when used as projections.
- Unknown operators MUST fail validation and evaluation.

### Evaluation And Validation

- The generic evaluator MUST evaluate literals, refs through an adapter, arrays, objects, templates, and supported calls.
- Template rendering MUST render strings directly, scalar non-strings with `String(value)`, and arrays/objects with `JSON.stringify` semantics.
- Template rendering MUST fail on missing, `undefined`, or non-JSON-compatible values.
- `fmap` evaluation MUST evaluate arg 0, load arg 1 as a JavaScript function source, invoke it synchronously, and return only JSON-compatible output.
- `lift2`, `lift3`, and `lift` evaluation MUST evaluate only explicit dependency args, load the callback source, invoke it synchronously, and return only JSON-compatible output.
- Callback dependency input MAY contain `undefined` from missing projections, including nested object fields. Callback output MUST NOT contain `undefined`.
- Callback evaluation MUST fail with `ExpressionEvaluationError` when the callback source is missing, not a string literal, cannot be loaded, does not evaluate to a function, throws, returns a thenable, or returns non-WorkflowData output.
- Callback evaluation MUST pass JSON-compatible cloned dependency values, plus transient projection `undefined`, into callbacks so callback mutation does not mutate the original runtime scope.
- Callback evaluation MAY access normal runtime globals such as `Math`, `JSON`, and `Date`; expression evaluation is not a sandbox boundary.
- The validator MUST reject malformed expression shapes, unknown fields, unknown operators, invalid arity, invalid paths, sparse IR arrays, invalid type metadata, and literal type metadata mismatches.
- The validator MUST reject malformed callback helper calls whose callback source argument is not a string literal expression.
- The validator/evaluator callback-source checks are IR backstops for synchronous arrow source shape and arity. Source-level callback complexity and lexical capture diagnostics belong to the workflow compiler authoring rules.

## Verification

- Tests MUST cover root and subpath public exports.
- Tests MUST cover authoring type inference and type-level rejection for callback helpers, predicate helpers, and accessors.
- Tests MUST cover lowering for values, templates, `fmap`, `lift2`, `lift3`, `lift`, predicate helpers, and `access`.
- Tests MUST cover evaluator semantics for templates, refs, expression-body and block-body `fmap`/`lift2`/`lift3`/`lift` callbacks, predicate helpers, `access`, runtime globals, thenable rejection, non-WorkflowData rejection, and dependency clone behavior.
- Tests MUST cover validator diagnostic codes and paths for malformed expression IR.
