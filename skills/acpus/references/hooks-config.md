# Hook System Configuration Reference

High-density reference for AI agents. Read when the user asks about configuring hooks, writing hook handlers, or understanding hook behavior.

## Config Files

- `~/.acpus/hooks.yaml` — global (applies to all Runs)
- `$WORKSPACE/.acpus/hooks.yaml` — project (merged with global)
- Merge: per-key array concatenation, global handlers before project
- Frozen at Run start into `hook-config.json`; fork inherits from source Run
- Empty config (no injectors + no events) → `freeze()` returns `undefined` → zero overhead
- `acpus workflows run --skip-hooks` disables hook loading/freezing/execution for that new Run and records `skipHooks: true`
- Full annotated single-file example: `skills/acpus/assets/hooks.example.yaml` (not auto-loaded; copy selected parts into `.acpus/hooks.yaml` to try it)

## Handler Types

### InjectorHookHandler (`injectors`)
```json
{
  "command": "<shell command>",
  "timeout": "5s",           // default 5s
  "env": {"KEY": "VALUE"},
  "cwd": "/path/to/dir",
  "on_failure": "fail"       // "fail" (default) | "skip"
}
```

### EventHookHandler (`events`)
```json
{
  "command": "<shell command>",
  "timeout": "30s",          // default 30s
  "env": {"KEY": "VALUE"},
  "cwd": "/path/to/dir",
  "sync": false              // false (default, fire-and-forget) | true (await)
}
```

## Handler Protocol

- **Stdin**: `JSON.stringify(HookPayload)` — full payload as JSON
- **Stdout**: injectors MUST output JSON (`InjectorResult`); events — stdout is ignored
- **Exit code**: 0 = success, non-zero = failure
- **Timeout**: duration string ("5s", "30s", "1m"); injectors 5s default, events 30s default
- **Env**: handler env vars merge into subprocess env (on top of process env)

## Injectors (2)

Blocking, synchronous, sequential execution. Output influences the node.

| Injector | Hook | Returns | Effect |
|----------|------|---------|--------|
| `beforeAgentExec` | Agent node | `AgentInjectorResult: {prependPrompt?: string}` | Prepended to rendered prompt before each executor call. Multiple handlers → `prependPrompt` joined with `\n` |
| `beforeProgramExec` | Program node | `ProgramInjectorResult: {env?: Record<string,string>}` | Merged into subprocess env LAST (highest priority: process env → step env → injected env). Multiple handlers → env merged, later overrides earlier |

**Failure behavior**: `on_failure: "fail"` → `HookFailureError` → node fails with `failure_kind: "hook_failure"`. `on_failure: "skip"` → console.warn, skip handler, continue.

**Exec frequency**: beforeAgentExec runs once per `executeAgent` call (per persisted attempt), NOT per parse/schema auto-retry iteration.

## Events (8)

Async (fire-and-forget by default), never affect Run/Node outcome. Failures logged as console.warn. Use `sync: true` to await completion.

| Event | Scope | Trigger | Retry/Resume |
|-------|-------|---------|--------------|
| `beforeRun` | Run | First execution only (`listNodeStates().length === 0`) | Skipped |
| `afterRun` | Run | Every `runToCompletion` reaching terminal status | Fires each time |
| `onNodeStart` | Node | `fromState !== "running"` (prevents duplicate on resume) | Fires on resume |
| `onNodeComplete` | Node | Node reaches `completed` | Fires |
| `onNodeError` | Node | Any non-abort error (HookFailureError, LeafExecutionError, GuardFailureError, plain Error) | Fires |
| `onNodePaused` | Node | Node aborted by operator pause | Fires |
| `onNodeCancelled` | Node | Node aborted by operator cancel | Fires |
| `onStateChange` | Node | Any actual state transition (`fromState !== state.state`) | Fires for each transition |

**Signal node extra**: `running → awaiting` transition emits a dedicated `onStateChange`. `awaiting → completed` also emits `onStateChange`.

**Telemetry writes do NOT trigger `onStateChange`** — only node lifecycle transitions do.

## Payload Fields (HookPayload)

### Always present
`hook_event_name`, `run_id`, `workflow_name`, `workflow_source_path`, `workflow_source_dir`, `cwd`, `timestamp`

### Run events only
`input` (beforeRun, raw opts.input), `run_status` (afterRun), `run_attempt`, `ir_digest`, `duration_ms` (afterRun), `output` (afterRun), `error` (afterRun)

### Node events + injectors
`node_key`, `node_id`, `node_kind`, `node_attempt`, `loop_round`, `fanout_item_id`, `fanout_item_index`, `parallel_lane_id`

### Node events only
`parent_node_key`, `parent_node_kind` (skips the implicit root pipeline and any explicit `pipeline` containers — exposes the leaf's enclosing composite), `from_state`, `to_state` (onStateChange only), `error`, `output`, `duration_ms`, `prompt`, `session_key`, `failure_kind`

### Composite fields
`join_strategy` (parallel/fanout), `max_concurrency` (parallel/fanout), `max_iterations` (loop), `subworkflow_spec_path` (subworkflow), `signal_timeout` (signal), `signal_on_timeout` (signal)

### Agent leaf fields (lifecycle events only)
`agent_model`, `agent_type`, `agent_policy`, `agent_exit_code`, `agent_response_text`

`agent_telemetry` is present on Agent node events when compact telemetry exists:

```json
{
  "attempt": 1,
  "state": "completed",
  "updated_at": "2025-01-01T00:00:00.000Z",
  "completed_at": "2025-01-01T00:00:01.000Z",
  "context": {
    "used": 25293,
    "size": 190000,
    "updated_at": "2025-01-01T00:00:00.500Z"
  },
  "token_usage": {
    "source": "prompt_response",
    "input_tokens": 100,
    "output_tokens": 50,
    "cached_read_tokens": 25,
    "cached_write_tokens": 5,
    "thought_tokens": 3,
    "total_tokens": 183
  }
}
```

Program node events and injector payloads do not include `agent_telemetry`.

### Program leaf fields (lifecycle events only)
`command`, `shell`, `subprocess_env`, `exit_code`, `stdout`, `stderr`

### Injector-only fields
`agent_use`, `is_continuation` (beforeAgentExec), `is_retry` (both injectors)

### Declared but NEVER populated
`items_count`, `successful_lanes`, `failed_lanes`, `iterations_completed`, `subworkflow_name`

## Journal

Append-only JSONL at `.acpus/state/runs/<runId>/hook-journal.jsonl`. One entry per injector handler invocation.

```json
{
  "sequence": 1,
  "node_key": "workflow/step",
  "injector": "beforeAgentExec",
  "handler_index": 0,
  "node_attempt": 1,
  "is_retry": false,
  "prepend_prompt": "injected text or null",
  "env": {"KEY": "VALUE"} | null,
  "timestamp": "2025-01-01T00:00:00.000Z",
  "duration_ms": 12
}
```

## CLI

```sh
acpus hooks validate [--global] [--project <path>] [--json]
acpus hooks list [--json] [--source]
acpus hooks path [--global]
```

## Config Validation (load-time)

Config is validated at load time (not just CLI). Errors are thrown on:
- Unknown hook name (not in injector/event name lists)
- Handler not an array
- `command` empty or missing
- Unknown handler fields
- `on_failure` not `"fail"` or `"skip"` (injectors only)
- `sync` not boolean (events only)
- `on_failure` on events, `sync` on injectors (mutually exclusive)
- `timeout` not a string, `cwd` not a string, `env` not a string map

## Config Freezing

1. Load both layers, merge, validate
2. If empty → return undefined (hook machinery disabled, zero overhead)
3. Hash merged config (`sha256:` over canonical JSON with sorted keys)
4. Persist as `hook-config.json` in the Run directory; record hash in run metadata
5. Retry/resume/fork reuse the frozen config — never reload from disk

## Fork Inheritance

Fork copies `hook-config.json` from the source Run directly. Same hash, same config.
