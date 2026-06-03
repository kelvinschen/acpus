---
name: acpus
description: >
  Orchestrate multi-step agent workflows with acpus — compile a spec into a
  deterministic execution plan, fan out work across parallel lanes, route
  through decision gates, and recover from failures. Use this skill whenever
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
   npx acpus run <spec> --input-json <input.json>
   npx acpus run <name> [--global]
   npx acpus run <name> --wait
   ```

   The positional argument accepts either a spec file path or a saved workflow name.
   Plain `run` spawns a background worker and returns immediately.
   `--wait` runs in foreground until terminal state.
   `--input-json <path>` supplies typed workflow inputs.

4. **Observe** — inspect runs by run id or directory path:

   ```bash
   npx acpus monitor <run>            # Interactive TUI (three-panel)
   npx acpus monitor <run> --json     # RunMonitorView as JSON
   npx acpus monitor detail <run> <task-id> --json
   npx acpus follow <run>             # Stream events in real time
   npx acpus follow <run> --json      # Stream NDJSON events
   ```

   `monitor` opens an Ink-based TUI with Stage List / Stage Info / Task Detail
   panels. `follow` streams events in real time until the run reaches terminal status.

5. **Resume & Diagnose** — operate on blocked/failed/diagnosed runs:

   ```bash
   npx acpus resume <run>             # Reset blocked stages, re-execute
   npx acpus resume <run> --wait
   npx acpus resume <run> --allow-partial-fanout <stage...>
   npx acpus resume <run> --max-fanout-items <stage=count...>
   npx acpus resume <run> --skip-fanout-item <stage=index...>
   npx acpus resume <run> --force     # Bypass active-worker check for stale workers
   npx acpus diagnose <run> [--wait]  # Read-only diagnostic analysis
   ```

   **Recovery decision tree:**
   - Run stuck? → `diagnose` first (read-only, explains what went wrong)
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

**Spec** — a JSON document declaring stages, roles, inputs, and how data flows
between stages. Starts from a single `root` stage, branches only through
`decisionGate`, and terminates at exactly one `gate`.

**Stage** — a unit of work. Seven kinds: `agentTask` (single agent call),
`discover` (find items), `fanout` (parallel execution across items and lanes),
`reduce` (aggregate results), `decisionGate` (conditional routing), `gate`
(final pass/fail), `loop` (bounded repetition).

**Role** — defines which agent runs a stage and what it can do. Category
(planning/implementation/validation/...) determines the output contract.
Mode (denyAll/readOnly/edit) controls tool access.

**Output contract** — the structured JSON each stage must produce. Contract
type is derived from stage kind and role category — authors don't choose it
directly. Contract failures produce **blocked** state, not **failed** (failed
is reserved for infrastructure errors).

**Condition DSL** — used for gate pass/fail, decisionGate routing, fanout lane
selection, and loop continuation. Six forms: comparison, membership, existence,
conjunction, disjunction, negation. Source roots: `input.*`, `outputs.*`,
`item.*`, `loop.*`, `run.*`.

## Design Constraints

These are enforced by lint or runtime and can't be worked around:

1. One root stage, one terminal gate per workflow
2. No arbitrary cycles — only `loop` for bounded repetition
3. Branching only via `decisionGate` — ordinary stages cannot have multiple dependents
4. Output contract failures block, never fail — `failed` is for infrastructure errors only
5. Observation surfaces are strictly read-only — `follow`/`monitor`/`diagnose` never mutate state
6. Disk state is authoritative — source of truth for crash recovery
7. Each run is isolated — independent directory + session store
8. No direct ACPX flow execution — acpus drives acpx through runtime API only
9. `summarize` stage is deprecated — replace with terminal `gate`
10. Edit-mode fanout requires a downstream readOnly `reduce` stage

## Reference Files

Read these when you need concrete details for a specific task:

| File | When to Read |
|------|-------------|
| `workflow-examples/` | Starting a new spec — 8 runnable example specs (raw JSON) covering linear pipeline, loops, fanout patterns, lane routing, and edit+reconcile. See `workflow-examples/README.md` for pattern index. |
| `references/spec-authoring.md` | Writing a workflow spec — complete field reference for inputs, roles, all 7 stage kinds with JSON fragments |
| `references/routing.md` | Writing decisionGate rules, gate conditions, or fanout lane groups — concrete JSON examples of each routing pattern |
| `references/conditions-and-variables.md` | Writing conditions, variable declarations, or prompt interpolation — all source roots, transform chains, template rendering |
| `references/output-contracts.md` | Understanding what output each stage produces — contract schemas, selection logic, parser behavior |
| `references/runtime.md` | Understanding runtime internals — worker lifecycle, scheduler, recovery, fanout pool, run directory, lint families |
