# Agent Executor Spec

## Purpose

`@acpus/agent-executor` owns one isolated `acpx/runtime` worker tree for each
Runtime Agent attempt. It exposes normalized turn results and process-ownership
evidence; [Runtime](runtime-spec.md) owns durable attempts, session identity,
and operator-facing recovery.

## Requirements

### Public Boundary

- The package MUST expose `createManagedAcpExecutor`, `recoverAcpOwnership`,
  `inspectAcpOwnership`, `acpxSessionProjectionPath`, and their public
  managed-attempt, normalized-turn, and ownership types.
- `withAttempt` MUST provide one callback-scoped `runTurn` capability and MUST
  clean its worker tree after the callback settles, regardless of the callback
  result.
- A managed attempt MUST admit at most one active turn at a time.
- A named Agent's launch MUST match package-pinned Acpx resolution for the
  attempt's effective working directory and environment.
- Structured argv returned by Acpx MUST cross worker startup without being
  rendered back into a command string.
- Named Agent resolution MUST complete before the executor creates a worker or
  ownership evidence.
- A managed attempt MUST resolve its named Agent once and reuse that launch for
  every turn; a later attempt MUST resolve against the then-current config.
- A command selector MUST use its authored command directly and MUST NOT read or
  validate Acpx configuration.
- The executor MUST NOT apply any Acpx configuration domain other than
  `agents`.
- A recoverable Acpx configuration-resolution failure MUST return a
  non-retryable runtime `config` failure without creating ownership evidence.
- An unavailable or incompatible package-pinned Acpx resolver MUST surface as a
  system failure.
- The executor MUST NOT expose or persist the full resolved Acpx configuration.
- A worker MUST use the `acpx/runtime` API with the supplied persistent session
  directory; turns in one managed attempt MUST reuse that worker and session.
- `acpxSessionProjectionPath` MUST map an acpx record id to
  `sessions/<encodeURIComponent(acpx-record-id)>.json` relative to the supplied
  session-state directory.
- The worker MUST supply an Acpus-owned `AcpSessionStore` adapter to
  `acpx/runtime`.
- The adapter MUST persist the acpx session projection at the path returned by
  `acpxSessionProjectionPath`.
- The adapter MUST load that projection for later workers that resume the same
  session.
- The adapter MUST preserve structured Agent argv in the session projection.
- Before saving, the adapter MUST preserve the acpx-projected User and Agent
  messages, including Text, Thinking, tool calls, and each tool result's compact
  `content`; it MUST omit each tool result's optional `output`.
- Because Acpus does not persist the acpx raw event stream, the saved session
  projection MUST use an empty `event_log.active_path`, omit
  `event_log.last_write_at`, and set `event_log.last_write_error` to an explicit
  explanation instead of naming a nonexistent stream file.
- `runTurn` MUST return the public normalized result union and MUST deliver
  normalized progress and observation callbacks without letting callback
  failures change turn settlement.
- The managed executor MUST reject child IPC messages with an unsupported
  version or malformed discriminant-specific payload. A turn result MUST carry
  string response segments, shared summary and timing data, and exactly the
  terminal detail required by its status, including completed-only
  `finalResponse`.
- Each turn MUST start with an empty response collector that is not shared with
  any earlier repair, retry, resumed, or steering turn.
- The response collector MUST append each non-thought `text_delta` exactly as
  received to the current response segment.
- A thought or plan event MUST close the current response segment without
  invalidating the latest final-response candidate.
- Every tool call or tool update MUST close the current response segment and
  invalidate every earlier final-response candidate.
- Usage, ordinary status, and unknown status events MUST NOT enter or segment
  responses and MUST NOT change the final-response candidate.
- Empty text deltas MUST NOT create response segments. Non-empty whitespace
  MUST be preserved as response text.
- Response collection MUST depend only on normalized event order and MUST NOT
  use provider names or response-text heuristics.
- Turn progress MUST expose the ordered response segments observed so far; its
  final segment MAY still be growing.
- Every progress and result response array MUST be detached from the mutable
  collector state.
- A completed turn MUST expose `finalResponse` as its latest valid
  final-response candidate.
- A completed turn without a valid final-response candidate MUST expose an
  empty `finalResponse` instead of falling back to an earlier response.
- A failed or cancelled turn MUST retain its observed response segments and
  MUST NOT expose `finalResponse`.
- A rejected static session option MUST return a `config` failure with upstream
  operation `session.set_config_option`.
- The executor MUST not expose raw ACP transport capture or raw provider wire
  output as a public request or result field.
- A named `claude` worker MUST default `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1`
  only when the caller did not set it; command-backed workers MUST not receive
  that default by name matching.

### Activity And Inactivity

- The executor MUST report ACP activity when it locally dispatches a turn and
  when it receives a public normalized `acpx/runtime` event.
- A status event with context counters or a token breakdown MUST become a usage
  observation.
- A `plan` status MUST become a plan observation.
- An empty `usage_update`, `available_commands_update`, `current_mode_update`,
  `config_option_update`, or `session_info_update` status MUST count as ACP
  activity without becoming a persisted observation.
- An untagged status whose complete text is `session resumed` MUST count as ACP
  activity without becoming a persisted observation.
- An untagged status whose first two whitespace-delimited fields are a known
  client-operation method and one of `running`, `completed`, or `failed` MUST
  count as ACP activity without becoming a persisted observation. The known
  methods are `fs/read_text_file`, `fs/write_text_file`, `terminal/create`,
  `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, and
  `terminal/release`.
- Any other status without usage counters or a token breakdown MUST remain an
  unknown observation so Runtime can report genuinely unsupported provider
  semantics as degraded.
- An optional `inactivityFailAfterMs` MUST reset on each reported activity.
- When that interval elapses, the executor MUST cancel the active turn and
  return a retryable `inactivity_stale` runtime failure with its silence
  duration and configured interval as evidence.
- Activity reporting MUST not claim receipt of an unexposed transport frame or
  provider-side execution confirmation.

### Ownership And Cleanup

- Before initializing a spawned worker, the executor MUST atomically write an
  active ownership manifest under the supplied workers root.
- A manifest MUST identify its run, attempt, session, daemon generation, and
  worker process; it MUST include a process-start token whenever the platform
  can obtain one.
- Managed-attempt cleanup MUST request turn cancellation and worker close,
  then make one bounded best-effort tree cleanup using TERM, KILL, and a final
  liveness check.
- Cleanup MUST delete a manifest only after the worker tree is no longer live.
- When cleanup cannot establish that the tree is gone, the executor MUST retain
  a degraded manifest rather than report a clean result.
- `recoverAcpOwnership` MUST perform only a bounded startup sweep of the
  supplied workspace workers root; it MUST not start a background reaper or
  scan other workspaces.
- Startup recovery MUST signal a residual worker only when its stored
  process-start token still matches; an unverified live PID MUST remain as
  ownership evidence without being signalled.
- `inspectAcpOwnership` MUST be read-only and report only degraded or orphaned
  ownership evidence; an active manifest owned by the supplied current daemon
  MUST not be reported as an orphan.

## Verification

- `pnpm test:unit packages/agent-executor`: verifies named Agent resolution,
  command bypass, response collection, managed-worker lifecycle,
  bounded cleanup, identity-safe startup recovery, session projection
  persistence, and normalized status classification.
- `pnpm test:integration packages/agent-executor`: verifies effective Acpx
  configuration and managed named-Agent startup and failure behavior.
- `pnpm test:contract packages/agent-executor` and `pnpm test:type packages/agent-executor`:
  verify the closed worker IPC protocol, exported managed-executor, and normalized result surface.
