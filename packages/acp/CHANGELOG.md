# @acpus/acp

## 0.2.0

### Minor Changes

- 525ef0d: Complete the workspace-wide Effect v4 migration with typed failures, Scope-owned resources, structured concurrency, deterministic time, and explicit Promise adapters. Add `@acpus/owned-process` as the shared child-process ownership and recovery boundary, and expose scoped ACP transport and cancellation capabilities.
- 289cb45: Replace acpx with the Acpus-owned stable ACP v1 runtime, including named Agent shell-command configuration, durable Agent Session checkpoints, generic Session-aware Retry, Interrupt & Continue Steer, SessionSupervisor process ownership, delta event transport, structured Session bindings, readable local identities, and natural-language-only CLI presentation.

### Patch Changes

- Updated dependencies [525ef0d]
  - @acpus/owned-process@0.2.0
