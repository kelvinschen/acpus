# Expressions and Schemas

## Mental model

Workflow authoring code runs once to build a graph. `input.*`, `meta.*`, and `node.output.*` are `Expr`/accessor tokens that lower to `ExprIR`, not actual runtime values. Use Acpus expression helpers instead of JavaScript runtime operators.

## Import helpers deliberately

```ts
import {
  and,
  coalesce,
  eq,
  every,
  filter,
  get,
  gt,
  head,
  ifElse,
  includes,
  isEmpty,
  len,
  lte,
  map,
  md,
  not,
  or,
  template,
  where,
} from "acpus/expression";
```

Common mappings:

| Do not write | Write |
| --- | --- |
| `input.ready && output.ok` | `and(input.ready, output.ok)` |
| `input.kind === "release"` | `eq(input.kind, "release")` |
| `risk <= 3` | `lte(risk, 3)` |
| `input.maybe ?? "fallback"` | `coalesce(input.maybe, "fallback")` |
| `` `topic ${input.topic}` `` | `template\`topic ${input.topic}\`` or `md\`...\`` |
| `input.items.length` on an expression array | `len(input.items)` |
| `items[0]` on an expression array | `get(items, 0)` or `head(items)` |
| `.map(...)` over a runtime expression array | `map(items, where(...))` or another expression helper |

Static arrays of already-declared nodes may still use normal JavaScript methods during graph construction, for example `reviews.map((review) => review.output.ready)`.

## Templates

Use `template` for compact strings and `md` for multiline Markdown prompts/messages. `md` trims surrounding blank lines and common indentation while preserving expression interpolations.

Runtime template rendering semantics:

- Strings render directly.
- Scalar non-strings render with `String(value)`.
- Arrays and objects render with `JSON.stringify` semantics.
- Missing, `undefined`, or non-JSON-compatible values fail loudly.

Prefer artifact refs or `JSON.stringify`-compatible structured values over dumping huge objects into prompts.

## Where filters

`where(target, filter)` is typed sugar for field-wise expression predicates:

```ts
where(review.output, { ready: true, riskCount: { lte: 3 } })
```

Supported operator keys include:

| Operator | Applies to | Example |
| --- | --- | --- |
| `eq`, `ne` | string, number, boolean, arrays | `where(item, { kind: { ne: "research" } })` |
| `lt`, `lte`, `gt`, `gte` | number | `where(item, { score: { gte: 70 } })` |
| `contains` | string or array | `where(item.tags, { contains: "ready" })` |
| `startsWith`, `endsWith`, `matches` | string | `where(item, { id: { startsWith: "release-" } })` |
| `length` | string or array | `where(item.tags, { length: { gt: 0 } })` |

Use direct helpers when a data field collides with an operator name:

```ts
// For an object with a field literally named "eq"
eq(item.output.eq, "value")
```

Empty `where` filters are invalid.

## Schemas

Use `z` from `acpus/core`. Boundary schemas should stay JSON-compatible and durable.

Accepted graph-boundary shapes include string, number, boolean, null, unknown, literal, enum, array, object, record, union, optional, nullable, default, and path schemas.

Use `z.path()` for filesystem paths crossing workflow boundaries:

```ts
inputSchema: z.object({ repoPath: z.path() })
```

Avoid unsupported runtime-only or non-serializable constructs at graph boundaries:

- transforms or custom validators that cannot become durable IR
- functions, promises, maps, sets
- date, bigint, symbol
- undefined, void, never
- hand-authored `kind: "integer"` IR

`z.number().int()` may be useful for TypeScript/Zod intent, but serialized workflow IR uses numeric values as `number`, not a separate `integer` kind.

## Nullish access

Required output fields must not point at nullable or optional refs unless you remove the nullish case explicitly:

```ts
return {
  firstLane: coalesce(head(lanes.output).lane, "(none)"),
};
```

## Output admissibility

Before values enter runtime scope, events, or durable storage, they must be workflow data: plain JSON-compatible values plus Acpus artifact/path/secret boundary values. Reject or convert class instances, functions, symbols, `Date`, `Map`, `Set`, `bigint`, non-finite numbers, sparse arrays, and cycles.
