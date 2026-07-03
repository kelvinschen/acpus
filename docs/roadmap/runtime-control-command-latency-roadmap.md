# Runtime Control Command Latency Roadmap

This document records a WebUI dogfooding incident where a run cancel command
was accepted but did not take effect until minutes later. It is a roadmap
investigation note and future fix record, not current product truth.

## Status

- [x] Incident captured from local dogfooding.
- [x] Immediate cleanup completed: the WebUI dev server, current supervisor
  process, and `acpx` child processes were stopped.
- [x] The affected run was eventually canceled and the command queue drained.
- [ ] Root cause needs a focused runtime regression test.
- [ ] Runtime control-command responsiveness needs a design decision.
- [ ] CLI/Web command feedback should distinguish queued, deferred, applied,
  and failed control commands.

## Incident

During WebUI testing, the workflow
`.acpus/workflows/adversarial-review/workflow.ts` was started so the Runtime
page could observe a live run graph and node inspection state.

The first test run failed because Claude-backed agents required local
authentication. A second run was started with selected agents overridden to
`pi`:

- run id: `2026070322361088B664D63205E83CB667`
- workflow name: `adversarial-review`
- agent overrides: `gamma`, `delta`, and `synthesizer` used `pi`

While this run was active, a cancel command was submitted. The CLI/API returned
a successful control response, but the run remained pending/running in the
runtime state. The WebUI and `doctor` still showed runnable work and a pending
command until manual cleanup and a later supervisor tick applied the cancel.

## Observed Timeline

All timestamps are UTC values from the local runtime DB.

- `2026-07-03T14:36:10.851Z` - run
  `2026070322361088B664D63205E83CB667` created.
- `2026-07-03T14:36:11.200Z` - root and worker frames started.
- `2026-07-03T14:38:05.675Z` - cancel command
  `cmd_25785bd4-75ca-43c2-9cae-c10bb7933eac` created with status `pending`.
- `2026-07-03T14:39:53.657Z` - scheduler still advanced the run and completed
  the `delta` branch after the cancel command had been queued.
- `2026-07-03T14:41:56.810Z` - cancel events appended: the beta attempt,
  worker group, root frame, and run were canceled.
- `2026-07-03T14:41:56.839Z` - cancel command marked `applied` with payload
  `{"status":"canceled"}`.

The final state was correct: the run became `canceled`, the pending command
queue became empty, and `doctor` reported no idle-stop blockers. The problem was
latency and misleading feedback, not eventual consistency failure.

## User-Visible Symptoms

- A cancel action appeared to succeed, but the run did not immediately switch to
  `canceled`.
- The run graph continued to show active or runnable work after cancellation.
- `doctor` reported:
  - one pending command;
  - one runnable run;
  - idle-stop blocked by pending commands and runnable runs.
- Process inspection showed supervisor and `acpx` child processes still present
  while the user expected "stop" to mean no active runtime work.
- A manual supervisor tick reported `commands: 1`, which was easy to misread as
  "the command was applied" even though a tick can count a command that was
  deferred or swallowed by the supervisor loop.

## Current Evidence

The cancel command was accepted and persisted. The WebUI/CLI path was not the
primary failure:

- Web command submission calls `applyRunControl` through the web server API.
- CLI control commands also call `applyRunControl`.
- `applyRunControl` submits a durable command and calls `applyControlCommand`
  with scheduler advancement disabled.

The runtime command path then attempts to claim the scheduler run lease. If the
lease cannot be claimed, `applySchedulerControlCommandUnchecked` defers the
command instead of applying it immediately.

The active scheduler execution path holds the same run lease while executing
ready agent instances. In this incident, long-running agent work kept the run
lease active while the cancel command waited. The cancel only applied after the
active work was interrupted/stopped and a later tick could claim the run lease.

The supervisor loop also contributes to confusing observability:

- the loop heartbeats the supervisor lease before entering `runSupervisorTick`;
- `runSupervisorTick` may spend a long time inside scheduler advancement while
  awaiting agent execution;
- a long tick can make the supervisor lease appear stale from the outside;
- `runSupervisorTick` catches control-command errors and still increments its
  command counter, so `commands: 1` means "one command was considered", not
  "one command was successfully applied".

## Working Theory

The core issue is control-plane responsiveness, not WebUI synchronization.

Runtime currently couples these concerns too tightly:

- command ingestion;
- command application;
- scheduler advancement;
- long-running agent execution;
- supervisor liveness reporting.

Cancel, pause, retry, and signal commands share the scheduler run lease with
active scheduler advancement. A command that needs to interrupt active work must
wait for the same ownership path that the active work already holds. This makes
operator controls durable, but not responsive under long-running agent calls.

## Potential Root Causes

These causes are not mutually exclusive.

1. **Run lease exclusivity blocks operator controls.**

   Control commands and active scheduler advancement both require the same run
   lease. While an agent attempt is running, cancel cannot append cancellation
   events unless it can claim that lease.

2. **Active attempts are only abortable from inside the current advance call.**

   The scheduler has `AbortController`s for active attempts, but external
   control commands do not have a direct way to signal those controllers. A
   cancel intent becomes DB state first; it does not immediately interrupt the
   in-memory agent execution owned by another tick.

3. **Supervisor heartbeat is tied to tick progress.**

   The supervisor process can be healthy while its supervisor lease heartbeat
   looks stale, because the loop is waiting inside a long tick. This can produce
   duplicate-looking supervisors or confusing diagnostics.

4. **Command counters hide deferred work.**

   `runSupervisorTick` increments `commands` after trying a command, even when
   command application throws or the command is deferred. This weakens both
   diagnostics and operator intuition.

5. **CLI/Web success wording is too strong.**

   The control response said "Run canceled" even though the durable command was
   only accepted or queued. The UI should not imply state transition completion
   until the command is `applied` and the run projection reflects it.

## Future Fix Directions

Candidate fixes to evaluate:

- Split command intake from command application in API responses. Return command
  status precisely: accepted, pending, deferred, applied, or failed.
- Change CLI/Web copy for queued controls, for example "Cancel queued" until the
  command reaches `applied`.
- Expose command lifecycle in runtime public APIs so the WebUI can show pending
  control commands and their last update time.
- Make supervisor heartbeat independent from long scheduler ticks, or run
  heartbeat from a timer that continues while agent work is in flight.
- Rework scheduler cancellation so cancel can interrupt active attempts without
  waiting for the normal run-lease claim path. Possible approaches include:
  - a cancellation-intent table that active attempts poll or receive through a
    local signal bus;
  - a control channel owned by the active run owner that can abort in-memory
    attempt controllers;
  - shorter execution slices where scheduler advancement starts work and returns
    quickly, with agent processes observed asynchronously.
- Add command outcome accounting to `runSupervisorTick`, such as considered,
  applied, deferred, failed, and shutdown counts.
- Add runtime diagnostics for stale active attempts, active run leases, and
  commands blocked by run lease ownership.
- Consider whether cancel should mark a run as operator-cancel-requested before
  all attempt cleanup completes, so the operator surface reflects intent quickly
  while cleanup remains in progress.

## Regression Test Shape

A useful test should reproduce the actual coupling:

- create a run with a controlled long-running executable node;
- start scheduler advancement so it holds the run lease and exposes an active
  attempt;
- submit a cancel command while the attempt is still running;
- assert the command does not misleadingly report applied if it is only queued;
- assert the runtime has a deterministic path to interrupt or cancel the active
  attempt once the chosen fix lands;
- assert diagnostics distinguish deferred command processing from applied
  command processing.

The seam should be in runtime/scheduler tests, not WebUI tests. WebUI tests can
later verify display behavior once runtime exposes precise command lifecycle
state.

## Open Questions

- Should cancel be a best-effort immediate interrupt or a durable intent that
  may wait for the active scheduler owner?
- If cancel becomes immediate, which component owns the in-memory abort channel:
  supervisor loop, scheduler runner, agent executor, or a small runtime control
  broker?
- Should run status gain an intermediate operator-cancel-requested state, or
  should command status alone carry that distinction?
- How should `doctor` report active run leases when the owning process is alive
  but the supervisor lease heartbeat is stale?
- Should supervisor auto-start dedupe before spawning, or is DB lease rejection
  sufficient once heartbeat behavior is fixed?

## Non-Goals

- This roadmap does not change WebUI design direction.
- This roadmap does not propose direct SQLite access from web code.
- This roadmap does not require introducing compatibility behavior for old
  runtime semantics.
- This roadmap does not treat the observed incident as a data-loss issue; the
  final persisted state was internally consistent.
