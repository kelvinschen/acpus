# Runtime Boundaries

- Status: approved
- Effect version: `4.0.0-rc.111`
- Sources: `NodeRuntime.ts`, `Effect.ts`, `Stream.ts`, `Layer.ts`

Use this note only when adding or reviewing an executable or plain-JavaScript
adapter.

## Executable roots

Long-lived daemon and worker processes hand one fully provided Effect to
`NodeRuntime.runMain`. Application services below them return Effects and never
call a Runtime execution API.

The interactive `acpus` entry uses one top-level `Effect.runPromise` because its
commands own first-SIGINT detach behavior. It installs no competing root signal
handler.

An explicit Commander, Hono, Cordis/Typert, Task-author, or worker adapter may
execute one fully composed Effect when its public API must return a Promise.
Keep every such file in the architecture boundary allowlist.

## Streaming and platform leaves

An Effect-facing multi-value operation exposes a typed-error `Stream`. Convert
it with `Stream.toAsyncIterable` only at the JavaScript method that must return
`AsyncIterable`; iterator return closes that adapter-owned Scope. Callback
sources register and remove listeners in one scoped Stream acquisition.

Detached daemon spawn deliberately uses native Node `detached` plus `unref`
because the child must outlive the CLI Scope. The daemon immediately re-enters
the normal Effect process root.

A filesystem lock may keep a small Promise polling driver, but application code
receives a scoped acquisition. Lock, authoritative recheck, Store open, and
finalizer registration form one atomic ownership operation.

## Reject

- Runtime execution inside an Effect service;
- an async generator that runs Effects item by item;
- manual root signal and `process.exit` handling beside `NodeRuntime`;
- opening a handle before its finalizer can own it;
- detached Fibers used to avoid a proper owner.
