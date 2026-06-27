---
name: acpus
description: Helps work with Acpus, the local durable runner for acpx-backed agents, Workflow Specs, Runs, catalog playbooks, and the acpus CLI. Use when the user mentions Acpus, Acpus Workflow Specs/Runs, acpus workflows/runs commands, Workflow Spec YAML, hooks.yaml, .acpus Run state, or Acpus acpx-backed agent execution. Do not use for standalone acpx usage, unrelated CI/CD pipelines, GitHub Actions, Airflow, Temporal, or generic workflow orchestration.
---

# Acpus

Acpus is the durable local runner that orchestrates acpx-backed agents through Workflow Specs, Runs, and catalog playbooks. Keep this file as the operating hub; read the referenced files only when the task needs that detail.

## Core Model

Three equal units, freely orchestrated with composite nodes (pipeline, loop, fanout, parallel, if, switch, guard) into controllable workflows:

- **Agent Step** (`run: agent`) — open-ended judgment via an acpx agent.
- **Program Step** (`run: program`) — deterministic local glue.
- **Signal Node** (`run: signal`) — external decision channel: the Run blocks in `awaiting` until a JSON payload (via `acpus runs signal`) steers it (branch, gate, feed next loop round). Deliver a signal when the user gives the decision or the Workflow explicitly delegates that decision and the payload is clear from Run state/artifacts.

## Classify the Task

Before acting, decide which path the user's request falls into. A single conversation may visit several paths in sequence — that is fine; just start from the right one each time.

| Path | When the user… |
|------|---------------|
| **Inspect / Monitor** | Asks about a Run's status, a Node's output, an artifact, or wants to watch a background Run. |
| **Recover** | Reports a failed or stalled Run, asks why something went wrong, or wants to fix/retry/fork. |
| **Run Existing** | Wants to execute a Workflow Spec or catalog playbook (with or without agent overrides). |
| **Author / Adapt** | Wants to write or edit a Workflow Spec, choose composite node types, or adapt a playbook. |
| **Configure Hooks** | Wants to set up, validate, or inspect hook configuration (hooks.yaml, injectors, events). See `references/hooks-config.md`. |
| **Explain** | Asks what Acpus is, how a concept works (CEL, composites, fork semantics…), or wants conceptual guidance with no side effects. |

> **Prerequisite for all action paths** — verify the CLI first: `acpus --version`. If missing, ask before installing: `npm install -g acpus`.

> **Safety** — ask before destructive workspace changes, publishing, pushing git refs, applying patches, or running external side-effect commands.

---

## Inspect / Monitor

1. **Always prefer the compact text format** — it is designed to minimize context window usage. Only switch to `--json` when you need structured output to pipe into `jq`/`grep` for exact node keys, artifact refs, or field extraction the text format omits:

   ```sh
   acpus runs show <runId>
   ```

2. To read an artifact, use paths or artifact refs from `runs show`, `runs show --json`, `.acpus/state/runs/<runId>/node-index.jsonl`.

3. For long-running background Runs, poll with decreasing intervals (5 → 4 → 3 → 2 → 2 min, repeat). On each poll, check the `Activity:` line for Agent Steps to see telemetry freshness, tool-call count, and recent tools. See `references/background-run-polling.md` for the full cadence table.

4. If the user wants to observe a background Run themselves, serve the read-only visualizer:

   ```sh
   acpus runs visualize <runId> --serve
   ```

---

## Recover

1. Get the full Run state and find the failed/awaiting nodeKey, error, and artifact refs:

   ```sh
   acpus runs show <runId> --json
   ```

2. Read the referenced artifacts before guessing what went wrong.

3. Pick the smallest recovery:

   - **Spec is wrong** (script bug, schema mismatch, control-flow error): edit the spec, then fork. Inherits unaffected completed work:

     ```sh
     acpus runs fork <runId> <fixed-spec> [--dry-run] [--from <nodeKey>]
     ```

   - **Agent choice is wrong**: use `--agents` on `workflows run` or `runs fork`. See `references/agent-selection.md`.

   - **Spec is fine, transient failure** (network, OOM, race): retry performs in-place recovery from the frozen IR and does not read edited YAML. If you edited the spec, use fork instead:

     ```sh
     acpus runs retry <runId> [--node <nodeKey>]
     ```

   - **Run paused**: `acpus runs resume <runId>`.

   - **Signal Node awaiting**: `acpus runs signal <runId> --node <nodeKey> --payload '<json>'` only when the user supplied the decision or the Workflow explicitly delegated it and the payload is unambiguous.

   - **Determinism / topology check**: `acpus runs replay <runId>`.

See `references/error-recovery.md` for the failure-symptom decision table and fork-inheritance semantics.

---

## Run Existing

1. Prefer existing playbooks before inventing a new Workflow Spec (unless user explicitly ask for orchestrating):

   ```sh
   acpus workflows list
   acpus workflows show <catalog-ref>
   ```

2. Inspect the Workflow's declared agent keys before asking for agent choices or writing overrides. If the user says "choose freely", inspect `acpx --help` and match agents by task shape. See `references/agent-selection.md`.

3. Lint and dry-run before starting real work. To temporarily change agents for this Run, pass Agent Overrides keyed by declared agent name:

   ```sh
   acpus workflows lint <workflow-or-ref>
   acpus workflows run <workflow-or-ref> --dry-run
   acpus workflows run <workflow-or-ref> --dry-run --agents '{"reviewer":{"type":"builtin","use":"claude","model":"opus"}}'
   ```

4. Start the Run — foreground for quick workflows, background for long ones:

   ```sh
   acpus workflows run <workflow-or-ref> --input '<json>'
   acpus workflows run <workflow-or-ref> --background --input '<json>'
   acpus workflows run <workflow-or-ref> --background --agents '{"reviewer":{"type":"builtin","use":"pi"}}' --input '<json>'
   ```

5. After launching a background Run, switch to **Inspect / Monitor** to track it.

---

## Author / Adapt

This path covers writing or editing a Workflow Spec YAML — no CLI commands run the spec here; use **Run Existing** for that.
Read `references/workflow-spec-schema.md` for full spec schema

### Authoring Defaults

- **Program vs Agent Step**: Program Steps are for deterministic local glue (prepare dirs, compute paths, collect diffs, apply/rollback patches, read state for guards). Agent Steps handle planning, judgment, synthesis, failure interpretation, role boundaries, and cross-round memory. If a Program Step starts encoding those decisions, move that work into an agent prompt and a durable file.
- **Composite nodes**: pipeline, guard, loop, fanout, parallel, switch — each has distinct scope variables and output shape. `do` lists on fanout/loop/switch compile as generated internal pipelines; use explicit `pipeline` with `outputs` when you need a custom public contract.
- **Expression forms**: raw CEL in `when`, `until`, and expression-valued `over`; `${{ ... }}` interpolation in prompts, command strings, keys, and messages. See `references/expressions-and-outputs.md`.
- **Structured values in strings**: never inject a whole object/array expression directly into prompt or command text; it renders as `[object Object]`. Use `json(...)`, a file artifact, or `env:` depending on where the value is consumed.
- **Output schema**: keep flat and minimal (paths, counts, booleans, durable ids). Do not put the output schema in the prompt — Acpus injects it and retries parse/schema failures. Large artifacts go in files; return their paths.
- **Helper scripts**: prefer real scripts over long inline shell for repository-local workflows. Dry-run scripts to verify them before integrating.
- **Timeouts**: bare number = milliseconds; string duration (`5m`, `30s`) also supported. Signal Nodes with a `timeout` require `on_timeout` (`fail` or `default`).
- **Examples**: see `assets/examples/` for copyable Specs — `review-guard` (simple, guard), `draft-review-loop` (medium, loop), `topic-fanout-synthesis` (complex, fanout).

### High-Friction Rules

- `fanout.output`: array, not key map.
- `loop.last`: previous body output; undefined on iter 0.
- `until`: skipped on iter 0; then checks previous output before each body run.
- `guard complete`: current scope only; loop continues by `until`/`max_iterations`.
- First-iter fallback: use `loop.iter == 0 ? x : loop.last.field`, not `coalesce(loop.last.field, x)`.

---

## Configure Hooks

Read `references/hooks-config.md` for the relevant hook names, handler protocol, payload fields, and examples.

---


## Reference Map

Read only the files needed for the task:

| Need | Read |
|------|------|
| Authoring rules, schema fields, composite shapes | `references/workflow-spec-schema.md` (`Top-Level Shape`, `Steps`, `Composite Output Shapes`, `Constraints Summary`) |
| CEL, `${{ }}`, output shapes, `json()`, macros | `references/expressions-and-outputs.md` |
| Debug a failed authoring/run pattern | `references/common-errors.md` |
| General authoring heuristics | `references/best-practices.md` |
| Fork/retry/resume/replay decisions | `references/error-recovery.md` |
| Choosing acpx worker agents | `references/agent-selection.md` |
| Background Run polling | `references/background-run-polling.md` |
| Hook config and payloads | `references/hooks-config.md` |
| Catalog playbook selection and local sources | `references/playbooks.md` |

`scripts/workflow-viz.py` generates an HTML visualization for a Spec or executed Run. `assets/examples/` contains copyable Specs: `review-guard`, `draft-review-loop`, `topic-fanout-synthesis`.

## Source Docs
> Only when skill + references aren't enough.
- [README](https://github.com/kelvinschen/acpus/blob/main/README.md)
- [Workflow Spec](https://github.com/kelvinschen/acpus/blob/main/specs/workflow-spec.md)
- [Workflow Catalog Spec](https://github.com/kelvinschen/acpus/blob/main/specs/workflow-catalog-spec.md)
- [CLI Spec](https://github.com/kelvinschen/acpus/blob/main/specs/cli-spec.md)
- [Local Runtime Target Spec](https://github.com/kelvinschen/acpus/blob/main/specs/local-runtime-target-spec.md)
- [Schema Spec](https://github.com/kelvinschen/acpus/blob/main/specs/schema-spec.md)
