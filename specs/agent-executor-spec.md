# Agent Executor Spec

## Purpose

`@acpus/agent-executor` executes one resolved acpx-backed ACP agent turn for
runtime consumers. It owns acpx CLI resolution, acpx argument construction,
process timeout/cancellation, ACP JSON stream parsing, and backend failure
classification. It does not own workflow prompt rendering, SchemaIR
validation, response repair policy, scheduler attempts, or durable runtime
state.

## Requirements

### Public API

- The package MUST expose `executeAgentTurn(request)`.
- The package MUST expose public acpx turn request/result/progress and normalized
  trace types.
- Public operational types MUST use the `AgentTurnSummary`,
  `AgentContextSummary`, `AgentTokenUsageSummary`, `AgentToolCallSummary`, and
  `AgentToolsSummary` names. Turn results and progress snapshots MUST expose
  this data through `summary`.
- The package MUST expose `AgentTurnTiming`. Every completed, failed, or
  cancelled turn result MUST contain `timing` with UTC `startedAt` and
  `finishedAt` timestamps plus a finite non-negative `elapsedMs` measured by a
  monotonic clock. Progress snapshots and turn summaries MUST NOT contain this
  terminal timing.
- The public acpx turn request MUST NOT accept an acpx path, binary, or
  provider-command mapping override.
- The package MUST resolve its bundled `acpx` dependency internally.
- The package MUST NOT expose a binary.

### Acpx Turn Requests

- Requests MUST select either a named acpx agent token or a custom acpx
  `--agent <command>` command.
- Requests MUST include rendered prompt text, absolute cwd, process env,
  resolved acpx session name, resolved permission mode, optional model,
  optional agent mode, optional resolved `timeoutMs`, and optional abort signal.
- For named `claude` agent requests, the executor MUST default
  `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1` when the request env does not already
  define that key. Explicit request env values MUST be preserved. Custom
  command agents MUST NOT receive this default through command string matching.
- A defined `timeoutMs` MUST be a non-negative safe integer. Invalid values MUST
  return a `config` failure without spawning acpx; zero MUST time out immediately.
- When `timeoutMs` is supplied, the executor MUST enforce the request duration
  locally and pass each acpx subprocess's remaining budget through acpx
  `--timeout`, rounded as `max(1, ceil(remainingMs / 1000))`. Local timers MUST
  preserve longer valid budgets without exceeding the platform's maximum native
  timer delay.
- Executor-local elapsed budgets MUST use a monotonic clock. Synchronous acpx
  resolution and subprocess startup MUST count against the shared turn budget;
  wall-clock changes MUST NOT extend or shorten that budget.
- Requests MAY include an optional raw debug capture flag for runtime
  diagnostics. This flag MUST NOT change prompt execution, parsing, summary,
  or failure classification.
- Requests MAY include `captureTrace?: boolean`. When absent or false, results
  MUST NOT contain a trace. Trace capture and raw debug capture MUST remain
  independent.
- Requests MAY include an optional progress callback. This callback MUST receive
  normalized progress snapshots derived from the ACP JSON stream and MUST NOT
  receive raw ACP JSON lines.
- Progress callbacks MAY complete synchronously or asynchronously. Callback
  throws and promise rejections MUST be treated as best-effort observer failures
  and MUST NOT fail the agent turn.
- Registering a progress callback MUST NOT change final response parsing,
  summary normalization, timeout/cancellation behavior, or backend failure
  classification.
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
- Prompt timeout and abort MUST best-effort call acpx `cancel -s <session>`
  before force-killing the active prompt subprocess.
- Timeout and abort MUST remain authoritative if subprocess or stdin errors race
  with termination. Synchronous resolution/startup failures and normal child
  settlement MUST recheck abort state and the monotonic deadline before being
  classified; when both are observed at one boundary, abort MUST win.
  Best-effort cancellation failures MUST NOT escape as unhandled process errors.
- A stdin write failure after successful spawn MUST NOT be classified as a spawn
  failure or discard the subprocess's terminal stderr and exit status. Once an
  invocation settles, later stdout MUST NOT alter its result or emit progress.

### Results

- `completed` results MUST include final assistant response text, stderr, and
  normalized summary facts.
- `failed` results MUST include one structured failure with a stable backend
  kind, actionable message, optional normalized acpx cause, response text
  collected before failure, stderr, and normalized summary facts.
- `cancelled` results MUST be separate from backend failure kinds.
- When trace capture is enabled, every result MUST contain trace timing and an
  ordered normalized event list. The event list MUST end in `turn_end` for
  completed, failed, cancelled, and timed-out turns; timeout failures MUST use
  terminal status `timed_out`.
- Stable backend failure kinds MUST include `config`, `spawn`,
  `provider_exit`, and `timeout`.
- JSON-RPC failures MUST preserve protocol code, message, and JSON data. Acpx
  envelope fields such as `acpxCode` and `origin` MUST remain separately
  queryable, and a non-empty string `data.details` MUST be the actionable
  message ahead of a generic protocol message.
- Failure classification MUST use local execution boundaries and stable
  protocol codes, not provider-error text matching. JSON-RPC invalid params
  (`-32602`) MUST be `config`; other prompt/session provider failures MUST be
  `provider_exit` unless timeout or spawn handling applies.
- The executor MUST NOT expose raw ACP JSON lines as runtime decision input.
  It MUST derive normalized per-turn summary from the ACP JSON stream.
- Normalized turn summary MUST include event count, optional stop reason,
  optional context window, optional token usage, tool-call summary, cwd, and
  optional acpx record id.
- The progress callback MUST fire for valid prompt stream activity even when
  that activity is not visible response text, including `agent_thought_chunk`
  events.
- Context summary MUST be derived from `usage_update` events. If a later
  `usage_update` reports `used = 0` after a non-zero used value, the executor
  MUST preserve the previous non-zero used value while updating size and
  timestamp.
- Token usage summary MUST be derived from JSON-RPC result `usage` fields and
  MAY be derived from `usage_update._meta.usage` or `usage_update.breakdown`
  fields before the final result arrives. Final result `usage` MUST replace
  earlier event-derived token usage for the same turn. Token usage parsing MUST
  accept both camelCase and snake_case variants for input, output, cached read,
  cached write, thought, and total token counts.
- Tool summary MUST capture `tool_call` and `tool_call_update` events,
  preserving each call's id, title, kind, acpx status, tool name from
  `_meta.claudeCode.toolName`, timestamps, and final completion timestamp for
  `completed`, `failed`, or `cancelled` statuses.
- Tool summary MUST capture only `rawInput` as a truncated JSON preview with
  4 KiB head and 4 KiB tail. It MUST NOT capture `rawOutput`, tool result
  payloads, or tool response bodies.
- Normalized trace tool records MUST preserve provider-emitted `rawInput`,
  `rawOutput`, `content`, and `locations` as full JSON values. This trace-only
  behavior MUST NOT broaden turn summary or progress payloads.
- Tool summary MUST preserve the complete per-turn call list. The reported
  total tool call count MUST equal the call list length.
- Normalized summary MUST NOT contain the request prompt, collected response,
  assistant or thought messages, tool output, or complete protocol events. The
  prompt MUST remain available on the request, and response text MUST remain
  available on results and progress snapshots. Message/thought events and full
  tool payloads belong only to an enabled normalized trace.
- When raw debug capture is requested, results MAY include raw acpx prompt
  stdout as opaque debug material. Runtime consumers MUST NOT need that field
  for execution decisions.
- Non-empty malformed stdout lines from `--format json --json-strict` MUST be
  backend failures, not successful empty responses.
- JSON-RPC error objects MUST be summarized to bounded human-readable error
  messages before being returned to runtime-facing results.

### Trace Capture

- Trace events MUST use schema version 1 and monotonically increasing sequence
  numbers, UTC `observedAt` timestamps captured when each stdout event arrives,
  and `elapsedMs` derived from a monotonic clock.
- Trace capture MUST share the always-on turn clock. When trace is present,
  `trace.startedAt` MUST equal `timing.startedAt`, and the terminal trace
  record's `observedAt` and `elapsedMs` MUST equal `timing.finishedAt` and
  `timing.elapsedMs`. Trace capture failure MUST NOT remove or alter timing.
- The executor MUST normalize provider message/thought, tool call/update,
  usage, and plan events without inferring content the provider did not emit.
  Unrecognized provider behavior and provider-facing client operations MUST be
  retained as `unknown` with their JSON value and tag when available.
- Normalized trace MUST exclude client-to-Agent ACP protocol and control frames,
  even when acpx echoes them on prompt stdout. The excluded methods are
  `initialize`, `authenticate`, `logout`, `$/cancel_request`, `mcp/message`,
  every `providers/*`, `nes/*`, and `document/*` method, and every `session/*`
  method except `session/update` and `session/request_permission`.
  `session/request_permission`, `fs/*`, `terminal/*`, `elicitation/*`,
  `mcp/connect`, `mcp/disconnect`, and unknown extension methods MUST remain
  eligible for `unknown` normalization.
- Request prompt text MUST NOT be copied into trace events, including through
  an echoed `session/prompt` frame. Raw debug capture MUST retain the unmodified
  acpx prompt stdout, including protocol frames.
- Prompt stdout MUST be decoded and parsed exactly once while streaming. Final
  response, summary, progress, and optional trace MUST be accumulated from
  that single parse; prompt stdout MUST NOT be reparsed after process
  settlement. Tool summary timestamps MUST therefore retain event-arrival
  time rather than process-settlement time.

### Progress

- Progress snapshots MUST include response text collected so far, normalized
  turn summary collected so far, and an update timestamp.
- Progress snapshot summary MUST use the same normalized summary shape as
  final turn results.
- Progress parsing MUST be byte-safe across arbitrary stdout chunk boundaries
  and MUST NOT treat incomplete JSON lines as events before a line boundary or
  process close.
- Progress callbacks MUST be best-effort observation hooks. Callback presence
  MUST NOT be required for execution decisions.

## Verification

- Public API contract tests MUST cover exported runtime keys.
- Type tests MUST cover public acpx turn request/result types and verify no
  authored timeout string, acpx path override, or provider-command mapping
  override is accepted.
- Type tests MUST cover the public progress callback and progress payload
  shape, trace request flag, trace events, and trace result.
- Unit tests MUST cover acpx argument construction for named and custom agents,
  permission mode flag mapping, session ensure before prompt, `agentMode`
  `set-mode` ordering, stdin prompt delivery, assistant text extraction,
  millisecond timeout validation, acpx second rounding, shared elapsed budgets,
  long-timeout timer scheduling, synchronous startup accounting, wall-clock
  rollback, and timeout/cancellation error races,
  normalized summary parsing for context, token usage, tool calls, tool
  parameter preview truncation, progress callbacks across stdout chunk
  boundaries, optional raw debug capture, optional trace capture, normalized
  trace ordering/payload preservation/terminal states, single-pass event-time
  summary, and backend failure classification.
