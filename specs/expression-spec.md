# Expression Spec

## Purpose

`@acpus/expression` owns the Acpus expression language: typed authoring helpers, serializable `ExprIR` and `TemplateIR`, expression validation, and generic expression/template evaluation. Workflow packages consume this language; they do not own expression semantics.

## Requirements

### Public API

- The root `@acpus/expression` entrypoint MUST expose the authoring surface: `isExpr`, `not`, `and`, `or`, `ifElse`, `eq`, `ne`, `add`, `subtract`, `multiply`, `divide`, `mod`, `lt`, `lte`, `gt`, `gte`, `coalesce`, `len`, `includes`, `isEmpty`, `startsWith`, `endsWith`, `matches`, `get`, `head`, `every`, `some`, `filter`, `map`, `transform`, `join`, `max`, `min`, `where`, `pick`, `template`, `md`, and the public `Expr`, `OutputAccessor`, and `WorkflowValue` types.
- The root `@acpus/expression` entrypoint MUST NOT export raw construction helpers such as `expr`, `refExpr`, or `valueToExprIR`.
- `@acpus/expression/ir` MUST expose serializable IR and JSON types plus advanced construction helpers needed by package internals and tests, including `tryValueToExprIR`.
- `@acpus/expression/evaluator` MUST expose generic expression and template evaluators.
- `@acpus/expression/validator` MUST expose `validateExprIR`.

### IR And Type Model

- `ExprIR` MUST be JSON-serializable and MUST NOT contain functions, Zod objects, processes, symbols, or runtime-only handles.
- `ExprIR` MUST support `literal`, `ref`, `var`, `call`, `array`, `object`, `template`, and `lambda` nodes.
- `TypeIR` MUST model expression-level values with `unknown`, `string`, `number`, `boolean`, `null`, `array`, `object`, `record`, and `union`.
- `TypeIR` MUST NOT include `integer`; numeric values MUST use `kind: "number"` and follow JavaScript number semantics.
- `TemplateIR` MUST contain text parts and expression parts only.
- Lambda bindings MUST be first-class IR nodes and MUST be valid only where an operator explicitly accepts a callback.
- Lambda nodes MUST contain params and body only; they MUST NOT carry a dedicated return type field.

### Authoring And Lowering

- `WorkflowValue<T>` MUST accept expression tokens, JSON-compatible literals, arrays, and plain objects, and MUST reject `undefined` at the type boundary when TypeScript can prove it.
- Runtime lowering MUST reject unsupported raw values such as `undefined`, sparse arrays, non-plain objects, functions, symbols, and bigint.
- `tryValueToExprIR(value)` MUST return a neverthrow `Result<ExprIR, ExprLoweringError>` for recoverable expression lowering failures.
- `ExprLoweringError` MUST be a serializable tagged union with stable path fields.
- Expression lowering MUST reject non-finite numbers because `ExprIR` literals MUST be JSON-serializable.
- `valueToExprIR(value)` MAY remain a throwing compatibility adapter over `tryValueToExprIR(value)` for existing authoring helpers.
- Accessors MUST keep `__ir` and `__type` reserved for expression internals and MUST lower property access to `ref`, `var`, or `get` IR according to the source node.
- User object fields named `ir` MUST remain reachable as normal output accessors.
- `get(array, index)` MUST support numeric array access and return an accessor typed as possibly `undefined`.
- `head(array)` MUST lower to `get(array, 0)`.
- `pick(source, keys)` MUST project object accessor fields and MUST NOT create a distinct IR shape.
- `pick(source, keys)` MUST reject reserved expression token keys at the type boundary when possible and at runtime as a fallback.
- `template` MUST lower tagged template strings to an expression node containing `TemplateIR` while preserving authored whitespace exactly.
- `md` MUST lower tagged template strings to normal `TemplateIR` after removing surrounding blank lines and common indentation from literal text parts. Expression interpolations MUST remain unchanged. Authors SHOULD use `md` for multiline Markdown prompts and messages.
- `transform(value, fn)` MUST lower to a `call` expression with operator id `transform`, the lowered workflow value as arg 0, and `fn.toString()` as a string literal arg 1.
- `transform(value, fn)` MUST be typed as `OutputAccessor<U>` for callback return type `U` and MUST NOT require input or output schemas.

### Operators And Collections

- Named helpers MUST lower to `call` IR with stable function names.
- Logical helpers MUST include `not`, `and`, and `or`.
- Conditional expressions MUST use `ifElse`.
- Comparison helpers MUST include `eq`, `ne`, `lt`, `lte`, `gt`, and `gte`.
- Arithmetic helpers MUST include `add`, `subtract`, `multiply`, `divide`, and `mod`; they MUST require numeric operands and follow JavaScript number arithmetic.
- String helpers MUST include `includes`, `startsWith`, `endsWith`, and `matches`.
- Array/string length helpers MUST include `len` and `isEmpty`.
- Nullish fallback MUST be represented by `coalesce`; `coalesce` MUST accept at least one operand.
- `every` and `some` MUST support both boolean arrays and runtime array lambda predicates.
- `filter` and `map` MUST require runtime array lambda callbacks.
- `transform` MUST accept exactly one workflow value and one callback source string. The callback source string MUST NOT be represented as lambda IR.
- `transform` MUST be a non-node expression helper; it MUST NOT create a workflow node, task attempt, task context, artifact access, cwd/env boundary, timeout, retry policy, or async execution boundary.
- `join` MUST accept a string array expression and separator and return the joined string. Authors SHOULD use `join(map(...), "\n")` for Markdown lists instead of relying on template array interpolation.
- `max` and `min` MUST accept one numeric array expression and MUST follow `Math.max(...values)` and `Math.min(...values)` semantics for JSON-serializable numeric inputs, including empty arrays.

### Where Filters

- `where(target, filter)` MUST be typed sugar that lowers to primitive expression calls.
- Field shorthand values MUST lower to equality checks.
- Object filters MUST be field-wise.
- Primitive/string/number/array operator objects MUST use named operators such as `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains`, `startsWith`, `endsWith`, `matches`, and `length`.
- Nullable target and field equality MUST support `null` equality filters when the TypeScript value type includes `null`.
- Array operator objects MUST support `eq` and `ne` equality in addition to collection operators such as `contains` and `length`.
- Object field-wise `where` sugar MUST reserve expression token keys `__ir` and `__type` plus operator keys; authors MUST use direct helpers such as `eq(object.eq, value)` for fields whose names collide with operator keys.
- Empty `where` filters MUST throw at authoring time.

### Evaluation And Validation

- The generic evaluator MUST evaluate literals, refs through an adapter, vars through lambda scope, arrays, objects, templates, and supported calls.
- The evaluator MUST preserve lambda scope inside nested expressions and templates.
- Template rendering MUST render strings directly, scalar non-strings with `String(value)`, and arrays/objects with `JSON.stringify` semantics.
- Template rendering MUST fail on missing, `undefined`, or non-JSON-compatible values.
- Equality MUST use structural JSON-compatible comparison with SameValueZero primitive behavior.
- `includes` MUST follow JavaScript string and array inclusion semantics.
- Invalid `matches` patterns MUST fail with `ExpressionEvaluationError`.
- `transform` evaluation MUST evaluate arg 0 normally, load arg 1 as a single-argument JavaScript function source, invoke it synchronously, and return only JSON-compatible output.
- `transform` evaluation MUST fail with `ExpressionEvaluationError` when the source is missing, not a string literal, cannot be loaded, does not evaluate to a function, throws, returns a thenable, returns a missing value, or returns non-JSON-compatible data such as functions, class instances, `Date`, `Map`, `Set`, `symbol`, `bigint`, non-finite numbers, sparse arrays, cycles, or `undefined` object fields.
- The validator MUST reject malformed expression shapes, unknown fields, unknown operators, invalid arity, lambdas outside allowed operator positions, unbound variables, invalid paths, sparse IR arrays, invalid type metadata, duplicate lambda params, and literal type metadata mismatches.
- The validator MUST reject malformed `transform` calls whose second argument is not a string literal expression.

## Verification

- Tests MUST cover root and subpath public exports.
- Tests MUST cover authoring type inference and type-level rejection for helpers, accessors, arithmetic, `transform`, `join`, `where`, `get`, and `pick`.
- Tests MUST cover lowering for values, operators, templates, lambdas, `where`, collection helpers, and `transform` source strings.
- Tests MUST cover evaluator semantics for templates, structural equality, nullish coalescing, arithmetic, `join`, collection lambdas, `transform`, static array paths, and `Math.max` / `Math.min` behavior.
- Tests MUST cover validator diagnostic codes and paths for malformed expression IR.
