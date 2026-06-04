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

1. **Author** — generate a starter spec, then edit:

   ```bash
   npx acpus save <name> --template basic
   ```

   Writes a saved workflow directory with a minimal two-stage template (plan + gate); edit before running.

2. **Plan** — validate and preview before execution:

   ```bash
   npx acpus plan <spec>
   npx acpus plan <spec> --quiet
   npx acpus plan <spec> --json
   ```

   Preview shows: workflow name, planned agent calls, fanout estimates,
   risk factors, stage listing, audit trail, and any lint issues.

3. **Conduct** — run after preview confirms correctness:

   ```bash
   npx acpus run <spec>
   npx acpus run <spec> --input '{"task":"review"}'
   npx acpus run <spec> --input <input.yaml>
   npx acpus run <name> [--global]
   npx acpus run <name> --wait
   ```

   The positional argument accepts either a spec file path or a saved workflow name.
   Plain `run` spawns a background worker and returns immediately.
   `--wait` runs in foreground until terminal state.
   `--input <json-or-yaml-or-path>` supplies workflow input values from an inline JSON object or a JSON/YAML file validated by `input.schema`.

4. **Observe** — inspect runs by run id or directory path:

   ```bash
   npx acpus monitor                  # Select a run, then open the TUI
   npx acpus monitor <run>            # Interactive TUI (three-panel)
   npx acpus monitor <run> --json     # RunMonitorView as JSON
   npx acpus monitor detail <run> <task-id> --json
   npx acpus follow                   # Select a run, then stream events
   npx acpus follow <run>             # Stream events in real time
   npx acpus follow <run> --json      # Stream NDJSON events
   ```

   `monitor` opens an Ink-based TUI with Stage List / Stage Info / Task Detail
   panels. `follow` streams events in real time until the run reaches terminal status.
   Empty `monitor --json` and `follow --json` return the current project's run summary list.

5. **Resume** — operate on blocked/failed runs:

   ```bash
   npx acpus resume <run>             # Reset blocked stages, re-execute
   npx acpus resume <run> --wait
   npx acpus resume <run> --allow-partial-fanout <stage...>
   npx acpus resume <run> --max-fanout-items <stage=count...>
   npx acpus resume <run> --skip-fanout-item <stage=index...>
   npx acpus resume <run> --force     # Bypass active-worker check for stale workers
   ```

   **Recovery decision tree:**
   - Run stuck? → `monitor` and `monitor detail` to inspect the blocked task
   - Stage blocked with bad output? → `resume` (resets blocked stages to pending)
   - Worker stale/dead? → `resume --force` (bypasses active-worker check)
   - Fanout partially blocked? → `resume --allow-partial-fanout <stage>` or
     `--skip-fanout-item` to skip specific items

6. **Catalogue** — list and inspect saved artifacts:

   ```bash
   npx acpus save <name> <path> [--overwrite] [--global]
   npx acpus list <workflows|runs> [--global] [--json]
   npx acpus show <workflow|run> <name> [--global] [--json]
   ```

   All commands accept `--json` for machine-readable output.

## Key Concepts

**Spec** — a YAML document declaring stages, inline actors, input schema, and data
flow. It starts from one `root`, branches only through `route`, and terminates
at exactly one `gate`.

**Stage** — a graph node. Current kinds are `task`, `fanout`, `loop`, `route`,
and `gate`. Executable objects declare `mode`; `fanout` and `loop` do not.

**Actor** — inline `{ agent, mode, label? }` declaration used by agent tasks,
agent gates, agent routes, fanout lanes, and agent fanin.

**Output schema** — optional `output.schema` DSL for agent executables. Omitted
agent schemas default to `{summary:string,data?:unknown}`. Program tasks and
program fanin output `{status,data}` and do not use the DSL.

**Condition DSL** — used for gate pass/fail, route rules, fanout lane selection,
and loop continuation. Source roots: `input.*`, `outputs.*`, `item.*`,
`results.*`, `loop.*`, `run.*`.

## Design Constraints

These are enforced by lint or runtime and can't be worked around:

1. One root stage, one terminal gate per workflow
2. No arbitrary cycles — only `loop` for bounded repetition
3. Branching only via `route` — route routes must equal direct downstream IDs
4. Output schema failures block, never fail — `failed` is for infrastructure errors only
5. Observation surfaces are strictly read-only — `follow`/`monitor` never mutate state
6. Disk state is authoritative — source of truth for crash recovery
7. Each run is isolated — independent directory + session store
8. No direct ACPX flow execution — acpus drives acpx through runtime API only
9. Fanout must declare explicit `fanin`
10. Program fanin currently supports only `mergeArrays`

## Reference Files

Read these when you need concrete details for a specific task:

| File | When to Read |
|------|-------------|
| `examples/` | Starting a new spec — YAML examples for current workflow patterns. |
| `references/spec-authoring.md` | Writing a workflow spec — current YAML fields, actors, stages, fanout/fanin, route, loop |
| `references/routing.md` | Writing route rules, gate conditions, or fanout lane filters |
| `references/conditions-and-variables.md` | Writing conditions, variable declarations, or prompt interpolation — all source roots, transform chains, template rendering |
| `references/output-contracts.md` | Understanding output.schema DSL, implicit fields, parser behavior |
| `references/runtime.md` | Understanding runtime internals — worker lifecycle, scheduler, recovery, fanout pool, run directory, lint families |
