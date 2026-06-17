---
name: acpus
description: Load when the user works with Acpus — the local durable runner that orchestrates acpx-backed agents through Workflow Specs, Runs, and catalog playbooks. Trigger on any mention of Acpus, acpx, Acpus Workflow Spec, Acpus Run, or catalog playbook, even if the user only says "workflow" when context clearly means Acpus (e.g., they reference the acpus CLI, acpx agents, or Acpus-specific concepts like fork/retry/resume of runs). Do not load for CI/CD pipelines, GitHub Actions, Airflow, Temporal, or any workflow or orchestration request that does not involve Acpus or acpx.
---

# Acpus

Acpus is the durable local runner that orchestrates acpx-backed agents through Workflow Specs, Runs, and catalog playbooks. Keep this file as the operating hub; read the referenced files only when the task needs that detail.

## Core Model: Three Composable Units

Three equal units, freely orchestrated with composite nodes (loop, fanout, parallel, switch, guard) into controllable workflows:

- **Agent Step** (`run: agent`) — open-ended judgment via an acpx agent.
- **Program Step** (`run: program`) — deterministic local glue.
- **Signal Node** (`run: signal`) — external decision channel: the Run blocks in `awaiting` until a JSON payload (via `acpus runs signal`) steers it (branch, gate, feed next loop round). The decider can be a human OR the agent driving the workflow.

## Classify the Task

Before acting, decide which path the user's request falls into. A single conversation may visit several paths in sequence — that is fine; just start from the right one each time.

| Path | When the user… |
|------|---------------|
| **Inspect / Monitor** | Asks about a Run's status, a Node's output, an artifact, or wants to watch a background Run. |
| **Recover** | Reports a failed or stalled Run, asks why something went wrong, or wants to fix/retry/fork. |
| **Run Existing** | Wants to execute a Workflow Spec or catalog playbook (with or without agent overrides). |
| **Author / Adapt** | Wants to write or edit a Workflow Spec, choose composite node types, or adapt a playbook. |
| **Explain** | Asks what Acpus is, how a concept works (CEL, composites, fork semantics…), or wants conceptual guidance with no side effects. |

> **Prerequisite for all action paths** — verify the CLI first: `acpus --version`. If missing, ask before installing: `npm install -g acpus`.

> **Safety** — ask before destructive workspace changes, publishing, pushing git refs, applying patches, or running external side-effect commands.

---

## Inspect / Monitor

1. **Always prefer the compact text format** — it is designed to minimize context window usage. Only switch to `--json` when you need exact node keys, artifact refs the text format omits:

   ```sh
   acpus runs show <runId>
   ```

2. To read an artifact (e.g., agent transcript, captured output), resolve the path:

   `artifact://runs/<runId>/nodes/<nodeKey>/<file>` → `.acpus/state/runs/<runId>/artifacts/<encoded-key>/<file>` (`/` → `:`).

3. For long-running background Runs, poll with decreasing intervals (5 → 4 → 3 → 2 min, repeat). On each poll, check the `Activity:` line for Agent Steps to see transcript freshness, tool-call count, and recent tools. See `references/background-run-polling.md` for the full cadence table.

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

   - **Spec is fine, transient failure** (network, OOM, race): retry replays the original frozen spec. If you edited the spec, use fork instead:

     ```sh
     acpus runs retry <runId> [--node <nodeKey>]
     ```

   - **Paused / awaiting / verifying**:

     ```sh
     acpus runs resume <runId>
     acpus runs signal <runId> --node <nodeKey> --payload '<json>'
     acpus runs replay <runId>
     ```

See `references/error-recovery.md` for the failure-symptom decision table and fork-inheritance semantics.

---

## Run Existing

1. If the user did not name worker agents, ask which acpx-supported agents to use. If they say "choose freely", inspect `acpx --help` and match by task shape (planning/review → `claude`, `pi`; implementation → `codex`, `cursor`, `trae`; custom ACP server → `type: command`). See `references/agent-selection.md`.

2. Prefer existing playbooks before inventing a new Workflow Spec:

   ```sh
   acpus workflows list
   acpus workflows show <catalog-ref>
   ```

3. Lint and dry-run before starting real work. To temporarily change agents for this Run, pass Agent Overrides with `--agents` (inline JSON):

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

Key decisions while authoring:

- **Program vs Agent Step**: Program Steps are for deterministic local glue (prepare dirs, compute paths, collect diffs, apply/rollback patches, read state for guards). Agent Steps handle planning, judgment, synthesis, failure interpretation, role boundaries, and cross-round memory. If a Program Step starts encoding those decisions, move that work into an agent prompt and a durable file.
- **Composite nodes**: guard, loop, fanout, parallel, switch — each has distinct scope variables and output shape. See `references/composite-nodes.md` for syntax and common pitfalls (e.g., parallel output needs double `.output.` level; `loop.last` is undefined on first iteration).
- **Expression forms**: raw CEL in `when`, `until`, and expression-valued `over`; `${{ ... }}` interpolation in prompts, command strings, keys, and messages. See `references/expressions-and-outputs.md`.
- **Output schema**: keep flat and minimal (paths, counts, booleans, durable ids). Do not put the output schema in the prompt — Acpus injects it and retries parse/schema failures. Large artifacts go in files; return their paths.
- **Helper scripts**: prefer real scripts over long inline shell for repository-local workflows. Dry-run scripts to verify them before integrating.
- **Timeouts**: bare number = milliseconds; string duration (`5m`, `30s`) also supported. Signal Nodes with a `timeout` require `on_timeout` (`fail` or `default`).
- **Examples**: see `assets/examples/` for copyable Specs — `review-guard` (simple, guard), `draft-review-loop` (medium, loop), `topic-fanout-synthesis` (complex, fanout).

---

## Explain

Answer conceptual questions without side effects. Common topics and where to find detail:

| Topic | Reference |
|-------|-----------|
| Fork vs retry semantics, fork inheritance | `references/error-recovery.md` |
| Composite node types and their scope/output | `references/composite-nodes.md` |
| CEL vs `${{ }}` placement rules | `references/expressions-and-outputs.md` |
| Authoring gotchas and positive/negative patterns | `references/best-practices.md` |
| Frequent mistakes and fixes | `references/common-errors.md` |
| Agent selection by task shape | `references/agent-selection.md` |

For deeper reading, link the user to the Source Docs at the bottom of this file.

## Reference Index

Every path above links its relevant references inline. For quick lookup:

- `references/best-practices.md` — gotchas and positive/negative authoring patterns
- `references/expressions-and-outputs.md` — CEL, templates, and output shape rules
- `references/composite-nodes.md` — guard, loop, fanout, parallel, and switch behavior
- `references/error-recovery.md` — failure-symptom decision table and fork semantics
- `references/common-errors.md` — frequent authoring mistakes and runtime errors with fixes
- `references/agent-selection.md` — choosing acpx-backed worker agents
- `references/background-run-polling.md` — efficient polling cadence for background Runs
- `references/playbooks.md` — GitHub source and raw links for public Agent Workflow Playbooks
  (`codebase-deep-research`, `adversarial-feature-implementation-review`,
  `solution-generate-filter`, `worktree-implementation-tournament`, `loop-until-green-fix`,
  `goal-driven-development`, `subagent-driven`, `human-in-the-loop-development`,
  `swarm-intelligence`)
- `scripts/workflow-viz.py` — generate an HTML visualization for a Spec (`python3 scripts/workflow-viz.py <spec.yaml> [-o out.html]`), or for an executed Run with real node outputs/state overlaid (`python3 scripts/workflow-viz.py --run .acpus/state/runs/<runId>/ [-o out.html]`)
- `assets/examples/` — copyable Workflow Spec examples: `review-guard`, `draft-review-loop`, `topic-fanout-synthesis`

## Source Docs

- [README](https://github.com/kelvinschen/acpus/blob/main/README.md)
- [Workflow Spec](https://github.com/kelvinschen/acpus/blob/main/specs/workflow-spec.md)
- [Workflow Catalog Spec](https://github.com/kelvinschen/acpus/blob/main/specs/workflow-catalog-spec.md)
- [CLI Spec](https://github.com/kelvinschen/acpus/blob/main/specs/cli-spec.md)
- [Local Runtime Target Spec](https://github.com/kelvinschen/acpus/blob/main/specs/local-runtime-target-spec.md)
- [Schema Spec](https://github.com/kelvinschen/acpus/blob/main/specs/schema-spec.md)
