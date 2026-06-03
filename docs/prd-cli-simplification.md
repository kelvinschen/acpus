# CLI Simplification PRD

## Problem Statement

The acpus CLI has 11 top-level commands grouped into four categories (Compose, Conduct, Recover, Catalogue). Several commands overlap in functionality, require redundant flags, or have misleading names. Specifically:

1. `validate` and `preview` are near-identical — `preview` is a strict superset of `validate` (it does the same load+lint, then adds plan estimation). Users must choose between two commands that mostly do the same thing.
2. `--spec <path>` is a required flag on every spec-accepting command, forcing `acpus run --spec foo.json` instead of the more natural `acpus run foo.json`.
3. `generate` creates a draft template, but the user must then `save` it separately — these are always used together.
4. `recover` is just "restart a stale worker" — a subset of what `resume` already does, yet they are separate commands in different groups.
5. `follow` promises streaming ("follow") but actually prints a one-shot snapshot — its name is misleading.
6. `list` and `show` require a positional `<kind>` argument with inconsistent singular/plural forms (`workflows` vs `workflow`), adding cognitive overhead.
7. The four-group structure (Compose, Conduct, Recover, Catalogue) has a singleton "Recover" group with only two commands.

These issues increase the learning curve, create redundancy, and make the CLI feel heavier than it is.

## Solution

Simplify the CLI from 11 commands to 7 top-level commands, restructured into three music-themed groups (Compose, Conduct, Catalogue) that align with the project's "opus" brand identity:

- **Merge `validate` and `preview` → `plan`**: A single command that validates the spec and, if valid, previews the execution plan. `--quiet` suppresses the plan and shows only issues (for CI).
- **Merge `generate` → `save --template`**: Scaffold + save in one step. The `drafts` directory and `draft` kind are removed.
- **Merge `recover` → `resume --force`**: Resume handles both blocked/failed recovery and stale worker restart. `--force` bypasses the active-worker check to restart a stale worker.
- **Make `<spec>` a positional argument with auto-detection**: `acpus run foo.json` (file path) or `acpus run my-workflow` (saved name). The CLI auto-detects by checking if the argument looks like a file path (exists on disk, has extension) or a saved workflow name.
- **Make `follow` actually stream**: Rename behavior to match name — stream events in real-time from a running workflow, rather than printing a one-shot snapshot.
- **Convert `list` and `show` to subcommand style**: `acpus list runs`, `acpus list workflows`, `acpus show run <id>`, `acpus show workflow <name>`. Remove `drafts`/`draft` kinds.
- **Restructure groups**: Compose (plan, save), Conduct (run, follow, monitor, resume, diagnose), Catalogue (list, show).

This is a breaking change. As the project is pre-1.0, no backward-compatibility layer is provided.

## User Stories

1. As a workflow author, I want to type `acpus plan my-spec.json` to validate and preview my spec in one step, so that I don't have to choose between `validate` and `preview`.
2. As a workflow author, I want `acpus plan my-spec.json --quiet` to show only validation issues, so that I can use it in CI pipelines that only care about pass/fail.
3. As a workflow author, I want `acpus plan my-spec.json --quiet --json` to get issues-only JSON output, so that I can programmatically consume validation results in CI.
4. As a workflow author, I want `acpus plan my-spec.json --json` to get the full plan as structured JSON, so that I can programmatically inspect agent call estimates and fanout work units.
5. As a workflow author, I want to type `acpus run my-spec.json` instead of `acpus run --spec my-spec.json`, so that the CLI feels more natural and requires less typing.
6. As a workflow author, I want to type `acpus run my-workflow` (without `.json` extension) to run a saved workflow by name, so that I don't have to remember whether to use `--spec` or `--workflow`.
7. As a workflow author, I want the CLI to auto-detect whether my argument is a file path or a saved workflow name, so that I don't need to specify `--spec` vs `--workflow` explicitly.
8. As a workflow author, I want `--workflow` to still work as an explicit flag for disambiguation, so that I can override auto-detection when needed.
9. As a workflow author, I want `acpus save my-wf my-spec.json` instead of `acpus save my-wf --spec my-spec.json`, so that the positional argument is consistent with other commands.
10. As a workflow author, I want `acpus save my-wf --template basic` to scaffold and save a new workflow from a template in one step, so that I don't have to run `generate` then `save` separately.
11. As a workflow author, I want `acpus resume my-run --force` to restart a stale worker, so that I don't need a separate `recover` command.
12. As a workflow author, I want `acpus resume my-run` (without `--force`) to handle blocked/failed run recovery, so that resume is the single command for all recovery scenarios.
13. As a workflow author, I want `acpus follow my-run` to stream events in real-time, so that the command name matches its behavior.
14. As a workflow author, I want `acpus list runs` and `acpus list workflows` as subcommands, so that tab-completion and help text are clearer.
15. As a workflow author, I want `acpus show run my-run-id` and `acpus show workflow my-wf` as subcommands, so that the command structure is consistent with `list`.
16. As a CI operator, I want `acpus plan my-spec.json --quiet` to set exit code 1 on validation failure and only print issues, so that CI output is clean.
17. As a CI operator, I want `acpus plan my-spec.json --quiet --json` to produce machine-readable issues, so that I can parse validation results in automation.
18. As a workflow author, I want `acpus plan my-workflow` (saved name) to work the same as `acpus plan my-spec.json` (file path), so that I can plan against saved workflows without extra flags.
19. As a workflow author, I want `acpus run my-workflow --global` to resolve from the global workflow store, so that cross-project workflows work seamlessly.
20. As a workflow author, I want `acpus save my-wf my-spec.json --overwrite` to continue working as before, so that I can update saved workflows.
21. As a workflow author, I want `acpus save my-wf my-spec.json --template basic --overwrite` to scaffold and overwrite in one step, so that I can iterate on templates.
22. As a workflow author, I want `--global` to remain on plan, run, save, list, and show, so that I can work with the global workflow store.
23. As a workflow author, I want the `--help` output to show three music-themed groups (Compose, Conduct, Catalogue), so that the CLI feels cohesive with the project's brand.
24. As a workflow author, I want `acpus resume my-run --force` to bypass the active-worker check, so that I can restart a worker I know is stale without waiting for heartbeat timeout.
25. As a workflow author, I want `acpus resume my-run --allow-partial-fanout stage3` to continue working as before, so that my existing resume policy workflows are not disrupted.
26. As a workflow author, I want `acpus follow my-run --json` to stream NDJSON events, so that I can programmatically consume run progress.
27. As a workflow author, I want `acpus monitor my-run` to open the TUI as before, so that the interactive monitoring experience is preserved.
28. As a workflow author, I want `acpus diagnose my-run --wait` to continue working as before, so that diagnostic workflows are not disrupted.

## Implementation Decisions

### 1. New `plan` command replaces `validate` and `preview`

The `plan` command merges both commands. Its action handler:
1. Resolves the spec path (positional arg with auto-detect, or `--workflow`/`--global`).
2. Calls `loadAndLint(specPath)` — identical to the current shared logic.
3. If the spec is valid, calls `previewRunView()` to build the full plan view (agent call estimates, fanout work, risks, stages).
4. In `--quiet` mode, skips the `previewRunView()` step and outputs only issues.
5. Sets `process.exitCode = 1` when `!result.ok`, preserving CI utility.

The `validate.ts` and `preview.ts` command files are deleted. A new `plan.ts` replaces them.

### 2. Positional `<spec>` argument with auto-detection

A new `resolveSpecArg` function replaces the current `resolveSpecPath`. The resolution order:
1. If `--workflow <name>` is explicitly provided, resolve from the saved workflows directory (respecting `--global`).
2. If a positional argument is provided:
   a. If the argument matches an existing file on disk (checked via `fs.access`), treat it as a file path.
   b. If the argument contains a path separator (`/` or `\\`) or has a recognized extension (`.json`, `.spec.json`), treat it as a file path.
   c. Otherwise, treat it as a saved workflow name and resolve from the workflows directory.
3. If neither is provided, throw an error asking the user to provide a spec.

This logic is added to `common.ts`. The `--spec` flag is removed from all commands. The positional argument is named `<spec>` in Commander registration.

### 3. `save` gains `--template` flag, replacing `generate`

The `save` command:
- Keeps its existing behavior when `--template` is not provided.
- When `--template <name>` is provided, generates the spec from a template (same scaffold logic currently in `generate.ts`) instead of requiring a `--spec` path.
- The `<spec>` positional argument becomes optional when `--template` is used.
- The `generate.ts` command file is deleted.
- Template names are implementation-defined; initially only `basic` is supported (matching the current `generate` output).
- The `.acpus/drafts/` directory is no longer created or referenced.

### 4. `resume --force` replaces `recover`

The `resume` command:
- Keeps all existing behavior (resume policy flags, status validation, worker activity check).
- Adds `--force` flag that bypasses the `workerIsActive` check, enabling restart of a stale worker. This is the `recover` use case.
- When `--force` is used on a run that is not blocked/failed/diagnosed_blocked AND has no active worker, it still rejects (same status validation as current `recover`).
- The `recover.ts` command file is deleted. The `recoverDriver` function from `src/runtime/worker.ts` is inlined or called from the resume handler.

### 5. `follow` streams events instead of snapshot

The `follow` command is reworked to stream events:
1. Syncs the run index initially.
2. Watches `events.ndjson` for new lines appended after the initial sync, streaming each event to stdout.
3. In text mode, prints each event as a formatted line. In `--json` mode, prints each event as a NDJSON line.
4. Exits when the run reaches a terminal status.
5. The one-shot snapshot behavior is no longer available via `follow`; users who want a snapshot can use `monitor --json`.

This requires a file-watching mechanism (polling `events.ndjson` with offset tracking, or `fs.watch` with tail logic). The implementation should use a simple polling approach with a configurable interval.

### 6. `list` and `show` converted to subcommand style

`list`:
- `acpus list runs` — lists run directories.
- `acpus list workflows` — lists saved workflow directories.
- The `<kind>` positional argument is replaced by Commander subcommands registered on the `list` command.
- The `drafts` kind is removed entirely.

`show`:
- `acpus show run <id>` — shows run details.
- `acpus show workflow <name>` — shows workflow spec.
- The `<kind>` and `<name>` positional arguments are replaced by Commander subcommands.
- The `draft` kind is removed.

### 7. Group restructuring in `cli.ts`

The program description changes from "Acpus — compose, conduct, recover, catalogue." to "Acpus — compose, conduct, catalogue."

Command registration order in `cli.ts`:
```
// ── Compose ─────────────────────────────────────────────────
registerPlan(program);
registerSave(program);

// ── Conduct ──────────────────────────────────────────────────
registerRun(program);
registerFollow(program);
registerMonitor(program);
registerResume(program);
registerDiagnose(program);

// ── Catalogue ────────────────────────────────────────────────
registerList(program);
registerShow(program);
```

Deleted registrations: `registerValidate`, `registerPreview`, `registerGenerate`, `registerRecover`.

### 8. Spec CLI spec update

The `specs/cli-spec.md` normative requirements must be updated to reflect all changes:
- `validate` and `preview` requirements are replaced by `plan` requirements.
- `generate` requirements are replaced by `save --template` requirements.
- `recover` requirements are replaced by `resume --force` requirements.
- `follow` streaming behavior is codified.
- `list`/`show` subcommand structure is codified.
- The `<spec>` positional argument and auto-detection logic are codified.

### 9. `plan` flags summary

| Flag | Behavior |
|---|---|
| `<spec>` (positional) | Spec file path or saved workflow name (auto-detected) |
| `--workflow <name>` | Explicit saved workflow name (overrides auto-detect) |
| `--global` | Resolve from global workflow store |
| `--quiet` | Suppress plan preview; show only validation issues |
| `--json` | JSON output (issues-only with `--quiet`, full plan without) |

### 10. `save` updated interface

```
acpus save <name> [spec] [--template <name>] [--overwrite] [--global] [--json]
```

- `<name>` — required workflow name.
- `[spec]` — optional positional spec path (required unless `--template` is used).
- `--template <name>` — generate from template instead of loading a spec file.
- When `--template` is used, `<spec>` must not be provided (mutual exclusion).

### 11. `resume --force` behavior

- Without `--force`: current behavior — rejects runs with active workers, only allows blocked/failed/diagnosed_blocked.
- With `--force`: allows resuming runs with stale workers (bypasses `workerIsActive` check). Still rejects terminal runs (completed, cancelled). Still rejects runs with a genuinely active (non-stale) worker unless the heartbeat is stale.
- Implementation: the `--force` flag relaxes the worker-activity guard to only reject when the worker heartbeat is recent (within the stale threshold). This mirrors the current `recoverDriver` logic.

### 12. `follow` streaming design

The streaming `follow` implementation:
1. Read the current `events.ndjson` file and print all existing events.
2. Track the byte offset of the last read.
3. Poll the file at a short interval (e.g., 500ms) for new content appended after the offset.
4. For each new line, parse and output the event.
5. After each event batch, check if the run has reached a terminal status by reading the run index.
6. Exit when terminal status is detected or the process receives SIGINT.

The `--json` flag outputs raw NDJSON events. Text mode formats each event type distinctly (stage transitions, worker events, gate verdicts, etc.).

## Testing Decisions

### What makes a good test

Tests should verify external CLI behavior (command names, flags, exit codes, stdout/stderr output) rather than internal implementation details. The highest test seam is the integration test that spawns the CLI via `tsx` and asserts on its output — this is the existing pattern in `test/integration/cli-lifecycle.test.ts`.

### Modules to be tested

1. **`plan` command**: Test that `plan <spec>` validates and produces plan output. Test `--quiet` suppresses plan. Test `--json` output structure. Test positional spec auto-detection (file path vs workflow name).
2. **`save --template`**: Test that `save <name> --template basic` creates a saved workflow from template. Test mutual exclusion of `--template` and spec argument.
3. **`resume --force`**: Test that `resume --force` restarts a stale worker (current `recover` test case). Test that `resume --force` still rejects terminal runs.
4. **`follow` streaming**: Test that `follow` streams events from a running workflow. Test `--json` NDJSON output. Test exit on terminal status.
5. **`list` subcommands**: Test `list runs` and `list workflows` as subcommands. Test that bare `list` without a subcommand shows help or errors.
6. **`show` subcommands**: Test `show run <id>` and `show workflow <name>` as subcommands. Test that bare `show` without a subcommand shows help or errors.
7. **Positional spec auto-detection**: Test that a file path is resolved as a spec. Test that a non-file argument is resolved as a workflow name. Test `--workflow` override.

### Prior art

- The existing `test/integration/cli-lifecycle.test.ts` is the primary seam. It uses `execa` to spawn `tsx src/cli.ts` with subcommand arguments. This pattern should be preserved and extended.
- Unit tests for `resolveSpecPath` / `resolveSpecArg` can be added to test the auto-detection logic in isolation.
- The existing `test/unit/resume-policy.test.ts` already tests resume policy parsing; `--force` flag handling can be added there.

### Test migration from `cli-lifecycle.test.ts`

The existing integration test exercises `validate`, `preview`, `generate`, `list drafts`, `show draft`, and `recover`. These test cases must be rewritten:
- `validate --spec ... --json` → `plan <spec> --quiet --json`
- `preview --spec ... --json` → `plan <spec> --json`
- `generate --name ... --json` → `save <name> --template basic --json`
- `list drafts --json` → removed (no drafts)
- `show draft <name> --json` → removed (no drafts)
- `recover <run-id>` → `resume <run-id> --force`
- `run --workflow <name>` → `run <name>` (positional auto-detect)
- `list workflows --json` → `list workflows --json` (unchanged)
- `list runs --json` → `list runs --json` (unchanged)
- `show workflow <name> --json` → `show workflow <name> --json` (now subcommand)
- `show run <id> --json` → `show run <id> --json` (now subcommand)

## Out of Scope

- **Backward compatibility aliases**: No hidden aliases for removed commands (`validate`, `preview`, `generate`, `recover`). Pre-1.0 breaking change.
- **`follow` snapshot mode**: The one-shot snapshot behavior is removed. Users should use `monitor --json` for a single status check.
- **Additional templates**: Only the `basic` template (matching current `generate` output) is in scope. Adding more templates (e.g., `fanout`, `loop`) is future work.
- **`monitor` changes**: The `monitor` TUI and its `detail` subcommand are unchanged.
- **`diagnose` changes**: The `diagnose` command behavior is unchanged; only its group assignment changes.
- **Skill wrapper update**: The `skills/acpus/scripts/acpus` wrapper is not in scope but should be updated in a follow-up.
- **JSON output schema changes**: No changes to the structure of JSON output envelopes (e.g., `run --json`, `resume --json`). New envelopes (`plan --json`, `follow --json`) follow existing conventions.
- **`--global` changes**: The `--global` flag behavior and availability are unchanged.
- **`_run-worker` internal command**: Unchanged.

## Further Notes

- This PRD encodes the decisions from a structured interview session where each branch of the design tree was resolved with the project author.
- The music-themed grouping (Compose, Conduct, Catalogue) aligns with the project's "opus" brand identity — "Every run is an opus."
- The `plan` command name was chosen over `check` and `dry-run` because it directly conveys "show me the execution plan" and naturally implies that validation is a prerequisite (you can't plan an invalid spec).
- The `follow` streaming implementation should use simple polling rather than filesystem watchers for portability and simplicity.
- The positional spec auto-detection heuristic (file exists → spec path, otherwise → workflow name) is intentionally simple. If edge cases arise, the `--workflow` flag provides an explicit override.
- The `drafts` directory under `.acpus/` can be deprecated (not deleted on disk) in this change. A future version may clean up old drafts.
