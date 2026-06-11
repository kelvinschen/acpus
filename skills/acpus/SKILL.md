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

5. Start quick Runs in the foreground and long Runs in the background:

   ```sh
   acpus workflows run <workflow-or-ref> --input '<json>'
   acpus workflows run <workflow-or-ref> --background --input '<json>'
   ```

6. Track background Run status with compact text output. Use decreasing polling intervals from `references/background-run-polling.md`; read the `Activity:` line on running Agent Steps to see transcript freshness, tool-call count, and recent tools:

   ```sh
   acpus runs show <runId>
   ```

   Use `--json` only when exact node keys, artifact refs, or machine-readable state are needed.

7. (Optional) Use the visualizer only when a human wants an interactive TUI:

   ```sh
   acpus workflows run <workflow-or-ref> --visualize --input '<json>'
   acpus runs visualize <runId>
   ```

## Authoring Rules

- Keep large intermediate material in files under `.acpus/output/...` or the workflow output directory. Return only paths, counts, booleans, decisions, and durable ids in node output.
- Keep `output:` schemas flat and minimal. Do not put the output schema in the prompt; Acpus injects it and retries parse/schema failures.
- Treat `output:` as workflow control data, not agent memory. Put reports, rationale, findings, handoff notes, and cross-step context in files, then return their paths.
- Use Program Steps only for deterministic local glue: preparing directories, computing paths, running verification, collecting diffs, applying or rolling back patches, and reading simple state for guards.
- Let Agent Steps handle planning, judgment, synthesis, failure interpretation, role boundaries, and cross-round memory. If a Program Step starts to encode those decisions, move that work into an agent prompt and a durable handoff/report file.
- Prefer real helper scripts over long inline shell for repository-local workflows. For public single-file templates, inline Program scripts are acceptable when they stay short, deterministic, and mechanically verifiable.
- Avoid `bash -lc` in Program Steps and verification wrappers. Use `bash -c` when shell semantics are required so the step inherits the runner environment instead of rebuilding it as a login shell.
- Approval gates are for humans. Agents may prepare approval context but must not approve on the human's behalf.
- Use raw CEL in `when`, `until`, and expression-valued `over`; use `${{ ... }}` interpolation inside prompts, command strings, keys, and messages.
- Only Agent Steps and Program Steps expose `steps.<id>.output`. Composite, guard, and approval outputs are direct values.
- Ask before destructive workspace changes, publishing, pushing git refs, applying patches, or running external side-effect commands.

## Recovery Loop

When a Run fails or stalls:

1. Inspect the Run and failed node:

   ```sh
   acpus runs show <runId> --json
   ```

2. Read referenced artifacts before guessing.
   `artifact://runs/<runId>/nodes/<nodeKey>/<filename>` resolves under the workspace state directory:
   `.acpus/state/runs/<runId>/artifacts/<encoded-node-key>/<filename>`, where `/` in the node key becomes `:`.
3. Choose the smallest recovery: `acpus runs retry <runId>`, `acpus runs retry <runId> --node <nodeKey>`, `acpus runs resume <runId>`, `acpus runs signal <runId> --node <nodeKey> --approve/--reject`, `acpus runs replay <runId>`, or fix the spec and start a new Run.
4. For background status tracking, follow `references/background-run-polling.md`; do not poll constantly.

## Load More When Needed

- `references/best-practices.md`: gotchas and positive/negative authoring patterns.
- `references/expressions-and-outputs.md`: CEL, templates, and output shape rules.
- `references/composite-nodes.md`: guard, loop, fanout, parallel, and switch behavior.
- `references/error-recovery.md`: failure-specific recovery paths.
- `references/agent-selection.md`: choosing acpx-backed worker agents.
- `references/background-run-polling.md`: efficient polling cadence for background Runs.
- `references/playbooks.md`: GitHub source and raw links for public Agent Workflow Playbooks.
- `assets/examples/`: copyable Workflow Spec examples.

## Source Docs

- [README](https://github.com/kelvinschen/acpus/blob/main/README.md)
- [Workflow Spec](https://github.com/kelvinschen/acpus/blob/main/specs/workflow-spec.md)
- [Workflow Catalog Spec](https://github.com/kelvinschen/acpus/blob/main/specs/workflow-catalog-spec.md)
- [CLI Spec](https://github.com/kelvinschen/acpus/blob/main/specs/cli-spec.md)
- [Local Runtime Target Spec](https://github.com/kelvinschen/acpus/blob/main/specs/local-runtime-target-spec.md)
- [Schema Spec](https://github.com/kelvinschen/acpus/blob/main/specs/schema-spec.md)
