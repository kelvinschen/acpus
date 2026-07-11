# CLI Operations

## Installation (Ask before globally install)

`npm install -g acpus`

## Discover commands

```sh
acpus --help
acpus workflow --help
acpus runs --help
acpus hooks --help
acpus <cmd> --help
```

Prefer command help for exact options. The skill should describe operating strategy, not mirror the whole CLI surface.

`doctor` is read-only and should not create runtime state in an uninitialized workspace.

## Operating defaults

- Run `acpus doctor` when the workspace health is uncertain.
- Use `acpus workflow check <workflow.ts-or-catalog>` before `run`.
- Use `acpus workflow list` and `acpus workflow show <name>` for catalog discovery.
- Use `acpus runs inspect [run-id]` before any retry, fork, signal, pause, resume, cancel, or delete.
- Use `--json` only when structured parsing is needed. Text output is usually better for human diagnosis.

`workflow check` prepares the workflow in memory and reports diagnostics, the source graph digest, and workflow summary data. It does not admit a runtime run and does not write durable preflight artifacts.

Agent nodes and agent declarations are validated by `workflow check`, but check does not invoke `acpx`, start an agent session, run Task or Signal nodes, admit a run, or count as an Agent workflow execution.

Failure phases:

- `usage`: invalid CLI input, invalid JSON, mutually exclusive options.
- `check`: TypeScript or Acpus authoring-rule diagnostics.
- `compile`: module read/import/default-export/build failures.
- `validate`: frozen IR structural diagnostics.

Use `--json` when the exact phase matters. It is a discoverable global option
and may appear before or after command names. For example, invalid `--agents`
overrides are reported in the JSON `phase` field before any runtime admission.

`--input` accepts either inline strict JSON or a `.json` file path. The suffix
is case-insensitive, and relative paths resolve from the CLI working directory:

```sh
acpus workflow check workflow.ts --input '{"topic":"release"}'
acpus workflow check workflow.ts --input sample-input.json
```

Use a file for realistic payloads instead of shell command substitution.

## Workflow run

Foreground `--json` emits newline-delimited JSON: an admitted record followed
by the same snapshot/update/resync/done stream as `runs inspect --follow`.
Terminal workflow output appears exactly once in the done record. Text mode
uses the same compact structural tree and follow renderer.

Use `--interval <duration>` to control the foreground observation cadence; it
defaults to `1s` and cannot be lower than `250ms`. Background runs reject this
option because they do not attach an observer.

`Ctrl-C` during a foreground run detaches observation; it should not cancel the daemon-owned run. Use the printed run id and `acpus runs cancel <run-id>` only when cancellation is intended.

For workflows that must receive a Signal, `--background` plus a follow view is
usually the cleanest operator loop:

1. Run once with `acpus workflow run <workflow.ts> --background --input sample-input.json`.
2. Attach with `acpus runs inspect <run-id> --follow`; it remains attached while awaiting.
3. Send a schema-valid payload to the dynamic signal target, for example `acpus runs signal <run-id> --target approval~abc123 --payload '{"approved":true,"notes":"ok"}'`.
4. Let the follow view reach terminal state. A denial payload is still valid signal handling and may intentionally drive a downstream assert failure.

## Catalog entries

Catalog packages live under project `.acpus/workflows/<name>/workflow.ts` or global `$HOME/.acpus/workflows/<name>/workflow.ts`. Discovery inspects only first-level directories. If project and global entries share a name, pass `--project` or `--global`.

## Run inspection

In interactive text terminals, omitting the run id opens the run picker.
Read-only run inspection does not start or wake the daemon. It reports durable
status plus derived execution state such as active, inactive, stale, terminal,
or unknown.

The default view is a bounded authored tree. Nested branches remain structural,
loop rounds and fanout items keep their dynamic identity, and homogeneous
completed contexts fold behind exact counts. Actionable current contexts are
expanded first. When a signal is awaiting input, text output includes a prompt
preview, payload guidance, and a copyable `runs signal` command.

Choose the narrowest deeper view:

```sh
acpus runs inspect <run-id> --target <nodeId-or-nodeKey-or-frameKey-or-attemptId>
acpus runs inspect <run-id> --all
acpus runs inspect <run-id> --raw --json
```

`--target` provides full matching attempts, signal details, progress, and
artifact references. `--all` expands every normalized dynamic context without
raw scheduler tables. `--raw --json` is the explicit unbounded source bundle,
including the complete frozen WorkflowIR under `.workflow`.

Use `--follow` instead of repeatedly invoking inspect. TTY output redraws in
place. Pipes print the compact tree once, append state transitions and compact
Agent progress, and print a small liveness checkpoint after 30 seconds of
otherwise silent observation. Agent progress identifies the authored Agent key
and includes turn, activity, context/token counters, and at most three
intent-only Last Tool Calls; it never prints command arguments or tool output.
Semantic transcript rows use only `+<elapsed>` as their prefix; internal event
sequence and Agent progress-version markers are intentionally omitted from text.
When one observation contains both a terminal durable transition and matching
terminal progress for the same Agent execution, text merges them into one
information-complete row. Structured JSON/NDJSON does not apply this
presentation merge: use `--follow --json` when exact event/progress cursors and
replay order are needed.
The default transcript retains 20 ordinary dynamic contexts, always preserves
failure/timeout/await/retry contexts, and summarizes additional contexts with
exact counts plus an `--all --follow` command.
`--follow --json` emits sparse NDJSON updates and stays completely silent for
clock-only checkpoints. The view remains attached through paused, awaiting,
inactive, and stale states. `Ctrl-C` detaches without canceling the run.

Terminal text inspection includes the final workflow output when present. This is useful for operator handoffs.

Default JSON inspection is also compact and versioned. It exposes normalized
status items and exact omitted counts rather than raw frames, instances,
attempts, groups, or execution-metadata tables. Use target or raw mode only
when that additional scope is intentional.

Failed Agent items expose a stable Acpus `failure.origin`/`failure.code`, an
actionable message, and a bounded `failure.upstream` acpx summary. Target JSON
adds the complete parsed upstream error data; raw ACP protocol lines remain
separate from normal inspection.

Common compact queries do not require raw inspection:

```sh
acpus runs inspect <run-id> --json |
  jq '.items[] | select(.status == "running" or .status == "awaiting" or .status == "failed")'

acpus runs inspect <run-id> --json |
  jq '.items[] | select(.agent) | {nodeKey, status, agent: .agent.key, turn: .agent.turnCount, tools: .agent.tools}'
```

Use raw mode only for an intentionally unbounded diagnostic query, for example
an exact execution-metadata lookup:

```sh
acpus runs inspect <run-id> --raw --json |
  jq '.run.dynamic.executionMetadata[] | select(.attemptId == "<attempt-id>")'

acpus runs inspect <run-id> --raw --json |
  jq '.workflow.agents["<agent-key>"]'
```

## Agent overrides

Agent overrides are JSON objects keyed by declared top-level agent names:

```sh
acpus workflow run review.workflow.ts \
  --agents '{"reviewer":{"use":"codex","model":"opus"}}'

acpus runs fork <run-id> \
  --agents '{"reviewer":{"command":"my-acp-server --stdio"}}'
```

Overrides reject unknown agent names, simultaneous `use` and `command`, `policy`, broad `options`, raw IR `kind`, and fields outside the allowlist.

If `use` or `command` changes identity, inherited `model` and `agentMode` are cleared unless replacements are supplied. `permissionMode` remains inherited across identity changes.

## Runtime controls

Controls route through the workspace daemon and wait only until the control is confirmed applied, failed, or the fixed client wait expires. They do not wait for the entire run to become terminal after the control effect.

Successful non-terminal controls print an exact
`acpus runs inspect <run-id> --follow` next step. Fork output uses the created
child run id, not the source run id.

`runs delete` is not a control command. It hard-deletes durable run state and
run-local artifacts without starting the daemon, rejects active live runs, and
opens a multi-select picker with an all-deletable option when no run id is
provided.

No `--no-wait` or custom timeout options are part of the next command surface.

## Hooks

Use hooks JSON files. See `references/hooks-json.md`.
