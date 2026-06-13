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

### Approval step timeout without `on_timeout`

**Symptom:** Approval step fails when timeout expires.

**Root cause:** Approval steps require `on_timeout` (`approve`/`reject`/`fail`/`escalate`) when `timeout` is set. Without it, the behavior is undefined.

**Fix:**
```yaml
- id: approve
  timeout: 24h
  approval:
    prompt: "Review and decide."
  on_timeout: reject
```

---

## Loop Errors

### `loop.last` is `undefined` on first iteration

**Symptom:** CEL expression like `loop.last.output.field` fails on iteration 0.

**Root cause:** `loop.last` is undefined (not null) on the first iteration. The `until` condition is only checked after iteration 0, but the condition must handle the initial state.

**Fix:** Guard with `loop.iter > 0`:
```yaml
until: loop.iter > 0 && loop.last.output.quality_ok
```

For prompt expressions, use ternary:
```yaml
${{ loop.iter == 0 ? "(first attempt)" : loop.last.output.feedback }}
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

*This list grows from real debugging failures. When you encounter a new error pattern not covered here, add an entry.*
