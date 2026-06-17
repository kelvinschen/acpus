# Expressions And Outputs

Acpus evaluates expressions with `@marcbachmann/cel-js` and adds a small set of Acpus-specific context roots and helper functions. CEL is for deterministic value selection and control flow, not for file I/O, shell execution, randomness, or wall-clock reads.

## CEL vs Template Interpolation

Use raw CEL where Acpus expects an expression:

```yaml
- id: require_changes
  guard:
    when: steps.collect.output.changed_file_count > 0
    then: continue
    else: fail

- id: repair
  loop:
    until: loop.iter > 0 && loop.last.output.ok
    do: [...]

- id: review_files
  fanout:
    over: steps.plan.output.items
    key: "${{ item.id }}"
    do: [...]
```

Use `${{ ... }}` inside text templates:

```yaml
prompt: |
  Review ${{ input.target }} using report ${{ steps.prepare.output.report_path }}.

cmd: ["node", "${{ workflow.source_dir }}/scripts/helper.mjs"]
key: "${{ item.id }}"
message: "No files changed for ${{ input.target }}"
```

Do not wrap `when`, `until`, or expression-valued `over` in `${{ ... }}`.

## Context Roots

These roots are available to CEL and `${{ }}` templates:

```yaml
input.<key>          # validated workflow input, including defaults
steps.<id>.output   # primary output envelope for a prior visible Node
steps.<id>.exit_code # Program Step exit code
workflow.<field>    # frozen Workflow Spec metadata
run_id              # current Run id
```

Composite body scopes add these local roots:

```yaml
loop.iter       # zero-based loop iteration
loop.last       # previous loop body final child output, absent on first iteration
item            # current fanout item
item_id         # rendered fanout key, or item index when no key is declared
item_index      # zero-based fanout item index
```

`workflow` exposes metadata from the frozen Workflow Spec:

```yaml
workflow.name
workflow.description
workflow.source_path
workflow.source_dir
```

Use `workflow.source_dir` when a spec needs helper scripts stored beside the spec. It is explicit and does not change the default Program or Agent working directory behavior.

## CEL Operators And Literals

Acpus relies on `cel-js` for CEL syntax. Common supported CEL forms include:

```cel
true
false
null
"text"
123
[1, 2, 3]
{"kind": "review", "count": 2}
input.files[0]
steps.plan.output.items
"admin" in input.roles
```

Common operators:

```cel
a == b
a != b
a < b
a <= b
a > b
a >= b
cond ? "yes" : "no"
!ready
ready && changed
ready || forced
1 + 2
count - 1
count * 2
count / 2
count % 2
```

Map/list/string access uses CEL field and index syntax:

```cel
input.target_path
steps.collect.output.files[0]
workflow.source_dir + "/scripts/helper.mjs"
```

`loop` is an Acpus logical root. Internally it is rewritten before parsing because `loop` is reserved in some CEL parser positions; author specs should still write `loop.iter` and `loop.last`.

## Functions

Acpus registers these top-level helper functions:

```cel
now()                         # deterministic workflow clock as string
len("abc")                    # 3
len(steps.plan.output.items)  # list length
startsWith(input.branch, "release/")
matches(input.path, "\\.ts$")
coalesce(input.optional, "fallback")
coalesce(input.a, input.b, "fallback")
json(steps.plan.output)       # deterministic JSON string, sorted object keys
```

Notes:

- `now()` is fixed for the workflow execution clock; do not use wall-clock APIs in scripts to make expression decisions.
- `len()` is an Acpus alias for string/list length. `cel-js` also supports CEL's built-in `size(...)` and receiver `.size()` forms.
- `json(value)` is the safe way to embed objects or arrays in prompts or env values. Without it, JavaScript stringification may produce `[object Object]`.
- `matches(string, pattern)` returns `false` for invalid regular expressions.
- `coalesce(...)` treats only `null` and `undefined` as absent; empty string, `0`, and `false` are real values.

`cel-js` also provides standard CEL conversions and receiver methods such as:

```cel
string(123)
int("42")
double("3.14")
bool("true")
size(input.files)
input.name.startsWith("A")
input.path.endsWith(".md")
input.path.contains("/docs/")
input.name.lowerAscii()
input.name.upperAscii()
input.name.trim()
input.path.matches("\\.tsx?$")
["a", "b"].join(",")
```

Prefer the Acpus helpers above when they are documented for workflow specs; other `cel-js` built-ins follow `@marcbachmann/cel-js` behavior and may surface parser/type errors directly.

## List Macros

`cel-js` supports CEL list macros. They are useful in `when`, `until`, and expression-valued `over`:

```cel
input.files.exists(path, path.endsWith(".ts"))
input.files.all(path, path.startsWith("src/"))
input.files.exists_one(path, path == "README.md")
input.files.filter(path, path.endsWith(".md"))
input.files.map(path, {"path": path, "kind": "doc"})
input.files.map(path, path.endsWith(".ts"), path)
has(input.optional_field)
```

Macros introduce local variable names inside the macro call. Static validation is conservative around macro locals: it may not prove every field path, but runtime evaluation still follows CEL semantics.

## Placement Rules

Raw CEL fields:

```yaml
guard:
  when: steps.collect.output.changed_count > 0

loop:
  until: loop.iter >= input.max_rounds || loop.last.output.done

fanout:
  over: input.files.filter(path, path.endsWith(".ts"))
```

Template fields:

```yaml
cmd: ["node", "${{ workflow.source_dir }}/scripts/helper.mjs"]
prompt: "Review ${{ input.target }} using ${{ steps.collect.output.report_path }}"
env:
  PLAN_JSON: "${{ json(steps.plan.output) }}"
```

Do not put `${{ }}` around raw CEL fields. Do not put whole objects or arrays directly into `cmd`; route structured data through `env` with `json(...)` and parse it in the script.

## Step Output Shapes

All Nodes expose their primary produced value through an `output` envelope:

```yaml
steps.review.output.ready
steps.collect.output.report_path
steps.collect.exit_code
```

```yaml
# parallel is a record keyed by branch id
steps.review_parallel.output.contract.output.report_path
steps.review_parallel.output.tests.output.report_path

# fanout is an array of successful lane outputs
steps.research_lanes.output[0].output.report_path

# guard decision fields are inside output
steps.require_ready.output.matched
steps.require_ready.output.action

# signal node output is exactly the injected payload object
steps.human_gate.output.approved
steps.human_gate.output.target
```

Use `steps.<id>.output` consistently for every Node's primary produced value. Program Steps also expose `steps.<id>.exit_code`.

## Output Schema Shape

Keep output schemas shallow:

```yaml
output:
  report_path: string
  risk_count: integer
  ready: boolean
```

Use outputs as the workflow control surface. Keep booleans, decisions, counts, ids, and durable paths there only when another step, final output, or the user needs them.

Avoid returning full reports, detailed findings, risk lists, implementation rationales, nested transcript fragments, or intermediate chain-of-thought-like material. Write those to report or handoff files and output the file path.
