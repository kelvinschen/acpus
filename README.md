# Acpus Rust Port

Acpus is a local durable runner for AI-first workflows. This repository is the Rust port of Acpus: the core compiler, runtime, CLI, and mock agent are implemented in Rust, while the terminal UI remains the copied Ink project under `packages/tui`.

## Layout

| Path | Purpose |
| --- | --- |
| `crates/acpus-core` | Workflow Spec parsing, validation, CEL evaluation, IR compilation, schema helpers, hashing. |
| `crates/acpus-runtime` | Durable local Run store, interpreter, hooks, fork/retry/replay control, Axum supervisor API. |
| `crates/acpus-cli` | `acpus` command line interface. |
| `crates/acpus-mock-agent` | Pure Rust ACP-compatible mock agent for tests and local workflows. |
| `packages/tui` | Ink-based TUI copied into this monoproject. |
| `.acpus/workflows` | Project workflow catalog. |
| `specs` | Current Acpus design truth. |

## Toolchain

The Rust toolchain is pinned in `rust-toolchain.toml`.

```sh
rustc --version
cargo --version
pnpm --version
```

This workspace expects Node 22+ and pnpm 9.x for the TUI package.

## Build

```sh
pnpm install
pnpm build
```

`pnpm build` builds the Rust workspace in release mode and then builds `@acpus/tui`.

Rust-only build:

```sh
cargo build --workspace --release
```

The release CLI is written to:

```sh
./target/release/acpus
```

During development, run the CLI through pnpm:

```sh
pnpm acpus --version
pnpm acpus workflows list
```

This uses `cargo run -p acpus-cli`, so source changes are rebuilt automatically. To use the already-built release binary through pnpm:

```sh
pnpm acpus:release workflows list
```

Use `--silent` when piping JSON output:

```sh
pnpm --silent acpus workflows list --json
pnpm --silent acpus:release workflows list --json
```

## Test

```sh
pnpm typecheck
pnpm test
```

Rust-only checks:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Workflow catalog check:

```sh
pnpm acpus workflows list
```

## Local Usage

List catalog workflows:

```sh
pnpm acpus workflows list
```

Inspect a workflow:

```sh
pnpm acpus workflows show project:codebase-deep-research
```

Lint and dry-run a workflow:

```sh
pnpm acpus workflows lint .acpus/workflows/goal-driven-development.workflow.spec.yaml
pnpm acpus workflows run .acpus/workflows/goal-driven-development.workflow.spec.yaml --dry-run
```

Run control:

```sh
pnpm acpus runs list
pnpm acpus runs show <runId>
pnpm acpus runs pause <runId>
pnpm acpus runs resume <runId>
pnpm acpus runs retry <runId>
pnpm acpus runs signal <runId> --node <nodeKey> --payload '{"approved":true}'
```

Visualizer:

```sh
pnpm acpus runs visualize
```

## Specs

Current behavior is specified in `specs/`:

- [Specs Index](specs/INDEX.md)
- [Workflow Spec](specs/workflow-spec.md)
- [CLI Spec](specs/cli-spec.md)
- [Local Runtime Target Spec](specs/local-runtime-target-spec.md)
- [Workflow Catalog Spec](specs/workflow-catalog-spec.md)
- [Hooks Spec](specs/hooks-spec.md)
- [Schema Spec](specs/schema-spec.md)
- [Mock Agent Spec](specs/mock-agent-spec.md)
- [Build Toolchain Spec](specs/build-toolchain-spec.md)

## Notes

- Workflow expressions use the Rust `cel` crate.
- The supervisor HTTP API is implemented with Axum.
- Runtime state is written under `.acpus/state/` and intentionally ignored by git.
- Catalog workflows under `.acpus/workflows/` are project assets and should stay versioned.
