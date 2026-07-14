# Agent Executor Spec

## Purpose

`@acpus/agent-executor` executes one resolved acpx-backed ACP turn. It owns acpx resolution/arguments, process deadlines and cancellation, single-pass ACP JSON parsing, normalized progress/trace, and backend failure classification; the [Runtime](runtime-spec.md) owns workflow rendering, schema repair, scheduler attempts, and durable records.

## Requirements

### Public API And Requests

- The package MUST expose `executeAgentTurn(request)` plus public request, result, progress, timing, summary, tool, and normalized trace types without a binary.
- Public operational types MUST use `AgentTurnSummary`, `AgentContextSummary`, `AgentTokenUsageSummary`, `AgentToolCallSummary`, `AgentToolsSummary`, and `AgentTurnTiming`.
- Terminal results MUST contain UTC `startedAt`/`finishedAt` and finite non-negative monotonic `elapsedMs`; progress and summary omit terminal timing.
- Requests MUST select a named acpx token or custom `--agent <command>` and provide rendered prompt, absolute cwd, environment, session, permission, optional model/mode, numeric timeout, optional abort, and optional observation callbacks.
- The executor MUST resolve its bundled `acpx` internally and reject request-level binary/path/provider-command overrides.
- Named `claude` requests MUST default `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1` only when absent; custom commands never receive that default by string matching.
- `timeoutMs` MUST be a non-negative safe integer, with invalid values returning `config` before spawn and zero timing out immediately.
- The full command sequence MUST share one monotonic deadline; each subprocess receives remaining seconds as `max(1, ceil(remainingMs / 1000))`, with long budgets protected from native timer overflow.
- Optional raw-debug and normalized-trace capture MUST be independent and have no effect on execution, parsing, summary, or failure classification.
- Progress callbacks MUST receive normalized snapshots rather than raw JSON; callback throws/rejections are best-effort observer failures.

### Command Sequence And Settlement

- Every turn MUST execute `sessions ensure --name <session>`, optional `set-mode <mode> -s <session>`, then `prompt -s <session> -f -` with prompt on stdin.
- Permission MUST map only to `--approve-reads`, `--approve-all`, or `--deny-all`; no synthetic policy flags are passed.
- Prompt commands MUST use `--format json --json-strict`, positional named agents, and `--agent <command>` for custom agents.
- `set-mode` rejection MUST return `config` without prompting.
- Prompt timeout or abort MUST best-effort invoke `cancel -s <session>` before force-killing the prompt process.
- Abort and expired deadlines MUST win settlement races, including synchronous startup; when both occur at one boundary, abort wins and cancellation errors remain handled.
- Stdin failure after spawn MUST preserve child stderr/exit classification; settled invocations ignore later stdout/progress.

### Results And Summaries

- Results MUST use `completed`, `failed`, or `cancelled`; stable backend failures are `config`, `spawn`, `provider_exit`, and `timeout`.
- Completed results MUST contain response, stderr, and normalized summary; failed results add one structured actionable failure and normalized acpx cause.
- Failure classification MUST use execution boundaries and protocol codes rather than provider text; JSON-RPC `-32602` is `config`, other prompt/session protocol failures are `provider_exit` absent timeout/spawn handling.
- JSON-RPC causes MUST preserve code, message, data, `acpxCode`, and origin; non-empty `data.details` supplies the actionable message.
- Summary MUST contain event count, telemetry availability, optional stop reason/context/token usage, complete tool-call list/count, cwd, and optional acpx record id without prompt, response, thought/message content, tool output, or complete protocol events.
- Telemetry availability MUST mark context as `available` only when normalized context exists, and token usage as `available` when `totalTokens` exists, `partial` when another normalized token counter exists, or `unavailable` when no normalized token counter exists; it MUST NOT infer missing values.
- Context MUST derive from `usage_update` while retaining the latest non-zero used value across later zero reports.
- Token usage MUST accept camelCase/snake_case input, output, cache, thought, and total counts; final result usage replaces provisional event-derived usage.
- Tool summaries MUST fold call/update events, retain identity/status/timestamps, and store only a bounded 4 KiB head/tail `rawInput` preview without raw output/results.
- Malformed non-empty strict-JSON stdout MUST be a backend failure, and JSON-RPC errors are bounded before runtime-facing return.

### Trace And Progress

- Trace events MUST use schema version 1, monotonic sequence/elapsed values, and event-arrival UTC `observedAt`; terminal trace timing equals terminal turn timing.
- When trace capture is enabled, every terminal result's trace event list MUST end with `turn_end`; timeout failures MUST use terminal status `timed_out`.
- Normalization MUST preserve emitted message/thought, tool, usage, and plan facts without inference; unrecognized provider behavior remains `unknown` with available tag/value.
- Trace MUST exclude client protocol/control frames and prompt echoes while retaining provider-facing permission, filesystem, terminal, elicitation, MCP, and unknown extension activity as normalized/unknown events.
- Trace tools MUST preserve full provider-emitted `rawInput`, `rawOutput`, `content`, and `locations` without broadening summary/progress payloads.
- Prompt stdout MUST be decoded and parsed once while streaming; response, summary, progress, and optional trace derive from that pass and retain event-arrival timing.
- Progress callbacks MUST fire for valid non-text prompt activity, including thought and tool events.
- Progress MUST include response-so-far, the same normalized summary shape including telemetry availability, and update time; parsing is byte-safe across arbitrary chunks and incomplete lines wait for a boundary/close.

## Verification

- Cover public request/result/progress/summary/timing/trace unions with contract and type tests.
- Exercise argument sequencing, timeout/cancellation races, strict JSON streaming, normalized summaries, observation callbacks, optional captures, and failure classification.
