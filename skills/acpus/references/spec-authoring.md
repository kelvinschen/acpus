# Spec Authoring Reference

Detailed schema and field reference for writing workflow specs.

## Top-Level Structure

```json
{
  "schemaVersion": "acpus.workflow/v1",
  "name": "string",
  "description": "string (optional)",
  "root": "stageId",
  "inputs": { },
  "roles": { },
  "limits": { "stageTimeoutMinutes": 30 },
  "stages": [ ]
}
```

## Inputs

| Type | Example |
|------|---------|
| `string`, `number`, `boolean` | Primitives |
| `path`, `glob` | Filesystem references |
| `json` | Arbitrary JSON object |
| `array<string>`, `array<path>`, `array<json>` | Typed arrays |

## Roles

Each role defines an agent's category, agent identifier, and permission mode:

- **category**: `planning`, `implementation`, `validation`, `review`, `research`,
  `summarization`, `coordination`
- **agent**: Agent identifier string (e.g. `"claude"`)
- **mode**: `denyAll` (no tool access), `readOnly` (read only), `edit` (full access)

Role category determines the output contract automatically:
`implementation` → implementation; `validation`/`review` → validation;
everything else → base.

```json
"roles": {
  "planner":     { "category": "planning",       "agent": "claude", "mode": "readOnly" },
  "implementer": { "category": "implementation",  "agent": "claude", "mode": "edit" },
  "validator":   { "category": "validation",      "agent": "claude", "mode": "readOnly" }
}
```

## Stage Kinds

| Kind | Agent? | Key Properties | Output Contract |
|------|--------|---------------|-----------------|
| `agentTask` | Yes | `role`, `prompt` | From role category |
| `discover` | Method-dependent | `method`, `args`, `output`, optional `role`/`prompt` | `discover` |
| `fanout` | Per-lane | `items`, `laneGroups[]`, `prompt`, `fanoutPolicy` | All lanes must match |
| `reduce` | Optional | `from`, `mode`, `role`/`prompt` or `operation` | From role or base |
| `decisionGate` | Optional | `rules[]`, `default`, `routes` | `decision` |
| `gate` | Optional | `condition` or `role`/`prompt` | `gate` |
| `loop` | Body-dependent | `maxRounds`, `body`, `continueWhen`, `onExhausted` | `base` |

### agentTask

Simple agent execution. Requires `role` and `prompt` (with `${variable}`
interpolation). Variables declare `name`, `source` (dotted path), and optional
`transform` chain.

```json
{
  "id": "plan",
  "kind": "agentTask",
  "role": "planner",
  "variables": [
    { "name": "task", "source": "input.task" },
    { "name": "cwd",  "source": "input.cwd" }
  ],
  "prompt": "Create an implementation plan for ${task} in ${cwd}."
}
```

### discover

Deterministic or agent-driven item discovery:

| Method | Behavior |
|--------|----------|
| `gitChangedFiles` | Git status with include/exclude filtering |
| `glob` | fast-glob pattern matching |
| `agent` | Agent-driven (requires `role` + `prompt`, must be readOnly) |

Output key defaults to `"items"`. Discover with `maxItems` caps the result set.

### fanout

Heterogeneous parallel execution across items and lanes. Lane groups control
which agent processes each item:

- `all` mode: every matching lane runs; unmatched items skipped
- `oneOf` mode: exactly one lane per item; `default` lane as fallback

Fanout policy (`fanoutPolicy`) controls partial completion tolerance:
`allowPartial`, `minCompletedRatio`, `maxBlockedItems`.

→ **For concrete lane selection examples** (`when` conditions, `oneOf` vs
`all`, `default` fallback, lint rules), read `references/routing.md`.

### reduce

Aggregation of upstream stage output.

- `mode: "agent"` — requires `role` + `prompt`; must not use edit role
- `mode: "program"` — requires `operation`:

| Operation | Description |
|-----------|-------------|
| `mergeArrays` | Concatenate arrays from upstream items |
| `severitySummary` | Count P0-P3 severities |
| `dedupeFindings` | Deduplicate by severity+path+summary |
| `sortBySeverity` | Sort findings by severity |

### decisionGate

Conditional routing. Rules evaluated in order; first match wins. Unselected
route dependents are automatically marked `skipped`. Mode: `program` (condition
evaluation) or `agent` (agent produces `route` field).

→ **For concrete examples** (program/agent mode, route pruning, decision output
shape, `routes` auto-derivation), read `references/routing.md`.

### gate

Terminal stage that determines final run status. Exactly one per workflow; must
be terminal (no dependents). Verdicts `pass`/`pass_with_warnings` complete the
run; `blocked`/`failed`/`unknown` block it. Pass verdicts survive resume.

→ **For concrete examples** (condition evaluation, single-upstream implicit
pass, agent gate, verdict semantics), read `references/routing.md`.

### loop

Bounded repetition container with inline body stages.

```json
{
  "kind": "loop",
  "maxRounds": 5,
  "body": {
    "root": "bodyStageId",
    "output": "convergenceStageId",
    "stages": [ ]
  },
  "continueWhen": { "source": "loop.current.output.data.needsAnotherRound", "op": "eq", "value": true },
  "onExhausted": "blocked"
}
```

- `body.root`: Single dependency-free body root stage ID
- `body.output`: Body stage whose output drives convergence
- `body.stages`: Allowed kinds: `agentTask`, `discover`, `fanout`, `reduce`,
  `decisionGate` (no `gate`, no nested `loop`)
- `continueWhen`: Condition evaluated after each round
- `onExhausted`: Currently only `"blocked"` (blocks with `LOOP_EXHAUSTED`)

Loop-local variables: `loop.current.output/outputs`, `loop.previous.output/outputs`.
