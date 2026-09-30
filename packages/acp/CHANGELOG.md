# @acpus/acp

## 0.2.1

### Patch Changes

- 748a358: Update the ACP SDK to 1.5.1 and built-in Pi, Codex, Claude, and Mux adapter ranges to their latest releases. Launch Mux directly through its renamed `@coder/xum` package and allow unattended first-time installation of Pi. The updated Pi adapter requires a host-provided Pi runtime of at least 0.80.4.

  Upgrade the DeepSeek Harness integration to the 0.1.5-rc.2 release train and its current browser runtime APIs.

## 0.2.0

### Minor Changes

- 525ef0d: Complete the workspace-wide Effect v4 migration with typed failures, Scope-owned resources, structured concurrency, deterministic time, and explicit Promise adapters. Add `@acpus/owned-process` as the shared child-process ownership and recovery boundary, and expose scoped ACP transport and cancellation capabilities.
- 289cb45: Replace acpx with the Acpus-owned stable ACP v1 runtime, including named Agent shell-command configuration, durable Agent Session checkpoints, generic Session-aware Retry, Interrupt & Continue Steer, SessionSupervisor process ownership, delta event transport, structured Session bindings, readable local identities, and natural-language-only CLI presentation.

### Patch Changes

- Updated dependencies [525ef0d]
  - @acpus/owned-process@0.2.0
