# Composite Nodes

Use this when authoring workflows with control flow. Composite nodes expose their primary produced value through `steps.<id>.output`, the same as executable nodes.

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

`until` is raw CEL and is checked after at least one body iteration. `loop.iter` is zero-based; `loop.last` is the previous body step value.

```yaml
- id: repair_until_green
  loop:
    max_iterations: 4
    until: loop.iter > 0 && loop.last.output.ok
    do:
      - id: attempt
        run: agent
        use: codex
        timeout: 10m
        session_key: repair-loop
        prompt: "Repair ${{ input.target }}."
        output:
          ok: boolean
          patch_path: string
```

## Fanout

`over` is raw CEL when it references another output. `key` is a template. The body can use `item`, `item_id`, and `item_index`. `steps.<fanout_id>.output` is an array of successful lane outputs.

```yaml
- id: review_files
  fanout:
    over: steps.plan.output.files
    key: "${{ item.path }}"
    join: all
    do:
      - id: review
        run: agent
        use: codex
        timeout: 10m
        prompt: "Review ${{ item.path }}."
        output:
          report_path: string
          finding_count: integer
```

Use `quorum` and `success_criteria.min_success` only when partial success is acceptable.

## Parallel

`steps.<parallel_id>.output` is a record keyed by branch id. With `join: all`, every branch must succeed. Use fail-fast behavior only when later branches are not worth completing after one failure.

```yaml
- id: checks
  join: all
  parallel:
    - id: review
      run: agent
      use: codex
      prompt: "Review ${{ input.target }}."
    - id: test
      run: program
      cmd: ["pnpm", "test"]
```

> **Common mistake**: parallel output is a record keyed by branch id, so there is an extra `.output.` layer between the parallel node and the branch.
>
> ```yaml
> # ❌ Wrong: intuitive but incorrect
> steps.checks.review.output.report_path
>
> # ✅ Correct: parallel output → branch key → branch output
> steps.checks.output.review.output.report_path
> ```

## Switch

Switch branches are evaluated in order. Use a default branch when the workflow should continue for unknown cases; omit it when an unmatched case should fail loudly.

```yaml
- id: route
  switch:
    cases:
      - when: steps.classify.output.complexity == "simple"
        do:
          - id: handle_simple
            run: agent
            use: fast_agent
            prompt: "Handle ${{ input.task }}."
            output:
              result_path: string
      - when: steps.classify.output.complexity == "complex"
        do:
          - id: handle_complex
            run: agent
            use: deep_agent
            prompt: "Handle ${{ input.task }}."
            output:
              result_path: string
    default:
      do:
        - id: handle_unknown
          run: program
          cmd: ["bash", "-c", "echo 'Unhandled complexity'"]
```
