set shell := ["bash", "--noprofile", "--norc", "-eu", "-o", "pipefail", "-c"]
set positional-arguments

default:
    just ci

acpus *args:
    cargo build -p acpus-cli --bin acpus
    @./target/debug/acpus "$@"

fmt:
    cargo fmt --all

fmt-check:
    cargo fmt --all -- --check

clippy:
    cargo clippy --workspace --all-targets -- -D warnings

test-rs:
    if command -v cargo-nextest >/dev/null 2>&1; then cargo nextest run --workspace --no-fail-fast; else cargo test --workspace; fi

test-ts:
    pnpm -r test

e2e:
    cargo test -p acpus-cli --test e2e

typecheck:
    pnpm -r typecheck

bindings:
    cargo run -p acpus-runtime-api --bin export-ts-bindings
    cargo run -p acpus-supervisor --bin export-openapi
    pnpm --filter @acpus/bindings generate:openapi
    pnpm --filter @acpus/bindings build

bindings-check:
    just bindings
    git diff --exit-code packages/bindings/src/generated

boundary-check:
    @check_absent() { \
        pkg="$1"; \
        pattern="$2"; \
        if cargo tree -p "$pkg" --edges normal | grep -E "$pattern"; then \
            echo "boundary violation: $pkg matched $pattern" >&2; \
            exit 1; \
        fi; \
    }; \
    check_absent acpus-spec 'acpus-runtime v'; \
    check_absent acpus-ir 'acpus-core v|acpus-runtime v'; \
    check_absent acpus-compiler 'acpus-runtime v'; \
    check_absent acpus-runtime 'axum v|reqwest v|clap v'; \
    check_absent acpus-runtime 'acpus-supervisor v'; \
    check_absent acpus-store 'acpus-runtime v|acpus-supervisor v'

ci:
    just fmt-check
    just clippy
    just bindings-check
    just boundary-check
    just test-rs
    just typecheck
    just test-ts
    just e2e

clean:
    cargo clean
    rm -rf packages/*/dist
