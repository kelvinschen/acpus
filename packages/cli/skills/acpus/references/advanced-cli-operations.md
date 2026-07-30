# Advanced CLI Operations

Read this only for inspection pagination/follow mechanics, detailed runtime
controls, catalogs, import, static visualization, WebUI, bundled-skill
management, artifact lookup, run deletion, or CLI automation. Use
`acpus <cmd> --help` for exact options.

If the CLI is unavailable, ask before suggesting `npm install -g acpus`.

## Standalone Check

Use `workflow check` only when validation without execution is the goal:

```sh
acpus workflow check <workflow> [--input <json|file.json>]
```

Use the same selected path, catalog, or `-` stdin source as `workflow run`. `workflow check` typechecks, compiles, and validates in memory. `--input` accepts strict inline JSON or a `.json` file resolved from the CLI working directory; prefer files for realistic payloads.

## Inspection details

Start with the Summary path in [CLI Operations](cli-operations.md).
- For a repeated authored target, choose one candidate `@ref` before paging or following.
- Use the printed `Next` or `Older` command to continue a candidate, Timeline, or Evidence view.
- `--follow` waits for the next decision boundary; use it for one decision-controlling transition, not polling.
- Use `--evidence` only for an exact prompt, fence, or terminal diagnosis.
- Use `--raw --json` only for diagnosis; it does not expose private bodies. Full provider-frame history needs `trace: true`; see [Agent Tracing](agent-tracing.md).

## Runtime control details

This section describes command mechanics. [Runtime Recovery](runtime-recovery.md#recovery-decision) owns recovery and intervention decisions.

Inspect before controlling a run and copy its printed operation command rather than writing an occurrence target.

Mutating controls start or wake the workspace daemon and wait up to 30 seconds for a durable effect. Success confirms that effect, not downstream completion. A control timeout reports unconfirmed application; inspect again before repeating it.

### Signal

```sh
acpus runs signal <run-id> --target <signal-target> --payload '<json>'
```

Schema-backed Signals validate the supplied JSON. Schema-less Signals require a JSON string such as `--payload '"approved"'`; Runtime passes its decoded string value through unchanged.

An invalid payload does not consume the wait and may return `RUN_NOT_CONTROLLABLE` with a schema path. Success confirms validation, not downstream completion. A timed-out wait is closed; inspect it, then use retry or fork instead of signaling it again.

### Steer

```sh
acpus runs steer <run-id> --target <exact-agent-target> --instruction '<correction>'
```

Apply the [Recovery decision](runtime-recovery.md#recovery-decision) rules before use.

Success durably fences the old attempt and queues `<steering>…</steering>` in the same Agent session. It does not mean the corrected work has completed. Receipts and follow output do not echo the instruction, but inline instructions remain visible in shell history and process listings;

### Pause and resume

```sh
acpus runs pause <run-id>
acpus runs resume <run-id>
```

Pause records a durable gate and requests best-effort abort of active attempts. Resume clears the gate and re-drives eligible work. These controls return after their immediate durable effect is confirmed, not after later work becomes terminal.

Pause and resume are idempotent. Pause fences active attempts from late commits and waits for bounded executor cleanup before reporting `paused`; resume continues through a newly claimed execution session. Signal timeout budgets are suspended while paused and restored on resume.

### Retry

```sh
acpus runs retry <run-id> [--target <target>]
```

Omitting `--target` resets eligible failed work across the run. A target must resolve to one failed node or frame. Runtime reopens only its required ancestor path and `parent_failed` completion dependencies, without broadening to independent failures.

Resume a paused run before retrying it. Retry rejects completed/canceled blockers, incompatible composite state, and targets that cannot make work admissible; rejection leaves durable state unchanged. Dynamic targets come from the source run's frozen workflow. Retry a pre-execution configuration-resolution failure through its containing frame or the whole run.

### Fork

```sh
acpus runs fork <run-id> \
  [--workflow <workflow> [--project | --global]] [--input <json|file.json>] \
  [--agents '<json>'] \
  [--target <replacement-target>] [--unsafe-reuse]
```

Fork creates a child run and leaves the source unchanged. Its receipt identifies both runs; continue inspection on the child. Unspecified workflow, input, and Agent overrides are inherited. Providing new input disables normal completed-output reuse.

Replacement workflows have the same resolution as check/run/viz: use a path,
a catalog name with optional scope, or `--workflow -` for raw UTF-8 TypeScript
on stdin. Scope flags require `--workflow` and cannot be used with `-`.

Omit `--target` unless recovery should begin at one point in the replacement workflow. For an inherited workflow, copy the target from source inspection; for a replacement, use one of its authored targets. Safe reuse carries only compatible completed prerequisites and registered artifacts. `--unsafe-reuse` relaxes workflow/input/signature compatibility checks; use it only when reusing earlier results and side effects is intentional.

### Cancel

```sh
acpus runs cancel <run-id> [--target <target>]
```

Run-level cancel is idempotent. A targeted cancel must resolve unambiguously to one non-terminal node or frame; it terminalizes that scheduler subtree as `operator_cancelled`. Both forms durably fence late result, artifact, and progress commits.

Treat cancel as destructive and ask before using it unless cancellation was already explicitly requested.

## Catalog and import

Catalog and import are for named or reusable workflows, not disposable heredoc runs. Project entries live under `.acpus/workflows/<name>/workflow.ts`; global entries under `$HOME/.acpus/workflows/<name>/workflow.ts`. The direct lower-kebab `defineWorkflow({ name })` must equal the package directory. Catalog names work with check, run, and viz; pass `--project` or `--global` when names collide. Discovery is static: invalid first-level packages remain listable but cannot be used.

```
acpus workflow catalog [name] [--project | --global]
acpus workflow import <file|directory|zip|tgz|http-url> [--project | --global] [--check]
```

Omit `name` in an interactive terminal to select an available workflow; piped text lists compact scope/status/name rows without paths, and `--json` returns the complete catalog projection without prompting. Provide a name to inspect its unique available entry; its TTY detail view uses restrained semantic color and honors `NO_COLOR`. Use a scope flag when project and global catalogs contain the same name.

Import copies one snapshot: it does not install dependencies, track the source, update, or overwrite. Default import reads metadata statically. `--check` executes trusted module top-level code and commits only after preparation succeeds; a global check proves compatibility only in the current workspace.

## Static visualization

```sh
acpus workflow viz <workflow> [--out <file.html> [--force]]
```

This accepts the same path, catalog, or `-` stdin source as run and prepares it without creating a run. 
With no `--out`, it prints a compact semantic tree to stdout; `--out` writes self-contained HTML instead. Both show the authored graph, while fanout items and loop rounds materialize only at runtime. Existing HTML output is rejected unless `--force` is explicit.

## Web operator console

```sh
acpus web [--host <host>] [--port <port>] [--token] [--json]
```

The command ensures the workspace daemon is running, binds to localhost and a random port by default, and stops on `Ctrl-C`. Use `--token` when access needs protection; JSON output can contain that sensitive token.

## Bundled skill and version

```sh
acpus skill install [--project | --global | --dir <skills-root>] [--agent <universal|claude|universal,claude>] [--dry-run]
acpus skill uninstall [--project | --global | --dir <skills-root>] [--agent <universal|claude|universal,claude>] [--dry-run]
acpus --version
```

Skill commands manage the Acpus skill bundled with this CLI and refuse targets not identifiable as Acpus skills. In a terminal they prompt only for missing scope or Agent selections. Scoped automation must provide `--project` or `--global` and `--agent`; selected roots are `.agents/skills/acpus` for universal agents and `.claude/skills/acpus` for Claude under the project or home directory. Install creates missing selected roots. They do not install or remove the npm package.

Alternatively, `--dir <skills-root>` selects one custom skills root without an Agent selection and installs or uninstalls `<skills-root>/acpus`. 

## Artifact registry

```sh
acpus runs artifacts <run-id> [--target <node-or-frame-or-attempt>]
```

This lists registered artifact metadata and absolute paths without reading file bodies. Use `--target` to narrow one static/dynamic node, frame, or attempt; use target inspection instead when surrounding execution state is also needed.

## Run maintenance

`acpus runs delete [run-id]` hard-deletes durable state and run-local artifacts without starting the daemon. It rejects active live runs and opens a multi-select picker when run id is omitted. Ask before deleting unless already explicitly requested.

## Structured automation

Put `--json` after the executable leaf. One-shot commands return one JSON
object; follow commands return NDJSON observations until their decision
boundary. Parse one line at a time, preserve order, and use focused `jq`
filters.
