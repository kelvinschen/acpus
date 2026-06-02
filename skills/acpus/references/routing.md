# Routing Reference

Concrete examples of decisionGate, gate, and fanout lane routing.

## DecisionGate Routing

Rules evaluated in order; first match wins. If no rule matches, the `default`
route is taken.

### Program Mode (most common)

The runtime evaluates `when` conditions against current `outputs` and
`workflowInput`, then selects the matching `to` target:

```json
{
  "id": "decide",
  "kind": "decisionGate",
  "mode": "program",
  "dependsOn": ["implement"],
  "rules": [
    {
      "when": { "source": "outputs.implement.status", "op": "eq", "value": "completed" },
      "to": "validate"
    },
    {
      "when": { "source": "outputs.implement.status", "op": "eq", "value": "blocked" },
      "to": "rollback"
    }
  ],
  "default": "blocked"
}
```

When `"implement"` completed → routes to `"validate"`.
When `"implement"` blocked → routes to `"rollback"`.
Otherwise → route is `"blocked"` (stage status becomes blocked).

### Agent Mode

When routing logic is too complex for conditions, an agent makes the decision:

```json
{
  "id": "route",
  "kind": "decisionGate",
  "mode": "agent",
  "role": "router",
  "prompt": "Based on the review results, decide the next step.",
  "dependsOn": ["validate"],
  "rules": [
    { "when": { "source": "outputs.validate.status", "op": "eq", "value": "completed" }, "to": "gate" }
  ],
  "default": "blocked"
}
```

The agent must produce a `decision` output contract with a `route` field
matching one of the declared routes.

### Route Pruning

After a decisionGate selects a route, all other dependents are marked `skipped`:

```
decide ──┬── validate    ← selected, runs normally
         ├── rollback    ← skipped ("Decision decide selected validate")
         └── escalate    ← skipped
```

Terminal gate treats skipped dependencies as satisfied, so unselected branches
don't block run completion.

### Routes Auto-Derivation

If `routes` is omitted, it's computed as: all rule `to` values + the `default`.
Explicit `routes` is only needed when you want to restrict the declared set.

### Decision Output Shape

```json
{
  "status": "completed",
  "summary": "Decision route: validate",
  "artifacts": [],
  "nextFocus": "validate",
  "route": "validate"
}
```

When the route is `"blocked"`, status becomes `"blocked"` with
`blockedReason: "BLOCKED_ROUTE"`.

---

## Gate Routing

### Program Gate with Condition

```json
{
  "id": "gate",
  "kind": "gate",
  "mode": "program",
  "dependsOn": ["validate"],
  "condition": {
    "all": [
      { "source": "outputs.validate.verdict", "op": "eq", "value": "pass" },
      { "source": "outputs.validate.severityCounts.P0", "op": "eq", "value": 0 }
    ]
  }
}
```

Condition true → `verdict: "pass"`, run completes.
Condition false → `verdict: "blocked"`, run blocks.

### Program Gate with Single Upstream (implicit pass)

The simplest form — no condition needed when there's exactly one dependency:

```json
{
  "id": "gate",
  "kind": "gate",
  "dependsOn": ["validate"]
}
```

Passes if the single upstream produced output. Lint rejects a program gate
with multiple `dependsOn` and no `condition` (`GATE_PROGRAM_CONDITION_REQUIRED`).

### Agent Gate

```json
{
  "id": "gate",
  "kind": "gate",
  "mode": "agent",
  "role": "reviewer",
  "prompt": "Evaluate whether all deliverables meet quality standards.",
  "dependsOn": ["validate", "review"]
}
```

Agent must produce a `gate` output contract with `verdict` field. Role must
not use `mode: "edit"`.

### Verdicts and Run Completion

| Verdict | Run Result | Preserved on Resume? |
|---------|-----------|---------------------|
| `pass` | Completed | Yes |
| `pass_with_warnings` | Completed | Yes |
| `blocked` | Blocked | Cleared (re-evaluated) |
| `failed` | Blocked | Cleared |
| `unknown` | Blocked | Cleared |

On pass, the gate copies passthrough fields (`deliverables`, `changedFiles`,
`checks`, `warnings`, `risks`, `nextActions`) from the single upstream.

---

## Fanout Lane Routing

### All Mode — Every Matching Lane Runs

```json
{
  "id": "review_files",
  "kind": "fanout",
  "dependsOn": ["discover"],
  "items": { "source": "outputs.discover.items" },
  "laneGroups": [
    {
      "id": "area_reviews",
      "mode": "all",
      "lanes": [
        {
          "id": "runtime",
          "role": "runtime_reviewer",
          "when": { "source": "item.area", "op": "in", "value": ["runtime", "platform"] }
        },
        {
          "id": "schema",
          "role": "schema_reviewer",
          "when": { "source": "item.area", "op": "eq", "value": "schema" }
        },
        {
          "id": "docs",
          "role": "docs_reviewer",
          "when": { "source": "item.area", "op": "eq", "value": "docs" }
        }
      ]
    }
  ]
}
```

Item `{ path: "src/runtime/scheduler.ts", area: "runtime" }` → only `runtime`
lane runs (matched by `in` condition).

Item `{ path: "README.md", area: "docs" }` → only `docs` lane runs.

Item `{ path: "package.json", area: "config" }` → no lanes match, item is
**skipped** entirely.

Lane without `when` always matches.

### OneOf Mode — Exactly One Lane per Item

```json
{
  "id": "review_files",
  "kind": "fanout",
  "dependsOn": ["discover"],
  "items": { "source": "outputs.discover.items" },
  "laneGroups": [
    {
      "id": "area_route",
      "mode": "oneOf",
      "lanes": [
        {
          "id": "runtime",
          "role": "runtime_reviewer",
          "when": { "source": "item.area", "op": "eq", "value": "runtime" }
        },
        {
          "id": "schema",
          "role": "schema_reviewer",
          "when": { "source": "item.area", "op": "eq", "value": "schema" }
        },
        {
          "id": "general",
          "role": "general_reviewer",
          "default": true
        }
      ]
    }
  ]
}
```

Item with `area: "runtime"` → `runtime` lane.
Item with `area: "schema"` → `schema` lane.
Item with `area: "other"` → `general` lane (default fallback).

**oneOf selection rules:**

| Matched | Default? | Result |
|---------|----------|--------|
| 1 lane | — | That lane selected |
| 0 lanes | Has default | Default lane selected |
| 0 lanes | No default | **Blocked** (`FANOUT_LANE_SELECTION_FAILED`) |
| 2+ lanes | — | **Blocked** (`FANOUT_LANE_SELECTION_FAILED`) |

**Lint constraints:**
- Non-default lanes in `oneOf` must declare `when` (`FANOUT_ONE_OF_WHEN_REQUIRED`)
- `default: true` lane must not declare `when` (`FANOUT_DEFAULT_WHEN_INVALID`)
- `default: true` only valid in `oneOf` groups (`FANOUT_DEFAULT_INVALID`)
- At most one default lane per group (`FANOUT_ONE_OF_DEFAULT_DUPLICATE`)

### Single-Lane All (simplest fanout)

```json
{
  "laneGroups": [
    {
      "id": "review",
      "mode": "all",
      "lanes": [{ "id": "validator", "role": "validator" }]
    }
  ]
}
```

Every item goes through the single lane. No `when` needed.
