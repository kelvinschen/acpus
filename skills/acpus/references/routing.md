# Routing Reference

## Route

Routes are first-match branch selectors. They have no default — if no rule matches, the stage blocks with `ROUTE_UNMATCHED`. To avoid this, ensure rules cover all possible values or add a catch-all rule at the end.

### Program Route

```yaml
- id: choose
  kind: route
  mode: program
  rules:
    - when: { source: outputs.inspect.data.kind, op: eq, value: docs }
      to: docs
    - when: { source: outputs.inspect.data.kind, op: eq, value: code }
      to: code
  routes: [docs, code]
- id: docs
  kind: task
  mode: program
  operation: command
  command: "true"
  dependsOn: [choose]
- id: code
  kind: task
  mode: program
  operation: command
  command: "true"
  dependsOn: [choose]
```

`routes` must exactly equal the direct downstream IDs. The selected branch remains active; unselected direct downstream branches are skipped. No match blocks with `ROUTE_UNMATCHED`.

### Agent Route

```yaml
- id: choose
  kind: route
  mode: agent
  actor: { agent: codex, mode: readOnly, label: router }
  prompt: >
    Decide whether this task is about documentation or code.
    Output a JSON object with a "route" field set to either "docs" or "code".
  routes: [docs, code]
```

Agent route uses an inline actor. The agent must output a `route` field whose value matches one of the `routes` list IDs. This is enforced regardless of `output.schema`.

## Gate

### Program Gate with Condition

```yaml
- id: gate
  kind: gate
  mode: program
  dependsOn: [validate]
  condition: { source: outputs.validate.verdict, op: eq, value: pass }
```

For program gates: a true condition produces verdict `pass`; a false condition produces verdict `blocked`. Program gate is the default — omit `mode` for program gate behavior.

### Agent Gate

```yaml
- id: gate
  kind: gate
  mode: agent
  dependsOn: [validate]
  actor: { agent: codex, mode: readOnly, label: judge }
  prompt: >
    Evaluate the validation results and decide a final verdict.
    Output a JSON object with a "verdict" field set to one of:
    "pass", "pass_with_warnings", "blocked", "failed", or "unknown".
```

Agent gate must output `verdict`: `pass`, `pass_with_warnings`, `blocked`, `failed`, or `unknown`. This is enforced regardless of `output.schema`.

Gate stages treat `skipped` upstream dependencies as satisfied, so unselected route branches do not block run completion.

## Fanout Lane Selection

Every lane runs by default. A lane with `when` runs only when the condition is true; when the condition is false or its source is missing, that lane is skipped. If multiple lane conditions are true, all matching lanes run. Use mutually exclusive `when` conditions when you want one-of authoring behavior.

```yaml
lanes:
  - id: schema
    actor: { agent: aiden, mode: readOnly, label: schema }
    when: { source: item.area, op: eq, value: schema }
  - id: runtime
    actor: { agent: aiden, mode: readOnly, label: runtime }
    when: { source: item.area, op: eq, value: runtime }
```
