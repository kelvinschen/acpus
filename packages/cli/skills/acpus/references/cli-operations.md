# CLI Operations

Use this for the ordinary lifecycle: run, observe, interact, and stop, plus validation without execution. Use `acpus <cmd> --help` for exact options. For optional tooling or run deletion, read [Advanced CLI Operations](advanced-cli-operations.md); for retry/fork and failure diagnosis, read [Runtime Recovery](runtime-recovery.md).


## Agent overrides

`workflow run` and `runs fork` accept a JSON object keyed by declared Agent name through `--agents`. Overrides allow `use` or `command`, `model`, `config`, `permissionMode`, `cwd`, and `env`; they reject unknown Agents, extra fields, simultaneous `use`/`command`, and tracing policy.

## Run and observe

```sh
acpus workflow run workflow.ts --input sample-input.json
acpus workflow run workflow.ts --background --input sample-input.json
acpus runs inspect <run-id> [--target <target>|--all] [--follow]
```

`workflow run` performs workflow check internally before starting it. If the workflow has issues, `run` exits with diagnostics and does not create a run. Fix the reported issues and run again. **If the goal is to run the workflow, there is no need for a separate `workflow check` step**.

Foreground mode follows the run. `--interval` defaults to `1s` with a `250ms` minimum and is invalid with `--background`. `Ctrl-C` only detaches.

Inspection is read-only and does not wake the daemon. Its compact tree preserves authored structure, folds completed repetitions, caps ordinary contexts, and separates Active from Attention. Omit run id only for the TTY picker.

### Low-context monitoring

1. Foreground already follows. Otherwise inspect once and read Tree, bounded Active, then Attention.
2. Narrow with an authored/Attention target; choose its dynamic target for repetitions. Target owns payload, attempt, Agent/Signal, and artifact details.
3. Follow overview/target only to the needed transition, then detach and snapshot; piped output keeps growing. Never default to `--all --follow`.
4. Use `--all` only for cross-occurrence topology. At terminal state, verify Output/artifacts against the goal.

Active/checkpoint Agent rows share one pulse: turn, one normalized tool, update age; age is freshness, not liveness.

For structured output, locate the target in text first, then pipe JSON/NDJSON through focused `jq`. Filter all-mode items by `nodeId` and cap matches.

Add `--follow` to any non-raw inspection view. Follow redraws a TTY; a pipe emits transitions and 30-second liveness checkpoints. It stays attached through paused, awaiting, inactive, or stale state and keeps 20 ordinary dynamic contexts visible unless `--all --follow` is used; failure, timeout, await, retry, and requeue stay immediate. Agent progress exposes bounded activity/tool intent, never tool arguments or output.

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

## Doctor

Run `acpus doctor` when workspace health is uncertain; it is read-only.
