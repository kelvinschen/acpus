# Owned Process

- Status: approved
- Effect version: `4.0.0-rc.111`
- Sources: `Effect.ts`, `Scope.ts`, `Stream.ts`, `unstable/process/*`

`@acpus/owned-process` is the shared capability for child processes Acpus owns.
It is not a generic process library.

The official unstable process module demonstrates useful Scope, exit, and
stream semantics, but does not cover Acpus Node IPC, complete signal exits,
process groups, arbitrary PID recovery, or Linux start-token fencing. Adding it
as a second backend would not remove the local capability.

## Boundary

Application packages receive `ProcessHost` and Scope-owned `OwnedProcess`
values, never raw `ChildProcess`. `ProcessHost` owns spawn events, output and
IPC adaptation, signalling, liveness, and process identity probes. Its Node
implementation may adopt an official Effect platform module later only if one
lifecycle owner remains.

The low-level process finalizer is orphan prevention. Finalizers acquired later
by Hook, Task, Capsule, or ACP code run first and own semantic policy such as
cooperative close, TERM grace, KILL escalation, and persisted cleanup evidence.

## Required semantics

- Spawn failure before readiness is a typed `OwnedProcessError` and leaks no
  partially created child.
- Successful spawn registers its Scope finalizer before returning the handle.
- Exit, post-spawn error, and interruption settle once.
- Signalling an already-dead target succeeds; other platform failures remain
  typed.
- Process identity retains `live`, `dead`, and `unverified`; unknown evidence is
  never promoted to proven death.
- Callback handlers resume Effects and never execute an application Runtime.
- Cooperative/grace/force ordering remains application policy, not
  `ProcessHost` policy.

Keep real integration evidence for spawn, streams, IPC, exit status, Scope
cleanup, process groups, identity tokens, and external AbortSignal listener
cleanup.
