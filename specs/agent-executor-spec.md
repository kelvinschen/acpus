# Agent Executor Spec

## Purpose

`@acpus/agent-executor` owns workspace-local Agent Session leases, named Agent
launch resolution, isolated ACP process capsules, and process-ownership
evidence. [Runtime](runtime-spec.md) owns durable Runs, Attempts, Agent Session
identity/generation/checkpoints, operator controls, and product inspection.
[ACP](acp-spec.md) owns the protocol Session and its projection.

The public execution seam is Session-oriented: `createAgentSessionSupervisor`
returns `withSessionLease`, `withSessionsNeutralized`, and `shutdown`. The
package MUST NOT expose the removed attempt-oriented `ManagedAcpExecutor`
surface.

## Requirements

### Named Agent Resolution

- Command selectors MUST bypass Host launches, configured resolution, and the
  built-in catalog.
- Named selection precedence MUST be immutable Host registry, the optional
  Runtime-provided configured-command resolver, then the package catalog. The
  resolver MUST preserve the project-over-global composition owned by the
  [Configuration](configuration-spec.md) contract.
- Registry and configured names MUST normalize by trim plus lowercase. The
  Executor MUST request the exact normalized name before its canonical alias
  in one configured-resolution call.
- Each configured command MUST resolve through the platform shell without
  Acpus tokenization or normalization. Configuration failures returned by the
  resolver MUST be non-retryable resolution failures.
- Resolution MUST complete before a Process Capsule or ownership manifest is
  created. One Session lease resolves once; a later lease resolves current
  configuration again. Resolved launch data MUST NOT be persisted here.

### Session Supervisor

- Construction MUST receive the Host's explicit `ProcessHostShape`; Agent
  Executor MUST NOT create a second raw Node process boundary or choose a
  owned-process implementation internally.
- Construction MUST require an explicit parent `Scope.Scope`, fork one
  Supervisor child Scope, and register semantic shutdown in that Scope. The
  Supervisor Scope MUST own one `FiberSet` containing every admitted lease and
  neutralization operation; each lease MUST own a Session child Scope and its
  Process Capsule child Scope.
- `createAgentSessionSupervisor` MUST recover workspace-local ownership before
  returning a usable supervisor. Unsupported manifest shapes MUST fail startup.
- `withSessionLease` MUST serialize ownership by exact `agentSessionId`. A
  second lease or neutralization for that Session MUST fail as `session_busy`
  before spawning a process.
- One admission semaphore MUST atomically decide closed state, reserve exact
  Session policy, and register the operation Fiber before releasing admission.
  The Session map MAY retain domain ownership records and deferred cleanup
  evidence; it MUST NOT own lifetime through Promises, polling, or timers.
- The caller MUST supply the exact durable Attempt context and Session intent.
  Cancellation and authored deadline remain authoritative through guard
  acquisition, Agent resolution, capsule open, every Turn, and cleanup.
- Inside the Session guard, Agent resolution MUST finish before capsule spawn.
  ACP MUST resolve and compare its structured Agent Session binding before the
  worker starts a Provider; binding resolution or mismatch MUST start no
  Provider process.
- A lease MUST open one Process Capsule and one ACP Session, expose only the
  lease's Session/lease/projection identities, optional bounded
  Provider-reported version, and `runTurn`, then close the
  capsule after the callback settles.
- One lease MUST admit at most one active Turn. Response-repair Turns MAY reuse
  that lease; natural shared-session continuation, safe retry, and Steer
  replacement Attempts acquire a later lease against Runtime's authoritative
  Session plan.
- `withSessionsNeutralized` MUST sort and deduplicate exact Session refs,
  acquire all guards before cleanup, neutralize every selected capsule, and
  invoke the commit callback only after all selected ownership is absent.
- Neutralization MUST close the selected Capsule/Session Scopes and await each
  lease's deferred cleanup evidence. A callback that remains suspended after
  capsule settlement MUST be interrupted by its Session Scope before
  neutralization returns.
- Partial neutralization MUST NOT invoke the commit callback. The callback is
  the sole boundary at which Runtime may atomically commit Retry abandonment
  and scheduler changes.
- `shutdown` MUST stop new leases, request cleanup for every capsule, wait for
  bounded cleanup, clear and await every owned operation Fiber, and return a
  typed aggregate when ownership remains. Shutdown MUST be cached and
  uninterruptible. Closing the supplied parent Scope directly MUST run the same
  semantic shutdown before the Supervisor's structural finalizers complete.

### Process Capsule And Turns

- Each Process Capsule MUST own exactly one worker process tree, one closed IPC
  channel, one ACP Session, and at most one active Turn.
- The worker Process handle, IPC consumers, semantic cleanup, and adapter
  fallback MUST share one owning Scope. Semantic cleanup MUST run before the
  owned-process finalizer when that Scope closes.
- The executable worker entry MUST run exactly one scoped program through
  `NodeRuntime.runMain` and provide the ACP Node transport Layer only there;
  library Session code MUST NOT construct or provide its own Node service
  graph. Acquired process message/disconnect listeners MUST feed an Effect
  Queue, and open/Turn work MUST be owned by one scoped `FiberSet`. Worker
  shutdown MUST stop children, close the ACP Session, publish `closed`, and
  disconnect before the outer Scope releases transport/process resources.
- Worker IPC MUST distinguish bootstrap acknowledgement from ACP Session
  readiness. A short package watchdog MAY cover worker bootstrap only; it MUST
  NOT become an Agent resolution, ACP open, or Turn deadline.
- Provider readiness MUST use a separate 30-second capsule-open bound, shortened
  by the Attempt deadline when less time remains. The bootstrap orphan watchdog
  MUST NOT shorten this Provider initialization window.
- The capsule MUST implement first-trigger-wins cancellation for caller abort,
  authored deadline, inactivity, event-sink failure, and cleanup. A trigger
  sends at most one Turn cancel and establishes one cleanup deadline.
- Each admitted Turn MUST use a nested Scope whose deadline, replaceable
  inactivity wait, caller-abort adapter, and cooperative-cleanup wait are child
  Fibers. Turn settlement MUST close that Scope and remove every child.
- After cancellation starts, matched events and the terminal result MUST
  continue through the settlement reducer until a terminal barrier, verified
  worker loss, or bounded hard cleanup. A second Turn remains rejected during
  drain.
- `runTurn` MUST return a typed completed outcome or typed event-sink, policy,
  originating ACP, capsule-loss, or cancellation failure while retaining the bounded
  Turn snapshot and settlement evidence.
- Consecutive assistant text events append to the current response segment.
  Thought/plan and tool events close a segment; tool calls invalidate earlier
  final-response candidates. Usage, Session, client-activity, and unknown
  events MUST NOT enter response text.
- Completed Turns expose the latest valid final-response candidate, or an empty
  string. Non-completed Turns retain observed segments and MUST NOT expose a
  completed final response.
- The public seam MUST NOT expose raw ACP transport, provider stdio, process
  identity, or child topology.
- Worker IPC MUST carry one ordered raw `AcpEvent` delta per event and one
  terminal envelope. `open_failed` is the only pre-ready ACP failure lane;
  `failed` is reserved for Process Capsule faults.
- Worker protocol v10 open MUST carry the resolved launch and effective Session
  inputs without a parent-computed binding value. Ready MAY carry the non-empty
  Provider-reported version bounded to 256 characters.
- The parent capsule MUST assign sequence/time metadata and exclusively own
  response, final-candidate, tool, usage, timing, and partial-snapshot
  reduction. Terminal receipt MUST NOT increment the ACP event count.
- An event after terminal, a duplicate terminal, or a mismatched Turn id MUST
  fail the capsule protocol.

### Activity And Observation

- Context-window counters and current-Turn token usage are independent optional
  telemetry and MUST NOT be inferred from each other.
- Dispatch and every admitted ACP event count as activity. Optional inactivity
  policy resets only on admitted activity before a policy wins.
- `TurnInput.onEvent` receives parent-enveloped raw ACP event deltas in worker
  order. No cumulative observation, request/result, or backend-failure public
  shape may coexist with this seam. Callback failure is an event-sink failure and MUST participate
  in Turn cancellation/drain rather than escape as an unowned throw.
- Permission, Session, and client activity count as Provider activity without becoming a semantic
  observation. Missing telemetry is `unavailable`, never an invented zero.

### Ownership And Cleanup

- Before worker initialization, the capsule MUST atomically write a schema-v3
  manifest identifying host, Runtime owner epoch, Agent Session, Session lease,
  Run, Attempt, and exact worker process identity.
- Cleanup MUST request Turn cancellation and Session close, then use one bounded
  TERM/KILL/final-liveness budget. Cooperative and process-tree cleanup MUST
  share that budget.
- Cleanup MUST be one cached uninterruptible Effect. Explicit close observes
  its typed result; direct unobserved Scope closure MUST still run adapter
  fallback and MUST NOT silently discard a semantic cleanup failure.
- A manifest may be removed only after worker-tree death is proven. Proven-live
  or unverified residual ownership MUST remain as degraded evidence and MUST
  quarantine the Session from later acquire.
- Final `unverified` liveness MUST remain `unverified` in the manifest and
  cleanup error; it MUST NOT be collapsed to boolean `alive` evidence.
- Startup recovery MUST be bounded to the supplied workspace root. It MUST
  signal a residual tree only when the recorded process-start token still
  matches; otherwise it retains unverified evidence without signalling.
- `inspectAcpOwnership` is read-only. Its safe manifest references expose only
  Session/Run/Attempt identity, lifecycle state, and
  `healthy | quarantined | unverified`; raw PID, token, argv, and environment
  MUST remain private.

## Verification

- `pnpm --filter @acpus/agent-executor typecheck`
- `pnpm test:type packages/agent-executor`
- `pnpm test:contract packages/agent-executor`
- `pnpm test:unit packages/agent-executor`
- `pnpm test:integration packages/agent-executor`
