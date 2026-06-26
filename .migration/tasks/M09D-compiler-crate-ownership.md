# M09D — compiler lowering/validation 迁入 `acpus-compiler`

Status: Completed on 2026-06-26.

## 目标

让 `acpus-compiler` 真正拥有 source -> IR 的 lowering、include expansion、validation、schema validation，而不是继续 delegate 到 `acpus-core`。

## 允许修改

```text
crates/acpus-compiler/**
crates/acpus-core/**
crates/acpus-spec/**
crates/acpus-ir/**
crates/acpus-expr/**
crates/acpus-cli/**
Cargo.toml
```

## Codex 指令

```text
执行 M09D。把 compile_workflow、compile_workflow_path、lint_workflow、include expansion、validation、lowering、schema validation 从 acpus-core 迁入 acpus-compiler。
acpus-core 仅保留兼容 re-export/adapter。
不要修改 runtime interpreter 逻辑。
所有 compiler golden snapshots 必须通过。
```

## 目标模块结构

```text
crates/acpus-compiler/src/
  lib.rs
  compile.rs
  include.rs
  validate.rs
  lower.rs
  schema.rs
  catalog.rs
```

## Public API

保持旧 API 兼容，同时提供 Rust-first API：

```rust
pub struct CompileOptions { ... }
pub struct CompileOutput { pub ir: AcpusIr, pub diagnostics: Vec<Diagnostic>, pub schedule: ScheduleSummary }

pub fn compile_workflow(source: &str, options: CompileOptions) -> CompileResult;
pub fn compile_workflow_path(path: impl AsRef<Path>, options: CompileOptions) -> CompileResult;
pub fn lint_workflow(...);
```

`acpus-core` 中：

```rust
pub use acpus_compiler::{compile_workflow, compile_workflow_path, lint_workflow, CompileOptions, ...};
```

## 迁移步骤

1. 先移动纯 validation/schema/lower helper。
2. 再移动 include/source resolver glue。
3. 最后移动 public compile functions。
4. 每步都跑 `cargo test -p acpus-compiler`。
5. 保留旧路径 re-export，避免 CLI/runtime 一次性改爆。

## 必须通过

```bash
cargo test -p acpus-compiler
cargo insta test -p acpus-compiler
cargo test -p acpus-core
cargo test --workspace
cargo fmt --all -- --check
```

## 验收标准

- `acpus-compiler` 不依赖 `acpus-core`。
- `acpus-core` 可以依赖/转发 `acpus-compiler`。
- compiler golden snapshots 稳定。
- CLI 编译/lint command 行为不变。

## 禁止事项

- 不要引入 runtime dependency。
- 不要为了通过测试降低 strict validation。
- 不要删除旧 public API，直到 M13。
