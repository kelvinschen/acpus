# Core Expression Spec

## Purpose

Acpus core owns its canonical expression IR (`ExprIR`). The public authoring surface intentionally avoids raw expression strings: authors express conditions and derived values through structured TypeScript (`where(...)` filters, named operators, and typed output refs), which the core lowers to a serializable expression IR consumed by the runtime, visualizers, and validators.

## Requirements

### Authoring styles

- The core MUST support a Prisma/Mongo-style `where(target, filter)` surface and MUST lower it to primitive `ExprIR` calls.

```ts
where(review.output, { ready: true, riskCount: { lte: 3 }, issues: { length: 0 } });
// lowers to:
// and(
//   eq(review.output.ready, true),
//   lte(review.output.riskCount, 3),
//   eq(len(review.output.issues), 0),
// )
```

- The core MUST support named operators usable directly and in composition with `where(...)`.

```ts
and(where(review.output, { ready: true }), lte(review.output.riskCount, 3));
```

- The core MUST support collection helpers over compile-time arrays via selector callbacks; these MUST NOT be used for runtime arrays (use `step.fanout(...)`).

```ts
all(reviews, review => review.output.ready);
max(reviews, review => review.output.riskCount);
```

### Operator set

- Number comparisons MUST include: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `notIn`.
- String operators MUST include: `eq`, `ne`, `contains`, `startsWith`, `endsWith`, `matches`, `in`, `notIn`.
- Boolean operators MUST include: `true`, `false`, `eq`, `ne`.
- Array operators MUST include: `length`, `contains`, `isEmpty`.
- Logical combinators MUST include: `AND`, `OR`, `NOT`.

### Canonical layer ownership

- `ExprIR` MUST be the canonical expression layer; the core MUST NOT adopt CEL or JSON Logic as the canonical authoring or storage form.
- The expression layer MUST serve typed refs, dependency collection, source mapping, graph visualization, schema-aware field diagnostics, scope-visibility validation, and stable IR serialization — not evaluation alone.
- Any future interop (JSON Logic import/export, a CEL backend, or an `unsafeExpr("...")` escape hatch) MUST remain optional and MUST NOT become the primary authoring surface.

## Verification

- Tests MUST cover that `where(...)` lowers to the documented primitive `ExprIR` calls, including the field-shorthand cases (`true` → `eq`, `{ length: 0 }` → `eq(len(...), 0)`).
- Tests MUST cover Mongo aliases (e.g. `$lte`, `$regex`) lowering to the same primitives as their named counterparts.
- Tests MUST cover compile-time collection helpers (`all`, `max`) producing logical/aggregate `ExprIR` over the selected refs.
