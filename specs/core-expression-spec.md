# Core Expression Spec

## Purpose

`@acpus/core/expression` owns Acpus expression authoring primitives and the canonical serializable `ExprIR` construction layer. Authors express conditions and derived values through typed refs, `where(...)` filters, named helpers, and collection helpers. Evaluation belongs to runtime consumers.

## Requirements

### Public API

- The expression public API MUST be exported from `@acpus/core/expression`.
- The root `@acpus/core` entrypoint MUST NOT export the full expression helper set.
- The expression entrypoint MUST export `expr`, `isExpr`, `valueToExprIR`, `literal`, `not`, `and`, `or`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `len`, `includes`, `isEmpty`, `startsWith`, `endsWith`, `matches`, `coalesce`, `fallback`, `head`, `nth`, `all`, `any`, `max`, `min`, `where`, `exprOps`, `pick`, and `refExpr`.
- The expression entrypoint MUST export the public expression and where-filter types.

### Expression Construction

- `ExprIR` MUST be the canonical expression storage form.
- `expr(ir)` MUST wrap a serializable expression IR as a typed workflow expression.
- `valueToExprIR(value)` MUST lower workflow values to literal, ref, array, object, template, or call expression IR.
- Literal helpers MUST lower primitive values to `literal` expression IR.
- Named operators MUST lower to `call` expression IR with stable function names.
- Logical combinators MUST include `not`, `and`, and `or`.
- Comparison helpers MUST include `eq`, `ne`, `lt`, `lte`, `gt`, and `gte`.
- String helpers MUST include `includes`, `startsWith`, `endsWith`, and `matches`.
- Array/string length helpers MUST include `len`, `includes`, and `isEmpty`.
- Nullish fallback MUST be represented by `coalesce`; `fallback` MUST lower to the same semantics.

### Where Filters

- `where(target, filter)` MUST support Prisma/Mongo-style object filters and lower them to primitive `ExprIR` calls.
- Field shorthand values MUST lower to equality checks.
- Field `{ length: n }` filters MUST lower to `eq(len(field), n)`.
- Mongo aliases such as `$lte` and `$regex` MUST lower to the same primitive calls as their named counterparts.
- `in` and `notIn` MUST be supported as `where(...)` filter operators only; they MUST NOT be direct public helper functions.
- `where(...)` filter values MUST accept workflow values, including refs, literal arrays, ref-backed arrays for `in` / `notIn`, and arrays containing refs.
- Array `isEmpty` in `where(...)` MUST remain a boolean literal selector.

### Accessors And Collections

- `pick(source, keys)` MUST return a plain object fragment of same-name output accessors without creating nodes or a distinct IR shape.
- `head(array)` and `nth(array, index)` MUST support ref-backed workflow arrays and lower to index ref paths.
- `nth` MUST require a zero-based non-negative integer index.
- `head` and `nth` MUST return accessors typed as possibly `undefined`.
- `all`, `any`, `max`, and `min` MUST support compile-time arrays via selector callbacks.
- Collection helpers over runtime arrays MUST be expressed with workflow fanout nodes rather than selector callbacks.

## Verification

- Tests MUST cover `where(...)` lowering, including shorthand equality, `{ length: 0 }`, Mongo aliases, workflow-value filters, and `in` / `notIn` filters.
- Tests MUST cover named operator lowering and composition with `where(...)`.
- Tests MUST cover `includes(...)`, `isEmpty(...)`, `fallback(...)`, `head(...)`, and `nth(...)`.
- Tests MUST cover compile-time collection helpers over selected refs.
- Type tests MUST cover expression helper imports from `@acpus/core/expression`.
