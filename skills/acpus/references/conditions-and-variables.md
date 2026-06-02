# Condition DSL Reference

Conditions control fanout lane selection, gate pass/fail, decisionGate routing,
and loop continuation.

## Six Condition Forms

### Comparison — value comparison

```json
{ "source": "outputs.implement.status", "op": "eq", "value": "completed" }
```

| op | Meaning | Value type |
|----|---------|-----------|
| `eq` | Strict equal (`===`) | Any |
| `neq` | Strict not equal | Any |
| `gt` | Greater than (both coerced to Number) | number |
| `gte` | Greater or equal | number |
| `lt` | Less than | number |
| `lte` | Less or equal | number |

### Membership — array contains

```json
{ "source": "item.area", "op": "in", "value": ["runtime", "platform"] }
```

`value` must be an array. True if the resolved source value is present in it.

### Existence — presence check

```json
{ "source": "outputs.discover.items", "op": "exists" }
```

| op | True when |
|----|-----------|
| `exists` | Value is not `undefined` and not `null` |
| `empty` | Value is `null`, `undefined`, `""`, or empty array `[]` |

### Conjunction — all must match

```json
{
  "all": [
    { "source": "outputs.validate.verdict", "op": "eq", "value": "pass" },
    { "source": "outputs.validate.severityCounts.P0", "op": "eq", "value": 0 }
  ]
}
```

### Disjunction — any must match

```json
{
  "any": [
    { "source": "outputs.review.status", "op": "eq", "value": "completed" },
    { "source": "outputs.review.status", "op": "eq", "value": "blocked" }
  ]
}
```

### Negation — invert

```json
{ "not": { "source": "outputs.plan.status", "op": "eq", "value": "blocked" } }
```

All forms can be nested arbitrarily: an `all` can contain `any` which contains
`not`, etc.

---

## Source Paths

Conditions reference values through dot-separated source paths with five roots:

| Root | Backed by | Example |
|------|-----------|---------|
| `input` | Workflow inputs | `input.task`, `input.cwd` |
| `outputs` | Stage outputs by ID | `outputs.plan.summary`, `outputs.review.verdict` |
| `item` | Current fanout item | `item.path`, `item.area` |
| `loop` | Loop context (body only) | `loop.current.output.data.needsAnotherRound`, `loop.previous.output.findings` |
| `run` | Run metadata | `run.id` |

Safe navigation: if any intermediate key is missing, the path resolves to
`undefined` (no error thrown). This means `outputs.nonexistent.foo` safely
yields `undefined`, which makes `exists`/`empty` checks useful for optional
stages.

---

## Where Conditions Are Used

| Context | Field | Evaluated Against |
|---------|-------|-------------------|
| Loop `continueWhen` | After each round | `outputs` + `workflowInput` + `local.loop` |
| Fanout lane `when` | Per item per group | `outputs` + `workflowInput` + `local.item` + loop context |
| Gate `condition` | On gate execution | `outputs` + `workflowInput` |
| DecisionGate `when` | On rule evaluation | `outputs` + `workflowInput` |

---

## Loop Context Shape

Inside loop body stages, the `loop` root provides:

```
loop.round                          → current round number (1-based)
loop.current.output                 → body.output stage's output this round
loop.current.outputs                → all body stage outputs this round
loop.previous.output                → body.output stage's output last round
loop.previous.outputs               → all body stage outputs last round
```

On round 1, `loop.previous` is undefined. Use the `default` transformer on
variables that reference `loop.previous` to handle this:

```json
{
  "name": "previousFindings",
  "source": "loop.previous.output.findings",
  "transform": [
    { "fn": "default", "args": { "value": [] } },
    { "fn": "json" }
  ]
}
```

---

## Variable Interpolation

Prompt text uses `${variableName}` placeholders. Each variable declares a
`name`, `source` (dotted path), and optional `transform` chain.

### Declaration Examples

```json
{ "name": "task", "source": "input.task" }
{ "name": "plan", "source": "outputs.plan.summary" }
{ "name": "file", "source": "item.path" }
{ "name": "prevFindings", "source": "loop.previous.output.findings",
  "transform": [
    { "fn": "default", "args": { "value": [] } },
    { "fn": "json" }
  ]
}
```

### Template Rendering

```
"Implement ${task} following this plan:\n\n${plan}"
```

Rendering rules:
- `null`/`undefined` → empty string
- `string` → used as-is
- objects/arrays → `JSON.stringify(value, null, 2)`

Escape `\${` for literal `${}` in output.

### Built-in Transformers

Applied as a chain, left to right:

| Transformer | Args | Purpose |
|-------------|------|---------|
| `compact` | `maxChars?` (2000) | Truncate to max characters |
| `tail` | `maxLines?` (80) | Keep last N lines |
| `json` | `pretty?` (true) | JSON.stringify |
| `quoteBlock` | — | Wrap in triple-backtick fence |
| `pathList` | — | Extract `.path`/`.file` fields, newline-join |
| `filterSeverity` | `levels: string[]` | Filter array by severity |
| `severitySummary` | — | Count P0-P3 severities |
| `join` | `separator?` ("\n") | Join array elements |
| `default` | `value: any` | Substitute when null/undefined/empty |
