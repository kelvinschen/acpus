# Output Contracts Reference

Seven contract types, each backed by a Zod schema. The contract type is
determined by stage kind and role category — authors don't choose it directly.

## Contract Selection

| Stage Kind / Role Category | Contract |
|---------------------------|----------|
| `gate` | `gate` |
| `decisionGate` | `decision` |
| `discover` | `discover` |
| Role category `implementation` | `implementation` |
| Role category `validation` or `review` | `validation` |
| Diagnostic runtime | `diagnostic` |
| Everything else | `base` |

All lanes in a fanout must resolve to the same contract (`FANOUT_CONTRACT_MISMATCH`
lint error if not).

---

## Contract Schemas

### Shared Fields (all contracts)

```json
{
  "status": "completed | blocked",
  "summary": "string",
  "artifacts": [{ "kind?": "string", "path?": "string", "url?": "string", "label?": "string" }],
  "nextFocus": "string",
  "blockedReason?": "string (required when status is blocked)",
  "data?": {},
  "metadata?": {}
}
```

### base

Just the shared fields. Used by `agentTask` with planning/research/coordination
roles.

```json
{
  "status": "completed",
  "summary": "Plan created for the feature.",
  "artifacts": [],
  "nextFocus": "implement"
}
```

### implementation

Shared fields **+** `changedFiles` and `checks`:

```json
{
  "status": "completed",
  "summary": "Implemented safely.",
  "artifacts": [],
  "nextFocus": "gate",
  "changedFiles": ["src/app.ts"],
  "checks": [
    { "command": "npm test", "status": "pass", "summary": "All tests passed" }
  ]
}
```

### validation

Shared fields **+** `verdict`, `severityCounts`, `findings`, `checks`:

```json
{
  "status": "completed",
  "summary": "Code review complete.",
  "artifacts": [],
  "nextFocus": "gate",
  "verdict": "fix",
  "severityCounts": { "P0": 0, "P1": 2, "P2": 1, "P3": 0 },
  "findings": [
    {
      "severity": "P1",
      "summary": "Missing error handling in fetch",
      "path": "src/api.ts",
      "details": "The fetch call on line 42 has no catch block"
    }
  ],
  "checks": []
}
```

Verdict values: `"pass"` | `"fix"` | `"blocked"` | `"unknown"`.

### decision

Shared fields **+** `route`:

```json
{
  "status": "completed",
  "summary": "Decision route: validate",
  "artifacts": [],
  "nextFocus": "validate",
  "route": "validate"
}
```

When route is `"blocked"`, status becomes `"blocked"`.

### discover

Shared fields **+** dynamic output key (default `"items"`). Supports `maxItems`
cap.

```json
{
  "status": "completed",
  "summary": "Found 5 changed files.",
  "artifacts": [],
  "nextFocus": "review",
  "items": [
    { "path": "src/runtime/scheduler.ts", "area": "runtime" },
    { "path": "src/schema/workflow-spec.ts", "area": "schema" }
  ]
}
```

### gate

Shared fields **+** `verdict`, `deliverables`, `changedFiles`, `checks`,
`warnings`, `risks`, `nextActions`:

```json
{
  "status": "completed",
  "summary": "All checks passed.",
  "artifacts": [],
  "nextFocus": "",
  "verdict": "pass",
  "deliverables": [],
  "changedFiles": [],
  "checks": [{ "name": "Unit tests", "status": "pass", "summary": "12/12 passed" }],
  "warnings": [],
  "risks": [],
  "nextActions": []
}
```

Cross-field validation: `pass`/`pass_with_warnings` → status must be
`"completed"`. `blocked`/`failed`/`unknown` → status must be `"blocked"`.

### diagnostic

Shared fields, but `data` is **required** (not optional):

```json
{
  "status": "completed",
  "summary": "Diagnostic complete.",
  "artifacts": [],
  "nextFocus": "",
  "data": {
    "blockedCause": "Agent output failed schema validation",
    "recoveryAdvice": ["Resume the run to retry the blocked stage"],
    "requiresNewRun": false
  }
}
```

---

## Output Parser Behavior

1. Scans agent response for the **last balanced JSON object** (tracks `{`/`}`
   depth, respects string literals and escapes)
2. Falls back to `jsonrepair` for common fixes (trailing commas, unquoted keys)
3. Validates against the contract's Zod schema
4. On schema failure: one repair turn is attempted (the agent is asked to fix
   the output). Repair turns count in agent usage.
5. If repair also fails: stage becomes **blocked** (not failed — `failed` is
   reserved for infrastructure errors)

The parser tolerates prose before/after the JSON and markdown code fences.
It deliberately picks the *last* balanced object so agents can show their
reasoning first and place the structured output at the end.
