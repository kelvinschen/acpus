---
name: acpus
description: Load when the user asks to design, run, inspect, recover, or improve an Acpus workflow, Workflow Spec, Run, catalog playbook, or acpx-backed agent orchestration.
---

# Acpus

Use Acpus as the durable local runner underneath the user's preferred agent. Keep this file as the operating hub; read the referenced files only when the task needs that detail.

## Operating Loop

1. Check the CLI:

   ```sh
   acpus --version
   ```

   If missing, ask before installing:

   ```sh
   npm install -g acpus
   ```

2. If the user did not name worker agents, ask which acpx-supported agents to use. If they ask you to choose freely, inspect `acpx --help` and pick from available builtins such as `claude`, `codex`, `pi`, `cursor`, or `trae`.

3. Prefer existing playbooks before inventing a new Workflow Spec:

   ```sh
   acpus workflows list
   acpus workflows show <catalog-ref>
   ```

4. Lint and dry-run before starting real work:

   ```sh
   acpus workflows lint <workflow-or-ref>
   acpus workflows run <workflow-or-ref> --dry-run
   ```

   To temporarily change agents for a new Run from an existing Spec, pass Agent Overrides with `--agents`. Prefer inline JSON:

   ```sh
   acpus workflows run <workflow-or-ref> --dry-run --agents '{"reviewer":{"type":"builtin","use":"claude","model":"opus"}}'
   ```

5. Start quick Runs in the foreground and long Runs in the background:

   ```sh
   acpus workflows run <workflow-or-ref> --input '<json>'
   acpus workflows run <workflow-or-ref> --background --input '<json>'
   acpus workflows run <workflow-or-ref> --background --agents '{"reviewer":{"type":"builtin","use":"pi"}}' --input '<json>'
   ```

6. Track background Run status with compact text output. Use decreasing polling intervals from `references/background-run-polling.md`; read the `Activity:` line on running Agent Steps to see transcript freshness, tool-call count, and recent tools:

   ```sh
   acpus runs show <runId>
   ```

   Use `--json` only when exact node keys, artifact refs, or machine-readable state are needed.

7. (Optional) When the user needs to observe a background workflow themselves, serve the read-only visualizer and send them the printed URL:

   ```sh
   acpus runs visualize <runId> --serve
   ```

## Authoring Rules

- Keep large intermediate material in files under `.acpus/output/...` or the workflow output directory. Return only paths, counts, booleans, decisions, and durable ids in node output.
- Keep `output:` schemas flat and minimal. Do not put the output schema in the prompt; Acpus injects it and retries parse/schema failures.
- Treat `output:` as workflow control data, not agent memory. Put reports, rationale, findings, handoff notes, and cross-step context in files, then return their paths.
- Use Program Steps only for deterministic local glue: preparing directories, computing paths, running verification, collecting diffs, applying or rolling back patches, and reading simple state for guards.
- Prefer real helper scripts over long inline shell for repository-local workflows. Dry-run helper scripts to verify they work before integrating them into a Workflow Spec. Inline Program scripts are acceptable when they stay short, deterministic, and mechanically verifiable.
- Let Agent Steps handle planning, judgment, synthesis, failure interpretation, role boundaries, and cross-round memory. If a Program Step starts to encode those decisions, move that work into an agent prompt and a durable handoff/report file.
- Use raw CEL in `when`, `until`, and expression-valued `over`; use `${{ ... }}` interpolation inside prompts, command strings, keys, and messages.
- Every Node exposes its primary produced value through `steps.<id>.output`. Program Steps also expose `steps.<id>.exit_code`.
- Ask before destructive workspace changes, publishing, pushing git refs, applying patches, or running external side-effect commands.

## Recovery Loop

When a Run fails or stalls:

1. `acpus runs show <runId> --json` — find the failed/awaiting nodeKey, error, artifact refs.
2. Read referenced artifacts before guessing. `artifact://runs/<runId>/nodes/<nodeKey>/<file>` resolves to `.acpus/state/runs/<runId>/artifacts/<encoded-key>/<file>` (`/` → `:`).
3. Pick the smallest recovery:
   - **Spec is wrong** (script bug, schema mismatch, control-flow error): edit spec, then `acpus runs fork <runId> <fixed-spec> [--dry-run] [--from <nodeKey>]`. Inherits unaffected work.
   - **Agent choice is wrong for the next submission**: use `--agents` on `workflows run` or `runs fork`; see `references/agent-selection.md`.
   - **Spec is fine, transient failure**: `acpus runs retry <runId> [--node <nodeKey>]` — retry replays the original frozen spec; if you edited the spec, use `fork` instead.
   - **Paused / awaiting / verifying**: `acpus runs resume <runId>` / `acpus runs signal <runId> --node <nodeKey> --approve|--reject` / `acpus runs replay <runId>`.

See `references/error-recovery.md` for failure-symptom decision table and fork semantics. Background polling cadence: `references/background-run-polling.md`.

## Agent Overrides

- Use Agent Overrides when reusing an existing Spec with different agents for one new Run.
- Prefer inline JSON for `--agents`, and dry-run first when exact agent selection matters.
- For detailed rules and examples, read `references/agent-selection.md`.

## Load More When Needed

- `references/best-practices.md`: gotchas and positive/negative authoring patterns.
- `references/expressions-and-outputs.md`: CEL, templates, and output shape rules.
- `references/composite-nodes.md`: guard, loop, fanout, parallel, and switch behavior.
- `references/error-recovery.md`: failure-specific recovery paths.
- `references/common-errors.md`: frequent authoring mistakes and runtime errors with fixes.
- `references/agent-selection.md`: choosing acpx-backed worker agents.
- `references/background-run-polling.md`: efficient polling cadence for background Runs.
- `references/playbooks.md`: GitHub source and raw links for public Agent Workflow Playbooks, which contains many complex workflow cases.
- `scripts/workflow-viz.py`: generate a self-contained HTML visualization page for a Workflow Spec (`python3 scripts/workflow-viz.py <spec.yaml> [-o out.html]`).
- `assets/examples/`: copyable Workflow Spec examples — `review-guard` (simple, guard), `draft-review-loop` (medium, loop), `topic-fanout-synthesis` (complex, fanout).

## Source Docs

- [README](https://github.com/kelvinschen/acpus/blob/main/README.md)
- [Workflow Spec](https://github.com/kelvinschen/acpus/blob/main/specs/workflow-spec.md)
- [Workflow Catalog Spec](https://github.com/kelvinschen/acpus/blob/main/specs/workflow-catalog-spec.md)
- [CLI Spec](https://github.com/kelvinschen/acpus/blob/main/specs/cli-spec.md)
- [Local Runtime Target Spec](https://github.com/kelvinschen/acpus/blob/main/specs/local-runtime-target-spec.md)
- [Schema Spec](https://github.com/kelvinschen/acpus/blob/main/specs/schema-spec.md)
