# Target Boundaries and Dependency Topology

This document freezes the intended dependency direction before implementation
agents redesign shared interfaces. It is a migration contract; concrete method
signatures are frozen in the relevant work package after inspecting callers.

## Dependency direction

```text
workflow authoring / CLI / web
          |
          v
application use cases / runtime orchestration
          |
          v
Acpus capability services
          |
          v
platform / SDK / persistence adapters
```

Pure domain code is consumed by application code but does not depend on the
Effect runtime or platform adapters.

## Core boundaries

### Pure domain

Includes canonical IR, scheduler events/types, transition reducers, control and
retry planning, materialization and deterministic normalization.

May depend on other pure packages. Must not depend on RuntimeStore, Process,
ACP transport, Layer, Scope, Fiber or Node lifecycle APIs.

### Runtime application

Owns workspace lifecycle, daemon behavior, scheduler execution, run sessions,
control coordination and hook orchestration.

May depend on pure domain + capability services. Must not depend directly on
SQLite statements, raw child-process event plumbing or ACP SDK Promise details.

### RuntimeStore capability

Owns Acpus persistence operations needed by application code. The service
surface follows consumer capabilities such as claim/heartbeat/release authority,
load snapshots, append events, start/commit attempts and admission/read
operations.

The implementation may use synchronous `node:sqlite`; callers do not own SQL
transaction mechanics.

**Forbidden direction:** store implementation importing scheduler runtime
orchestration to decide when Fibers run.

### Process capability

Owns raw Node process creation, process identity/liveness, event/callback
adaptation, signalling and platform termination mechanics required by Acpus.

Application code owns policy such as cooperative close and grace/force
escalation. The adapter owns how to perform the platform operation.

**Forbidden direction:** process adapter appending scheduler events or deciding
workflow cancellation.

### ACP boundary

ACP SDK/transport adapter owns SDK Promise/callback/AbortSignal mechanics.
ACP session application code owns session semantics and Scope lifetime.
Agent supervisor owns session selection/lease policy, not transport details.

**Forbidden direction:** ACP transport knowing run projection/fencing or
committing scheduler state.

### Agent executor

Consumes process + ACP/session capabilities and exposes agent execution/session
capabilities to runtime. It may understand Acpus agent/session ownership but not
become the durable scheduler.

### Composition root

Workspace/process entrypoints construct Layers and run the Effect runtime.
Deep application functions request services; they do not build mini Layer
graphs repeatedly.

## Target relationship map

```text
WorkspaceRuntime
  -> RuntimeStore
  -> RunExecution/Scheduler application
  -> AgentSessionSupervisor
  -> HookRunner

Scheduler execution
  -> RuntimeStore
  -> NodeExecutor
  -> Effect Clock/concurrency

NodeExecutor(agent)
  -> AgentSessionSupervisor

AgentSessionSupervisor
  -> ProcessCapsule / AcpSession capability
  -> Process capability

AcpSession
  -> ACP SDK/transport adapter
  -> Process capability where process ownership is in this boundary
  -> filesystem capability only where genuinely external

RuntimeStoreLive
  -> node:sqlite + runtime locks/layout
```

The exact split between ProcessCapsule and AcpSession process ownership is
frozen in B02/B03/C02/C03 work packages; agents must not independently create
overlapping process abstractions.

## Interface-freeze protocol

Before B01-B04 or any downstream fan-out, the master records for each shared
service:

```text
Service name:
Consumers:
Operations:
Success values:
Typed errors:
Scope requirement:
Interruption behavior:
Durable/transaction guarantees:
Adapter implementation owner:
Test replacement strategy:
Explicit non-operations:
```

No two parallel agents may independently redesign the same shared service.

## Forbidden dependency shortcuts

Reject implementations that introduce any of these merely to reduce local diff:

- scheduler -> raw SQLite;
- scheduler -> raw child_process;
- store -> scheduler Fiber registry;
- process adapter -> durable event append;
- ACP transport -> RuntimeStore;
- pure reducer -> Effect service;
- deep use case -> local `Effect.provide` graph;
- public workflow DSL -> runtime Layer requirements;
- Effect Workflow -> replacement durable scheduler;
- Effect SQL -> replacement persistence semantics in this migration.

## Public boundary rule

Plain-JavaScript/TypeScript surfaces may intentionally run/provide an Effect at
the outer boundary. That does not justify preserving `ResultAsync` internally.
Workflow authoring remains plain TypeScript where exposing Effect requirements
would not improve the author contract.
