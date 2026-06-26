# M13 Handoff — Remove Shims and Enforce Boundaries

Status: Completed on 2026-06-26.

## Completed Work

- Added `just boundary-check`.
- Wired `just boundary-check` into `just ci`.
- Enforced crate-boundary checks for:
  - `acpus-spec` not depending on `acpus-runtime`.
  - `acpus-ir` not depending on `acpus-core` or `acpus-runtime`.
  - `acpus-compiler` not depending on `acpus-runtime`.
  - `acpus-runtime` not depending on `axum`, `reqwest`, `clap`, or `acpus-supervisor`.
  - `acpus-store` not depending on `acpus-runtime` or `acpus-supervisor`.
- Updated `docs/refactor/migration-matrix.md` with completed statuses and a boundary guardrail section.
- Confirmed generated runtime API bindings remain stable.

## Validation Summary

- `just boundary-check` passed.
- `just bindings-check` passed.
- `just ci` passed.

## Gaps

- `acpus-core` remains in the workspace as a transitional compatibility crate. It is no longer the owner of spec, IR, expression, compiler, store, runtime API, or supervisor transport concerns, but it still exposes agent override and hook helpers used by runtime/store/supervisor.
- The boundary check intentionally guards direct ownership regressions rather than banning every future compatibility reference to `acpus-core`, because removing that crate requires a separate public API migration.
- TUI still has a local supervisor client implementation in `packages/tui/src/acpus.ts`, but its domain types come from `@acpus/bindings`.

## Suggested Next Step

Proceed to M14 and finalize CI hardening. In particular, decide whether `just ci` should also run `just bindings-check` and whether final CI should keep `just e2e` as part of the default path.
