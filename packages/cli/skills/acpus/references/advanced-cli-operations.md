# Advanced CLI Operations

Read this only for Forensics, inspection candidate-selection/follow mechanics, detailed runtime
controls, catalogs, import, static visualization, WebUI, bundled-skill
management, run deletion, or version lookup. Use
`acpus <cmd> --help` for exact options.

If the CLI is unavailable, ask before suggesting `npm install -g acpus`.

## Standalone Check

Use `workflow check` only when validation without execution is the goal:

```sh
acpus workflow check <workflow> [--input <json|file.json>] [--agents <json|file.json>]
```

- **Source:** Accept the same path, catalog, or `-` stdin source as `workflow run`.
- **Effect:** Typecheck, compile, and validate without creating a run.
- **Input:** Pass strict inline JSON or a CLI-working-directory `.json` file through `--input` and Agent injections through `--agents`.

## Inspection details

Start with the Summary path in [CLI Operations](cli-operations.md).
- A repeated authored target returns every occurrence in stable path order; choose one candidate `@ref` before following or inspecting its details.
- Candidate Select commands preserve Timeline or Forensics detail. Timeline always shows its fixed recent window.
- `--follow` waits until the fixed subject is terminal. `--await-decision` waits until that subject needs external input, is paused, or is terminal.
- For settled turn artifacts or the run-local ACP session projection, see [Agent Records](agent-records.md).

### Forensics

Use Forensics only when diagnosis depends on reconciling the run's frozen Definition, actual Invocation, and scheduler-accepted Result. It is not an ordinary monitoring or proof-of-progress view.

```sh
acpus runs inspect <run-id> [--target <nodeId|@ref|@ref#attemptNo>] --forensics
```

Omitting `--target` inspects `root`. Forensics is one-shot and cannot be combined with `--timeline`, `--follow`, or `--await-decision`. 

- **Definition:** Frozen effective workflow.
- **Invocation:** Values resolved for the selected occurrence or Attempt.
- **Result:** Accepted output or explicit terminal state.
- **Sensitivity:** Values are complete and may contain sensitive business data.

## Runtime control details

This section describes command mechanics. [Runtime Recovery](runtime-recovery.md#recovery-decision) owns recovery and intervention decisions.

Inspect before controlling a run and use its displayed public selector rather than reconstructing an internal occurrence identity.

- Mutating controls start or wake the workspace daemon and wait up to 30 seconds.
- Success confirms the requested control, not downstream completion.
- A timeout means application is unconfirmed. Inspect before repeating the control.

### Signal

```sh
acpus runs signal <run-id> --target <signal-target> --payload '<json>'
```

Schema-backed Signals validate the supplied JSON. Schema-less Signals require a JSON string such as `--payload '"approved"'`; Runtime passes its decoded string value through unchanged.

- **Invalid payload:** Leaves the wait open and may return `RUN_NOT_CONTROLLABLE` with a schema path.
- **Success:** Confirms validation, not downstream completion.
- **Timed-out wait:** Is closed. Inspect it, then Retry or Fork instead of signaling again.

### Steer

```sh
acpus runs steer <run-id> --target <exact-agent-target> --instruction '<update>'
```

Apply the [Recovery decision](runtime-recovery.md#recovery-decision) rules before use.

- **Delivery:** Interrupt & Continue. Fence the exact active Attempt, drain its current Turn, then queue `<steering>…</steering>` for a replacement Turn in the same Agent Session.
- **Success means:** The instruction was accepted for delivery.
- **Success does not mean:** The Provider consumed it or completed the updated work.
- **Side effects:** Already-performed tools and side effects are not rolled back.
- **Privacy:** Receipts and inspection do not echo the instruction or raw Agent binding inputs. Inline text remains visible in shell history and process listings.

### Pause and resume

```sh
acpus runs pause <run-id>
acpus runs resume <run-id>
```

- **Pause:** Stop admitting new work, request cancellation of active Attempts, and reject their late results. Report `paused` after bounded cleanup.
- **Resume:** Clear the pause and continue eligible work.
- **Signals:** Suspend timeout budgets while paused and restore them on resume.
- Both controls are idempotent and confirm only their immediate effect, not later completion.

### Retry

```sh
acpus runs retry <run-id> --target <task-agent-or-frame-target>
```

- **Target:** One failed or timed-out Task, Agent, or frame. There is no run-level Retry.
- **Reopens:** The complete required path, including parents that failed only because required descendants failed. Independent failures stay unchanged.
- **Rejects:** Completed/canceled blockers, incompatible composite state, or a target that cannot make work admissible. Rejection leaves the run unchanged.
- **Local Agent:** Clean up affected Sessions; start the next Attempt in a new generation with the authored prompt.
- **Shared `sessionKey`:** Reject without changes and print the exact Fork command. Retry cannot split shared conversation continuity.

### Fork

```sh
acpus runs fork <run-id> \
  [--workflow <workflow> [--project | --global]] [--input <json|file.json>] \
  [--agents <json|file.json>] \
  [--target <source-target>]
```

- **Use Fork when:** Workflow, input, Agent binding, or Task definition must change.
- **Child:** Leave the source unchanged, inherit every option not replaced, then inspect the child id from the receipt.
- **With `--target`:** Rerun the target and work completed after it became ready. Rerun any intersecting explicit `sessionKey` conversation as one unit.
- **Without `--target`:** Reuse compatible completed results. Ambient state and randomness are outside compatibility matching.
- **Shared `sessionKey`:** Reuse the complete closed conversation or rerun it entirely in a fresh child Session.
- **Artifacts:** Follow reused results.

To rewind, such as re-asking a consumed Signal, copy its `@ref` (without `#1`) from source inspection.

`--workflow` accepts the same path, catalog, or `-` stdin forms as `workflow run`. Use `--project` or `--global` only with a catalog workflow.

### Cancel

```sh
acpus runs cancel <run-id> [--target <target>]
```

Run-level cancel is idempotent. A targeted cancel must resolve unambiguously to one non-terminal node or frame and cancels that subtree. Late results, artifacts, and progress from canceled work are not accepted.

Treat cancel as destructive and ask before using it unless cancellation was already explicitly requested.

## Catalog and import

- Use catalog/import for named or reusable workflows, not disposable heredoc runs.
- Store project entries at `.acpus/workflows/<name>/workflow.ts` and global entries at `$HOME/.acpus/workflows/<name>/workflow.ts`.
- Match the direct lower-kebab `defineWorkflow({ name })` to the package directory.
- Pass `--project` or `--global` when catalog names collide.
- Invalid first-level packages remain listable but cannot be used.

```
acpus workflow catalog [name] [--project | --global]
acpus workflow import <file|directory|zip|tgz|http-url> [--project | --global] [--check]
```

- **Browse:** Omit `name` in a terminal to select a workflow; piped output groups names and statuses by scope.
- **Inspect:** Provide `name`; add a scope flag when project and global entries collide.
- **Import:** Copy one snapshot. Do not install dependencies, track updates, or overwrite.
- **`--check`:** Use only with trusted modules because it executes module top-level code. A global check proves compatibility only in the current workspace.

## Static visualization

```sh
acpus workflow viz <workflow> [--out <file.html> [--force]]
```

This accepts the same path, catalog, or `-` stdin source as run and prepares it without creating a run. 
- Without `--out`, print a compact semantic tree.
- With `--out`, write self-contained HTML.
- Show the authored graph only; fanout items and loop rounds appear during execution.
- Require `--force` to replace existing HTML.

## Web operator console

```sh
acpus web [--host <host>] [--port <port>] [--token]
```

- Bind to localhost and a random port by default.
- Stop with `Ctrl-C`.
- Use `--token` when access needs protection.

## Bundled skill and version

```sh
acpus skill install [--project | --global | --dir <skills-root>] [--agent <universal|claude|universal,claude>] [--dry-run]
acpus skill uninstall [--project | --global | --dir <skills-root>] [--agent <universal|claude|universal,claude>] [--dry-run]
acpus --version
```

- Manage only the Acpus Skill bundled with this CLI, not the npm package.
- In a terminal, prompt for missing scope or Agent selections.
- Outside a terminal, require `--project` or `--global` plus `--agent`.
- Use `--dir <skills-root>` for one custom root without `--agent`.

## Run maintenance

- `runs delete [run-id]` removes run state and artifacts; without an id, open a multi-select picker.
- Reject active runs.
- Use `runs prune --dry-run` to preview age-based terminal-run cleanup.
- Ask before deleting unless the user already requested it.
