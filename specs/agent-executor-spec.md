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

- `pnpm test:unit packages/agent-executor`: verifies managed-worker lifecycle,
  bounded cleanup, identity-safe startup recovery, session projection
  persistence, and normalized status classification.
- `pnpm test:contract packages/agent-executor` and `pnpm test:type packages/agent-executor`:
  verify the exported managed-executor and normalized result surface.
