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
- Use `acpus workflow import <source>` to copy a reusable workflow snapshot into the project catalog; add `--global` only when user-wide reuse is intended.
- Use `acpus runs inspect [run-id]` before any retry, fork, signal, pause, resume, cancel, or delete.
- Use `--json` only when structured parsing is needed. Text output is usually better for human diagnosis.

`workflow check` prepares the workflow in memory and reports diagnostics, the source graph digest, and workflow summary data. It does not admit a runtime run and does not write durable preflight artifacts.

Agent nodes and agent declarations are validated by `workflow check`, but check does not invoke `acpx`, start an agent session, run Task or Signal nodes, admit a run, or count as an Agent workflow execution.

Failure phases:

- `usage`: invalid CLI input, invalid JSON, mutually exclusive options.
- `check`: TypeScript or Acpus authoring-rule diagnostics.
- `compile`: module read/import/default-export/build failures.
- `validate`: frozen IR structural diagnostics.
- `import`: download, unpack, metadata, collision, or catalog commit failure.

Use `--json` when the exact phase matters. It is a discoverable global option and may appear before or after command names. For example, invalid `--agents` overrides are reported in the JSON `phase` field before any runtime admission.

`--input` accepts either inline strict JSON or a `.json` file path. The suffix is case-insensitive, and relative paths resolve from the CLI working directory:

```sh
acpus workflow check workflow.ts --input '{"topic":"release"}'
acpus workflow check workflow.ts --input sample-input.json
```

Use a file for realistic payloads instead of shell command substitution.

## Workflow run

Foreground `--json` emits newline-delimited JSON: an admitted record followed by the same snapshot/update/resync/done stream as `runs inspect --follow`. Terminal workflow output appears exactly once in the done record. Text mode uses the same compact structural tree and follow renderer.

Use `--interval <duration>` to control the foreground observation cadence; it defaults to `1s` and cannot be lower than `250ms`. Background runs reject this option because they do not attach an observer.

`Ctrl-C` during a foreground run detaches observation; it should not cancel the daemon-owned run. Use the printed run id and `acpus runs cancel <run-id>` only when cancellation is intended.

For workflows that must receive a Signal, `--background` plus a follow view is usually the cleanest operator loop:

1. Run once with `acpus workflow run <workflow.ts> --background --input sample-input.json`.
2. Attach with `acpus runs inspect <run-id> --follow`; it remains attached while awaiting.
3. Send a schema-valid payload to the dynamic signal target, for example `acpus runs signal <run-id> --target approval~abc123 --payload '{"approved":true,"notes":"ok"}'`.
4. Let the follow view reach terminal state. A denial payload is still valid signal handling and may intentionally drive a downstream assert failure.

## Catalog entries

Catalog packages live under project `.acpus/workflows/<name>/workflow.ts` or global `$HOME/.acpus/workflows/<name>/workflow.ts`. The authored `defineWorkflow({ name })` is the catalog identity: it must be a direct lower-kebab string and exactly match the package directory. Discovery statically reads metadata without executing the module. Invalid first-level packages remain visible in `workflow list`, but cannot be shown, checked, run, or visualized by name. If available project and global entries share a name, pass `--project` or `--global`.

Import a local file, package directory, ZIP, TGZ, or HTTP(S) snapshot:

```sh
acpus workflow import ./release.ts
acpus workflow import ./release-package --project
acpus workflow import https://example.invalid/release.tgz --global
```

Import copies the package once. It does not install dependencies, retain the source URL, update existing entries, or overwrite a same-name entry. The default path is static and does not execute top-level workflow code.

Use `--check` only for a trusted source when a full preparation gate is required:

```sh
acpus workflow import ./release.tgz --check
```

`--check` may execute module top-level code. It commits only after check/compile/validate succeeds and the prepared workflow name matches the static name. A global `--check` is evaluated in the current workspace context, so success establishes compatibility with that project, not every future project.

## Run inspection

Read-only. Does not start or wake daemon. Omit run id in interactive TTY for picker.

**Mandatory:** Start with text. Never use `--json` for first inspection. When a concrete query needs JSON, always pipe through `jq` and select smallest useful fields. No `jq`: stay in text mode. `--raw --json`: last resort only.

```sh
# Compact authored tree. Best first look.
acpus runs inspect <run-id>

# Stay attached. Do not poll with repeated inspect calls.
acpus runs inspect <run-id> --follow

# One node, frame, or attempt. Matching attempts, Signal details, current progress, artifact refs.
acpus runs inspect <run-id> --target <nodeId-or-nodeKey-or-frameKey-or-attemptId>

# Every normalized dynamic context.
acpus runs inspect <run-id> --all

# Registry metadata and absolute paths only; does not read artifact bodies.
acpus runs artifacts <run-id>
acpus runs artifacts <run-id> --target <nodeId-or-nodeKey-or-frameKey-or-attemptId>
```

Default tree keeps authored nesting and dynamic loop/fanout identity. Actionable contexts open; repeated completed contexts fold with exact counts. Awaiting Signal shows prompt, payload help, copyable signal command. Terminal view includes workflow output when present.

Follow text:

- TTY: redraw in place.
- Pipe: initial tree, state changes, compact Agent progress, 30-second silent liveness checkpoint. For a long run observed by an Agent, prefer a non-TTY pipe such as `acpus runs inspect <run-id> --follow | tee run-follow.log` so terminal redraws do not become repeated transcript text.
- Agent progress: Agent key. When available: turn, activity, context/token counts, up to three tool intents. No tool arguments or output.
- Transcript: `+<elapsed>` prefix. Matching terminal state/progress in same update merge into one row.
- Bounded: 20 ordinary dynamic contexts. The first omission summary is immediate; later omitted updates retain the latest state per context and flush at most once per 30 seconds or at a terminal/checkpoint boundary. Failure, timeout, await, retry, and requeue always remain immediate. Use `--all --follow` for all.
- Paused, awaiting, inactive, stale: stays attached. `Ctrl-C`: detach, never cancel.

Need exact replay order and cursors:

```sh
acpus runs inspect <run-id> --follow --json |
  jq -c '{kind, cursor, run: ((.run // .document.run) | {id, status}), changes: [.changes[]? | {sequence, progressVersion, subject, action, status}], output}'
```

Sparse NDJSON. No clock-only records. No text presentation merge.

For an Agent that only needs durable state changes, use filtered NDJSON instead of a PTY:

```sh
acpus runs inspect <run-id> --follow --json |
  jq -c 'select(.kind == "update" or .kind == "done") | {kind, run: .run.status, changes, output}'
```

Default JSON stays compact: normalized `.items`, exact omitted counts. Failed Agent item has stable `failure.origin`, optional `failure.code`, actionable message, bounded `failure.upstream`. Target JSON adds parsed upstream error data when available. Raw ACP lines stay outside normal inspection.

Agent JSON also carries `availability.context` and `availability.tokenUsage`. Token availability is `available` with a reported total, `partial` with only component counters, and `unavailable` with no reported counters. Text simply omits unavailable context/token lines and never estimates them. The run header summarizes only `instances`, `attempts`, and `turns`; a forked run also names its direct source and this fork's target/unsafe-reuse option.

Common queries need no raw mode:

```sh
acpus runs inspect <run-id> --json |
  jq '.items[] | select(.status == "running" or .status == "awaiting" or .status == "failed") | {nodeKey, status, failure}'

acpus runs inspect <run-id> --json |
  jq '.items[] | select(.agent) | {nodeKey, status, agent: .agent.key, turn: .agent.turnCount, tools: .agent.tools}'
```

Raw mode only for exact internal lookup:

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

Success messages name that applied effect: `Retry applied.`, `Fork run created.`, and `Signal consumed.`. Signal success also reports the requested and resolved dynamic targets plus validation evidence without echoing payload. Fork JSON uses `.run` for the child and `control.sourceRunId` for the source; it uses no second child-id field.

Successful non-terminal controls print an exact `acpus runs inspect <run-id> --follow` next step. Fork output uses the created child run id, not the source run id.

`runs delete` is not a control command. It hard-deletes durable run state and run-local artifacts without starting the daemon, rejects active live runs, and opens a multi-select picker with an all-deletable option when no run id is provided.


## Hooks

Use hooks JSON files. See `references/hooks-json.md`.
