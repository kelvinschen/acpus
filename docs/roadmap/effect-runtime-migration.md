# Effect Runtime Migration Roadmap

This roadmap tracks execution of ADR-0001. It is an active planning record, not
a specification. Delete it after the migration is complete and lasting
contracts have moved into the owning ADR/spec/maintenance guides.

## Goal

Converge Acpus onto Effect v4 as the sole process-local effect system in the
appropriate application/runtime boundaries, remove neverthrow, replace manual
Promise/Abort/timer/resource orchestration with structured Effect primitives,
and preserve the durable scheduler/store/fencing/replay model.

The active technology baseline is Effect v4 RC. See
`docs/effect-migration/v4-rc-baseline.md` for version/API policy and
`docs/effect-migration/upstream-source-workflow.md` for the vendored-source
knowledge workflow used by coding agents.

## Status legend

- `planned`: contract not yet frozen for implementation;
- `ready`: master has frozen the work-package contract;
- `active`: one execution agent owns the package;
- `review`: implementation awaits master acceptance;
- `done`: accepted and downstream packages may rely on it.

A01 is `ready`. Its frozen release baseline is recorded in
`docs/effect-migration/baseline-lock.md`, and its executable worker contract is
`docs/effect-migration/work-packages/A01.md`. All later work packages remain
`planned` until their own Execution Packets are compiled.

## Dependency graph

```text
A01 Effect v4 RC baseline + architecture gates + vendored source corpus
  |
  +--> A02 Pure Result removal: core/shared values
  +--> A03 Runtime error/API vocabulary
  +--> A04 ACP/agent error/API vocabulary
  +--> A05 Peripheral package Result removal
             |
             v
B01 RuntimeStore Effect boundary
B02 Process + AbortSignal adapter boundary
B03 ACP SDK/transport adapter boundary
B04 Effect composition roots / config baseline
  |       |       |       |
  +-------+-------+-------+
                  v
C01 Hooks lifecycle
C02 Process capsule lifecycle
C03 ACP session + reverse RPC lifecycle
C04 Agent supervisor/session ownership
C05 Workspace + daemon lifecycle
                  |
                  v
D01 Scheduler wakeup + mutation serialization
D02 Scheduler active execution ownership
D03 Scheduler concurrency + timing + heartbeat
D04 Scheduler shutdown/control interruption integration
                  |
                  v
E01 CLI/web/tasks/compiler surface convergence
E02 Repository cleanup + final architecture review
```

The master may refine dependencies after inspecting concrete interfaces, but
must not create temporary compatibility paths merely to enable unsafe
parallelism.

## Pass A: Vocabulary convergence

### A01 — Effect v4 RC baseline, vendored source and migration guardrails

Status: `ready`

Execution Packet:

- `docs/effect-migration/work-packages/A01.md`
- frozen baseline: `effect@4.0.0-rc.111`, `@effect/vitest@4.0.0-rc.111`;
- matching upstream commit: `648f566dd259898e7697c7fcb796183ccbc474ab`.

Scope candidates:

- workspace/package manifests and lockfile;
- one exact compatible Effect v4 RC release train;
- matching upstream Effect source vendored at `repos/effect` using a squashed
  git subtree (or explicitly approved equivalent);
- repository lint/check capability for closed-set migration rules;
- test support needed by later Effect work;
- developer/agent documentation references;
- v4 API source-of-truth and unstable-module guardrails;
- editor/build/test isolation needed so `repos/**` is searchable by agents but
  not treated as application source.

Goal:

Establish one exact Effect v4 RC baseline and make it difficult to add new
neverthrow/ResultAsync code, Effect v3/beta/snapshot packages, v3 compatibility
helpers, or unapproved `effect/unstable/*` imports while migration is in
progress.

A01 also makes Effect's matching upstream source locally explorable by coding
agents. The installed dependency and vendored source are one coherent baseline:
never pin package.json to one RC while agents browse a newer moving `main`.

A01 freezes the native v4 patterns downstream work packages will rely on for
service definition, Layer provisioning, Scope/resource construction, Fiber
forking/supervision, Cause/error handling, and runtime entry points. These must
be verified against the pinned RC type declarations, the matching vendored
source/tests/`LLMS.md`/`ai-docs`, and official v4 guidance, not copied from v3
memory.

A01 establishes the pattern-note protocol under
`docs/effect-migration/agent-patterns/`. It does not need to create every note
up front. Master commissions a note just before the first work package that
needs a reusable/high-risk primitive, then later packets reuse that reviewed
interpretation.

Does not migrate business/runtime behavior.

Exit evidence:

- exact Effect v4 RC dependency versions intentionally pinned and compatible;
- vendored `repos/effect` source corresponds to the same selected RC and its
  upstream commit/release is recorded;
- `repos/effect/LLMS.md` is available in a normal checkout;
- Acpus code cannot import from `repos/effect` and vendored source is excluded
  from normal application build/test/coverage/typecheck discovery;
- no Effect v3, beta, or snapshot dependency introduced;
- no semver range can silently advance the active RC during a work package;
- central service/Scope/Fiber/Cause patterns are validated against the pinned
  v4 API and matching vendored source;
- `effect/unstable/*` defaults to disallowed unless a named work package
  explicitly approves a module;
- the source-refresh rule couples future RC dependency updates with subtree
  updates and pattern-note revalidation;
- guardrail approach is small and repository-native rather than a custom lint
  framework;
- normal repository checks remain green.

### A02 — Pure Result removal in core/shared value code

Status: `planned`

Scope candidates include pure Result usage under:

- `packages/core/**`;
- pure duration/reference/parsing helpers consumed across packages;
- other shared deterministic utilities identified by repository search.

Goal:

Remove neverthrow from pure domain/value code without making pure functions
Effectful. Use direct values, domain ADTs, Effect `Either`, or `Option` only
where they improve semantics.

Key review question:

Did any deterministic reducer/parser become Effect-returning merely for
uniformity? If yes, rework.

### A03 — Runtime error and API vocabulary

Status: `planned`

Scope candidates:

- `packages/runtime/src/admission/**`;
- `packages/runtime/src/evaluation/**`;
- runtime configuration/artifact/workspace/run use-case boundaries;
- runtime service types consumed by scheduler/daemon/execution code.

Goal:

Freeze final Effect-v4-compatible success/error contracts before lifecycle
work. Separate domain outcomes from expected effect errors, interruption, and
defects.

Avoid implementing scheduler concurrency in this package.

### A04 — ACP and agent error/API vocabulary

Status: `planned`

Scope candidates:

- `packages/acp/**`;
- `packages/agent-executor/**` or equivalent agent execution package paths on
  the branch;
- runtime agent-session-facing service contracts.

Goal:

Freeze final session/process/transport failure taxonomy and native v4 service
contracts so Pass B/C agents do not invent local translations or v3
compatibility layers.

### A05 — Peripheral neverthrow removal

Status: `planned`

Scope candidates identified by repository search include:

- CLI input/import/catalog/daemon client boundaries;
- web server/client transport boundaries;
- workflow compiler module/preflight/worker boundaries;
- tasks and DSH host boundaries.

Goal:

Remove neverthrow from areas that do not need deep lifecycle redesign and
prevent downstream public surfaces from forcing compatibility adapters.

Parallelism:

Can run in parallel across unrelated packages once any shared result/error
contract from A02-A04 is frozen.

## Pass B: Platform and service boundaries

### B01 — RuntimeStore Effect boundary

Status: `planned`

Primary scope:

- current runtime SQLite store open/close/transaction capability;
- store-facing runtime service contract;
- store error translation and test Layer/fake boundary.

Goal:

Expose stable RuntimeStore capabilities as Effect operations while preserving
current `node:sqlite` behavior, synchronous transaction semantics,
`BEGIN IMMEDIATE` usage, WAL behavior, event append/projection rules, owner
epoch/fencing, and idempotency.

Explicitly out of scope:

- Effect SQL adoption;
- schema redesign;
- changing transaction boundaries;
- making synchronous SQLite magically asynchronous.

### B02 — Process and AbortSignal adapter boundary

Status: `planned`

Primary scope:

- child-process spawn/exit/signal/stream adapter;
- centralized interruption <-> AbortSignal integration;
- process handle abstraction required by runtime/agent/hook consumers.

Goal:

Make application code stop owning raw Node process event plumbing and
AbortController lifecycle while preserving process-group and termination
semantics.

This package is a prerequisite for C01-C04.

Any use of a v4 unstable process module requires explicit approval in this work
package; RC status alone does not make unstable modules a default choice.

Before B02 is marked ready, Master should commission/review the scoped-process
pattern note using the matching vendored Effect source, including whether stable
core adapters or `effect/unstable/process` give the smallest correct boundary.

### B03 — ACP SDK/transport adapter boundary

Status: `planned`

Primary scope:

- ACP SDK Promise/callback integration;
- connection/session transport adaptation;
- reverse-RPC external request cancellation bridge.

Goal:

Confine Promise and AbortSignal mechanics required by the ACP SDK to adapter
leaves and present Effect-native capabilities to Acpus session code.

Any unstable v4 RPC/socket module considered here must be justified against the
simpler stable/core adapter approach before adoption.

### B04 — Composition roots and configuration baseline

Status: `planned`

Primary scope:

- workspace/runtime/daemon executable composition boundaries;
- Layer assembly conventions;
- configuration/environment services only where genuinely effectful.

Goal:

Freeze where Layers are provided and where Effect runtime execution is allowed
so later agents do not create local Layer graphs or runtime escape hatches.
Use the native pinned v4 runtime/Layer model rather than emulating removed v3
runtime abstractions.

Before B04 is marked ready, Master should commission/review the
service-and-layer pattern note from vendored v4 source and `LLMS.md`.

## Pass C: Lifecycle kernel

### C01 — Hooks lifecycle

Status: `planned`

Primary scope candidates:

- `packages/runtime/src/hooks/runner.ts`;
- hook process timeout/termination paths;
- hook runtime ownership and related tests.

Why first:

It is a bounded subprocess lifecycle and a good proof of the B02 process
adapter, Scope finalization, Clock-based grace periods, and best-effort error
handling.

Required semantics:

- existing hook output/error contract;
- timeout policy;
- SIGTERM/SIGKILL escalation;
- non-authoritative hook failures remain explicitly non-fatal where currently
  intended.

### C02 — Process capsule lifecycle

Status: `planned`

Primary scope:

- agent process capsule;
- ownership manifest/process group lifecycle;
- active turn and process monitoring;
- cooperative close and forced termination.

Goal:

Replace manual process/timer/listener/close state machines with scoped Effect
ownership while preserving exact process ownership and kill policy.

This is deliberately separate from C04 supervisor policy so one package can
prove the resource boundary before the supervisor owns many instances.

### C03 — ACP session and reverse-RPC lifecycle

Status: `planned`

Primary scope candidates:

- `packages/acp/src/session.ts`;
- `packages/acp/src/reverse-rpc.ts`;
- terminal lifecycle and pending permission/wait operations.

Goal:

Model an ACP session as a Scope-owned resource whose child connection,
process, active turn, pending operations, and terminals cannot outlive it.

Required semantics:

- session open/resume/load/new behavior;
- reverse RPC permission/path/filesystem policy;
- terminal output/release/kill behavior;
- cleanup does not erase primary errors;
- interruption does not invent durable cancellation.

### C04 — Agent supervisor and session ownership

Status: `planned`

Primary scope:

- session supervisor;
- session registry/leases;
- active turn ownership;
- neutralize/drain/shutdown behavior.

Goal:

Make supervisor/session ownership structural via Scope/Fiber relationships
rather than mutable Promise registries while preserving lease/ownership policy.

Depends on C02 and C03 target boundaries.

Before C04/D02, Master should have a reviewed fiber-supervision pattern note
covering the pinned v4 forking/supervision/keep-alive semantics.

### C05 — Workspace and daemon lifecycle

Status: `planned`

Primary scope candidates:

- workspace runtime construction/shutdown;
- daemon loop/tick/heartbeat;
- runtime authority lease ownership;
- top-level hook/agent/scheduler resource composition.

Goal:

Make the Workspace Scope the composition/lifetime root. Workspace shutdown
must structurally interrupt/release its owned runtime tree rather than execute a
second manual cleanup graph.

Preserve authority acquisition/release and daemon observable behavior.

## Pass D: Scheduler execution runtime

### D01 — Scheduler wakeup and mutation serialization

Status: `planned`

Primary scope candidates:

- scheduler wakeup helper;
- daemon/runtime mutation queue;
- tests covering ordering/wakeup behavior.

Goal:

Replace hand-written Promise resolver/tail mechanisms with v4 primitives
matching the actual semantics (typically Deferred/Queue/single consumer
ownership after verifying the pinned API).

This package must not alter durable scheduler events or reducer transitions.

Before D01 is ready, Master should commission/review a deferred-queue pattern
note that explicitly covers lost-wakeup semantics rather than merely listing
APIs.

### D02 — Active execution ownership

Status: `planned`

Primary scope:

- active scheduler executions;
- execution settlement;
- attempt Fiber lifetime;
- relation between local execution and durable attempt identity.

Goal:

Make active process-local attempts Scope/Fiber-owned without treating the Fiber
registry as authoritative state.

Critical race review:

- owner loss while execution is active;
- interruption before/after durable outcome commit;
- process completion concurrent with control/cancellation;
- cleanup failure after primary execution failure.

### D03 — Scheduler concurrency, timing, and heartbeat

Status: `planned`

Primary scope:

- max process-local concurrency;
- attempt deadlines/timeouts;
- execution/owner heartbeat timing;
- repeating scheduler work.

Goal:

Use the pinned v4 Semaphore/Clock/Schedule/scoped-Fiber APIs as appropriate while
retaining scheduler admission and durable retry semantics.

Tests should become deterministic with controlled time where possible.

Before D03 is ready, Master should commission/review clock-and-timeout and
Effect-testing notes if they do not already exist.

### D04 — Scheduler shutdown and control interruption integration

Status: `planned`

Primary scope:

- pause/resume/cancel/steer interactions with active Fibers;
- scheduler stop/shutdown settlement;
- workspace Scope integration.

Goal:

Finish the execution runtime so controls explicitly bridge durable state
transitions and process-local interruption rather than conflating them.

Required existing evidence includes control, fencing, idempotency, retry,
scheduler runner, task concurrency/process, and shutdown integration tests.

## Pass E: Repository convergence

### E01 — CLI/web/tasks/compiler final surface convergence

Status: `planned`

Primary scope:

- remaining public/internal Result/Promise adapters;
- public JS boundaries where running an Effect is intentionally allowed;
- workflow authoring surfaces that should stay plain TypeScript.

Goal:

Remove transitional API residue without leaking Effect requirements into pure
workflow authoring unnecessarily.

### E02 — Cleanup and final architecture review

Status: `planned`

Primary scope:

- all package manifests and lockfile;
- obsolete helpers;
- duplicate errors/services/Layers;
- migration-only code;
- v3 compatibility aliases/helpers if any escaped earlier review;
- Effect version/import coherence;
- vendored-source/dependency coherence;
- final static quality gates;
- repository-wide verification.

Required final searches:

- no `neverthrow`;
- no `ResultAsync`;
- no Effect v3/beta/snapshot dependencies;
- no unapproved `effect/unstable/*` imports;
- no import from `repos/effect`;
- no unreviewed runtime-level Promise/Abort/timer orchestration;
- no Effect runtime escape hatches below approved entry points;
- no unreviewed detached Fibers;
- no hidden second durable scheduler implemented with Effect primitives.

Final verification includes `pnpm test` and `pnpm typecheck` plus every
additional check required by the actual changed surfaces.

## Master scheduling guidance

Before marking a work package `ready`, create a concrete package from
`docs/effect-migration/execution-packet-template.md` containing exact files,
contracts, ownership, error taxonomy, invariants, dependencies, checks, active
Effect v4 RC baseline, vendored Effect commit, and upstream/pattern references.

Do not hand an execution agent a vague task such as "Effectify scheduler".
Every task should leave one architectural boundary complete and final.

Prefer sequential work for shared ownership state machines and parallel work
for independent leaves after their interfaces are frozen.

Do not upgrade the Effect RC or vendored subtree while parallel agents are
implementing against the previous pinned API. RC/source upgrades are
coordinating/Master-agent work and create a new frozen baseline before fan-out
resumes.

## Migration completion

When all work packages are `done`:

1. perform the final architecture review in
   `docs/effect-migration/review-and-quality-gates.md`;
2. verify ADR-0001 still accurately describes the implemented boundaries;
3. verify the repository is coherent on the intended Effect v4 release line,
   the vendored reference source matches it, and no v3 compatibility
   architecture remains;
4. move any lasting implementation contract into the appropriate owning spec
   or maintenance guide;
5. delete this roadmap and other purely transitional planning records according
   to the roadmap documentation convention.
