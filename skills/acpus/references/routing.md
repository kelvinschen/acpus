# Routing Reference

## Route

Routes are first-match branch selectors. They have no default.

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

Agent route uses inline actor and must output a valid `route` field.

## Gate

Program gate with condition:

```yaml
- id: gate
  kind: gate
  mode: program
  dependsOn: [validate]
  condition: { source: outputs.validate.verdict, op: eq, value: pass }
```

Agent gate must output `verdict`: `pass`, `pass_with_warnings`, `blocked`, `failed`, or `unknown`.

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
