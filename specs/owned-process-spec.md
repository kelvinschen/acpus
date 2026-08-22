# Owned Process Capability Spec

## Purpose

`@acpus/owned-process` owns child processes started or recovered by Acpus. It
confines spawn, stream, IPC, signal, liveness, and process-identity mechanics
beneath an Effect-native, Scope-owned interface. Hook, Task, Agent Executor,
compiler, and ACP packages retain their application policies and consume this
interface.

## Requirements

- `ProcessHost.spawn` MUST require `Scope`, register one fallback finalizer
  before returning, and MUST NOT expose Node `ChildProcess` or event emitters.
- Spawn failure before readiness MUST use the typed `OwnedProcessError` channel.
  Successful spawn MUST expose one typed close/exit Effect, single-consumer
  stdout/stderr and IPC streams, standard Web stdin where requested, and typed
  IPC send.
- Node exit, error, interruption, and finalization races MUST settle each
  adapter resource once. Scope interruption after raw spawn MUST NOT orphan the
  owned child.
- Process targeting MUST preserve the distinction between a PID and an owned
  process group. POSIX groups and Windows `taskkill` are adapter mechanics.
- Signalling an already-dead target MUST succeed. Liveness MUST preserve
  `live`, `dead`, and `unverified`; the adapter MUST NOT promote unknown
  evidence to proven death.
- Linux process-start tokens MAY be returned for ownership fencing. Absence or
  unsupported platforms MUST remain `undefined`, not an invented identity.
- `captureProcessIdentity`, `probeProcessTarget`, and `probeProcessIdentity`
  MUST expose the same liveness and start-token evidence used by `ProcessHost`;
  callers MUST NOT duplicate raw PID or `/proc` probing.
- Node APIs and official Effect platform modules are implementation choices.
  They MUST preserve this interface's exit, IPC, targeting, identity, and Scope
  semantics and MUST NOT create a second lifecycle backend in one composition.
- The module MUST NOT own Hook/Task/capsule/ACP grace periods, protocol close,
  RuntimeStore commits, manifests, or scheduler policy.

## Verification

- `pnpm --filter @acpus/owned-process typecheck`: verifies the public Effect
  interface and Node implementation types.
- `pnpm exec vitest run packages/owned-process/test`: verifies spawn, stream, IPC,
  Scope cleanup, signal/liveness, and process-identity evidence.
- `pnpm check`: verifies dependency direction, implementation independence,
  public package/toolchain registration, and dead-code policy.
