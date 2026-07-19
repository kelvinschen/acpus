# Expression Spec

## Purpose

`@acpus/expression` owns the Acpus expression language: typed authoring helpers, serializable `ExprIR` and `TemplateIR`, expression validation, and generic expression/template evaluation. The [Core](core-spec.md) and [Workflow Compiler](workflow-compiler-spec.md) consume this language; they do not own expression semantics.

## Requirements

### Public API

- The root `@acpus/expression` entrypoint authoring value surface MUST be `lift`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `not`, `and`, `or`, `template`, and `md`.
- The root `@acpus/expression` entrypoint public authoring types MUST be `Expr`, `ExprValue`, `WorkflowData`, and `Resolvable`.
- The root `@acpus/expression` entrypoint MUST NOT export raw construction helpers such as `expr`, `isExpr`, `refExpr`, or `valueToExprIR`.
- `@acpus/expression/ir` MUST expose serializable IR and JSON types plus advanced construction helpers needed by package internals and tests, including `expr`, `isExpr`, `refExpr`, `tryValueToExprIR`, `valueToExprIR`, `staticExprShape`, and shared expression operator and arity-aware callback-layout metadata.
- `@acpus/expression/evaluator` MUST expose generic expression and template evaluators.
- `@acpus/expression/validator` MUST expose `validateExprIR`.

### IR And Type Model

- `ExprIR` MUST be JSON-serializable and MUST NOT contain functions, Zod objects, processes, symbols, or runtime-only handles.
- `ExprIR` MUST support `literal`, `ref`, `call`, `array`, `object`, and `template` nodes.
- `ExprIR` MUST NOT support `lambda` or `var` nodes.
- `StaticExprShape` MUST be `{ kind: "object"; possibleKeys: string[] } | { kind: "array" } | { kind: "scalar" } | { kind: "dynamic" }`.
- `staticExprShape(expr)` MUST classify object and array syntax directly, classify literal and template syntax as scalar, and classify ref and call syntax as dynamic. Object `possibleKeys` MUST be sorted authored keys and MUST NOT claim that a key is required at run time.
- Literal expression nodes MUST contain a `JsonPrimitive`; arrays and objects MUST use structural `array` and `object` nodes.
- `TemplateIR` MUST use the canonical `{ kind: "template", parts: TemplatePartIR[] }` shape and MUST contain text parts and expression parts only.
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
- `lift(value, fn)`, `lift(a, b, fn)`, and `lift(a, b, c, fn)` MUST accept one, two, or three `Resolvable` dependencies respectively and MUST infer each callback parameter from its corresponding resolved dependency.
- A resolved dependency type MUST unwrap an `Expr<T>` to `T` and MUST recursively resolve array, tuple, and plain-object members. This type transform MUST remain internal to the package.
- A named dependency object MUST be treated as one structured dependency. Arrays and tuples MUST likewise be accepted as one structured dependency.
- More than three positional dependencies MUST be rejected by the public type contract; authors MUST use a named object for larger dependency sets.
- Every `lift` overload MUST lower to operator id `lift`, explicit dependencies as leading args in authored order, and `fn.toString()` as the final string-literal arg. Canonical `lift` call arity MUST therefore be 2, 3, or 4.
- `eq(a, b)` and `ne(a, b)` MUST accept only string, number, boolean, or null values and MUST lower through `lift` callbacks using JavaScript strict equality and inequality.
- `lt(a, b)`, `lte(a, b)`, `gt(a, b)`, and `gte(a, b)` MUST accept only number values and MUST lower through `lift` callbacks using the corresponding JavaScript numeric comparison.
- `not(value)` MUST lower through unary `lift`. `and(...values)` and `or(...values)` MUST require at least two boolean operands and lower through unary `lift` over the operand array using eager `every` and `some` evaluation.
- Callback helpers MUST be typed as `ExprValue<R>` where callback return type `R` extends `WorkflowData`.
- Callback helpers MUST accept inline synchronous arrow functions with either expression bodies or block bodies; source-level callback complexity and lexical capture policy belong to the workflow compiler authoring rules.
- Callback helpers MUST NOT create workflow nodes, task attempts, task contexts, artifact access, cwd/env boundaries, timeout policies, retry policies, or async execution boundaries.
- `template` MUST accept `Resolvable` interpolations and lower tagged template strings to a flat `ExprIR.kind: "template"` node with `parts` while preserving authored whitespace exactly.
- `md` MUST lower tagged template strings to normal `TemplateIR` after removing surrounding blank lines and common indentation from literal text parts. Expression interpolations MUST remain unchanged.
- Authors SHOULD use `md` for multiline Markdown prompts and messages; they MAY use `template` instead when exact authored whitespace is required.

### Operators

- The only supported call operators MUST be `lift` and internal `access`; predicate helpers MUST lower to those existing operators rather than introduce new call operators.
- Shared operator metadata MUST declare `lift` arity as 2, 3, or 4 and MUST provide an arity-aware callback layout whose callback-source index and callback parameter count equal `argCount - 1` and whose dependency indexes cover every preceding arg.
- `access` MUST project object fields and canonical array indices from evaluated dependency values.
- Missing object fields and out-of-bounds array indices MUST evaluate as `undefined` when used as projections.
- Object expression evaluation MUST omit a field whose expression resolves as missing. Top-level missing expressions MUST evaluate as `undefined`, while array expression elements MUST reject missing values.
- Unknown operators MUST fail validation and evaluation.

### Evaluation And Validation

- The generic evaluator MUST evaluate literals, refs through an adapter, arrays, objects, templates, and supported calls.
- Template rendering MUST render strings directly, scalar non-strings with `String(value)`, and arrays/objects with `JSON.stringify` semantics.
- Template rendering MUST fail on missing, `undefined`, or non-JSON-compatible values.
- `lift` evaluation MUST evaluate only its one to three explicit dependency args, load the trailing callback source, invoke it synchronously with the dependencies as positional arguments, and return only JSON-compatible output.
- Callback dependency input MAY contain `undefined` from missing projections, including nested object fields. Callback output MUST NOT contain `undefined`.
- Callback evaluation MUST fail with `ExpressionEvaluationError` when the callback source is missing, not a string literal, cannot be loaded, does not evaluate to a function, throws, returns a thenable, or returns non-WorkflowData output.
- Callback load and execution diagnostics MUST safely render thrown non-`Error` values.
- Callback evaluation MUST pass JSON-compatible cloned dependency values, plus transient projection `undefined`, into callbacks so callback mutation does not mutate the original runtime scope.
- Callback evaluation MAY access normal runtime globals such as `Math`, `JSON`, and `Date`; expression evaluation is not a sandbox boundary.
- The validator MUST reject malformed expression shapes, unknown fields, unknown operators, invalid arity, invalid paths, sparse IR arrays, and non-primitive literal values.
- The validator MUST reject malformed callback helper calls whose callback source argument is not a string literal expression.
- Validator/evaluator callback-source checks MUST remain IR backstops for synchronous arrow source shape and arity; source-level callback complexity and lexical capture diagnostics belong to the [Workflow Compiler](workflow-compiler-spec.md).

## Verification

- Contract and type tests cover public exports, `lift` inference/rejection, structured dependencies, predicates, templates, and accessors.
- Lowering, evaluator, and validator tests cover every IR kind and operator, callback arity/source rules, projection absence, clone isolation, and malformed input diagnostics.
