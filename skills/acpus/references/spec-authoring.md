# Spec Authoring Reference

Workflow specs are YAML files named `*.workflow.spec.yaml` or `workflow.spec.yaml`.

## Top-Level Shape

```yaml
schemaVersion: acpus.workflow/v1
name: example
root: plan
input:
  schema: |
    {
      task: string,
      maxConcurrency?: number
    }
  default:
    task: ""
    maxConcurrency: 2
limits:
  stageTimeoutMinutes: 30
stages: []
```

Limits may be literal positive integers or run-start bindings sourced from workflow input:

```yaml
limits:
  stageTimeoutMinutes: 30
stages:
  - id: review
    kind: fanout
    items:
      source: input.items
    limits:
      maxConcurrency:
        source: input.maxConcurrency
      maxFanoutItems:
        source: input.maxFanoutItems
        default: 50
```

There is no top-level `roles` map. Agent executables use inline actors:

```yaml
actor:
  agent: codex
  mode: readOnly
  label: reviewer
```

## Stage Kinds

| Kind | Purpose |
|------|---------|
| `task` | Agent or command program work |
| `route` | First-match branch selection |
| `fanout` | Agent lane work across items, followed by required fanin |
| `loop` | Bounded repeated body graph |
| `gate` | Terminal verdict |

Executable objects declare `mode`. `fanout` and `loop` do not declare stage-level `mode`.

## Task

```yaml
- id: implement
  kind: task
  mode: agent
  actor: { agent: codex, mode: edit, label: implementer }
  prompt: Implement ${task}
  variables:
    - name: task
      source: input.task
  output:
    schema: "{summary:string,data?:unknown}"
```

Program task:

```yaml
- id: collect
  kind: task
  mode: program
  operation: command
  command: node
  args: ["scripts/collect.js"]
```

## Route

```yaml
- id: choose
  kind: route
  mode: program
  rules:
    - when: { source: input.kind, op: eq, value: docs }
      to: docs
  routes: [docs, code]
```

`routes` must exactly equal direct downstream stage IDs. No match blocks the route.

## Fanout And Fanin

```yaml
- id: review_items
  kind: fanout
  items: { source: input.items }
  prompt: Review one item.
  lanes:
    - id: validator
      actor: { agent: aiden, mode: readOnly, label: validator }
      output:
        schema: "{summary:string,data:[{summary:string,severity?:string}]}"
  fanin:
    mode: program
    operation: mergeArrays
  fanoutPolicy:
    allowPartial: true
```

Program fanin supports only `mergeArrays`. Agent fanin uses `mode: agent`, `actor`, and `prompt`; agent fanin prompts may reference `${results}` without declaring a workflow variable.

## Loop

```yaml
- id: review_loop
  kind: loop
  maxRounds: 3
  body:
    root: review
    output: review
    stages:
      - id: review
        kind: task
        mode: agent
        actor: { agent: aiden, mode: readOnly, label: reviewer }
        prompt: Review.
  continueWhen: { source: loop.current.output.data.needsAnotherRound, op: eq, value: true }
  onExhausted: blocked
```

Loop body output cannot be a `route` stage.
