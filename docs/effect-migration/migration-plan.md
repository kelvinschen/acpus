# Effect Migration Plan

This plan executes ADR-0001 on the
`feat/stable-acp-runtime-and-agent-orchestration` baseline.

It is intentionally organized by semantic dependency rather than by package.
The objective is to avoid hybrid architecture, duplicated failure models, and
temporary compatibility paths.

## Target dependency baseline

Use **Effect v4 RC** for this migration. `v4-rc-baseline.md` is authoritative
for version and API policy.

A01 selects one exact v4 RC release train and pins the relevant Effect ecosystem
packages deliberately. Do not use v3, beta, snapshot, or floating RC ranges.
Do not allow an RC upgrade to land implicitly inside an unrelated work package.

Because v4 is a structural release rather than a version-only bump, agents must
use the pinned v4 type declarations and official v4 documentation as their API
source of truth. Do not reproduce v3 service, Cause, forking, Scope, runtime, or
package-layout idioms through local compatibility helpers.

This plan does not require adopting Effect SQL, Effect Workflow, or replacing
the existing SQLite implementation. `effect/unstable/*` modules require an
explicit work-package decision as defined by `v4-rc-baseline.md`.

## Definition of Done

The migration is complete when all of the following are true:

- Effect v4 is the only process-local effect/async composition model in migrated
  application/runtime code;
- the repository uses one intentionally pinned compatible v4 RC release train
  and contains no Effect v3/beta/snapshot dependency;
- `neverthrow` is absent from source, tests, package manifests, and lockfile;
- no production `ResultAsync` remains;
- pure domain functions remain pure and use direct values, domain ADTs,
  `Either`, or `Option` where useful;
- application/runtime cancellation is Fiber interruption, with AbortSignal
  bridges confined to adapter edges;
- long-lived resources are Scope-owned;
- application/runtime time is expressed with Effect Clock/Schedule primitives;
- detached process-local work has explicit ownership and no unstructured
  Promise escape hatches remain;
- scheduler events/store/projection/fencing/replay remain the durable source of
  truth;
- workflow retry still uses scheduler durable retry semantics;
- existing event schemas, persisted storage contracts, and public workflow
  semantics are unchanged unless separately approved;
- relevant unit, type, contract, integration, regression, and end-to-end tests
  pass;
- `pnpm test` and `pnpm typecheck` pass before final handoff;
- quality-gate searches in `review-and-quality-gates.md` are clean or every
  exception is explicitly documented and justified.

## Migration strategy

There are five coherent passes. A pass may contain multiple work packages that
can run in parallel only when they do not edit the same architectural boundary.
Do not start a downstream work package by introducing a compatibility shim for
an upstream dependency that is scheduled to be migrated immediately.

### Pass A: Vocabulary convergence

Goal: remove the second typed-result model and establish Effect-native
signatures without yet rewriting every concurrency mechanism.

Primary work:

- add/pin Effect v4 RC dependencies in packages that need them, using one
  compatible RC release train;
- establish repository guardrails against v3/beta/snapshot Effect packages and
  unapproved `effect/unstable/*` imports;
- replace `ResultAsync` effectful APIs with `Effect<A, E, R>`;
- replace pure `Result` usage with a domain ADT, Effect `Either`, or direct
  values according to semantics;
- migrate tagged recoverable errors to a consistent Effect-compatible error
  taxonomy;
- remove `neverthrow` imports package by package;
- delete neverthrow dependencies when each package is clean;
- update type tests and contracts to the intended final API rather than keeping
  compatibility overloads;
- validate central service/Scope/Fiber/Cause patterns against the pinned v4 RC
  API before downstream work packages depend on them.

Important constraint:

This is not a mechanical `ResultAsync -> Effect.tryPromise` translation, and it
is not a mechanical Effect v3 -> v4 rename pass. The pass establishes final v4
signatures; adapter conversion belongs only at external leaves and native v4
idioms are used directly.

Exit criteria:

- no new neverthrow use can be introduced;
- packages completed in this pass contain no `ResultAsync`;
- cross-package APIs touched by the pass use their final Effect v4 or pure-domain
  form, not dual signatures;
- no v3 compatibility helper has been introduced;
- the selected exact v4 RC dependency set is recorded and repository checks
  verify version coherence where practical.

Suggested work-package ordering:

1. Effect v4 RC baseline, dependency pins, test support, and architecture gates;
2. pure low-level utilities and core parsing/value functions;
3. configuration/admission/evaluation pure boundaries;
4. runtime effectful service interfaces;
5. agent/ACP effectful service interfaces;
6. CLI/web/compiler/task I/O surfaces that currently expose neverthrow.

### Pass B: Platform and service boundaries

Goal: isolate Promise/callback/Node/SDK mechanics beneath stable Effect
capabilities.

Primary work:

- establish capability-oriented services using native Effect v4 service APIs;
- adapt ACP SDK Promise/callback behavior at the ACP boundary;
- adapt subprocess creation, exit, signal, and stream handling behind the
  process capability used by application code;
- centralize Fiber <-> AbortSignal bridging;
- adapt current SQLite store opening/closing/operations into Effect services
  while preserving existing synchronous transaction semantics;
- move configuration/environment acquisition to explicit Effect services where
  it is genuinely effectful;
- keep filesystem/socket/platform details behind owned adapters where this
  reduces repeated lifecycle code.

Avoid capability explosion. Prefer the smallest stable service matching an
Acpus consumer operation over wrappers for individual standard-library
functions. Do not recreate v3 package/service structure by habit when v4 has
consolidated or renamed the relevant capability.

Exit criteria:

- application layers do not contain large `tryPromise` blocks;
- AbortController creation for third-party APIs is centralized;
- low-level Node event registration is concentrated at platform boundaries;
- service construction is Layer/scoped at composition roots rather than
  repeatedly provided deep in application code;
- service definitions and provisioning are idiomatic for the pinned v4 RC,
  without local v3 compatibility facades.

### Pass C: Lifecycle kernel

Goal: make Scope the authoritative owner of process-local resources.

Primary migration targets:

- process capsule and child-process lifecycle;
- ACP session lifecycle;
- reverse-RPC terminal and pending-request lifecycle;
- agent session supervisor;
- hooks process lifecycle;
- workspace runtime construction/shutdown;
- daemon repeating work and shutdown coordination.

Desired ownership shape:

```text
process scope
  workspace scope
    store / authority lease
    scheduler
    agent supervisor
      ACP session
        terminal / process
    hook runtime
```

Work-package requirements:

- identify resource acquisition and finalization before editing;
- replace manual close/drain registries with scoped ownership;
- make child Fibers scoped or explicitly joined according to v4 semantics;
- use Effect Clock for grace periods/repeating work;
- preserve existing SIGTERM/SIGKILL and ownership policies;
- preserve primary failure information when finalizers also fail;
- validate any Cause/finalizer handling against the pinned v4 Cause model.

Exit criteria:

- no migrated lifecycle component relies on a `closePromise` or
  `Set<Promise<...>>` ownership registry;
- closing an owning Scope releases all child resources;
- no process/session background task can outlive its owner without an explicit
  documented process-scope reason;
- lifecycle tests cover acquisition, interruption, active use, and finalization
  races where they matter.

### Pass D: Scheduler execution runtime

Goal: replace manual process-local scheduler concurrency without changing
scheduler meaning.

Primary migration targets:

- scheduler wakeup mechanism;
- mutation serialization;
- active execution ownership;
- heartbeat/repeating jobs;
- attempt execution Fibers;
- bounded concurrency;
- shutdown and settlement;
- process-local execution timeouts.

Preserve the authoritative flow:

```text
store/projection
  -> plan work
  -> run Effect/Fiber
  -> outcome
  -> scheduler event(s)
  -> fenced transaction
  -> projection
```

Do not migrate pure reducers, durable transitions, retry planning, event
identity, owner epochs, or fencing into Fiber state.

Exit criteria:

- scheduler process-local concurrency is structured;
- wakeup/serialization use primitives whose semantics match the old contract;
- concurrency limits are deterministic and covered by tests;
- workflow retries still create/use durable attempts through scheduler logic;
- scheduler shutdown cannot leave an owned attempt Fiber running;
- existing fencing, idempotency, replay, targeted-retry, WAL, and control tests
  remain authoritative.

### Pass E: Surface cleanup and repository convergence

Goal: remove migration residue and present one coherent architecture to future
contributors and agents.

Primary work:

- migrate remaining CLI, web, tasks, compiler I/O, and public TypeScript
  boundaries to final APIs;
- remove unused adapters, transitional helpers, and duplicate error types;
- remove neverthrow from manifests and lockfile;
- remove obsolete Promise timeout/deferred/cancellation helpers;
- remove any v3 compatibility aliases or migration-only Effect wrappers;
- simplify Layers/services that have only one caller and no durable reason to
  exist;
- update developer documentation/spec references affected by final public
  contracts;
- add static architecture gates where practical;
- perform repository-wide bad-taste and Effect-version searches and full
  verification.

Exit criteria:

- Definition of Done is satisfied repository-wide;
- the execution manual describes the implementation that now exists rather
  than a mixed future state;
- Effect dependencies are coherent on the selected v4 RC release train and no
  v3/beta/snapshot residue remains;
- temporary migration plan entries can be removed once all lasting contracts
  live in ADR/spec/maintenance documentation.

## Recommended work-package boundaries

Work packages should be sized around one ownership or service boundary, not a
fixed line count. Useful candidates include:

- Effect v4 RC dependency/bootstrap and architecture gates;
- neverthrow-removal primitives;
- pure Result -> Either/domain ADT conversion in core;
- RuntimeStore Effect boundary;
- ProcessService/AbortSignal adapter boundary;
- ACP transport/session adapter boundary;
- hooks lifecycle;
- process capsule lifecycle;
- ACP session + reverse RPC lifecycle;
- agent supervisor lifecycle;
- workspace/daemon lifecycle;
- scheduler wakeup + mutation queue;
- scheduler active executions/concurrency;
- scheduler timeouts/heartbeat/shutdown;
- CLI/web/task/compiler final surface cleanup;
- repository dependency and architecture-gate cleanup.

Do not split one ownership state machine across multiple simultaneous agents if
they would each need temporary bridges to keep the intermediate code working.

## Parallelization guidance for AI agents

Parallel work is safe when work packages touch independent leaves and already
share a settled target interface.

Good parallelism examples:

- pure neverthrow removal in unrelated packages;
- independent platform adapters after service interfaces are frozen;
- unrelated tests for already migrated boundaries.

Poor parallelism examples:

- two agents independently redesigning RuntimeStore;
- process capsule and supervisor agents both changing session ownership
  contracts at the same time;
- scheduler execution and durable reducer changes in parallel;
- one agent creating a temporary Promise compatibility adapter while another
  removes it;
- one agent upgrading the Effect RC while other work packages are implementing
  against the previous pinned API.

A coordinating/master agent should freeze shared interface decisions and the
active v4 RC baseline before fan-out.

## Master-agent responsibilities

The coordinating agent does not need to implement every work package. It owns
architectural consistency.

For each pass it should:

1. select/freeze the active exact Effect v4 RC release train where relevant;
2. select and freeze target service/error/ownership contracts;
3. create work packages with explicit file/module scope;
4. record invariants each package must preserve;
5. identify packages that may run in parallel;
6. prevent tactical compatibility abstractions, including v3 compatibility
   wrappers;
7. review diffs for bad taste before accepting passing tests;
8. require cleanup of superseded abstractions in the same work package;
9. run or commission cross-package verification at pass boundaries;
10. keep the migration status document current;
11. reject implementations that satisfy types by collapsing errors,
    interruptibility, durable semantics, or by coercing old v3 patterns into
    v4-shaped types.

## Pass-boundary verification

Use narrow tests during implementation. At each pass boundary, run checks
proportional to affected packages and the repository architecture.

Before final completion run at minimum:

```text
pnpm test
pnpm typecheck
```

Also run package/build/contract checks required by the repository maintenance
guides for the actual changed surfaces, and verify the selected Effect v4 RC
versions/imports remain coherent.

A passing test suite is necessary but not sufficient. The quality gates and
architectural review checklist remain mandatory because an Effect syntax
translation can pass behavioral tests while retaining unstructured lifecycle
code or v3 compatibility architecture.
