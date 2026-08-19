# Agent Executor Spec

## Purpose

`@acpus/agent-executor` owns named Agent launch resolution and one isolated
worker tree for each Runtime Agent attempt. It exposes normalized turn results,
semantic observations, inactivity policy, and process-ownership evidence while
delegating protocol sessions and persistence to [ACP](acp-spec.md).
[Runtime](runtime-spec.md) owns durable attempts, run-local session identity,
and operator-facing recovery.

## Requirements

### Named Agent Resolution

- A command selector MUST bypass Host launches, Agent configuration, and the
  built-in catalog.
- For a named selector, an own-property match in the immutable Host registry
  MUST take precedence over project Agent configuration, global Agent
  configuration, and the package-owned built-in catalog, in that order.
- Host registry keys MUST use trimmed lowercase Agent names. A Host resolver
  MUST receive only the attempt's optional effective model and MUST return a
  structured argv launch.
- Acpus Agent configuration MUST be read from the effective working
  directory's `.acpus/agents.json` and the effective home directory's
  `.acpus/agents.json` when a home is available.
- Each Agent configuration file MUST be the closed `{ agents: { ... } }`
  object, and each entry MUST be the closed `{ argv: [...] }` object with a
  non-empty executable. Names MUST match after trimming and lowercasing;
  normalized collisions MUST fail validation.
- Every present configuration file MUST be validated completely before
  selection. A missing file MUST contribute no entries; malformed JSON, an
  invalid entry, or a read failure MUST return a non-retryable `agent-config`
  failure naming the path.
- A project entry MUST override a same-named global entry, and either configured
  entry MUST override the same built-in name.
- The package MUST own a built-in catalog of structured argv launches.
- An unknown named Agent MUST return a non-retryable `agent-config` failure.
- Named Agent resolution MUST complete before the executor creates a worker or
  ownership evidence.
- A managed attempt MUST resolve its named Agent once and reuse that launch for
  every turn; a later attempt MUST resolve against the then-current Host
  registry and Agent configuration.
- The executor MUST NOT persist the resolved Agent configuration or launch.

### Managed Attempts And Turns

- The package MUST expose `createManagedAcpExecutor`, `recoverAcpOwnership`,
  `inspectAcpOwnership`, and their public managed-attempt, normalized-turn, and
  ownership types.
- `withAttempt` MUST provide one callback-scoped `runTurn` capability and MUST
  clean its worker tree after the callback settles, regardless of the callback
  result.
- A managed attempt MUST accept an optional cancellation signal that remains
  authoritative through named Agent resolution, worker and ACP session startup,
  and every turn. Cancellation MUST prevent late resolution, readiness, or turn
  results from making the attempt usable or successful.
- A managed attempt MUST admit at most one active turn at a time.
- Worker IPC MUST distinguish bootstrap acknowledgement from ACP session
  readiness. Bootstrap acknowledgement MUST prove only that the owned worker
  accepted initialization and began session open; session readiness MUST be
  reported only after `openAcpSession` succeeds, and bootstrap acknowledgement
  alone MUST NOT make the managed attempt usable.
- The executor MAY apply a short package-owned watchdog only to owned-worker IPC
  bootstrap. It MUST NOT use that watchdog as a deadline for named Agent
  resolution, ACP session open, or session readiness.
- A worker MUST use one [ACP session](acp-spec.md#public-session-boundary) with
  the supplied persistent state directory and record identity; turns in one
  managed attempt MUST reuse that session.
- `runTurn` MUST return the public normalized result union and MUST deliver
  normalized progress and observation callbacks without letting callback
  failures change turn settlement.
- A turn summary MUST carry the ACP state-root-relative
  `sessionProjectionPath` when a projection exists.
- The managed executor MUST reject child IPC messages with an unsupported
  version or malformed discriminant-specific payload. A turn result MUST carry
  string response segments, shared summary and timing data, and exactly the
  terminal detail required by its status, including completed-only
  `finalResponse`.
- Each turn MUST start with an empty response collector that is not shared with
  any earlier repair, retry, resumed, or steering turn.
- Consecutive non-empty assistant text updates MUST append exactly as received
  to the current response segment, preserving non-empty whitespace.
- A thought or plan MUST close the current response segment without
  invalidating the latest final-response candidate.
- A tool call MUST close the segment and invalidate every earlier
  final-response candidate; a tool update MUST close the segment without
  invalidating that candidate.
- Usage, session, client-activity, and unknown events MUST NOT enter or segment
  responses or change the final-response candidate.
- Response collection MUST depend only on normalized event order and MUST NOT
  use Agent or provider identity or response-text heuristics.
- Turn progress MUST expose detached ordered response segments observed so far;
  its final segment MAY still be growing.
- A completed turn MUST expose `finalResponse` as its latest valid candidate, or
  an empty string when no candidate remains. A failed or cancelled turn MUST
  retain observed response segments and MUST NOT expose `finalResponse`.
- The executor MUST NOT expose raw ACP transport or raw provider output as a
  public request or result field.

### Activity And Inactivity

- Context-window counters and token usage MUST remain independent optional
  telemetry: context is the latest session-window checkpoint, while token usage
  describes the current turn and MUST NOT be inferred from context.
- Terminal usage reported by the ACP session result MUST replace the live
  current-turn token breakdown without changing settlement or emitting another
  usage observation.
- The executor MUST report ACP activity when it dispatches a turn and whenever
  it receives a public ACP event.
- Message, thought, tool, usage, plan, and unknown events MUST become their
  normalized observations. Session and client-activity events MUST count as
  activity without becoming persisted semantic observations.
- An optional `inactivityFailAfterMs` MUST reset on each reported activity.
  When it elapses, the executor MUST cancel the active turn and return a
  retryable `inactivity_stale` failure with its silence duration and configured
  interval as evidence.
- Activity reporting MUST not claim receipt of an unexposed transport frame or
  Agent-side execution confirmation.

### Ownership And Cleanup

- `shutdown()` MUST first stop admitting new managed attempts and request every
  resolving, starting, ready, or active attempt to stop. It MUST issue those
  stop requests before awaiting attempt or cleanup settlement.
- Before initializing a spawned worker, the executor MUST atomically write an
  active ownership manifest under the supplied workers root.
- A manifest MUST identify its run, attempt, session, executor-owner
  generation, and worker process; it MUST include a process-start token
  whenever the platform can obtain one.
- Managed-attempt cleanup MUST request turn cancellation and session close,
  then make one bounded best-effort tree cleanup using TERM, KILL, and a final
  liveness check.
- Cleanup MUST delete a manifest only after the worker tree is no longer live.
  When cleanup cannot establish that result, it MUST retain a degraded manifest.
- `recoverAcpOwnership` MUST perform only a bounded startup sweep of the
  supplied workspace workers root; it MUST not start a background reaper or
  scan other workspaces.
- Startup recovery MUST signal a residual worker only when its stored
  process-start token still matches; an unverified live PID MUST remain as
  ownership evidence without being signalled.
- `inspectAcpOwnership` MUST be read-only and report only degraded or orphaned
  ownership evidence; a manifest owned by the supplied executor owner and
  generation MUST not be reported as an orphan.

## Verification

- `pnpm --filter @acpus/agent-executor typecheck`: verifies the public managed
  executor and ACP type boundary.
- `pnpm test:unit packages/agent-executor`: verifies Agent resolution, response
  collection, event normalization, inactivity, and ownership lifecycle.
- `pnpm test:integration packages/agent-executor`: verifies Host, project,
  global, built-in, and command-backed Agent startup and failure behavior.
- `pnpm test:contract packages/agent-executor` and
  `pnpm test:type packages/agent-executor`: verify the closed worker IPC and
  exported managed-executor surface.
