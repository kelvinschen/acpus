# Hooks Spec

## Purpose

Acpus Hooks are a runtime platform-layer capability, independent of any Workflow Spec. They are configured outside Workflow YAML and are not frozen into the IR. Hooks do two things: synchronously **inject** external context into an execution environment before an Agent Step or Program Step runs, and asynchronously **observe** Run and Node lifecycle changes. Hooks MUST NOT adjudicate execution: they cannot block, reject, or alter Workflow control flow. Workflow correctness remains the Workflow author's responsibility.

## Requirements

### Configuration

- The runtime MUST load hook configuration from two YAML layers: a global file at `~/.acpus/hooks.yaml` and a project file at `.acpus/hooks.yaml` (relative to the Workspace).
- The runtime MUST treat a missing layer as an empty configuration and MUST NOT error when either file is absent.
- The runtime MUST merge the two layers by concatenating handler arrays per event/injector key, with global handlers ordered before project handlers.
- A hook configuration MUST contain an `injectors` map and/or an `events` map. Each maps a hook name to an ordered array of handlers.
- A handler MUST declare `command` (a shell-form string) and MAY declare `env` (a map merged into the handler process environment) and `cwd` (defaulting to the process working directory).
- A handler MAY declare `timeout` as a duration string; the runtime MUST default injector timeouts to `5s` and event timeouts to `30s`.
- An injector handler MAY declare `on_failure` as `"fail"` or `"skip"`; the runtime MUST default injectors to `"fail"`.
- An event handler MAY declare `sync: true`; event handlers MUST run asynchronously by default.

### Configuration Freezing

- The runtime MUST load, merge, and freeze hook configuration once at new Run creation, before execution starts, and MUST reuse the frozen configuration for all retry and resume executions of that Run.
- When the merged configuration is non-empty, the runtime MUST write it to `.acpus/state/runs/<runId>/hook-config.json` containing the merge hash, the source layer paths, and the merged configuration object.
- The runtime MUST record the frozen configuration hash on Run metadata as `hookConfigHash`.
- When both layers are absent or empty, the runtime MUST NOT write `hook-config.json`, MUST set `hookConfigHash` to absent/null, and MUST NOT construct a hook runner or incur per-node hook overhead.
- When a Run is submitted with hooks disabled, the runtime MUST NOT load, freeze, or execute hooks for that Run; it MUST record `skipHooks: true` on Run metadata and MUST NOT write `hook-config.json` or `hookConfigHash`.
- A Forked Run MUST inherit the source Run's frozen `hook-config.json` and `hookConfigHash`. When the source Run has `skipHooks: true`, the Forked Run MUST inherit `skipHooks: true` and MUST NOT write `hook-config.json` or `hookConfigHash`.

### Injectors

- The runtime MUST support two injectors: `beforeAgentExec` and `beforeProgramExec`.
- `beforeAgentExec` MUST run inside Agent Step execution, before the executor call, and MUST prepend each handler's returned `prependPrompt` (in handler order) to the rendered prompt.
- `beforeAgentExec` MUST run once per Agent Step execution (per persisted attempt) and MUST NOT re-run for internal parse/schema auto-retry iterations within a single executor call.
- `beforeProgramExec` MUST run inside Program Step execution, before the executor call. Because command and environment rendering occur inside the Program executor, the runtime MUST pass injector `env` results to the executor, which MUST merge them into the child environment.
- `beforeProgramExec` MUST NOT translate any prompt/context field into a child environment variable; Program injectors inject only `env`.
- Injector handlers for a single Node MUST run sequentially in merged order; `prependPrompt` MUST be concatenated in order for `beforeAgentExec`, and `env` maps MUST be merged with later handlers overriding earlier ones for `beforeProgramExec`.
- An injector handler that exits non-zero, times out, or emits stdout that is not valid JSON MUST be treated per its `on_failure` policy: `"fail"` MUST fail the Node with `failureKind: "hook_failure"` and an error containing the handler's stderr; `"skip"` MUST record a warning, inject nothing for that handler, and continue.
- An injector handler returning an empty object or no output MUST inject nothing and MUST NOT fail the Node.

### Events

- The runtime MUST support the events `beforeRun`, `afterRun`, `onNodeStart`, `onNodeComplete`, `onNodeError`, `onNodePaused`, `onNodeCancelled`, and `onStateChange`.
- `beforeRun` MUST fire only at the first `runToCompletion` entry and MUST NOT fire on retry or resume. `afterRun` MUST fire once the Run reaches a terminal status.
- Node lifecycle events MUST fire at the corresponding state-transition site inside Node execution: `onNodeStart` on entry to `running`, `onNodeComplete` on `completed`, `onNodeError` on `failed`, `onNodePaused` on `paused`, `onNodeCancelled` on `cancelled`.
- `onStateChange` MUST fire only when the Node's `state` field actually changes, and MUST NOT fire for telemetry-only persistence that does not change `state`. The runtime MUST fire `onStateChange` at the same transition sites as the specific lifecycle events, carrying `from_state` and `to_state`.
- An event MUST NOT affect Run or Node outcome. An event handler that exits non-zero, times out, or fails MUST record a warning and continue.
- Event handlers MUST be dispatched without blocking the main flow by default. Event handlers declared `sync: true` MUST be awaited before execution proceeds past the firing site.
- Events MUST NOT be recorded in the hook journal.

### Protocol

- The runtime MUST pass a `HookPayload` JSON object to each command handler on stdin.
- The payload MUST carry the common fields `hook_event_name`, `run_id`, `workflow_name`, `workflow_source_path`, `workflow_source_dir`, `cwd`, and `timestamp`, plus the node-, injector-, and event-specific fields applicable to the firing context.
- For node-level firings the payload MUST carry `node_key`, `node_id`, `node_kind`, `node_attempt`, and, when the node executes inside a container, `parent_node_key` and `parent_node_kind`. Composite nodes MUST carry their container-specific fields (e.g. `join_strategy`, `max_concurrency`, `max_iterations`, `subworkflow_spec_path`, `signal_timeout`). Agent and Program `onNodeComplete`/`onNodeError` payloads MUST carry their executor detail (agent: `agent_model`, `agent_type`, `agent_policy`, `session_key`, `agent_exit_code`, `agent_response_text`; program: `command`, `shell`, `subprocess_env`, `exit_code`, `stdout`, `stderr`), and `onNodeError` MUST carry `failure_kind` when one is known (including `hook_failure` for injector-caused failures).
- Agent node event payloads MUST include `agent_telemetry` when compact Agent telemetry is available for the current attempt. `agent_telemetry` MUST be an object containing `attempt`, `state`, `updated_at`, optional `completed_at`, optional `context` (`used`, `size`, `updated_at`), and optional `token_usage` (`source`, `input_tokens`, `output_tokens`, `cached_read_tokens`, `cached_write_tokens`, `thought_tokens`, `total_tokens`). Program node events and injector payloads MUST NOT include `agent_telemetry`.
- Injector payloads MUST carry `is_retry`. `beforeAgentExec` MUST NOT carry a `prompt` field, because injectors run before the prompt is rendered.
- An injector handler MUST be allowed to return an `InjectorResult` JSON object on stdout. A `beforeAgentExec` result MAY contain `prependPrompt`. A `beforeProgramExec` result MAY contain `env`.

### Journal

- The runtime MUST append one record per injector handler invocation to `.acpus/state/runs/<runId>/hook-journal.jsonl`.
- Each journal record MUST store the resolved `prependPrompt` text and `env` map actually injected (not merely a boolean flag), along with `sequence`, `node_key`, `injector`, `handler_index`, `node_attempt`, `is_retry`, `timestamp`, and `duration_ms`.
- The journal reader MUST tolerate a torn final line from a crash mid-append by skipping unparseable lines rather than failing.
- The journal is for audit and observability only. Replay re-walks the frozen IR read-only and does not re-execute executors or injectors, so the journal MUST NOT be required to reconstruct replay correctness.

### CLI

- The CLI MUST provide `acpus hooks validate`, which validates a hooks file's JSON structure and handler field completeness, returns exit code `0` on success and `1` on failure, and accepts `--global`, `--project <path>`, and `--json`.
- The CLI MUST provide `acpus hooks list`, which loads and merges both layers and prints the effective configuration grouped by injectors and events, accepting `--json` and `--source`.
- The CLI MUST provide `acpus hooks path`, which prints the absolute global and project hook file paths and whether each exists.

## Verification

- Tests MUST cover loader merge ordering (global before project), absent-layer tolerance, and hash stability.
- Tests MUST cover command handler execution, timeout handling, non-zero exit handling, and stdout JSON parse failure under both `on_failure` policies.
- Tests MUST cover `prependPrompt` injection into Agent prompts and `env` injection into Program child environments.
- Tests MUST cover that an injector failure under `fail` fails the Node with `hook_failure` and under `skip` continues without injecting.
- Tests MUST cover that `beforeAgentExec` runs once per Node execution and not per internal auto-retry.
- Tests MUST cover that events fire at the correct lifecycle transitions, that `onStateChange` does not fire for telemetry-only writes, and that an event failure never changes Run or Node outcome.
- Tests MUST cover that Agent node event payloads expose nested `agent_telemetry` context window and token usage fields when available.
- Tests MUST cover configuration freezing: `hook-config.json` written once, `hookConfigHash` on Run metadata, no files and no runner when configuration is empty, and Fork inheritance of the frozen configuration.
- Tests MUST cover that a Run submitted with hooks disabled records `skipHooks: true` and does not freeze or execute hook configuration.
- Tests MUST cover that the journal records full injected prompt prefixes and env per handler invocation.
- Tests MUST cover the `acpus hooks validate`, `list`, and `path` commands.
