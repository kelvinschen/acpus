# Agent Executor Spec

## Purpose

`@acpus/agent-executor` executes one resolved acpx-backed ACP agent turn for
runtime consumers. It owns acpx CLI resolution, acpx argument construction,
process timeout/cancellation, output caps, ACP JSON stream parsing, and
backend failure classification. It does not own workflow prompt rendering,
SchemaIR validation, response repair policy, scheduler attempts, or durable
runtime state.

The package does not expose the old command-backed request helpers or
provider-command environment mapping helpers. All current product execution
goes through the resolved acpx turn API.

## Requirements

### Public API

- The package MUST expose `executeAgentTurn(request)`.
- The package MUST expose public acpx turn request/result types.
- The public acpx turn request MUST NOT accept an acpx path, binary, or
  provider-command mapping override.
- The package MUST resolve its bundled `acpx` dependency internally.
- The package MUST NOT expose legacy raw-command execution helpers,
  provider-command environment parsing helpers, or provider-required migration
  errors as public product API.
- The package MUST NOT expose a binary.

### Acpx Turn Requests

- Requests MUST select either a named acpx agent token or a custom acpx
  `--agent <command>` command.
- Requests MUST include rendered prompt text, absolute cwd, process env,
  resolved acpx session name, resolved permission mode, optional model,
  optional agent mode, optional timeout, and optional abort signal.
- When a timeout is supplied, the executor MUST enforce the request duration
  locally and pass acpx `--timeout` as a positive integer number of seconds.
- Requests MAY include an optional raw debug capture flag for runtime
  diagnostics. This flag MUST NOT change prompt execution, parsing, telemetry,
  or failure classification.
- Permission modes MUST map only to explicit acpx flags:
  `approve-reads -> --approve-reads`, `approve-all -> --approve-all`, and
  `deny-all -> --deny-all`.
- The executor MUST NOT synthesize or pass acpx `--policy` or
  `--permission-policy`.
- The executor MUST pass `--format json --json-strict` for acpx turn commands
  so stdout is machine-consumable ACP JSON.

### Command Sequence

- Every turn MUST run acpx `sessions ensure --name <session>` before prompting.
- If `agentMode` is present, the executor MUST run acpx
  `set-mode <agentMode> -s <session>` after session ensure and before prompt.
- The executor MUST send the rendered prompt to acpx `prompt -s <session> -f -`
  on stdin.
- Named agents MUST be passed as positional acpx agent tokens.
- Custom command agents MUST be passed through acpx `--agent <command>`.
- `set-mode` rejection MUST be surfaced as `config` and MUST NOT send a prompt.
- The timeout budget MUST apply to the full turn command sequence, not
  independently to each acpx subprocess.
- Prompt timeout, abort, and output overflow MUST best-effort call acpx
  `cancel -s <session>` before force-killing the active prompt subprocess.

### Results

- `completed` results MUST include final assistant response text, stderr, and
  normalized telemetry facts.
- `failed` results MUST include a stable backend failure kind, message,
  response text collected before failure, stderr, and normalized telemetry
  facts.
- `cancelled` results MUST be separate from backend failure kinds.
- Stable backend failure kinds MUST include `config`, `spawn`,
  `provider_exit`, `timeout`, and `output_overflow`.
- The executor MUST NOT expose raw ACP JSON lines as runtime decision input.
  It MUST derive normalized per-turn telemetry from the ACP JSON stream.
- Normalized turn telemetry MUST include event count, optional stop reason,
  optional context window, optional token usage, tool-call telemetry, prompt
  input preview, response output preview, cwd, and optional acpx record id.
- Context telemetry MUST be derived from `usage_update` events. If a later
  `usage_update` reports `used = 0` after a non-zero used value, the executor
  MUST preserve the previous non-zero used value while updating size and
  timestamp.
- Token usage telemetry MUST be derived from JSON-RPC result `usage` fields and
  MUST accept both camelCase and snake_case variants for input, output, cached
  read, cached write, thought, and total token counts.
- Tool telemetry MUST capture `tool_call` and `tool_call_update` events,
  preserving each call's id, title, kind, acpx status, tool name from
  `_meta.claudeCode.toolName`, timestamps, and final completion timestamp for
  `completed`, `failed`, or `cancelled` statuses.
- Tool telemetry MUST capture only `rawInput` as a truncated JSON preview with
  4 KiB head and 4 KiB tail. It MUST NOT capture `rawOutput`, tool result
  payloads, or tool response bodies.
- Tool telemetry MUST preserve the complete per-turn call list. The reported
  total tool call count MUST equal the call list length.
- Prompt and response IO previews in executor telemetry MUST be untruncated.
  The response remains bounded by the executor output cap.
- When raw debug capture is requested, results MAY include bounded raw acpx
  prompt stdout as opaque debug material. Runtime consumers MUST NOT need that
  field for execution decisions.
- Non-empty malformed stdout lines from `--format json --json-strict` MUST be
  backend failures, not successful empty responses.
- JSON-RPC error objects MUST be summarized to bounded human-readable error
  messages before being returned to runtime-facing results.

## Verification

- Public API contract tests MUST cover exported runtime keys.
- Type tests MUST cover public acpx turn request/result types and verify no
  acpx path override or provider-command mapping override is accepted.
- Unit tests MUST cover acpx argument construction for named and custom agents,
  permission mode flag mapping, session ensure before prompt, `agentMode`
  `set-mode` ordering, stdin prompt delivery, assistant text extraction,
  normalized telemetry parsing for context, token usage, tool calls, tool
  parameter preview truncation, optional raw debug capture, and backend failure
  classification.
