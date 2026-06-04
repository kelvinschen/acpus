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

Agent executables use inline actors (no top-level `roles` map):

```yaml
actor:
  agent: codex
  mode: readOnly      # filesystem access: denyAll | readOnly | edit
  label: reviewer
```

Note: Actor `mode` (filesystem access) is distinct from stage-level `mode` (agent/program).

## Stage Kinds

| Kind | Purpose |
|------|---------|
| `task` | Agent or command program work |
| `route` | First-match branch selection |
| `fanout` | Agent lane work across items, followed by required fanin |
| `loop` | Bounded repeated body graph |
| `gate` | Terminal verdict |

Executable objects declare `mode`. `fanout` and `loop` do not declare stage-level `mode`.

## Dependencies

Stages declare execution dependencies with `dependsOn`:

```yaml
- id: implement
  kind: task
  # ... task fields ...

- id: validate
  kind: task
  dependsOn: [implement]
  # ... task fields ...
```

`dependsOn` is an array of stage IDs that must all reach terminal state before this stage can execute. Outputs of depended-on stages are available via the `outputs.*` source root. The `root` stage must not declare `dependsOn`.

## Task

Agent task (LLM executes a prompt):

```yaml
- id: implement
  kind: task
  mode: agent                          # stage mode: agent | program
  actor: { agent: codex, mode: edit, label: implementer }  # actor mode: filesystem access
  prompt: Implement ${task}
  variables:
    - name: task
      source: input.task
  output:
    schema: "{summary:string,data?:unknown}"
```

Program task (shell command):

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
  limits:
    maxConcurrency: 2       # or: { source: input.maxConcurrency }
    maxFanoutItems: 50      # or: { source: input.maxFanoutItems, default: 50 }
```

Program fanin supports only `mergeArrays`. Agent fanin uses `mode: agent`, `actor`, and `prompt`; agent fanin prompts may reference `${results}` without declaring a workflow variable.

**`fanoutPolicy.allowPartial`** (default `false`): when `true`, the fanout stage can reach a terminal state even if some items are blocked, allowing fanin to proceed with partial results.

**Per-stage `limits`**: fanout stages accept `maxConcurrency` (parallel agent sessions, default 1) and `maxFanoutItems` (default 1). Values can be literal numbers or input-sourced bindings (`{ source: input.xxx, default?: N }`).

## Loop

```yaml
- id: review_loop
  kind: loop
  maxRounds: 3
  body:
    root: review              # first stage executed each round
    output: review            # which body stage's output becomes the loop's output
    stages:
      - id: review
        kind: task
        mode: agent
        actor: { agent: aiden, mode: readOnly, label: reviewer }
        prompt: Review.
  continueWhen: { source: loop.current.output.data.needsAnotherRound, op: eq, value: true }
  onExhausted: blocked
```

- **`body.root`**: the first stage executed in each loop round.
- **`body.output`**: names which body stage's output becomes the loop stage's output (used by `continueWhen` and downstream stages). Cannot name a `route` stage.
- **`onExhausted`**: determines the loop's status when `maxRounds` is reached without `continueWhen` becoming false. Currently only `blocked` is supported.
