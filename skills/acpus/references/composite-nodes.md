# Composite Nodes

Use this when authoring workflows with control flow. Composite nodes return direct values; they do not add a `.output` envelope.

## Guard

`when` is raw CEL. `then` and `else` must be `continue`, `fail`, or `complete`.

- `continue`: keep executing the current scope.
- `fail`: fail the node with the guard output.
- `complete`: complete the current scope early and return the guard output.

```yaml
- id: require_changes
  guard:
    when: steps.collect.output.changed_file_count > 0
    then: continue
    else: fail
    message: "No changes found for ${{ input.target }}"
```

## Loop

`until` is raw CEL and is checked after at least one body iteration. `loop.iter` is zero-based; `loop.last` is the previous body output.

```yaml
- id: repair_until_green
  loop:
    max_iterations: 4
    until: loop.iter > 0 && loop.last.ok
    steps:
      - id: attempt
        agent:
          use: codex
          prompt: "Repair ${{ input.target }}."
          output:
            ok: boolean
            patch_path: string
```

## Fanout

`over` is raw CEL when it references another output. `key` is a template. The body can use `item`, `item_id`, and `item_index`. The result is an array of successful lane outputs.

```yaml
- id: review_files
  fanout:
    over: steps.plan.output.files
    key: "${{ item.path }}"
    join: all
    steps:
      - id: review
        agent:
          use: codex
          prompt: "Review ${{ item.path }}."
          output:
            summary: string
            finding_count: integer
```

Use `quorum` and `success_criteria.min_success` only when partial success is acceptable.

## Parallel

Parallel output is a record keyed by branch id. With `join: all`, every branch must succeed. Use fail-fast behavior only when later branches are not worth completing after one failure.

```yaml
- id: checks
  parallel:
    join: all
    branches:
      - id: review
        steps: [...]
      - id: test
        steps: [...]
```

## Switch

Switch branches are evaluated in order. Use a default branch when the workflow should continue for unknown cases; omit it when an unmatched case should fail loudly.
