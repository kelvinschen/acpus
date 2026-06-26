# M09B — IR/hash/schedule 迁入 `acpus-ir`

Status: Completed on 2026-06-26.

## 目标

把 compiled IR、node model、IR digest、schedule summary 迁入 `acpus-ir`。这是 compiler/runtime 之间最关键的边界。

## 允许修改

```text
crates/acpus-ir/**
crates/acpus-core/**
crates/acpus-compiler/**
crates/acpus-runtime/**
crates/acpus-runtime-api/**
Cargo.toml
```

## Codex 指令

```text
执行 M09B。把 AcpusIr、IrNode、IrNodeKind、IrBranch、NodeKeyTemplate、AgentSpec、ScheduleSummary、IR hash/digest 相关代码迁入 acpus-ir。
acpus-core 保留 pub use 兼容。
不要迁移 expression、runtime state machine、supervisor。
完成后 compiler snapshots 必须稳定；若 snapshot 变化，只接受字段顺序/derive 引起的可解释变化。
```

## 操作步骤

1. 搜索 IR 类型：

```bash
rg "AcpusIr|IrNode|IrNodeKind|NodeKeyTemplate|ScheduleSummary|ir_digest|digest" crates/acpus-core crates/acpus-runtime crates/acpus-cli
```

2. 将类型与纯函数搬到 `acpus-ir`。
3. `acpus-core` 改为 re-export：

```rust
pub use acpus_ir::{AcpusIr, IrNode, IrNodeKind, ...};
```

4. `acpus-compiler` 直接依赖 `acpus-ir`。
5. `acpus-runtime` 逐步改为引用 `acpus-ir`，但保留旧路径兼容。

## 重要约束

- `acpus-ir` 不得依赖 `acpus-core`。
- `acpus-ir` 不得依赖 `acpus-runtime`。
- IR serialization 必须 deterministic。优先使用 `BTreeMap` 而非 `HashMap` 存放会序列化的 map。

## 测试要求

`acpus-ir` 增加：

```text
ir_digest_is_stable
serialize_deserialize_roundtrip
node_path_string_is_stable
schedule_summary_snapshot
```

## 必须通过

```bash
cargo test -p acpus-ir
cargo test -p acpus-compiler
cargo test -p acpus-runtime
cargo test --workspace
cargo fmt --all -- --check
```

如果有 snapshots：

```bash
cargo insta test -p acpus-compiler
```

## 验收标准

- `cargo tree -p acpus-ir` 不出现 `acpus-core`、`acpus-runtime`。
- compiler golden snapshots 可解释且稳定。
- runtime 编译通过。

## 禁止事项

- 不要修改 workflow spec 语义。
- 不要在 IR crate 引入 Axum/Reqwest/Clap。
