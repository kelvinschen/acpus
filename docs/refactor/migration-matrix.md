# Migration Matrix

Overall status: Completed through M15 on 2026-06-26.

| Area | Current Owner | Target Owner | First Guardrail | Migration Milestone | Status |
|---|---|---|---|---|---|
| Workflow source parsing | `acpus-core` | `acpus-spec` | Compiler golden fixtures | M09A | Completed |
| Diagnostics | `acpus-core` | `acpus-spec` | Invalid fixture snapshots | M09A | Completed |
| Source resolver/includes | `acpus-core` | `acpus-spec` | Include fixture snapshots | M09A | Completed |
| IR data shape | `acpus-core` | `acpus-ir` | Valid fixture IR snapshots | M09B | Completed |
| IR digest/schedule | `acpus-core` | `acpus-ir` | Schedule snapshots | M09B | Completed |
| Expression/template evaluation | `acpus-core` | `acpus-expr` | Expression fixture snapshots | M09C | Completed |
| Compiler facade/lowering | `acpus-core` | `acpus-compiler` | Compiler golden tests | M09D | Completed |
| Runtime JSON contract | `acpus-runtime` / CLI / TUI | `acpus-runtime-api` | Rust and TS contract tests | M04, M10A | Completed |
| Durable store | `acpus-runtime` | `acpus-store` | Store unit tests | M06, M10B | Completed |
| Supervisor transport | `acpus-runtime` | `acpus-supervisor` | Supervisor client/API tests | M07, M10C | Completed |
| Runtime TS bindings | Hand-written TS string | `ts-rs` generated Rust DTO bindings | `just bindings-check` | M15 | Completed |
| Supervisor TS client | TUI-local fetch client | `@acpus/bindings` OpenAPI-backed client | OpenAPI export and TUI contract tests | M15 | Completed |
| Integration harness | Ad hoc tests | `acpus-testkit` | Test workspace helpers | M08 | Completed |
| CLI orchestration | `acpus-cli` | thin CLI over crates | JSON black-box tests | M11 | Completed |
| TUI domain types | Hand-written TS facade | generated bindings | TUI contract tests | M05 | Completed |

## Boundary Guardrails

Status: Completed in M13.

`just boundary-check` is part of `just ci` and protects the Rust-first ownership graph:

- `acpus-spec` must not depend on `acpus-runtime`.
- `acpus-ir` must not depend on `acpus-core` or `acpus-runtime`.
- `acpus-compiler` must not depend on `acpus-runtime`.
- `acpus-runtime` must not depend on transport/CLI crates such as `axum`, `reqwest`, or `clap`.
- `acpus-runtime` must not depend on `acpus-supervisor`.
- `acpus-store` must not depend on `acpus-runtime` or `acpus-supervisor`.

Remaining transitional compatibility: `acpus-core` is still present as a re-export crate plus agent override and hook helpers used by runtime/store/supervisor. It should not regain ownership of spec, IR, expression, compiler, store, runtime API, or supervisor transport responsibilities.
