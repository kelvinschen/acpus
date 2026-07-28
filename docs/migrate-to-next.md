# Migrate to Acpus 0.6

> [!IMPORTANT]
> Acpus 0.6 is a TypeScript-first foundation rewrite. It is not a compatibility release
> for the 0.5 YAML Workflow-Spec product. Migrate one workflow at a time,
> keep the 0.5 workflow available until the replacement has been checked and
> exercised, and verify current behavior against [`specs/`](../specs/INDEX.md),
> `acpus --help`, and `acpus workflow check`.

Acpus 0.6 keeps the durable-workflow goal, but changes the authoring model. A
0.5 workflow cannot be made into a 0.6 workflow by changing the extension
from `.yaml` to `.ts`. The graph, runtime value flow, local execution boundary,
and several control semantics must be re-authored deliberately.

There is no promised YAML compatibility shim, automatic converter, or 0.5
run-state importer. The current CLI accepts TypeScript workflow modules and
TypeScript workflow packages; it does not execute 0.5 Workflow-Spec YAML.

## The new mental model

### `build` declares a graph; it does not run the workflow

A 0.6 workflow is a TypeScript module built with
`defineWorkflow(...).build(...)`. Acpus executes the synchronous `build`
callback during workflow preparation to construct the authored graph. The
runtime executes that frozen graph later.

That split is the most important concept in the migration:

```text
TypeScript module
  -> build declares nodes, scopes, and dependencies
  -> Acpus checks, compiles, and validates WorkflowIR
  -> runtime admits and executes a durable run
```

Inside `build`, `input`, `meta`, fanout items, loop state, and node outputs are
not ordinary values. They are typed `Expr<T>` tokens that mean “a `T` will be
available when this run reaches this point.”

Consequently, runtime values must not be used with author-time JavaScript
control or operators:

```ts
// Wrong: input.ready is Expr<boolean>, not boolean.
if (input.ready) {}

// Wrong: output.items is Expr<string[]>, not string[].
const count = result.output.items.length;
```

Use the operation that matches the intent:

| Intent | 0.6 authoring surface |
| --- | --- |
| Render text | `template` or dedented Markdown `md` |
| Project a known field | `node.output.field` |
| Transform or combine runtime values | `lift(...)` with explicit dependencies |
| Compare or combine predicates | `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `not`, `and`, `or` |
| Choose runtime graph structure | `step(...).if`, `.switch`, `.fanout`, or `.loop` |
| Perform local I/O or commands | a Task node |

`lift` is a value transformation, not an execution node. It has no independent
attempt, retry, artifact, cwd, or timeout. Use a Task when the work needs those
runtime boundaries.

### Authoring Agent, execution Agents, and Acpus have different jobs

- An Authoring Agent—or a human—writes and reviews `workflow.ts`.
- The workflow declares which ACP-compatible Agents, Tasks, Signals, and control
  nodes participate in the run.
- Acpus checks and freezes the authored graph, executes it, records durable
  state, and exposes inspection and recovery controls.

Agent-authored does not mean unchecked. Run `workflow check` after every
meaningful edit, and review important workflows before admission.

### Choose nodes by execution boundary

| Node | Use it for | Important boundary |
| --- | --- | --- |
| Agent | Research, judgment, implementation, critique, and synthesis | Runs through acpx over ACP; use a named `use` token or a raw ACP `command` |
| Task | Files, commands, dependencies, artifacts, and local computation that needs its own attempt | Trusted local TypeScript in a fresh Node process per attempt; it is not a sandbox or a purity guarantee |
| Signal | Durable external input such as approval or an operator decision | A schema-backed Signal accepts structured input; a schema-less Signal accepts a raw string |
| Assert | Fail the current execution path when a boolean workflow value is false | It has no output and is not a general Guard replacement |

Task outputs are inferred from `exec`; Task and composite nodes do not accept an
author-facing `outputSchema`. Pass runtime data through Task `input`. An inline
Task `exec` must be self-contained instead of capturing workflow or module
bindings.

## 0.5 and 0.6 at a glance

| Area | 0.5 | 0.6 | Migration consequence |
| --- | --- | --- | --- |
| Authoring file | YAML Workflow Spec | TypeScript module using `defineWorkflow(...).build(...)` | Re-author the workflow; do not mechanically rename the file |
| Runtime values | CEL and `${{ ... }}` strings | Typed `Expr<T>`, projections, predicates, `template` / `md`, and `lift` | Rewrite every value-flow expression and condition |
| Schemas | YAML-native Schema DSL | Supported Zod 4 subset lowered to `SchemaIR` | Replace input and Agent/Signal output declarations with `z` schemas |
| Workflow output | Top-level `outputs` map | The single durable value returned by `build` | Return the public output explicitly |
| Main leaves | Agent, Program, Signal | Agent, Task, Signal, Assert | Program-to-Task is a boundary redesign, not a rename |
| Local execution | Program command plus capture/output configuration | Typed Task `input` plus `exec`, `$`, and explicit artifacts | Move parsing and returned shape into TypeScript; do not add Task `outputSchema` |
| Agent definitions | `type: builtin` or `type: command`, plus `use` and `policy` | `{ use, model?, ... }` or `{ command, model?, ... }`, with `permissionMode` | Recheck identity and permission semantics rather than copying fields |
| Structured Agent result | YAML `output`; extra response fields persisted | Zod `outputSchema`; stored output is projected to the declared shape | Declare every field the workflow needs |
| Error policy | Authored `on_error` and `retry` / backoff on Agent and Program steps | No equivalent per-node authoring policy; operator recovery uses runtime retry/fork | Redesign skip/retry behavior instead of copying the fields |
| Composite surface | Pipeline, parallel, fanout, if, switch, loop, subworkflow, Guard | if, switch, parallel, fanout, loop, plus Assert | Guard and Subworkflow have no direct equivalent |
| Loop | `until`, `max_iterations`, `loop.iter`, and `loop.last` | Do-while transition `{ state, stop }` with `index`, `round`, and `state` | Model complete typed state and encode an explicit stopping bound |
| Signal timeout | `fail` or a default payload | `onTimeout: { message? }` fails the wait | `on_timeout: default` must be redesigned |
| Hooks | YAML injectors and events; injectors could prepend prompts or alter Program env | JSON event observers only; failures cannot change workflow state or output | Remove injector dependencies or move required context into workflow inputs/Tasks |
| Replay | Read-only topology replay command | No replay product surface | Use inspect for evidence, retry for the same frozen plan, and fork for a changed plan; none is a replay alias |
| Visualization | TUI and served visualizer | Compact CLI inspection, static offline HTML, and local Web operator console | Replace old visualization commands and operational habits |
| Catalog | YAML specs under catalog roots | `.acpus/workflows/<name>/workflow.ts` packages, with the directory and workflow names matching | Repackage catalog entries; YAML is not a valid 0.6 entry |
| Durable state | 0.5 `.acpus/state/...` layout | Per-workspace shards under `$HOME/.acpus/workspaces/<workspace-key>/runtime/` | Do not copy 0.5 state files; the current runtime creates its own database and run directories |

0.5 already had ACP Agents, frozen workflow state, pause/resume, retry,
Signal, fork, and visualization. Those are retained product foundations, not
capabilities that 0.6 invented. 0.6's main change is the typed authoring and
runtime boundary: TypeScript graph construction, `Expr<T>` value flow, typed
Tasks, current inspection surfaces, and compatibility-aware replacement fork.

## Map the workflow definition

### Inputs, Agents, and output

Translate the top-level contract first:

| 0.5 | 0.6 |
| --- | --- |
| `input:` | `inputSchema: z.object(...)` |
| `agents.<name>.type: builtin` plus `use` | `agents.<name>: { use: "..." }` |
| `agents.<name>.type: command` plus `use` | `agents.<name>: { command: "..." }` |
| Agent `policy: read` or `policy: full` | Review and choose `permissionMode: "approve-reads"`, `"approve-all"`, or `"deny-all"` |
| Top-level `outputs:` | The durable object/value returned from `build` |
| `run_id` / workflow metadata expressions | `meta.runId`, `meta.workflowPath`, `meta.workflowName`, `meta.workspaceDir` |

Only claim support for ACP-compatible Agents. A named `{ use: "..." }` value
must be available through acpx; use `{ command: "..." }` only for a raw ACP
server command without a named acpx token.

### Expressions and references

Keep a migration ledger for every 0.5 expression. A few common rewrites:

| 0.5 intent | 0.6 form |
| --- | --- |
| Interpolate `${{ input.topic }}` in a prompt | ``md`Review ${input.topic}``` |
| Read `${{ steps.review.output.ready }}` | `review.output.ready` |
| Compare two scalar runtime values | `eq(left, right)` or another predicate helper |
| Read `.length`, map/filter an array, compute text, or combine values | `lift(value, resolved => ...)` |
| Use a runtime boolean to select work | `step("route").if({ condition, then, else })` |
| Publish selected results | Return a durable object from the workflow/composite callback |

`lift` supports one to three positional dependencies; use one named object as a
structured dependency for more. Its callback must be an inline synchronous
arrow, must not capture external bindings, and must return JSON-compatible data.

### Agent, Program, Task, and Signal

An Agent step maps naturally only after its expressions and schema are migrated:

```ts
const review = step("review").agent({
  agent: agents.reviewer,
  outputSchema: ReviewOutput,
  prompt: md`Review ${input.topic}`,
});
```

Program-to-Task requires a design decision:

- Bind graph values through `input`.
- Put local logic in `exec` or an exported `task.define(...)` module.
- Use the Acpus-owned `$` wrapper for commands.
- Return durable data directly; output types come from the TypeScript return
  type.
- Write only meaningful artifacts with `artifact.write(...)`; do not assume
  0.5 Program stdout/stderr capture behavior.
- Treat the Task as trusted code with possible side effects. A fresh process per
  attempt prevents shared module globals across attempts; it does not make the
  Task deterministic or safe to reuse automatically.

For Signals, add an `outputSchema` whenever the payload is structured. A
schema-less 0.6 Signal expects a JSON string at the CLI boundary, not the
arbitrary JSON object accepted by a schema-less 0.5 Signal. 0.5
`on_timeout: default` has no direct 0.6 equivalent; redesign the decision path
or recover the failed wait with retry/fork.

## Map control flow deliberately

### Sequence, if, and switch

0.6 has no authored Pipeline node. A workflow or composite callback declares a
static scope and returns its single output. Each `step("id")` is a static node
declaration; ids remain static even inside fanout and loop callbacks because the
runtime derives distinct dynamic `nodeKey` values.

0.6 `if` requires both `then` and `else`. If a 0.5 `if` omitted `else`,
return `{}` explicitly from the 0.6 `else` callback when that branch is
control-only. 0.6 `switch` requires `default`, as 0.5 did.

### Parallel and fanout

Review join semantics instead of copying names:

- 0.6 `parallel` supports `strategy: "all" | "race"`. A 0.6 race returns
  `{ winner, result }` for the first successful branch and cancels the rest.
  0.5 parallel race did not cancel losing branches.
- 0.6 `fanout` supports `strategy: "all" | "quorum"`; quorum uses a runtime
  `count`. It does not expose 0.5 `race`, `key`, or independent
  `success_criteria` fields.
- `fanout all` preserves duplicate occurrences and returns results in ascending
  `itemIndex`. Quorum accepts successful outputs in completion order and cancels
  remaining work when the quorum is reached.
- `maxConcurrency` is a runtime value in 0.6. `0` or `undefined` means no
  authored local cap, still subject to the runtime's host ceiling.

If a 0.5 fanout race meant “first successful lane,” 0.6 quorum with
`count: 1` may express the intent, but it is not a mechanical translation:
recheck failure handling, cancellation, output order, and downstream shape.

### Loop

0.6 loops are do-while state machines. Declare the complete initial state and
return a complete transition on every round:

```ts
const loop = step("refine").loop({
  state: { draft: input.draft, done: false },
  do({ state, round }) {
    const refined = step("refine_round").agent({
      agent: agents.reviewer,
      outputSchema: z.object({ draft: z.string(), done: z.boolean() }),
      prompt: md`Refine ${state.draft} in round ${round}`,
    });
    return {
      state: {
        draft: refined.output.draft,
        done: refined.output.done,
      },
      stop: or(refined.output.done, gte(round, 3)),
    };
  },
});
```

The transition replaces the whole state; it does not merge a partial object.
0.6 has no authored `max_iterations` field, so include an explicit bound in
`stop`. Widen empty arrays, `null`, or literal state fields with an explicit
TypeScript type when necessary.

### Guard, Assert, and Subworkflow

- A 0.5 Guard whose only purpose was “continue when true, fail when false”
  can usually become `step(...).assert({ condition, message })`.
- Guard `complete` has no direct 0.6 equivalent. Restructure the remaining work
  into `if`/`switch` branches and return the selected scope output.
- Guard's persisted `{ matched, action, message? }` output has no Assert
  equivalent. Preserve that data explicitly if downstream work needs it.
- Subworkflow has no current 0.6 node equivalent. Re-author one static graph or
  split the workflow at an operational boundary. A reusable Task shares local
  computation; it is not a nested durable workflow.
- 0.5 YAML `include` is not a 0.6 graph-composition contract. TypeScript
  imports can share ordinary code and reusable Tasks, but imported code must
  still produce one valid static authored graph.

## Migrate operations as a separate workstream

### CLI commands

| 0.5 | 0.6 |
| --- | --- |
| `acpus workflows lint <workflow.yaml>` | `acpus workflow check <workflow.ts>` |
| `acpus workflows run <workflow.yaml>` | `acpus workflow run <workflow.ts>` |
| `acpus workflows run --dry-run` | `acpus workflow check` |
| `acpus runs show <run-id>` | `acpus runs inspect <run-id>` |
| `acpus runs retry <run-id> --node <nodeKey>` | `acpus runs retry <run-id> --target <target>` |
| `acpus runs signal <run-id> --node <nodeKey>` | `acpus runs signal <run-id> --target <target>` |
| 0.5 spec/run visualizer | `acpus workflow viz ... --out workflow.html` for static HTML; `acpus web` for the local operator console |
| `acpus runs replay <run-id>` | No 0.6 equivalent |

`wf` remains an alias for the singular `workflow` command. `workflow run`
submits and returns by default; use `--follow` to wait for terminal status.
`Ctrl-C` during follow detaches without canceling the run.

### Hooks

Do not copy `.acpus/hooks.yaml` to `.acpus/hooks.json`. Rebuild the integration
from its purpose:

- 0.6 reads `<workspace>/.acpus/hooks.json` and `$HOME/.acpus/hooks.json`.
- The JSON top level is an event map; there is no `hooks` wrapper.
- Supported events are `run.started`, `run.completed`, `run.failed`,
  `run.canceled`, `run.awaiting`, `node.started`, `node.completed`, and
  `node.failed`.
- 0.6 hooks are asynchronous, non-interfering observers. A hook failure,
  timeout, or output cannot change workflow status, output, or IR.
- `beforeAgentExec` prompt injection and `beforeProgramExec` environment
  injection have no direct equivalent. Move required inputs into the workflow
  contract, Agent prompt, Agent/Task environment, or an explicit Task.

Validate and inspect the replacement configuration with:

```sh
acpus hooks validate
acpus hooks list
```

### Recovery: retry, fork, and reuse

Start with inspection:

```sh
acpus runs inspect <run-id>
```

Use retry when the admitted frozen workflow, input, and Agent mapping are still
the right plan and the failure is transient or local:

```sh
acpus runs retry <run-id>
acpus runs retry <run-id> --target <nodeKey-or-frameKey-or-static-alias>
```

Use fork when the workflow source, input, or Agent mapping must change:

```sh
acpus runs fork <run-id> --workflow fixed.workflow.ts
acpus runs fork <run-id> --agents '{"reviewer":{"use":"codex"}}'
```

Safe fork reuse is compatibility-aware. It reuses only accepted completed facts
inside the target and dependency boundaries. Changed input disables normal
completed-output reuse; workflow or node signature changes can also make old
facts ineligible. Task side effects and artifact provenance still require human
review. `--unsafe-reuse` is an explicit dangerous override, not a cache switch or
a fix for an invalid target.

Workspace-source reusable Tasks remain live module references. Snapshot
admission durably captures supported local Task modules and dependencies.
Do not delete or mutate required live workspace modules while a run may still
load them.

## A complete YAML-to-TypeScript example

The public input and output keys stay the same in this example; only the
authoring and runtime-value model changes.

### 0.5

```yaml
# review.workflow.yaml
version: 1
name: quick-review
input:
  topic: string
agents:
  reviewer:
    use: codex
workflow:
  steps:
    - id: review
      run: agent
      use: reviewer
      prompt: |
        Review this topic and return concise JSON:
        ${{ input.topic }}
      output:
        risk_count: integer
        ready: boolean
outputs:
  risk_count: ${{ steps.review.output.risk_count }}
  ready: ${{ steps.review.output.ready }}
```

### 0.6

```ts
// review.workflow.ts
import { defineWorkflow, z } from "acpus/core";
import { md } from "acpus/expression";

const ReviewOutput = z.object({
  risk_count: z.number().int(),
  ready: z.boolean(),
});

export default defineWorkflow({
  name: "quick-review",
  inputSchema: z.object({
    topic: z.string(),
  }),
  agents: {
    reviewer: { use: "codex" },
  },
}).build(({ input, agents, step }) => {
  const review = step("review").agent({
    agent: agents.reviewer,
    outputSchema: ReviewOutput,
    prompt: md`
      Review this topic and return concise JSON:
      ${input.topic}
    `,
  });

  return {
    risk_count: review.output.risk_count,
    ready: review.output.ready,
  };
});
```

Check and visualize before admission, then run with a realistic input:

```sh
acpus workflow check review.workflow.ts --input '{"topic":"release readiness"}'
acpus workflow viz review.workflow.ts --out review.workflow.html
acpus workflow run review.workflow.ts --input '{"topic":"release readiness"}'
```

What changed:

1. The input and Agent output schemas became Zod schemas.
2. `agents.reviewer` became a typed Agent token inside `build`.
3. `${{ input.topic }}` became an `Expr<string>` interpolation inside `md`.
4. The Agent result is read through exactly one `.output`.
5. Top-level `outputs` became the value returned by `build`.
6. `workflow check` now typechecks, applies Acpus authoring rules, compiles, and
   validates without admitting a run.

## A phased migration

### 1. Capture the 0.5 contract

Before rewriting, record:

- representative inputs and expected public outputs;
- Agent definitions, models, permissions, cwd, and environment;
- Program commands, exit-code handling, captures, artifacts, and side effects;
- every expression and the values it can observe;
- fanout/parallel join and failure semantics;
- loop termination, Guard `complete`, Subworkflow, Signal default, hook injector,
  and replay dependencies;
- the operational commands and dashboards used by people or automation.

Keep existing 0.5 runs on the 0.5 runtime. Do not copy their state
directories into 0.6.

### 2. Establish the 0.6 contract

Create `workflow.ts` with a literal, identifier-like `name`, supported Zod
`inputSchema`, and top-level Agent definitions. A catalog package additionally
requires a lower-kebab name that matches its directory. Decide the one durable
value the workflow returns. Preserve public field names when downstream
consumers depend on them.

### 3. Rebuild value flow

Replace CEL and `${{ ... }}` one expression at a time. Use direct projection for
known fields, `md`/`template` for text, predicates for comparisons, and `lift`
for synchronous JSON-compatible transformations. Turn runtime control into graph
nodes rather than JavaScript `if`, `switch`, or loops.

### 4. Rebuild execution boundaries

Migrate Agent and schema-backed Signal nodes, then redesign each Program as an
inline or reusable Task. Bind all runtime data through Task `input`; make
artifacts and side effects explicit. Replace fail-only Guards with Assert and
redesign Guard `complete`, Subworkflow, Signal default, and per-node error
policies.

### 5. Recheck composite semantics

Audit race cancellation, fanout strategies and ordering, duplicate items,
concurrency, loop state replacement, and termination bounds. These differences
can change results even when the graph looks similar.

### 6. Migrate the operating surface

Update CLI invocations, catalog packaging, hooks JSON, dashboards, scripts, and
runbook language. Replace replay-dependent procedures with evidence inspection
and an explicit retry/fork decision.

### 7. Check, visualize, and exercise

Run `workflow check` with representative input after every meaningful edit.
Generate the static graph and review branches, concurrency, Signal waits, and
scope outputs. Exercise the workflow on disposable or test inputs before using
it for important work.

### 8. Cut over intentionally

Compare public outputs and side effects against the recorded 0.5 contract.
Test at least one transient retry and one replacement fork in a non-critical
run. Keep rollback instructions and the 0.5 workflow until the 0.6
replacement is accepted. Treat the migration as a product change rather than
an in-place package upgrade.

## Verification checklist

- [ ] `acpus --version` reports the CLI build you intend to use.
- [ ] `acpus doctor` reports a usable authoring/runtime environment.
- [ ] The workflow imports public facades from `acpus/core`,
      `acpus/expression`, and, when needed, `acpus/tasks/git`.
- [ ] `build` is synchronous and contains only static graph declaration.
- [ ] No `Expr<T>` is used with JavaScript truthiness, arithmetic, string
      concatenation, array methods, or untagged interpolation.
- [ ] Every node result is read through exactly one `.output`.
- [ ] Inline Task code is self-contained; runtime data arrives through `input`.
- [ ] Task and composite outputs rely on TypeScript inference, without
      `outputSchema`.
- [ ] Structured Signal payloads have an `outputSchema`; timeout behavior has
      been redesigned where 0.5 used a default payload.
- [ ] Parallel race, fanout, loop, Guard, and Subworkflow behavior has been
      reviewed rather than mechanically translated.
- [ ] 0.5 hooks injectors have been removed or replaced by explicit
      workflow inputs, prompts, environments, or Tasks.
- [ ] `acpus workflow check <workflow.ts> --input <representative.json>` passes
      with no diagnostics.
- [ ] `acpus workflow viz <workflow.ts> --out <file.html>` shows the intended
      complete authored structure.
- [ ] A disposable run completes with the expected public output and artifacts.
- [ ] `acpus runs inspect <run-id>` exposes enough evidence for the team runbook.
- [ ] Retry is reserved for the same frozen plan; fork is used for changed
      workflow/input/Agents.
- [ ] Fork reuse is treated as compatibility-bounded completed-fact reuse, not
      unconditional memoization; `--unsafe-reuse` is absent from routine runbooks.
- [ ] No process depends on 0.5 run state, replay, TUI, hooks injectors, or
      YAML catalog behavior after cutover.

## Related documentation

- [Acpus README](../README.md)
- [Bundled Acpus Skill](../packages/cli/skills/acpus/SKILL.md)
- [Specs index](../specs/INDEX.md)
- [Core spec](../specs/core-spec.md)
- [Expression spec](../specs/expression-spec.md)
- [Workflow compiler spec](../specs/workflow-compiler-spec.md)
- [Runtime spec](../specs/runtime-spec.md)
- [CLI spec](../specs/cli-spec.md)
- [Hooks spec](../specs/hooks-spec.md)
- [Current authoring guide](../packages/cli/skills/acpus/references/authoring.md)
- [Current runtime recovery guide](../packages/cli/skills/acpus/references/runtime-recovery.md)
- [Current workflow examples](../packages/cli/skills/acpus/workflows/examples/)
- [Bundled workflow library](../packages/cli/skills/acpus/workflows/library/)
- [0.5 product README at `acpus@0.5.2`](https://github.com/kelvinschen/acpus/blob/acpus%400.5.2/README.md)
- [0.5 Workflow Spec at `acpus@0.5.2`](https://github.com/kelvinschen/acpus/blob/acpus%400.5.2/specs/workflow-spec.md)
- [0.5 hooks spec at `acpus@0.5.2`](https://github.com/kelvinschen/acpus/blob/acpus%400.5.2/specs/hooks-spec.md)
