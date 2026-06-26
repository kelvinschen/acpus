# M10B — runtime store 实现迁入 `acpus-store`

Status: Completed on 2026-06-26.

Execution note: completed as a conservative ownership extraction. The durable `.acpus/state` filesystem implementation and persisted run/node DTOs now live in `acpus-store`; `acpus-runtime` re-exports `acpus_store::FsRunStore` as `RunStore` to preserve the existing interpreter/supervisor call sites. A full generic `RunStore` trait seam for the runtime engine remains deferred because the current runtime still relies on concrete filesystem-only methods such as artifact path resolution and supervisor metadata paths.

## 目标

把 durable state 文件读写从 `acpus-runtime` 迁到 `acpus-store`，runtime 只依赖 `RunStore` trait。

## 允许修改

```text
crates/acpus-store/**
crates/acpus-runtime/**
crates/acpus-testkit/**
Cargo.toml
```

## Codex 指令

```text
执行 M10B。把 acpus-runtime 中的 store/file persistence 实现迁入 acpus-store，并让 runtime 通过 RunStore trait 读写。
保持现有 .acpus/state 兼容。不要重写 interpreter 调度逻辑。
```

## 操作步骤

1. 搜索现有 store：

```bash
rg "\.acpus/state|store|snapshot|events|run_dir|state" crates/acpus-runtime/src
```

2. 将纯文件读写与 state persistence 移动到 `acpus-store`。
3. runtime 引入 trait dependency：

```rust
pub struct RuntimeEngine<S: RunStore> { store: S, ... }
```

如果当前代码不适合泛型，过渡可使用 `Arc<dyn RunStore>`。

4. 添加旧格式读取/迁移测试，如果当前 state 格式不同，先做 compatibility loader。

## 测试要求

新增 runtime/store integration：

```text
create_run_persists_snapshot
resume_loads_existing_run
replay_uses_frozen_ir_not_yaml
corrupt_store_returns_typed_error
```

## 必须通过

```bash
cargo test -p acpus-store
cargo test -p acpus-runtime
cargo test --workspace
cargo fmt --all -- --check
```

## 验收标准

- runtime 不再直接拼 `.acpus/state` 文件格式，除非通过 `acpus-store`。
- store 文件格式兼容旧 run。
- replay/resume 测试通过。

## 禁止事项

- 不要换 SQLite。
- 不要让 supervisor/CLI/TUI 直接读写 store。
- 不要删除旧 state 兼容逻辑。
