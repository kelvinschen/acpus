# M09C Handoff — Expression Ownership in `acpus-expr`

Status: Completed on 2026-06-26.

## Completed Work

- Moved production CEL evaluation, template rendering, expression caches, helper functions, and scoped expression validation from `acpus-core` into `acpus-expr`.
- Added `acpus-expr` dependencies on `acpus-ir` and `acpus-spec` for IR and diagnostics, without depending on core/runtime/compiler.
- Kept `acpus-core` compatibility re-exports for `EvalContext`, `EvalError`, `eval_cel`, `render_template`, `ScopedValidationInput`, and `validate_scoped_expressions`.
- Added direct `acpus-expr` dependencies to compiler/runtime crates and updated runtime eval/render imports to use `acpus-expr`.
- Added expression tests covering scalar template rendering, unknown references, CEL booleans, CEL path access, invalid CEL typed errors, loop rewrite behavior, helpers, cache behavior, and structured template compatibility.

## Validation Summary

- `cargo test -p acpus-expr` passed.
- `cargo test -p acpus-compiler` passed, including compiler golden snapshots.
- `cargo test -p acpus-runtime` passed.
- `cargo test --workspace` passed.
- `cargo fmt --all -- --check` passed.
- `cargo tree -p acpus-expr` did not include `acpus-core`, `acpus-runtime`, or `acpus-compiler`.

## Gaps

- The task sketch mentioned `non_scalar_template_returns_error`, but current runtime behavior intentionally renders structured values with JavaScript-compatible stringification. This was preserved to avoid changing CLI/runtime behavior.
- Compiler lowering still lives in `acpus-core`; it now uses the expression validator through the core compatibility facade.
- `acpus-ir` and `acpus-expr` both depend on `cel`; later cleanup could decide whether workflow-reference detection should move out of IR hashing.

## Suggested Next Step

Proceed to M09D by moving compiler facade/ownership into `acpus-compiler`, leaving `acpus-core` as a compatibility layer.

## Suggested Skills

- `codebase-design` is useful for separating compiler lowering ownership from the remaining core compatibility facade.
