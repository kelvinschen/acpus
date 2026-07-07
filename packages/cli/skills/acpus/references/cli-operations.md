# CLI Operations

## Verify environment

```sh
acpus --help
acpus doctor
```

In an Acpus source checkout:

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm exec acpus --help
```

`doctor` is read-only and should not create runtime state in an uninitialized workspace.

## Workflow check

```sh
acpus workflows check <workflow.ts-or-catalog>
acpus workflows check <workflow.ts-or-catalog> --input '{"ready":true}'
acpus workflows check <workflow.ts-or-catalog> --agents '{"reviewer":{"use":"codex","model":"opus"}}'
acpus --json workflows check <workflow.ts-or-catalog> --input '{"ready":true}'
```

`workflows check` prepares the workflow in memory and reports diagnostics, digests, and workflow summary data. It does not admit a runtime run and does not write durable preflight artifacts.

The workflow file must be inside the CLI workspace `cwd`. For scratch authoring inside this repository, prefer an ignored path such as `.acpus/tmp/<scenario>/workflow.ts` and run commands from the repository root. Do not put scratch workflows under `/tmp` and then check them from the repo root; the compiler rejects workflow files outside the workspace.

Agent nodes and agent declarations are validated by `workflows check`, but check does not invoke `acpx`, start an agent session, run Task or Signal nodes, admit a run, or count as an Agent workflow execution.

Failure phases:

- `usage`: invalid CLI input, invalid JSON, mutually exclusive options.
- `check`: TypeScript or Acpus authoring-rule diagnostics.
- `compile`: module read/import/default-export/build failures.
- `validate`: frozen IR structural diagnostics.

Use `--json` when the exact phase matters. For example, invalid `--agents` overrides are reported in the JSON `phase` field before any runtime admission.

## Workflow visualization

```sh
acpus workflows viz <workflow.ts-or-catalog> --out workflow-viz.html
acpus workflows viz <workflow.ts-or-catalog> --out workflow-viz.html --force
```

`workflows viz` prepares the workflow in memory and writes one self-contained static visualization HTML file. It fails rather than overwriting an existing file unless `--force` is passed.

## Workflow run

```sh
acpus workflows run <workflow.ts-or-catalog> --input '{"ready":true}'
acpus workflows run <workflow.ts-or-catalog> --background --input '{"ready":true}'
acpus --json workflows run <workflow.ts-or-catalog> --input '{"ready":true}'
```

Foreground `--json` emits newline-delimited JSON: admitted record, observation records, terminal summary. Text mode shows bounded compact observations and a final summary.

`Ctrl-C` during a foreground run detaches observation; it should not cancel the daemon-owned run. Use the printed run id and `acpus runs cancel <run-id>` only when cancellation is intended.

For workflows that must receive a Signal, `--background` is usually the cleanest operator loop:

1. Run once with `acpus workflows run <workflow.ts> --background --input '<json>'`.
2. Poll with `acpus runs inspect <run-id>` until the signal row is awaiting.
3. Send a schema-valid payload to the dynamic signal target, for example `acpus runs signal <run-id> --target approval~abc123 --payload '{"approved":true,"notes":"ok"}'`.
4. Inspect again for the terminal state. A denial payload is still valid signal handling and may intentionally drive a downstream assert failure.

## Catalog entries

```sh
acpus workflows list
acpus workflows list --project
acpus workflows list --global
acpus workflows show <name>
acpus workflows show <name> --project
acpus workflows show <name> --global
```

Catalog packages live under project `.acpus/workflows/<name>/workflow.ts` or global `$HOME/.acpus/workflows/<name>/workflow.ts`. Discovery inspects only first-level directories. If project and global entries share a name, pass `--project` or `--global`.

## Run inspection

```sh
acpus runs inspect
acpus runs inspect <run-id>
acpus --json runs inspect <run-id>
```

Use `runs inspect`, not legacy `runs show`. In interactive text terminals,
omitting the run id opens the run picker. Read-only run inspection should not
start or wake the daemon. It reports durable status plus derived execution state
such as active, inactive, stale, terminal, or unknown.

Compact text node rows use static ids and dynamic node keys. When a signal is awaiting input, text output should include the rendered prompt, expected payload guidance, and a copyable `runs signal` command.

Terminal text inspection includes the final workflow output when present. This is useful for benchmark reports and operator handoffs.

Text inspection is intentionally compact. For composite-heavy runs, JSON inspection exposes the full dynamic frame/node metadata and Agent telemetry that text mode may omit.

## Agent overrides

Agent overrides are JSON objects keyed by declared top-level agent names:

```sh
acpus workflows run review.workflow.ts \
  --agents '{"reviewer":{"use":"codex","model":"opus","permissionMode":"approve-reads"}}'

acpus runs fork <run-id> \
  --agents '{"reviewer":{"command":"my-acp-server --stdio","permissionMode":"deny-all"}}'
```

Overrides reject unknown agent names, simultaneous `use` and `command`, legacy `policy`, broad `options`, raw IR `kind`, and fields outside the allowlist.

If `use` or `command` changes identity, inherited `model` and `agentMode` are cleared unless replacements are supplied. `permissionMode` remains inherited across identity changes.

## Runtime controls

```sh
acpus runs pause <run-id>
acpus runs resume <run-id>
acpus runs retry <run-id>
acpus runs retry <run-id> --target <target>
acpus runs cancel <run-id>
acpus runs cancel <run-id> --target <target>
acpus runs delete <run-id>
acpus runs delete
acpus runs signal <run-id> --target <signal-target> --payload '{"approved":true,"notes":"ok"}'
acpus runs fork <run-id> --workflow replacement.workflow.ts --input '{"ready":true}'
acpus runs fork <run-id> --target review --workflow replacement.workflow.ts
```

Controls route through the workspace daemon and wait only until the control is confirmed applied, failed, or the fixed client wait expires. They do not wait for the entire run to become terminal after the control effect.

`runs delete` is not a control command. It hard-deletes durable run state and
run-local artifacts without starting the daemon, rejects active live runs, and
opens a multi-select picker with an all-deletable option when no run id is
provided.

No `--no-wait` or custom timeout options are part of the next command surface.

## Hooks

```sh
acpus hooks validate
acpus hooks list
acpus hooks validate --project
acpus hooks list --global
```

Use hooks JSON files, not legacy `hooks.yaml`. See `references/hooks-json.md`.
