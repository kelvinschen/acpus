# M09A — source diagnostics/source resolver 迁入 `acpus-spec`

Status: Completed on 2026-06-26.

## 目标

把 source-level 概念从 `acpus-core` 迁到 `acpus-spec`，同时保留 `acpus-core` re-export 兼容。

## 允许修改

```text
crates/acpus-spec/**
crates/acpus-core/**
crates/acpus-compiler/**
Cargo.toml
```

## Codex 指令

```text
执行 M09A。把 Diagnostic、DiagnosticSeverity、SourceResolver、source digest、source location/parse source 相关代码迁入 acpus-spec。
acpus-core 保留 pub use 兼容，不要破坏现有 import。
不要移动 IR、CEL、runtime 代码。
```

## 操作步骤

1. 搜索当前定义：

```bash
rg "struct Diagnostic|enum DiagnosticSeverity|SourceResolver|ResolvedSource|source_digest" crates/acpus-core crates/acpus-runtime crates/acpus-cli
```

2. 把 source-level 类型迁入 `acpus-spec`。
3. 在 `acpus-core` 中改为：

```rust
pub use acpus_spec::{Diagnostic, DiagnosticSeverity, SourceResolver, ...};
```

4. 修复 imports。
5. 确保 `acpus-spec` 不依赖 `acpus-core`。

## 测试要求

`acpus-spec` 增加单测：

```text
parse_minimal_workflow
missing_version_diagnostic
missing_workflow_steps_diagnostic
source_digest_is_stable
filesystem_resolver_reads_relative_include
```

## 必须通过

```bash
cargo test -p acpus-spec
cargo test -p acpus-core
cargo test -p acpus-compiler
cargo test --workspace
cargo fmt --all -- --check
```

## 验收标准

- `cargo tree -p acpus-spec` 不出现 `acpus-core`。
- 原来从 `acpus_core::Diagnostic` 引用的代码仍可编译。
- compiler golden snapshots 不发生非预期变化。

## 禁止事项

- 不要迁移 IR。
- 不要迁移 compiler lowering。
- 不要改 runtime 行为。
