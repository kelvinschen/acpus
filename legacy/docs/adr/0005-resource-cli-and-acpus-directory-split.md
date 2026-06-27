# Use resource-first CLI and split `.acpus` author assets from runtime state

Workflow definitions need a stable project/global discovery surface for humans and AI agents, while Run state can grow quickly and should remain ignored local runtime data. The previous flat CLI mixed Workflow execution commands and Run commands at the top level, and `.acpus/` was entirely runtime state.

## Considered Options

- Keep top-level commands and add only `acpus workflows`.
- Keep `.acpus/` entirely ignored and continue storing Runs directly under `.acpus/runs`.
- Split author assets and runtime state under `.acpus/`.
- Use a resource-first CLI with `workflows` and `runs`.

## Decision

Acpus uses a resource-first CLI. Workflow definition commands live under `acpus workflows`, with `acpus wf` as a human shorthand. Run commands live under `acpus runs`, including `acpus runs clean` for deleting terminal Run records.

Project Workflow Catalog entries live under tracked `.acpus/workflows/`. Runtime state lives under ignored `.acpus/state/`, including Runs, supervisor metadata, supervisor lock, and supervisor logs. Global Workflow Catalog entries live under `$HOME/.acpus/workflows/`.

## Consequences

AI agents can discover reusable Workflow Specs with `acpus workflows list --json` and execute a selected `ref` with `acpus workflows run <ref>`. Humans can use the shorter `acpus wf` alias. Runtime cleanup is explicit through `acpus runs clean`, which deletes terminal Runs but preserves running and paused Runs.
