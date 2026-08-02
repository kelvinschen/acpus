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
- `--page` continues only a candidate view; Timeline always shows its fixed recent window.
- `--follow` waits until the fixed subject is terminal. `--await-decision` waits until that subject needs external input, is paused, or is terminal.
- Inspection is text-only. It has no JSON/NDJSON, raw, topology, controls, or custom-limit surface. For settled turn artifacts or the run-local acpx session projection, see [Agent Records](agent-records.md).

## Runtime control details

This section describes command mechanics. [Runtime Recovery](runtime-recovery.md#recovery-decision) owns recovery and intervention decisions.

Inspect before controlling a run and use its displayed public selector rather than reconstructing an internal occurrence identity.

Mutating controls start or wake the workspace daemon and wait up to 30 seconds for a durable effect. Success confirms that effect, not downstream completion. A control timeout reports unconfirmed application; inspect again before repeating it.

### Signal

```sh
acpus runs signal <run-id> --target <signal-target> --payload '<json>'
```

Schema-backed Signals validate the supplied JSON. Schema-less Signals require a JSON string such as `--payload '"approved"'`; Runtime passes its decoded string value through unchanged.

An invalid payload does not consume the wait and may return `RUN_NOT_CONTROLLABLE` with a schema path. Success confirms validation, not downstream completion. A timed-out wait is closed; inspect it, then use retry or fork instead of signaling it again.

### Steer

```sh
acpus runs steer <run-id> --target <exact-agent-target> --instruction '<update>'
```

Apply the [Recovery decision](runtime-recovery.md#recovery-decision) rules before use.

Success durably fences the old attempt and queues `<steering>…</steering>` in the same Agent session. It does not mean the updated work has completed. Receipts and inspection output do not echo the instruction, but inline instructions remain visible in shell history and process listings.

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

Retry rejects completed/canceled blockers, incompatible composite state, and targets that cannot make work admissible; rejection leaves durable state unchanged. Dynamic targets come from the source run's frozen workflow. Retry a pre-execution configuration-resolution failure through its containing frame or the whole run.

### Fork

```sh
acpus runs fork <run-id> \
  [--workflow <workflow> [--project | --global]] [--input <json|file.json>] \
  [--agents '<json>'] \
  [--target <source-target>]
```

Use fork when the workflow, input, Agent mapping, or Task definition must change. It creates a child run, leaves the source unchanged, and inherits every option you do not replace. Continue inspection on the child id from the receipt.

Usually omit `--target`, including after a failure. Acpus reuses completed work that is still valid and runs affected or unfinished work normally:

- Changing one input field reruns only work that reads it.
- Changing one step reruns that step; later work may still be reused when its input remains the same.
- Fork starts new Agent conversations, so work using `sessionKey` runs again. Reused artifacts follow their results automatically.

Use `--target` only to deliberately rewind, such as re-asking a consumed Signal. Copy the occurrence selector `@ref` (without suffixes like `#1` ) from source inspection; that point and later work run again.

`--workflow` accepts the same path, catalog, or `-` stdin forms as `workflow run`. Use `--project` or `--global` only with a catalog workflow.

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

Omit `name` in an interactive terminal to select an available workflow; piped text lists compact scope/status/name rows without paths. Provide a name to inspect its unique available entry; its TTY detail view uses restrained semantic color and honors `NO_COLOR`. Use a scope flag when project and global catalogs contain the same name.

Import copies one snapshot: it does not install dependencies, track the source, update, or overwrite. Default import reads metadata statically. `--check` executes trusted module top-level code and commits only after preparation succeeds; a global check proves compatibility only in the current workspace.

## Static visualization

```sh
acpus workflow viz <workflow> [--out <file.html> [--force]]
```

This accepts the same path, catalog, or `-` stdin source as run and prepares it without creating a run. 
With no `--out`, it prints a compact semantic tree to stdout; `--out` writes self-contained HTML instead. Both show the authored graph, while fanout items and loop rounds materialize only at runtime. Existing HTML output is rejected unless `--force` is explicit.

## Web operator console

```sh
acpus web [--host <host>] [--port <port>] [--token]
```

The command ensures the workspace daemon is running, binds to localhost and a random port by default, and stops on `Ctrl-C`. Use `--token` when access needs protection.

## Bundled skill and version

```sh
acpus skill install [--project | --global | --dir <skills-root>] [--agent <universal|claude|universal,claude>] [--dry-run]
acpus skill uninstall [--project | --global | --dir <skills-root>] [--agent <universal|claude|universal,claude>] [--dry-run]
acpus --version
```

Skill commands manage the Acpus skill bundled with this CLI and refuse targets not identifiable as Acpus skills. In a terminal they prompt only for missing scope or Agent selections. Scoped automation must provide `--project` or `--global` and `--agent`; selected roots are `.agents/skills/acpus` for universal agents and `.claude/skills/acpus` for Claude under the project or home directory. Install creates missing selected roots. They do not install or remove the npm package.

Alternatively, `--dir <skills-root>` selects one custom skills root without an Agent selection and installs or uninstalls `<skills-root>/acpus`. 

## Artifacts

```sh
acpus runs artifact 'artifact://<run-id>/<artifact-id>' [--json]
acpus runs artifacts <run-id> [--target <node-or-frame-or-attempt>] [--json]
```

Use singular `artifact` to resolve one ArtifactRef into verified local source
metadata. It prints the absolute path, media type, size, digest, and producing
node attempt without reading the file body. Inspect the source through that path
with a range- or query-limited tool appropriate to its type and size.

Use plural `artifacts` to list registered artifact metadata and absolute paths.
Use `--target` to narrow one static/dynamic node, frame, or attempt; use target
inspection instead when surrounding execution state is also needed.

## Run maintenance

`acpus runs delete [run-id]` hard-deletes durable state and run-local artifacts without starting the daemon. It rejects active live runs and opens a multi-select picker when run id is omitted. Ask before deleting unless already explicitly requested.
