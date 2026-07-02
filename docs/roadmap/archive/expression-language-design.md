# Expression Language Design Notes

This document records the design direction behind rebuilding `@acpus/core/expression`
into `@acpus/expression`. It is not current product truth; current implemented
behavior lives in `specs/expression-spec.md`.

## Design Goal

The planned `Expr` system is a pure, synchronous, deterministic, serializable
JSON-value expression language for workflow data calculation.

It can read workflow scope values, compose predicates, project values, and derive
runtime JSON values. It cannot create workflow nodes, perform IO, run async work,
or influence graph topology. Node execution, concurrency, retry, artifacts, logs,
and scheduling remain owned by workflow nodes such as task, agent, fanout, and
loop.

The expression language borrows from lambda calculus and functional programming:
values, references, lexical bindings, composition, and pure evaluation. It does
not become a general-purpose functional language: no first-class runtime
functions, user-defined reusable expression functions, generic apply, recursion,
type classes, or unrestricted higher-order programming.

The rebuild is treated as greenfield current behavior for the unpublished
TypeScript-first core. The implementation plan keeps the final state clean: no
compatibility shims, deprecation paths, migration diagnostics, or tests whose
only purpose is to document or reject removed legacy expression behavior.
When implementation lands, it replaces the current
`specs/core-expression-spec.md` with `specs/expression-spec.md` owned by
`@acpus/expression`. Core and runtime specs reference expression package
boundaries without duplicating the full expression operator language.
The roadmap remains a decision log. The implementation-time spec update
distills it into concise RFC 2119 requirements rather than copying rationale
wholesale into specs:
expression semantics belong in `expression-spec.md`, core only records workflow
authoring/storage boundaries, and runtime records workflow adapter/evaluation
timing.
The package split and behavior replacement complete as one coherent goal.
Implementation can use multiple internal steps or commits, but the final merged
state contains no half-migrated dual-entrypoint period.
All expression imports migrate in that same goal: public authoring imports move
from `@acpus/core/expression` to `@acpus/expression`, expression IR/value types
move from `@acpus/core/ir` to `@acpus/expression/ir`, core removes its
`./expression` export, and core root removes `template`.

The expression language moves into a dedicated `@acpus/expression` package as
part of the rebuild, rather than first being rebuilt inside `@acpus/core` and
split later. The new package owns the expression language directly; it is not a
mechanical relocation of the current half-finished helpers.

`@acpus/expression` owns the JSON value type model: `TypeIR`, `ExprIR`,
`Expr<T>`, `WorkflowValue<T>`, `TemplateIR`, and pure template construction and
rendering semantics. `@acpus/core` owns workflow and node IR, and its schema
bridge reuses expression `TypeIR` instead of defining a separate value type
model. `JsonValue`, `JsonObject`, and `JsonArray` also belong to expression's
value model and are exported from `@acpus/expression/ir`. `@acpus/expression`
does not import `@acpus/core`.
The Zod/schema bridge remains in `@acpus/core`; this rebuild does not create a
separate schema package. Core schema lowering emits schema IR backed by
expression `TypeIR`.
`@acpus/expression` also owns typed expression accessors and accessor factories
for refs and lambda vars. Workflow `NodeRef` remains in core, but node outputs use
the expression accessor type. Accessor helpers such as `pick` belong with
expression because they operate only on expression accessors. This is a
greenfield package boundary, so old `@acpus/core/expression` names do not need
compatibility shims.

The package has one authoring root and focused low-level subpaths:

- `@acpus/expression` exports public authoring helpers, `Expr`, `WorkflowValue`,
  accessor types, and `template`.
- `@acpus/expression/ir` exports `ExprIR`, `TypeIR`, `TemplateIR`, and value-model
  types, plus limited advanced helpers such as `expr`, `valueToExprIR`, and
  `refExpr`. It does not export literal or raw call constructors.
- `@acpus/expression/validator` exports expression validation.
- `@acpus/expression/evaluator` exports the generic pure evaluator and template
  renderer.
Template interpolation formats runtime values as follows: strings render
directly; numbers, booleans, and null use `String(value)`; arrays and plain
objects use `JSON.stringify(value)`; internal missing values and raw JavaScript
`undefined` fail loudly. Custom formatting hooks are out of the first pass.
Template interpolation accepts expression/JSON workflow values only. Secret refs
are not part of `@acpus/expression` and are not interpolated through templates;
secret-aware runtime fields keep their own explicit handling.
The `template` tagged helper returns `Expr<string>` and lowers to an
`ExprIR` template node. `TemplateIR` remains the nested parts structure inside
that expression node rather than a separate authoring value system.
The generic evaluator accepts a scope adapter such as `resolveRef(path)`.
Workflow-specific roots like `input`, `nodes`, `meta`, `fanout`, and `loop`
belong to `@acpus/runtime`'s adapter/wrapper, not to the expression package.
Dependency policy for `@acpus/expression` defaults to zero runtime dependencies,
but it is not a hard ban. Type-only/dev dependencies can be considered when they
materially reduce TypeScript complexity. Runtime dependencies require a clear
benefit, low maintenance cost, and no semantic mismatch with the expression
language. Broad utility libraries such as lodash are not appropriate for v1
expression semantics.
The first evaluator adapter shape stays minimal: `resolveRef(path)` is required,
and an optional ref description hook can improve diagnostics. Lambda variable
bindings are evaluator-internal state, not part of the host adapter API.
Evaluator failures use a lightweight `ExpressionEvaluationError` class exported
from the evaluator subpath. The first pass uses one evaluator error class with a
stable message and optional operator/path/context fields rather than a detailed
error hierarchy.
Expression validation returns diagnostics rather than throwing. Diagnostics are
data objects with code, severity, message, and serialized IR path; workflow
validators compose them with path prefixes when validating full workflow IR.
Expression diagnostic codes use an `EX###` namespace owned by
`@acpus/expression`. Core/workflow validators preserve those codes when nesting
expression diagnostics rather than reusing the old core `E###` expression codes.

## ExprIR Kernel

- `ExprIR` gains a standard lambda/binding structure rather than hiding callback
  semantics inside each collection helper.
- `lambda` is a serialized `ExprIR` kind even though it is not a runtime value.
  `call.args` remains `ExprIR[]`, and the operator registry declares which
  argument positions accept lambda nodes. Lambda in unsupported value positions
  is invalid, and evaluating a lambda directly is an evaluator error.
- Lambda is structural IR, not a runtime value. Public authoring does not expose
  `Expr<Function>`.
- Lambda appears only in operator argument positions that explicitly consume it.
  There is no generic `apply(lambda, args)` operator.
- Runtime evaluates a lambda only through the consuming operator, such as `map`,
  `filter`, `every`, or `some`.
- Lambda params use stable internal positional binding ids. User parameter names
  from TypeScript source do not affect serialized IR.
- Lambda params carry optional value type metadata. Lambda nodes do not carry a
  dedicated return type field, do not use the normal expression `type` field,
  and `TypeIR` does not grow a function type.
- Binding ids are deterministic and unique within an expression tree. Nested
  lambdas allocate fresh ids from the same expression-local sequence; validator
  still checks that each `var` id is in scope.
- Lowering is deterministic for a given expression tree. Generated ids do not use
  random values or process/global counters that leak across expressions. Object
  projection field order follows authoring object insertion order, while internal
  metadata uses stable ordering where practical.
- Scoped callback lowering uses an internal expression build context that owns
  binding id allocation and active lambda scope. Public helpers hide this context,
  nested scoped helpers reuse it, and no global mutable counter is used.
- Scoped callbacks execute at authoring/build time to produce ExprIR. Build-time
  JavaScript control flow over plain values is allowed, but JavaScript control
  flow over `Expr` values is invalid authoring usage. Runtime conditionals require
  explicit expression operators if added later. Future lint rules can reject
  `Expr` values in JS `if`, ternary, logical, comparison, and arithmetic
  contexts.
- Lambda-bound values use a distinct `var` expression node with a stable binding
  id and nested access path. Workflow/global scope references remain `ref`
  nodes, so evaluators and validators do not confuse workflow scope with lambda
  invocation scope.
- `var.path` may be empty; an empty path refers to the bound lambda value itself.
  Nested var paths use the same safe optional access semantics as refs.
- The expression package validates `ref` structure only, such as a non-empty
  string path. Host-specific root policy belongs to the package embedding the
  expression language; Acpus workflow roots are validated/resolved by core/runtime
  adapters rather than by `@acpus/expression`.
- `ref` remains `{ kind: "ref", path: string[] }`; the first path segment is a
  host-defined root by convention rather than a separate IR field.
- Operator invocation remains a unified `call` expression with a string operator
  id, but the id space is closed by Acpus' expression operator registry. Unknown
  operator ids are invalid, and the registry owns arity, argument categories,
  lambda allowance, type rules, and runtime evaluation behavior. The registry is
  internal in the first pass; public helpers are the supported way to create
  calls.
- Public collection helpers can expose ergonomic `(item, index)` callbacks, while
  the IR lambda shape supports arbitrary arity so future operators such as
  `reduce` can fit without replacing the kernel.
- Lambda body expressions can capture outer workflow refs, outer lambda vars,
  JSON-compatible literals, and expressions created by helpers.
- Lambda capture is not JavaScript closure execution. Captured values lower into
  serializable `ExprIR`; arbitrary JS functions, class instances, promises, dates,
  regex objects, maps, and sets are outside the value model.
- Expression nodes carry type metadata where authoring helpers know it: schema
  refs, lambda params, var refs, calls, arrays, objects, and projections can all
  annotate result type. Type metadata improves IR validation, runtime errors,
  and developer tooling, but TypeScript remains the primary authoring validator.
- Value-producing expression nodes use optional `type?: TypeIR` for result value
  metadata. Lambda nodes do not carry a dedicated return type field because
  lambdas are structural callback IR, not runtime values.
- Type metadata is intentionally smaller than TypeScript. It describes
  JSON-compatible runtime shape and does not encode full TS generics,
  conditional types, or exhaustive union reasoning.
- `TypeIR` models nullable values as unions including `{ kind: "null" }`.
  Optional object fields are represented by object `required` metadata rather
  than an `undefined` type; `TypeIR` has no `undefined` kind.
- The first `TypeIR` shape includes `string`, `number`, `boolean`, `null`,
  `unknown`, `array`, `object`, `record`, and `union`. It removes the old
  `integer` kind to keep the numeric model aligned with TypeScript `number`.
  Record metadata stores only a value type because record keys are implicitly
  strings.
- Union type metadata is lightly canonicalized: nested unions are flattened,
  structurally duplicate variants are removed, and variant order is deterministic.
  The type system does not attempt advanced TypeScript-style union normalization.
- Record type metadata represents JSON objects with arbitrary string keys and a
  single value type. Record keys are implicitly strings; numeric-key records are
  not modeled separately.
- Object type metadata represents known fields with `required` and
  `additionalProperties` metadata. Record type metadata remains a separate kind,
  and dynamic `get(record, key)` is typed only for records; `additionalProperties:
  true` on an object does not make it a typed record in the first pass.
- Union values can exist, but the first expression language pass does not attempt
  TypeScript-style control-flow narrowing from expression predicates such as
  `eq(item.kind, "push")`. Discriminant checks remain ordinary boolean
  expressions, and union-specific field access uses optional/missing semantics
  where the authoring type can express it.

## Value And Type Model

- The stable expression value model follows TypeScript/JSON-compatible
  primitives: `string`, `number`, `boolean`, `null`, arrays, and plain objects.
- Number values use TypeScript's `number` model. The expression language does
  not add a public integer/finite-number primitive, and it does not add guards
  solely to reject `NaN`, `Infinity`, or `-Infinity`; JSON serialization follows
  normal `JSON.stringify` behavior for unusual numeric values.
- `undefined` is not a stable serialized/runtime value. It only exists as an
  authoring type signal or an internal missing-path/optional-access result.
- Evaluator internals represent missing values with a private sentinel rather
  than exposing it as a serialized value. Safe path/get misses return the
  sentinel, adapter `undefined` results are normalized to it, and it never appears
  in public JSON outputs.
- `coalesce` handles `null` and internal missing values.
- `coalesce` is the canonical variadic nullish operator and evaluates left to
  right until the first non-nullish value. `coalesce(value, defaultValue)` is a
  valid two-argument form that narrows nullish out of the first value's type
  while unioning the default type.
- Path access behaves like safe optional access: missing object fields, array
  indexes outside the runtime array, and subfield access through a missing value
  evaluate to an internal missing value rather than throwing immediately.
- Supported-root path misses, access through missing, and access through
  primitives evaluate to the internal missing sentinel. Unsupported host ref
  roots remain adapter errors and are not converted to missing.
- Operators other than nullish helpers reject internal missing values unless
  their type explicitly permits nullish input.
- Boundary outputs validate against JSON-compatible schemas so unresolved
  missing values do not leak into required output fields.
- Literal/projection `undefined` is rejected. Authors use `null` or
  `coalesce(..., null)` when they want a JSON absence value.
- `valueToExprIR` rejects raw `undefined`, including undefined object fields and
  array items, during authoring/lowering. The evaluator's internal missing
  sentinel is never produced by value lowering.
- Sparse array holes are rejected by value lowering; authors use explicit `null`
  when they want null array items.
- `valueToExprIR` rejects unsupported primitives such as `bigint`, `symbol`, and
  `function`, along with non-plain objects.
- Runtime object fields or array items containing raw JavaScript `undefined` are
  unsupported expression values. Structural equality and other value-sensitive
  operations fail loudly rather than treating them as omitted fields or missing
  values.
- Plain object and array literals remain supported as expression literals and
  projections, including nested refs and helper expressions.
- Plain object lowering accepts objects whose prototype is `Object.prototype` or
  `null`; class instances and built-in runtime objects remain unsupported.
- Object expression fields are string-keyed. Own symbol keys cause lowering
  errors rather than being silently ignored.
- Plain object lowering uses own enumerable string fields. Non-enumerable string
  fields are ignored.
- Projection object field names are static authoring-time keys. Dynamic keys and
  conditional field omission are outside the core projection model; nullable
  fields are expressed with `null` or `coalesce(..., null)`.
- Non-plain objects such as `Date`, `RegExp`, `Map`, `Set`, class instances,
  promises, errors, and functions are rejected by expression lowering.
- `Expr<unknown>` can exist as an external JSON value token, but typed operators
  do not operate on it until schema typing or an explicit future narrowing helper
  gives it a concrete JSON-compatible shape.
- Static object fields use TypeScript-style property access, and static array
  indexes use index access. Runtime dynamic field/index access uses a separate
  `get(target, keyOrIndex)` helper rather than an Expr method.
- Dynamic `get` is intended for arrays and typed records. Plain object dynamic
  string access is rejected unless the object is modeled as a record shape.
- Public `get` does not support string indexing; string-specific indexing or
  substring helpers are future string-helper design work.
- `get` is the canonical access operator. `head(array)` remains as the only
  collection access convenience and lowers to `get(array, 0)`. `nth` is removed
  because `get(array, index)` covers that purpose directly.
- `get(array, index)` accepts a number workflow value and returns item type plus
  missing. `get(record, key)` accepts a string workflow value and returns record
  value type plus missing. Dynamic string access on non-record plain objects is
  rejected at the TypeScript layer.
- Array access follows JS-like property lookup for numeric keys. Negative,
  fractional, or out-of-range numeric indexes simply produce the internal missing
  value rather than a special index validation error.
- Accessors can be backed by any expression, not only refs or vars. Static
  property/index access over computed expressions lowers to `get(base, key)`;
  simple ref/var path flattening is only an optional optimization.
- Canonical lowering flattens static access over `ref` into `ref.path` and static
  access over `var` into `var.path`. Static access over any other expression, and
  all dynamic access, lowers to `get`.
- Acpus assumes typed workflow authorship. `any` is an escape hatch that bypasses
  type safety and is not a supported correctness path; a future lint rule can
  enforce this convention.

## Static Checking Strategy

TypeScript is the first validator for workflow authorship. IR validation is the
fallback validator for serialized/malformed shapes. Runtime evaluation is the
last line of defense for dynamic value mismatches.

- Public expression helper signatures stay narrow.
- Operators use strict types and no JavaScript truthiness or coercion.
- Logical operators accept boolean values.
- Numeric comparisons accept numeric values.
- Ordering comparisons `lt`, `lte`, `gt`, and `gte` are numeric-only in the
  first pass. String ordering is not part of v1.
- String operators accept string values.
- Array operators accept arrays with compatible item types.
- `len` accepts only evaluated strings and arrays. Null or internal missing
  values fail loudly, and `isEmpty` inherits the same rule because it lowers to
  `eq(len(value), 0)`.
- Runtime evaluator reports loud, stable errors for dynamic type mismatches.
- Runtime evaluation performs operator-demand type checks rather than deep
  JSON-shape validation of every runtime value. Host-provided unusual JavaScript
  values are handled only when an operator's semantics require inspecting them.
- Runtime expression evaluation assumes workflow IR has already been validated
  at a load/prepare boundary. It does not rerun full structural validation for
  every expression evaluation, though evaluated operands still receive dynamic
  type checks.
- Validator diagnostics include stable serialized IR paths. Runtime expression
  errors include operator context and, for collection lambdas, item index/context
  where available. Source-code locations are future tooling rather than a first
  expression-kernel requirement.
- IR validator checks malformed lambda bindings, unsupported lambda positions,
  unknown operators, invalid arity, and unbound variables where the information
  is present.
- IR validation focuses on structural integrity, closed-operator checks, lambda
  scope validity, and obvious type metadata conflicts. It does not attempt full
  TypeScript-style inference, union narrowing, or complete static proof of every
  runtime value type.
- Equality uses JSON structural equality rather than JavaScript object identity:
  arrays compare by ordered elements, objects compare by own fields without key
  insertion-order significance, and `ne` is the negation of `eq`. This is an
  intentional expression-language semantic because serialized JSON values do not
  preserve JavaScript object identity. Primitive equality uses SameValueZero
  semantics, so `NaN` equals `NaN` and `0` equals `-0`. The equality helper is a
  local JSON-value implementation rather than a broad utility-library deep equal.
  Cyclic values are outside the expression value model; encountering cycles
  during evaluation fails loudly rather than defining cyclic equality.
- Boolean `and` and `or` evaluate left to right with short-circuit semantics.
  Validation still checks every operand's structure and known type metadata.
  Zero-arity `and()` evaluates to true, and zero-arity `or()` evaluates to false,
  following standard logical identity semantics.
- Conditional `ifElse(condition, thenValue, elseValue)` is a pure expression
  value selector. It requires a boolean condition and evaluates only the selected
  branch at runtime; workflow graph branching remains owned by workflow nodes.
  Its result type is the union of the then/else value types, with no automatic
  coercion to a common primitive type.

The design intentionally avoids a wide API that accepts unknown values and relies
on runtime errors to recover type safety.

## Collection Helpers

The first public helper set can stay small, but the ExprIR kernel is not limited
to that helper set.

Initial runtime-array scoped helpers:

```ts
every(input.items, (item, index) => item.done)
some(input.items, item => eq(item.status, "failed"))
filter(input.items, item => item.done)
map(input.items, item => ({ id: item.id, done: item.done }))
```

Runtime `every` and `some` evaluate array items in index order with short-circuit
semantics. Empty arrays follow standard quantifier semantics: `every([])` is true,
and `some([])` is false.
Runtime `map`, `filter`, `every`, and `some` follow JavaScript array method
iteration semantics. Invoked callbacks are checked according to expression
operator rules, but runtime sparse arrays are not separately validated by the
evaluator. `filter` preserves original item order, and `map` follows JS `map`
result-shape behavior.
`every`, `some`, and `filter` callback results are boolean. They do not use
JavaScript truthiness coercion.
`map` callback results can be any JSON-compatible workflow value, including
null, arrays, and plain objects. The result type is inferred as an array of the
callback result value type.
`filter` returns the original item value shape, following JavaScript filter
semantics. Projection is expressed by composing `filter` with `map`.
Collection operators require evaluated array inputs. Null or internal missing
array inputs fail loudly; authors use `coalesce(arrayValue, [])` when they want
nullish arrays to behave as empty arrays.

Existing static array forms remain useful for fixed collections:

```ts
every([a.output.ok, b.output.ok])
some([a.output.failed, b.output.failed])
```

Future operators such as `reduce`, `find`, `sum`, `count`, `groupBy`, `sortBy`,
and `flatMap` are not required in the first helper set, but the lambda IR is
general enough to express them later without changing the kernel.

## Operator Registry

The first canonical operator registry stays small and focused on the expression
kernel:

- Boolean composition: `not`, `and`, `or`
- Conditional value selection: `ifElse`
- Equality and comparison: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`
- Nullish fallback: `coalesce`
- String/collection primitives: `len`, `includes`, `startsWith`, `endsWith`,
  `matches`
- Dynamic access: `get`
- Scoped collection operators: `every`, `some`, `filter`, `map`
- Existing static aggregators: `max`, `min`

Public helpers lower to operators in this closed registry, and `where` remains
only sugar over the same registry. The expression evaluator does not contain
ad hoc behavior outside the registry.

Ergonomic semantic helpers are allowed when they significantly improve authoring
clarity and lower to canonical operators without adding unique runtime
semantics. Examples include `isEmpty(value)` lowering to `eq(len(value), 0)` and
`head` lowering to `get(array, 0)`.
Predicate string helpers stay in the first surface: `includes`, `startsWith`,
`endsWith`, and `matches`. String transform helpers such as `trim`, `lowercase`,
`uppercase`, `replace`, `split`, and substring helpers are future candidates, not
part of the first pass.
`includes` supports string substring checks and array membership checks. String
checks follow JavaScript substring semantics. Array membership uses expression
structural equality with SameValueZero primitive comparison. Null or internal
missing collection operands fail loudly, and search values are not coerced.
`max` and `min` remain one-argument numeric array aggregators over workflow array
values. Projection is expressed separately with `map`, for example
`max(map(items, item => item.score))`; selector overloads are not part of the new
surface.
`max` and `min` require inspected array items to be numbers and do not coerce
strings or booleans. Once values are numbers, results follow `Math.max` and
`Math.min` semantics, including `max([]) === -Infinity`, `min([]) === Infinity`,
and normal `NaN` propagation.

Candidate future helpers/operators are explicitly out of the first
implementation pass:

- Arithmetic: `add`, `sub`, `mul`, `div`, `mod`
- Numeric aggregations: `sum`, `avg`, `count`
- Search/selection: `find`, `firstWhere`, `countWhere`
- Collection transforms: `reduce`, `flatMap`, `sortBy`, `groupBy`, `distinct`
- String transforms: `lowercase`, `uppercase`, `trim`, `replace`
- Advanced path/query helpers such as JSONPath-style access

## Public Authoring Style

The canonical public interface remains named helpers exported from
`@acpus/expression`:

```ts
every(input.items, item => item.done)
map(input.items, item => ({ id: item.id }))
eq(item.status, "done")
```

Namespace imports such as `import * as E from "@acpus/expression"` are a
supported ergonomic style. The old `exprOps` convenience object is removed;
namespace imports cover that use case without duplicating the public surface or
confusing helper exports with the internal operator registry.
`@acpus/core` does not re-export the full expression helper set, and the old
`@acpus/core/expression` subpath is removed rather than shimmed. Workflow docs
teach expression imports from `@acpus/expression` so the package boundary stays
visible.
`template` is not an exception: it is imported from `@acpus/expression`, and the
existing core root `template` export is removed during the rebuild.
Low-level construction helpers such as `expr`, `valueToExprIR`, and `refExpr`
are advanced APIs and do not belong in the root authoring surface. Literal and
raw call constructors remain internal.
Export policy follows one rule: the authoring surface stays minimal and semantic;
non-core helpers are exported from focused advanced subpaths only when core,
runtime, tests, or tooling need them. Internal helpers that are not needed by
those consumers remain unexported.
The root surface does not add `constant`, `value`, `always`, or `never` helpers
in the first pass. Plain JavaScript literals are accepted wherever
`WorkflowValue<T>` is accepted; explicit literal construction remains an advanced
IR/testing concern.

`Expr<T>` stays a thin token and does not grow public methods such as
`expr.map(...)`, `expr.filter(...)`, `expr.get(...)`, or `expr._.default(...)`.
This avoids collisions with user fields and keeps multi-input operators natural.
`pick(source, constKeys)` remains as static object accessor projection sugar. It
accepts authoring-time literal keys and returns a plain object of expression
accessors/projections; dynamic runtime key picking is out of scope.

The token remains a branded holder of expression IR and phantom type metadata.
Public behavior lives in helpers and workflow builders; internal factories create
ref, var, and scoped accessors.

`Expr<T>.ir` remains readable for tests, inspection, contracts, and tooling.
Authors are expected to produce IR through TypeScript workflow authoring helpers,
not by mutating IR objects by hand. Helpers construct new IR rather than mutating
existing expressions; validator remains the backstop for malformed or manually
edited IR.
Hand-authored ExprIR is not a normal authoring path and does not receive the same
correctness guarantees as typed workflow code. The project does not add costly
defensive machinery solely to make manually written IR ergonomic or safe.

## `where` Direction

`where` remains as small predicate sugar. It lowers to canonical expression
operators and does not own unique runtime semantics.

Kept direction:

```ts
where(item, { status: "done", score: { gte: 80 } })
where(item.status, "done")
where(item.name, { contains: "release" })
where(item.name, { matches: "^release/" })
where(item.tags, { length: 0 })
where(item.tags, { contains: "ready" })
```

Canonical helper composition handles complex logic:

```ts
and(
  where(item, { status: "done" }),
  or(gte(item.score, 80), eq(item.priority, "high")),
)
```

Planned removals from `where`:

- Mongo-style aliases: `$eq`, `$ne`, `$lt`, `$lte`, `$gt`, `$gte`, `$in`,
  `$nin`, `$regex`, `$and`, `$or`, and `$not`.
- Query-style `in` and `notIn`; authors use `includes(collection, value)` and
  `not(includes(collection, value))`.
- Logical object keys `AND`, `OR`, and `NOT`; authors use canonical `and`, `or`,
  and `not`.
- `isEmpty`; authors use `where(x, { length: 0 })`, `eq(len(x), 0)`, or
  `gt(len(x), 0)`.
- Nested collection query-object forms such as `none`; authors use lambda
  collection helpers for collection predicates.

Object-target `where` is field-wise only:

```ts
where(item, { eq: "x" })
```

means field `item.eq` equals `"x"` when `eq` is a field. Whole-object equality is
spelled with `eq(item, objectValue)`.

Empty filters are rejected:

```ts
where(item, {})
```

Authors use plain `true` or `eq(value, value)` style helpers for explicit
constant predicates; raw literal constructors are not part of the root authoring
surface.

Unknown object keys are rejected by TypeScript for typed authoring. The expression
module does not add schema reflection solely to rescue dynamic `any` filters.
The remaining `where` v2 leaf operators are only `eq`, `ne`, `lt`, `lte`, `gt`,
`gte`, `contains`, `startsWith`, `endsWith`, `matches`, and `length`. They are
thin sugar over canonical expression helpers and do not introduce unique runtime
semantics.
`length` sugar applies to string and array targets and lowers through
`len(target)`.
`contains` sugar applies to string and array targets and lowers to
`includes(target, value)`. These small sugar decisions follow one standard:
match common JS/TS authoring intuition, fit the expression-language purpose, and
preserve strong type inference.

## Implemented Decisions

The implementation records these decisions in current specs and tests:

- `@acpus/expression` owns expression authoring, IR, validation, and generic
  evaluation.
- Root authoring exports stay semantic; raw constructors live on `/ir` when
  needed by package internals and tests.
- `TypeIR` uses `number`, not `integer`.
- `head(array)` lowers to `get(array, 0)`; `nth` and `exprOps` are absent.
- `where` v2 is small sugar over canonical helpers, with operator/reserved keys
  excluded from object-field sugar.
- Runtime adapts workflow refs into the generic expression evaluator instead of
  owning expression operator semantics.

Source-code locations are intentionally outside the first ExprIR kernel. Future
compiler/tooling passes can attach optional debug metadata if the benefit becomes
clear, but expression semantics and tests rely on serialized IR paths.

## Test Strategy

Tests for the rebuild focus on the lowest stable layer:

- Type tests prove public helper inference and rejection behavior for scoped
  collection helpers, projection, dynamic `get`, unknown values, and tightened
  `where` filters.
- Expression unit tests assert canonical IR slices for lowering; they avoid
  whole-workflow snapshots.
- Validator contract tests cover lambda scope, unknown operators, unsupported
  lambda positions, unbound vars, and malformed expression shapes.
- Runtime evaluator unit tests cover short-circuiting, empty array semantics,
  structural equality, missing-path access, dynamic `get`, and fail-fast
  collection behavior.
- A small number of integration tests cover the full authoring-to-runtime path
  without duplicating every operator permutation.

Tests describe only the new current behavior. They do not preserve compatibility
with removed expression behavior and do not add negative assertions whose only
purpose is to document removed legacy syntax.

`@acpus/expression` owns its own verification commands: package typecheck, unit
tests for lowering/evaluator/template/equality behavior, type tests for helper
inference, and contract tests for public exports and diagnostic codes. Core and
runtime tests cover integration with the expression package rather than
duplicating the full expression operator matrix.
Public API contract tests are the first acceptance gate for the package split:
they verify the new expression root and subpaths, and they verify that core no
longer exposes the old expression subpath, root expression helpers, or `template`.
Old-import grep checks are an implementation checklist item rather than an
automated test because docs and legacy history may legitimately mention removed
paths.
Implementation is test-first at the package seam: create `@acpus/expression`
contract/type/unit test skeletons before migrating core and runtime to consume the
new package.
The implementation goal is complete only when relevant expression, core, and
runtime typecheck/test commands pass. If an expected command cannot run, the
handoff records why.

## Implementation Order

The implementation order moves from the expression kernel outward:

1. Create `@acpus/expression` and move expression-language ownership there:
   expression IR, value/type model, helpers, registry, validation, and generic
   evaluator kernel.
2. Add the ExprIR kernel pieces: `lambda`, `var`, operator registry, and type
   metadata foundations.
3. Add shared accessor factories so workflow refs and lambda vars use the same
   property/index access model.
4. Teach the expression evaluator lambda consumption, var lookup, dynamic `get`,
   structural equality, and scoped collection operators.
5. Teach the expression validator closed operator checks, lambda placement,
   lambda scope stack, var binding, and basic type metadata checks.
6. Add public runtime-array helpers such as `every`, `some`, `filter`, `map`, and
   `get`, while preserving useful static-array helper forms.
7. Refit `where` after the canonical operator semantics are stable.
8. Update `@acpus/core` to depend on `@acpus/expression` for workflow authoring
   values and expression IR.
9. Update `@acpus/runtime` to use the generic expression evaluator through a
   workflow runtime scope adapter.
10. Move implemented decisions from this roadmap note into specs and tests in the
    same behavior-changing work.

Public lambda helpers stay unexposed until both evaluator and validator
understand lambda and var expressions.
