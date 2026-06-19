# Common Errors

Frequent authoring mistakes and runtime errors. Each entry shows the symptom, root cause, and fix.

---

## Expression Errors

### `No such key: <field>` on template evaluation

**Symptom:** A step fails at config/prompt evaluation time with `No such key: <field>`.

**Root causes:**

1. **Guard skips a step, but downstream expressions reference its output.**
   A `guard` with `else: complete` (or `else: fail`) may cause later steps to never execute. If `outputs:` or another step references `steps.<skipped_id>.output.<field>`, the key does not exist at evaluation time.

   **Fix:** Use `else: fail` (matching real workflow conventions) so the run fails cleanly instead of reaching unreachable output references. If early completion is intentional, do not reference the skipped step's output in `outputs:`.

2. **Fanout item schema mismatch.**
   When `fanout.over` references an agent output array, but the array items use different field names than the fanout body expects. For example, the agent returns `{name, focusArea}` but the body uses `item.topic` and `item.focus`.

   **Fix:** Declare a typed array schema so the agent knows the exact field names:
   ```yaml
   # Wrong — agent picks arbitrary field names
   output:
     topics: array

   # Correct — agent returns the exact fields
   output:
     topics: [{ topic: string, focus: string }]
   ```

3. **Loop output shape mismatch.**
   A loop node's `steps.<id>.output` is the last child step's output (not a struct with `iter` or `last` fields). `loop.iter` and `loop.last` are scope variables available only inside the loop body.

   **Fix:** Never reference `steps.<loop_id>.output.iter` or `steps.<loop_id>.output.last` outside the loop. If you need iteration count in `outputs:`, have the last loop body step include it in its output schema.

### `No such key: length` / `.length` on arrays

**Symptom:** Expression like `steps.<fanout_id>.output.length` fails.

**Root cause:** CEL does not support property-style `.length` on arrays.

**Fix:** Use `len()` — the Acpus-registered custom CEL function:
```yaml
# Wrong
${{ steps.review_topics.output.length }}

# Correct
${{ len(steps.review_topics.output) }}
```

### `EXPR_UNKNOWN_ROOT` warning on `size()`

**Symptom:** Compile-time warning that `size` is not part of the M1 DSL context.

**Root cause:** `size()` works at runtime (provided by the CEL library) but is not in Acpus's allowed function set. The runtime-registered function is `len()`.

**Fix:** Replace `size()` with `len()`.

### Object/array interpolated as `[object Object]`

**Symptom:** A prompt or `cmd` that embeds a whole step output renders literal `[object Object]` (or `[object Object],[object Object]` for an array of objects) instead of the data.

**Root cause:** Template interpolation `${{ ... }}` stringifies the result with `String()`. For a primitive that is correct, but an object or array becomes `[object Object]`. Referencing a composite value directly (e.g. a fanout's aggregated output, an agent's whole output object) hits this.

**Fix:** Wrap the value in `json()` to serialize it to a real JSON string (object keys are sorted for determinism):
```yaml
# Wrong — renders "[object Object],[object Object],..."
The dispatched reviews returned:
${{ steps.dispatch.output }}

# Correct — renders a JSON array string
The dispatched reviews returned:
${{ json(steps.dispatch.output) }}
```
Reach for a single scalar field (`${{ steps.x.output.count }}`) when you only need one value; use `json(...)` when you intentionally want the whole structure inline.

---

## Schema Errors

### `failureKind: "schema"` — extra fields in agent output

**Symptom:** Agent step fails schema validation after auto-retries exhausted.

**Root cause:** Output schema is strict by default — any field not declared in `output:` causes validation failure. Agents may return extra fields (reasoning, metadata, etc.).

**Fix:** Only declare fields you need in `output:`. The prompt should say "Output schema is strict — no extra fields allowed." If the agent still adds extras, simplify the output shape.

### `failureKind: "capture"` — Program Step stdout not JSON

**Symptom:** `capture: { from: stdout, parse: json }` fails because stdout is not valid JSON.

**Root cause:** Program step printed non-JSON output (log messages, progress, etc.) before the JSON line.

**Fix:** Ensure the script only prints one JSON object to stdout. Send diagnostics to stderr:
```yaml
cmd:
  - bash
  - -c
  - |
    set -euo pipefail
    echo "working..." >&2   # stderr — not captured
    printf '{"result":"ok"}'  # stdout — captured as JSON
```

---

## Interpolation Errors

### Bash variable interpolation into inline scripts

**Symptom:** Python or Node.js inline script receives wrong values, or the script crashes with syntax errors.

**Root cause:** Bash variable interpolation into `python3 -c "…$VAR…"` or `node -e "...$VAR..."` breaks when the value contains spaces, quotes, or special characters.

**Fix:** Pass values via `sys.argv` / `process.argv` instead:
```yaml
# Wrong
cmd:
  - bash
  - -c
  - |
    python3 -c "import json; print(json.dumps({\"path\": \"$OUT\"}))"

# Correct
cmd:
  - bash
  - -c
  - |
    python3 - "$OUT" <<'PYEOF'
    import json, sys
    print(json.dumps({"path": sys.argv[1]}))
    PYEOF
```

### `${{ }}` step output interpolated into a `cmd` breaks the shell

**Symptom:** A Program Step fails with `failureKind: "exit"` and stderr like
`bash: -c: line 1: syntax error near unexpected token '('` (or near `"`, `&`,
backticks, etc.). Common when embedding a whole step output, a `json(...)` blob,
or any free-text agent/operator value (a reviewer's feedback, a signal's notes).

**Root cause:** Acpus expands `${{ ... }}` **before** the shell runs, splicing
the value straight into the command text. Shell metacharacters in that value —
`(`, `)`, `"`, `'`, `;`, `&`, `` ` `` — then get parsed as shell syntax. This is
different from the bash `$VAR` case above: the unsafe content is injected by
Acpus templating, so a heredoc + `sys.argv` does NOT help (the `${{ }}` in the
argv position is substituted before bash ever sees it).

**Fix:** Route `${{ }}` values through `env:` (template-evaluated and passed to
the subprocess as environment strings — never parsed by the shell), and read
them with `os.environ` / `process.env`:
```yaml
# Wrong — JSON with () and " breaks `bash -c`
cmd:
  - bash
  - -c
  - |
    python3 - "${{ json(steps.dispatch.output) }}" <<'PY'
    import json, sys
    print(json.loads(sys.argv[1]))
    PY

# Correct — the value never touches the shell
env:
  OUTCOME: "${{ json(steps.dispatch.output) }}"
cmd:
  - bash
  - -c
  - |
    python3 <<'PY'
    import json, os
    print(json.loads(os.environ["OUTCOME"]))
    PY
```

---

## Timeout Errors

### `timeout: 300` means 300 milliseconds

**Symptom:** Step times out almost immediately.

**Root cause:** `timeout` is in **milliseconds** when a number. `300` = 0.3 seconds.

**Fix:** Use string duration syntax for readability:
```yaml
# Wrong — 300ms, almost certainly a mistake
timeout: 300

# Correct — 5 minutes
timeout: 300000
# or
timeout: 5m
```

### Signal Node timeout without `on_timeout`

**Symptom:** Signal Node fails to compile, or fails when timeout expires.

**Root cause:** Signal Nodes with a `timeout` require `on_timeout` (`fail` or `default`). With `default`, a literal `default` payload is also required (and is validated against the declared `output` schema at compile time).

**Fix:**
```yaml
- id: gate
  run: signal
  prompt: "Review and decide."
  output:
    approved: boolean
  timeout: 24h
  on_timeout: default
  default:
    approved: false
```

---

## Loop Errors

### `loop.last` is `undefined` on first iteration

**Symptom:** CEL expression like `loop.last.field` fails on iteration 0.

**Root cause:** `loop.last` is undefined (not null) on the first iteration. The `until` condition is only checked after iteration 0, but the condition must handle the initial state.

**Fix:** Guard with `loop.iter > 0`:
```yaml
until: loop.iter > 0 && loop.last.quality_ok
```

For prompt expressions, use ternary:
```yaml
${{ loop.iter == 0 ? "(first attempt)" : loop.last.feedback }}
```

---

## Fanout Errors

### Fanout `key` collision

**Symptom:** Fewer lanes than expected; some items are merged.

**Root cause:** `key` is used to identify lanes. If two items produce the same key (e.g., same `item.topic` value), they merge into one lane.

**Fix:** Include `item_index` in the key for uniqueness:
```yaml
fanout:
  over: steps.identify.output.topics
  key: "${{ item_index }}-${{ item.topic }}"
```

---

## Agent Errors

### Agent runs in the wrong directory

**Symptom:** An agent that should edit / inspect another repository instead
operates on the host project. Telemetry shows `cwd` pointing at the workspace
root, not your `target_path`. The reviewer "sees" unrelated files; the
implementer's edits land nowhere you expect.

**Root cause:** No `cwd` was set, so the agent defaults to the executor process
working directory.

**Fix:** `cwd` can be set either on the agent definition (a default for every
step using that agent) or on the individual `run: agent` step (overrides the
agent default for that step only). A step-level `cwd` is the right tool when one
agent is reused across several target directories. Program steps support `cwd`
too. All forms are template-evaluated against the step context, so they can read
`input.*` and prior `steps.*`:
```yaml
agents:
  implementer:
    use: pi
    cwd: "${{ input.target_path }}"   # default for every step using `implementer`

workflow:
  steps:
    - id: edit_other_repo
      run: agent
      use: implementer
      prompt: "..."
      cwd: "${{ input.other_repo }}"  # overrides the agent default for this step
```
Resolution order for a `run: agent` step is: step `cwd` → agent-definition
`cwd` → process working directory.

To make one step opt OUT of an agent's default `cwd` and run in the process
working directory, set `cwd: ""` (or a template that renders empty) on that step
— a declared-but-empty `cwd` resolves to the process cwd and skips the agent
default. `cwd` must be a string; a non-string value (`cwd: 123`) is a lint error.

### Switch/parallel/pipeline references a sibling via the composite id

**Symptom:** `Failed to evaluate ... template: No such key: <composite_id>` for a
node inside a `switch` case, `parallel` branch, or `pipeline` that references an
earlier sibling in the same scope.

**Root cause:** Inside a branch or pipeline, sibling nodes are referenced by
their own id (`steps.<sibling_id>.output`), not through the enclosing composite
(`steps.<switch_id>.<sibling_id>.output`). The composite's own `steps.<id>`
value does not exist until the composite completes.

**Fix:**
```yaml
- id: route
  switch:
    cases:
      - when: steps.review.output.approved
        do:
          - id: human_gate
            run: signal
            prompt: "..."
            output: { approved: boolean, notes: string }
          - id: normalize
            run: program
            env:
              # Wrong: steps.route.human_gate.output.approved  → No such key: route
              # Right: reference the sibling directly
              APPROVED: "${{ steps.human_gate.output.approved }}"
            cmd: ["bash", "-c", "..."]
```
Outer / earlier scopes (e.g. `steps.review`, `steps.prepare`, `input`) ARE
visible from inside a branch; only the not-yet-produced composite self-reference
is not.

### Pipeline `outputs` references an unknown or not-yet-executed child

**Symptom:** A `pipeline` node fails evaluating its `outputs` projection with
`No such key: <field>` or an unknown-step error.

**Root cause:** `pipeline.outputs` templates reference children of that pipeline.
A reference to a child id that does not exist, or a field path the child does not
declare, fails at projection time (after children complete).

**Fix:** Reference only real pipeline children, and use closed-schema field
paths the child declares:
```yaml
- id: setup_and_validate
  pipeline:
    - id: validate
      run: program
      output: { ready: boolean }
      cmd: ["bash", "-c", "..."]
  outputs:
    # Wrong: steps.setup_and_validate.validate.output.ready → No such key: setup_and_validate
    # Right: reference the child directly
    ready: "${{ steps.validate.output.ready }}"
```

---

*This list grows from real debugging failures. When you encounter a new error pattern not covered here, add an entry.*
