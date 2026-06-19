# Workflow Spec Schema Reference

Compact full-schema reference for AI agents authoring or validating Acpus Workflow Spec YAML. Every field, constraint, and interaction defined here is enforced by the compiler (structural) or runtime (behavioral). No prose — just the schema.

## Top-Level Shape

```yaml
version: 1               # required, MUST be 1
name: <string>           # required
description: <string>    # optional
input: <SchemaDSL>       # optional, compiled to JSON Schema
agents: <AgentMap>       # optional, keyed by agent name
workflow:                # required
  steps: <Step[]>        # required, ordered list of Nodes
outputs: <StringMap>     # optional, ${{ }} templates evaluated after root scope
```

Additional top-level keys are rejected (`additionalProperties: false`).

## Schema DSL

Acpus Schema DSL is a YAML-native shorthand compiled to JSON Schema at compile time. Used in `input:`, `output:` on all step types, and `signal.default`.

### Field Shorthand

```yaml
field: string            # required string
field?: string           # optional string ("?" suffix)
field: integer            # integer
field: number             # float
field: boolean            # bool
field: string = "hello"   # default value → implicitly optional
field: integer = 5        # default integer
field: boolean = true     # default boolean
field: string = null      # default null
```

Type aliases: `int`→`integer`, `str`→`string`, `bool`→`boolean`, `num`→`number`. Case-insensitive.

### Object Form

```yaml
field:
  type: string
  required: true          # overrides key-suffix and default-value requiredness
  default: "hello"
  description: "doc"      # string only
```

Object form keys are restricted to `type`, `required`, `default`, `description`. `items`, `properties`, `elements` are explicitly rejected.

### Nested Objects

```yaml
metadata:                 # no "type" key → nested object
  title: string
  tags: [string]          # array of strings
```

### Arrays

```yaml
tags: [string]            # array of strings
items: [{ name: string }] # array of objects
nested: [[string]]        # array of arrays of strings
```

### Compilation Rules

- All object types get `additionalProperties: false` (closed objects).
- A field with a default value is omitted from `required` unless `required: true` is set.
- The `?` suffix makes a field optional regardless of defaults.
- Default values are parsed: integers, floats, `true`/`false`/`null`, quoted strings, bare strings.

## Agents

```yaml
agents:
  <name>:
    type: builtin           # default, or "command"
    use: <string>           # required — acpx adapter name or launch command
    model: <string>         # optional
    cwd: <any>              # optional, runtime-coerced
    env: <object>           # optional, free-form string→string
    policy: read | full     # default: full
```

- `type: builtin` — `use` names an acpx built-in adapter (`pi`, `claude`, `codex`).
- `type: command` — `use` is an ACP server launch command via acpx `--agent`.
- `policy: read` — agent can only read/search; write tool calls fail.
- `policy: full` — all operations allowed.

Agent definitions are merged with Agent Overrides at Run creation; the frozen IR stores the effective agent definition per step.

## Steps

Every step is an object with a required `id`:

- `id: <string>` — required, non-empty, no colons (`:`), unique within the spec after include expansion.

### Step Kind Dispatch

A step MUST match exactly one of these shapes (enforced by `oneOf`):

| Discriminator | Kind |
|---|---|
| `run: agent` | Agent Step |
| `run: program` | Program Step |
| `run: signal` | Signal Node |
| `parallel: [...]` | Parallel |
| `fanout: {...}` | Fanout |
| `switch: {...}` | Switch |
| `loop: {...}` | Loop |
| `guard: {...}` | Guard |
| `subworkflow: <path>` | Subworkflow |
| `include: <path>` | Include (compile-time expansion) |

### Common Fields

These fields are valid on Agent and Program steps. Signal steps only support `timeout` (see Signal Node section).

```yaml
timeout: <duration | number>    # string "5m"/"30s"/"1h"/"500ms" or number (ms)
on_error: fail | retry | skip   # default: fail — Agent + Program only
retry:                          # Agent + Program only
  max: <integer ≥ 0>            # extra attempts after initial
  backoff: <duration>           # string, "5s"/"1m" etc.
```

### Agent Step (`run: agent`)

```yaml
- id: <string>
  run: agent
  use: <string>            # required — references an agent name in top-level agents
  prompt: <string>         # required — ${{ }} template
  cwd: <string>            # optional — template, overrides agent default cwd
  session_key: <string>    # optional — template, session-sharing key
  output: <SchemaDSL>      # optional — compiled output schema
  retry:                   # optional
    max: <integer ≥ 0>
    backoff: <duration>
  timeout: <duration|number>
  on_error: fail | retry | skip
  policy: read | full      # optional — overrides agent-level policy
```

- `use` MUST reference an agent declared in top-level `agents`.
- `session_key` allows explicit session sharing between materialized Agent Steps in the same Run. When absent, session identity is derived from Run id + Node Key.
- `cwd: ""` (empty string) bypasses the agent default `cwd` and uses the executor process working directory.
- `output` schema compiles to JSON Schema. Parse/schema failures trigger auto-retry (default `retry.max: 2` when `output` is present and no explicit `retry`).

### Program Step (`run: program`)

```yaml
- id: <string>
  run: program
  cmd: <string | string[]>  # required — string = shell, array = no shell
  env: <object>             # optional — added to subprocess env
  cwd: <string>             # optional — template, subprocess working dir
  capture:                  # optional
    from: stdout | file
    parse: json | text
    path: <string>          # required when from: file
  expect:                   # optional, default: { exit_code: [0] }
    exit_code: <integer[]>  # non-empty, values ≥ 0
  output: <SchemaDSL>       # optional — requires capture.parse: json
  retry:
    max: <integer ≥ 0>
    backoff: <duration>
  timeout: <duration|number>
  on_error: fail | retry | skip
```

- `cmd` as string → shell execution. As array → direct exec, no shell expansion.
- `expect.exit_code` allow-lists exit codes. Non-allow-listed codes fail the node with `failureKind: "exit"`.
- `capture.from: file` resolves `capture.path` relative to the resolved `cwd`.
- `output` schema requires `capture.parse: json`.
- stdout/stderr always persisted as artifacts (`stdout.log`, `stderr.log`).
- Result exposed as `{ output, exit_code }` at `steps.<id>`.

### Signal Node (`run: signal`)

```yaml
- id: <string>
  run: signal
  prompt: <string>          # required — operator-facing description template
  output: <SchemaDSL>       # optional — validates injected payload
  timeout: <duration>         # optional — string only, no raw ms; requires on_timeout when set
  on_timeout: fail | default # required when timeout is set
  default: <object>          # required when on_timeout: default
```

- Blocks in `awaiting` state until an external JSON payload is injected via `acpus runs signal`.
- When `output` is declared, the injected payload is validated against it; non-conforming payloads are rejected and the node stays `awaiting`.
- `on_timeout: default` — on timeout, completes with the literal `default` payload. `default` is validated against `output` at compile time.
- `on_timeout: fail` — fails the node on timeout.
- `output: {}` (empty map) means accept any object without validation.
- Result exposed as `{ output: <injected payload> }` at `steps.<id>`.

### Parallel

```yaml
- id: <string>
  join: all | race        # default: all
  max_concurrency: <integer ≥ 1>
  parallel:
    - id: <string>
      # ... full step (any kind)
    - id: <string>
      # ... full step
```

- `steps.<id>.output` is a **record keyed by branch id**.
- `join: all` — fail-fast on first branch failure; cancels remaining branches.
- `join: race` — first branch to complete wins; output is a single-key map.
- Access pattern: `steps.<parallel_id>.output.<branch_id>.output.<field>`. Note the extra `.output.` layer — parallel is a map of branch ids, and each branch's value is that branch's step envelope, so you need `.output.<branch_id>.output.<field>`. Accessing `steps.<parallel_id>.<branch_id>.output.<field>` (without the first `.output.`) is a common mistake.

### Fanout

```yaml
- id: <string>
  fanout:
    over: <string | array>   # required — CEL expression or literal array
    key: <string>            # optional — ${{ }} template, default: item index
    join: all | race | quorum # default: all
    quorum: <integer ≥ 1>    # required when join: quorum
    max_concurrency: <integer ≥ 1>
    success_criteria:
      min_success: <integer ≥ 1>
    do:                       # required
      - id: <string>
        # ... full step
```

- `over` is raw CEL when it's a string referencing another output. Literal arrays are coerced to JSON strings in IR.
- `over` array elements MUST be primitives (string, number, boolean, null) — no objects or nested arrays.
- Body locals: `item` (current element), `item_id` (rendered key or index), `item_index` (zero-based).
- `steps.<id>.output` is an **array** of successful lane outputs.
- `join: all` — fail-fast on first lane failure; `join: race` / `join: quorum` — capture failed lanes, don't abort.
- `success_criteria.min_success` — how many successful lanes needed for overall success. Default: `all`→all lanes, `race`→1, `quorum`→`quorum`. Only use `quorum`/`success_criteria` when partial success is acceptable.
- `key` is a template — supports `${{ item.<field> }}`.

### Switch

```yaml
- id: <string>
  switch:
    cases:
      - when: <string | boolean>  # raw CEL or boolean literal
        do:
          - id: <string>
            # ... full step
    default:                # optional
      do:
        - id: <string>
          # ... full step
```

- Cases evaluated in order; first truthy match wins.
- No default → unmatched cases fail the node.
- `steps.<id>.output` is the selected branch's final child step value (`selected` projection).
- `when` as boolean literal is coerced to string at compile time.

### Loop

```yaml
- id: <string>
  loop:
    until: <string | boolean>  # raw CEL, checked after at least one iteration
    max_iterations: <number>   # required
    do:
      - id: <string>
        # ... full step
```

- `loop.iter` — zero-based iteration counter.
- `loop.last` — previous iteration body final child step value (absent/undefined on first iteration).
- `until` is checked after the body completes; always runs at least once.
- `until` as boolean literal is coerced to string at compile time.
- `steps.<id>.output` is the last iteration's final child step value (`last` projection).

### Guard

```yaml
- id: <string>
  guard:
    when: <string | boolean>  # required — raw CEL
    then: continue | fail | complete  # required
    else: continue | fail | complete  # required
    message: <string>         # optional — ${{ }} template, failure message
```

- `continue` — complete guard, continue to next sibling in scope.
- `fail` — fail the guard node with `message` (or `Guard '<id>' failed`).
- `complete` — complete guard AND complete the current scope (skip later siblings). Inside a fanout lane or parallel branch, this affects only that lane/branch. At the root scope, it completes the entire Run.
- `steps.<id>.output` contains `{ matched: boolean, action: string, message?: string }`.
- `when` as boolean literal is coerced to string at compile time.

### Subworkflow

```yaml
- id: <string>
  subworkflow: <string>    # path to another Workflow Spec
  input: <object>          # optional — free-form, ${{ }} templates evaluated
```

- Referenced spec is compiled and executed at runtime.
- `steps.<id>.output` is the child spec's evaluated top-level `outputs`.
- Child spec's `workflow.*` context is scoped to the child, not the parent.

### Include (compile-time)

```yaml
- include: <path>          # path to another Workflow Spec
```

- Expanded at compile time — the included spec's `workflow.steps` are inlined.
- Requires an include resolver (provided by the CLI).
- Cycle detection: re-including the same path is rejected.
- Included steps inherit the parent's `workflow.*` context.

## Expressions

### Syntax

Two forms, never mix them:

| Form | Syntax | Used In |
|---|---|---|
| **Template** | `${{ <expr> }}` | `prompt`, `cmd`, `key`, `message`, `env` values, `session_key`, `cwd`, `subworkflow.input`, `outputs` |
| **Raw CEL** | bare expression | `when`, `until`, `over` (expression-valued) |

Do NOT wrap raw CEL fields in `${{ }}` — the compiler warns for `when`, `until`, and `over`.

### Context Roots

```cel
input.<key>              # validated workflow input
steps.<id>.output.<path> # primary output of a visible prior step
steps.<id>.exit_code     # Program Step exit code (integer)
workflow.name            # spec name
workflow.description     # spec description (empty string if absent)
workflow.source_path     # absolute path to spec file (empty string if none)
workflow.source_dir      # directory of spec file (empty string if none)
run_id                   # current Run id (string)
```

Scope-local roots (only available inside their composite body):

```cel
loop.iter       # zero-based iteration (loop body only)
loop.last       # previous iteration body value (loop body only)
item            # current fanout element (fanout body only)
item_id         # rendered fanout key (fanout body only)
item_index      # zero-based fanout index (fanout body only)
```

### Functions

```cel
now()                                    # deterministic workflow clock string
len(x)                                   # string length or list length
startsWith(s, prefix)                    # boolean
matches(s, regex)                        # boolean (false on invalid regex)
coalesce(a, b, ..., fallback)            # first non-null, non-undefined
json(value)                              # deterministic JSON string (sorted keys)
```

`cel-js` built-ins also available: `string()`, `int()`, `double()`, `bool()`, `size()`, `.startsWith()`, `.endsWith()`, `.contains()`, `.lowerAscii()`, `.upperAscii()`, `.trim()`, `.matches()`, `.join()`, list macros (`exists`, `all`, `exists_one`, `filter`, `map`, `has`).

### Step Visibility

Steps can reference only **previously executed** sibling steps (sequential visibility). Within a loop body, all body steps are mutually visible (relaxed to avoid false positives). Parallel branches and fanout lanes cannot see each other; switch cases cannot see each other.

### Composite Output Shapes

| Node Kind | `steps.<id>.output` shape | Notes |
|---|---|---|
| `run.agent` | `{ <schema fields> }` | Validated against declared schema |
| `run.program` | `{ <schema fields> }` | Validated against declared schema |
| `run.signal` | `{ <injected fields> }` | The injected payload object |
| `parallel` | `{ <branch_id>: { output, ... } }` | Map keyed by branch id |
| `fanout` | `[{ output, ... }, ...]` | Array of successful lane outputs |
| `switch` | `{ output, ... }` (selected branch's final child) | Selected projection |
| `loop` | `{ output, ... }` (last iteration's final child) | Last projection |
| `guard` | `{ matched, action, message? }` | Decision envelope |
| `subworkflow` | `{ <output keys> }` | Child spec's evaluated outputs |
| `pipeline` | opaque | Root implicit pipeline |

### Static Validation

The compiler validates expressions at compile time:

- **Closed-schema field paths**: `steps.<id>.output.<field>` is checked against the declared output schema; unknown fields are errors.
- **Input field paths**: `input.<field>` is checked against the compiled input schema.
- **Workflow metadata**: `workflow.<field>` is checked against the known metadata fields.
- **Fanout item**: `item.<field>` is checked against the element schema when `over` resolves to a typed array.
- **Scope**: `loop`, `item`, `item_id`, `item_index` outside their composite body are errors.
- **Step visibility**: referencing a later sibling or sibling-branch step is an error.
- **Non-scalar in cmd**: object/array values spliced into `cmd` produce a warning (use `env:` + `json()` instead).

Validation is fail-quiet: any shape that cannot be determined statically is silently accepted.

## Outputs

```yaml
outputs:
  <key>: <string>    # ${{ }} template, evaluated after root scope completes
```

- Evaluated after the root workflow scope completes successfully.
- If evaluation fails, the Run fails.
- Each value is a template string; the result becomes the Run's public output.

## Retry

```yaml
retry:
  max: <integer ≥ 0>     # extra attempts after initial execution
  backoff: <duration>    # string, e.g. "5s", "1m"
```

- `retry.max: 0` disables retry.
- Agent Steps with `output` present default to `retry.max: 2` for parse/schema failures when no explicit `retry` is declared.
- `backoff` is the delay between retry attempts.

## Timeout

```yaml
timeout: <duration | number>
```

- String: duration format — `(\d+)(ms|s|m|h)?`, e.g. `"30s"`, `"5m"`, `"2h"`, `"500ms"`. Bare numbers (e.g. `"500"`) are also accepted and treated as milliseconds.
- Number: milliseconds (positive).
- Signal nodes: `timeout` requires `on_timeout`; compiler validates this cross-field dependency.

## Error Codes

Compiler diagnostic codes emitted during validation:

| Code | Meaning |
|---|---|
| `SPEC_SHAPE` | Generic structural error |
| `SPEC_VERSION` | `version` must be `1` |
| `STEP_ID` | Missing or invalid step id |
| `STEP_ID_DUPLICATE` | Duplicate step id |
| `STEP_ID_COLON` | Step id contains `:` |
| `STEP_KIND` | No matching step kind |
| `STEP_SHAPE` | Unknown step property |
| `STEP_TIMEOUT` | Invalid timeout format |
| `STEP_ON_ERROR` | Invalid `on_error` value |
| `AGENT_SHAPE` | Invalid agent definition |
| `AGENT_REF` | `use` references unknown agent |
| `AGENT_PROMPT` | Missing agent prompt |
| `PROGRAM_CMD` | Missing program cmd |
| `CAPTURE_SHAPE` | Invalid capture object |
| `CAPTURE_FROM` | Invalid `capture.from` |
| `CAPTURE_PARSE` | Invalid `capture.parse` |
| `CAPTURE_PATH` | Missing `capture.path` when `from: file` |
| `RETRY_SHAPE` | Invalid retry spec |
| `FANOUT_OVER` | Missing `fanout.over` |
| `FANOUT_DO` | Missing or invalid `fanout.do` |
| `FANOUT_QUORUM` | Missing `quorum` when `join: quorum` |
| `FANOUT_OVER_TYPE` | Non-primitive in `over` array |
| `FANOUT_SUCCESS_CRITERIA` | Invalid `success_criteria` |
| `JOIN_VALUE` | Invalid `join` value |
| `LOOP_MAX_ITERATIONS` | Missing `max_iterations` |
| `LOOP_UNTIL_TYPE` | Invalid `until` type |
| `SWITCH_CASE` | Invalid switch case entry |
| `SWITCH_CASES` | `switch.cases` must be an array |
| `SWITCH_WHEN_TYPE` | Invalid `when` type in switch case |
| `GUARD_WHEN` | Missing `guard.when` |
| `GUARD_WHEN_TYPE` | Invalid `when` type |
| `GUARD_ACTION` | Invalid `then`/`else` value |
| `GUARD_MESSAGE` | Invalid `message` type |
| `SIGNAL_TIMEOUT` | Invalid signal timeout format |
| `SIGNAL_ON_TIMEOUT` | Missing `on_timeout` when `timeout` is set |
| `SIGNAL_DEFAULT` | Missing/invalid `default` when `on_timeout: default` |
| `OUTPUT_SHAPE` | Invalid output schema |
| `OUTPUT_REQUIRES_JSON` | `output` requires `capture.parse: json` |
| `INPUT_SHAPE` | Invalid input schema |
| `EXPR_PARSE` | CEL parse error |
| `EXPR_EMPTY` | Empty expression |
| `EXPR_UNKNOWN_ROOT` | Unknown context root or function |
| `EXPR_UNKNOWN_STEP` | Unknown or invisible step reference |
| `EXPR_UNKNOWN_FIELD` | Unknown field on schema |
| `EXPR_ROOT_OUT_OF_SCOPE` | Scoped local used outside its body |
| `EXPR_NONSCALAR_IN_CMD` | Non-scalar value in `cmd` (warning) |
| `EXPR_TEMPLATE_IN_CEL` | `${{ }}` in raw CEL field (warning) |
| `INCLUDE_CYCLE` | Include cycle detected |
| `INCLUDE_RESOLVER` | No include resolver provided |
| `INCLUDE_RESOLUTION` | Include resolution error |
| `INCLUDE_SHAPE` | Included spec is not a valid workflow |
| `YAML_PARSE` | YAML parse error |
| `JSON_SCHEMA_SHAPE` | Compiled schema not a valid JSON Schema |
| `JSON_SCHEMA_INVALID` | Invalid JSON Schema |

## Constraints Summary

- `id` must be non-empty, no colons, unique after include expansion.
- `version` must be `1`.
- Every step must match exactly one kind.
- `fanout.over` array elements must be primitives.
- `fanout` with `join: quorum` requires `quorum`.
- `program` with `output` requires `capture.parse: json`.
- `capture.from: file` requires `capture.path`.
- `signal` with `timeout` requires `on_timeout`.
- `signal` with `on_timeout: default` requires `default`.
- `signal.default` is validated against `output` schema at compile time.
- `session_key` is only valid on `run: agent` steps.
- `${{ }}` must not wrap raw CEL fields (`when`, `until`, `over`).
- Step references must be to visible (previously executed) steps.
- `retry.backoff` and `timeout` strings must match `(\d+)(ms|s|m|h)?`.
- All object types in compiled schemas are closed (`additionalProperties: false`).
