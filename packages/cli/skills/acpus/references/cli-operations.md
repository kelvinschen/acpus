# CLI Operations

Use this for the ordinary lifecycle: check, run, observe, interact, and stop. Use `acpus <cmd> --help` for exact options. For optional tooling or run deletion, read [Advanced CLI Operations](advanced-cli-operations.md); for retry/fork and failure diagnosis, read [Runtime Recovery](runtime-recovery.md).

## Check

Run `acpus doctor` when workspace health is uncertain; it is read-only. Check every edited workflow before running:

```sh
acpus workflow check workflow.ts --input sample-input.json
```

`workflow check` typechecks, compiles, and validates in memory. It does not admit a run, invoke acpx, start Agent sessions, or execute Task/Signal nodes. `--input` accepts strict inline JSON or a `.json` file resolved from the CLI working directory; prefer files for realistic payloads.

## Agent overrides

`workflow run` and `runs fork` accept a JSON object keyed by declared Agent name through `--agents`. Overrides allow `use` or `command`, `model`, `permissionMode`, `agentMode`, `cwd`, and `env`; they reject unknown Agents, extra fields, simultaneous `use`/`command`, and tracing policy. Changing identity clears inherited `model` and `agentMode` unless replaced, while `permissionMode` remains inherited.

## Run and observe

```sh
acpus workflow run workflow.ts --input sample-input.json
acpus workflow run workflow.ts --background --input sample-input.json
acpus runs inspect <run-id> [--target <target>|--all] [--follow]
```

Foreground mode follows the run. `--interval` defaults to `1s` with a `250ms` minimum and is invalid with `--background`. `Ctrl-C` only detaches.

Inspection is read-only and does not start or wake the daemon. Normal views are normalized and status-first; the default compact tree folds repeated completed contexts, opens actionable ones, shows copyable Signal help, and includes terminal output. Omit run id only for the TTY picker; use `--target` for one static/dynamic node, frame, or attempt, and `--all` for every repeated context.

Follow redraws a TTY; a pipe emits transitions and 30-second liveness checkpoints. It stays attached through paused, awaiting, inactive, or stale state and keeps 20 ordinary dynamic contexts visible unless `--all --follow` is used; failure, timeout, await, retry, and requeue stay immediate. Agent progress exposes bounded activity/tool intent, never tool arguments or output.

## Signal and lifecycle controls

```sh
acpus runs signal <run-id> --target <signal-nodeKey-or-static-alias> --payload '<json>'
acpus runs pause <run-id>
acpus runs resume <run-id>
acpus runs cancel <run-id> [--target <target>]
```

Signal target inspection exposes the complete persisted prompt/schema. Schema-backed signals validate JSON; schema-less signals require a JSON string such as `--payload '"approved"'`, whose decoded value is passed raw. A static alias must resolve to one open wait; use its dynamic `nodeKey` when multiple waits exist. Invalid payload never consumes the wait and may report `RUN_NOT_CONTROLLABLE` with a schema path. Success reports requested/resolved targets and validation, but not downstream completion. A timed-out wait is closed; use retry/fork rather than signaling it again.

Pause records a durable gate and best-effort aborts active attempts; resume clears the gate and re-drives eligible work. Cancel terminalizes the run or selected scheduler subtree. Ask before canceling unless already explicitly requested. Controls return when their effect is confirmed, not when later work becomes terminal.

Prefer text for people. Use a structured leaf's local `--json` option only for parsing; foreground run NDJSON uses `phase: "run"`, while inspect-follow uses `phase: "inspect"` over the same snapshot/update/resync/done model.
