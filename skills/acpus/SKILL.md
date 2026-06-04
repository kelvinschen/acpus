---
name: acpus
description: >
  Orchestrate multi-step agent workflows with acpus — compile a spec into a
  deterministic execution plan, fan out work across parallel lanes, route
  through route stages and gates, and recover from failures. Use this skill whenever
  the user wants to coordinate multiple agent sessions in a structured pipeline,
  run heterogeneous parallel agent work, author a workflow spec, monitor or
  recover a running workflow, or anything involving the acpus CLI. Even if the
  user doesn't say "acpus" or "workflow", if they describe a multi-stage agent
  pipeline, parallel agent review, or conditional agent routing, this skill
  applies.
---

# Acpus

Acpus is a runtime-driven workflow orchestrator for ACP agents, built on the
acpx agent runtime. It accepts a structured *workflow spec*, validates it,
compiles a deterministic execution plan, and conducts heterogeneous fanout
across parallel lanes. Every run is tracked as a numbered, replayable execution.

The public surface is the `acpus` CLI binary. 

## Core Workflow

1. **Author** — start from an example spec, then edit:

   ```bash
   cp examples/simple-feature.workflow.spec.yaml my-workflow.workflow.spec.yaml
   ```

   Example specs are YAML files that match the current workflow model. Edit a copy before running or saving it.

2. **Plan** — validate and preview before execution:

   ```bash
   npx acpus plan <spec>
   npx acpus plan <spec> --quiet
   npx acpus plan <spec> --json
   ```

   Preview shows: workflow name, planned agent calls, fanout estimates,
   risk factors, stage listing, audit trail, and any lint issues.

3. **Run** — execute after preview confirms correctness:

   ```bash
   npx acpus run <spec>
   npx acpus run <spec> --input '{"task":"review"}'
   npx acpus run <spec> --input <path.yaml>
   npx acpus run <name> [--global]
   npx acpus run <name> --wait
   ```

   The positional argument accepts either a spec file path or a saved workflow name.
   Plain `run` spawns a background worker and returns immediately.
   `--wait` runs in foreground until terminal state.
   `--input` supplies workflow input values — either an inline JSON object (value starts with `{`) or a path to a JSON/YAML file. Inline YAML is not supported; values not starting with `{` are treated as file paths. Parsed input is validated by `input.schema`.
   `--global` resolves the saved workflow from the global directory instead of the project-local one.

4. **Observe** — inspect runs by run id or directory path:

   ```bash
   npx acpus monitor                  # Select a run, then open the TUI
   npx acpus monitor <run>            # Interactive TUI (three-panel)
   npx acpus monitor <run> --json     # RunMonitorView as JSON
   npx acpus monitor detail <run> <stage-task-id> --json
   npx acpus follow                   # Select a run, then stream events
   npx acpus follow <run>             # Stream events in real time
   npx acpus follow <run> --json      # Stream NDJSON events
   ```

   `monitor` opens an Ink-based TUI with Stage List / Stage Info / Task Detail
   panels. `monitor detail` inspects one stage task (observation-surface work item) within a run — `<stage-task-id>` is a monitor observation ID, not a spec-level stage ID.
   `follow` streams events in real time until the run reaches terminal status.
   Empty `monitor --json` and `follow --json` return the current project's run summary list.

5. **Resume** — operate on blocked/failed runs:

   ```bash
   npx acpus resume <run>             # Reset blocked stages to pending, re-execute
   npx acpus resume <run> --wait
   npx acpus resume <run> --allow-partial-fanout <stage...>
   npx acpus resume <run> --max-fanout-items <stage=count...>
   npx acpus resume <run> --skip-fanout-item <stage=index...>
   npx acpus resume <run> --force     # Bypass active-worker check for stale workers
   ```

   Resume re-aggregates already-terminal fanout items and only re-runs
   blocked/missing stages — completed work is preserved.

   **Recovery decision tree:**
   - Run stuck? → `monitor` and `monitor detail` to inspect the blocked stage task
   - Stage blocked with bad output? → `resume` (resets blocked stages to pending, scheduler re-executes them)
   - Worker stale/dead? → `resume --force` (bypasses active-worker check)
   - Fanout partially blocked? → `resume --allow-partial-fanout <stage>` or
     `--skip-fanout-item` to skip specific items

6. **Catalogue** — list and inspect saved artifacts:

   ```bash
   npx acpus save <name> <path> [--overwrite] [--global]
   npx acpus list <workflows|runs> [--global] [--json]
   npx acpus show <workflow|run> <name> [--global] [--json]
   ```

   `save <name> <path>` persists an existing spec file to the workflow store.
   All commands accept `--json` for machine-readable output.

## Key Concepts

**Workflow Spec** — a YAML document declaring `schemaVersion`, stages, inline
actors, input schema, and data flow. It starts from one `root`, branches only
through `route`, and terminates at exactly one `gate`. Spec files must be named
`*.workflow.spec.yaml` or `workflow.spec.yaml`.

**Stage** — a graph node. Current kinds and their purposes:

| Kind | Purpose |
|------|---------|
| `task` | Agent or program work (single execution unit) |
| `route` | First-match conditional branch |
| `fanout` | Parallel lane work across items, followed by required fanin |
| `loop` | Bounded repetition of a body graph |
| `gate` | Terminal verdict (pass / blocked / failed) |

Executable objects (task, route, gate, fanin) declare `mode: agent` or
`mode: program`. `fanout` and `loop` are structural containers and do not
declare stage-level `mode`.

**Actor** — inline `{ agent, mode, label? }` declaration used by agent tasks,
agent gates, agent routes, fanout lanes, and agent fanin. Actor `mode` controls
filesystem access (`denyAll`, `readOnly`, `edit`) and is distinct from
stage-level `mode` (agent/program) which controls execution type.

**Fanin** — the required aggregation step after fanout. It collects outputs from
all parallel lanes and produces a single merged output. Program fanin uses
`operation: mergeArrays`; agent fanin uses an actor and prompt. Downstream
stages see fanin output, not individual lane outputs.

**Output schema** — optional `output.schema` DSL for agent executables. Omitted
agent schemas default to `{summary:string,data?:unknown}`. Supported:
primitives, `unknown`, literals, arrays, objects, optional keys, unions.
Unsupported: `any`, `Record`, type aliases. Program tasks and program fanin
output `{status,data}` and do not use the DSL.

**Implicit output fields** — Gate agents must output `verdict`
(`pass` | `pass_with_warnings` | `blocked` | `failed` | `unknown`). Route
agents must output `route` (a downstream stage ID). These are enforced
regardless of `output.schema`. Program gates map condition results: true →
`pass`, false → `blocked`.

**Condition DSL** — used for gate pass/fail, route rules, fanout lane selection,
and loop continuation. Supports comparison (`eq`/`neq`/`gt`/`gte`/`lt`/`lte`),
membership (`in`), existence (`exists`/`empty`), and compound forms
(`all`/`any`/`not`) that nest arbitrarily. Source roots: `input.*` (workflow
inputs), `outputs.*` (stage outputs by ID), `item.*` (current fanout item),
`results.*` (fanout aggregate for fanin), `loop.*` (loop context). Source paths
use safe navigation — missing keys resolve to `undefined` rather than throwing.

## Design Constraints

These are enforced by lint or runtime and can't be worked around:

1. One root stage, one terminal gate per workflow
2. No arbitrary cycles — only `loop` for bounded repetition (guarantees every run terminates)
3. Branching only via `route` — the `routes` list must exactly equal the stage's direct downstream IDs; no match blocks with `ROUTE_UNMATCHED`
4. Output schema failures block, never fail — `failed` is for infrastructure errors only; blocking preserves partial results and allows resume
5. Observation surfaces are strictly read-only — `follow`/`monitor` never mutate state
6. Disk state is authoritative — source of truth for crash recovery
7. Each run is isolated — independent directory + session store
8. No direct ACPX flow execution — acpus drives the acpx agent runtime (the ACP agent execution layer) through its runtime API only
9. Fanout must declare explicit `fanin` — downstream stages see fanin output, not individual lane outputs
10. Program fanin currently supports only `mergeArrays`

## Reference Files

Read these when you need concrete details for a specific task.
Recommended reading order for first-time users: `spec-authoring.md` → `routing.md` + `conditions-and-variables.md` → `output-schema.md` → `runtime.md`.

| File | When to Read |
|------|-------------|
| `examples/` | Starting a new spec — YAML examples for current workflow patterns. |
| `references/spec-authoring.md` | Writing a workflow spec — current YAML fields, actors, stages, fanout/fanin, route, loop, `dependsOn` |
| `references/routing.md` | Writing route rules, gate conditions, or fanout lane selection |
| `references/conditions-and-variables.md` | Writing conditions, variable declarations, or prompt interpolation — all source roots, transform chains, template rendering |
| `references/output-schema.md` | Understanding output.schema DSL, implicit fields, parser behavior |
| `references/runtime.md` | Understanding runtime internals — worker lifecycle, scheduler, recovery, fanout pool, run directory, lint families |
