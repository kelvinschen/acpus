# Resource Ownership Registry

This registry states the intended lifetime owner for runtime resources. Agents
must validate it against concrete code before a lifecycle work package and
report any necessary correction to the master.

## Target ownership tree

```text
Process / executable lifetime
└─ Workspace Scope
   ├─ RuntimeStore resource
   │  └─ shared runtime lock / SQLite handles owned by store finalizer
   ├─ RuntimeAuthority resource
   │  └─ authority heartbeat Fiber
   ├─ Scheduler / run execution resources
   │  └─ Run execution Scope
   │     └─ Attempt Fiber(s)
   │        └─ executor-owned external operation/process bridge
   ├─ AgentSessionSupervisor Scope
   │  └─ Session Scope(s)
   │     ├─ ProcessCapsule / ACP worker process
   │     ├─ ACP connection/session
   │     ├─ active turn Fiber
   │     └─ terminal/pending-operation child resources
   └─ Hook runtime
      └─ Hook invocation Scope
         └─ hook child process
```

Some current components may combine levels. Migration should establish the
semantic ownership without creating gratuitous wrapper classes solely to match
the diagram.

## Ownership records

### OWN-001 Workspace Scope

Acquires: runtime store, authority claim, supervisor, sessions/hooks/scheduler
composition, repeating heartbeat/tick work.

Finalizes: stop accepting new work; interrupt/settle owned runtime Fibers;
release agent/hook resources; release authority; close store/lock.

Must not rely on: `closePromise`, active heartbeat/tick Promise fields or
unstructured `void close().catch(...)` as the ownership model.

Public `close` may remain as an operation that closes this owned lifetime.

### OWN-002 RuntimeStore

Owner: Workspace Scope or narrower read-session Scope.

Acquisition includes store/lock readiness required by the existing contract.
Finalizer closes handles and releases the owned lock. Transaction operations
remain atomic according to current store semantics.

### OWN-003 Runtime authority heartbeat

Owner: Workspace Scope / authority resource.

On authority loss it signals/interrupts the owning runtime according to policy;
it does not itself become the authority source of truth. Store authority state
is authoritative.

### OWN-004 Run execution

Owner: Workspace scheduler/runtime.

A run execution may own multiple attempt Fibers. Run-local Fiber state is
reconstructable/disposable; durable run state remains in store/projection.

### OWN-005 Attempt Fiber

Owner: Run execution Scope.

Created only after durable attempt start. Interruption stops local execution but
does not by itself commit cancellation. Completion result is local until fenced
commit.

### OWN-006 AgentSessionSupervisor

Owner: Workspace Scope.

Owns live session Scopes and the policy/registry necessary to route turns.
Shutdown structurally closes/interupts sessions rather than draining a second
Promise ownership graph.

### OWN-007 Agent/ACP Session Scope

Owner: AgentSessionSupervisor.

Owns worker/process capsule, ACP connection/session, active turn and child
terminal/pending resources. Session resources cannot outlive the session unless
a concrete persisted/process-recovery protocol explicitly says otherwise.

### OWN-008 ProcessCapsule

Owner: Session Scope.

Acquisition establishes worker process identity and ownership manifest before
normal use. Finalization follows existing cooperative-close/process-tree cleanup
policy and finishes ownership evidence. Manifest/process-group semantics are not
replaced by Scope; Scope guarantees local lifetime execution of the policy.

### OWN-009 Active turn

Owner: Session Scope, normally a narrower turn child Fiber.

External AbortSignal is an adapter concern. Turn deadline/inactivity timers
become Effect time. A pending turn is settled/interrupted when its session
closes according to existing semantics.

### OWN-010 Reverse-RPC terminal/pending operations

Owner: ACP Session Scope, with narrower child scopes when the resource has its
own release operation.

File handles, terminal child processes and pending permissions must be released
when the session closes. No orphan terminal survives session finalization.

### OWN-011 Hook invocation

Owner: Hook runtime / invocation Scope.

Child process is finalized under success/failure/interruption. Existing
SIGTERM/grace/SIGKILL behavior remains explicit policy.

## Ownership questions every lifecycle WP must answer

```text
What is acquired?
Who owns it?
Can it escape the owner Scope? Why?
What happens on normal completion?
What happens on typed failure?
What happens on interruption?
What happens when finalization itself fails?
Which durable state survives after the Scope is gone?
Which current manual registries become deletable?
```

If an agent cannot answer these before coding, the work package is not ready.
