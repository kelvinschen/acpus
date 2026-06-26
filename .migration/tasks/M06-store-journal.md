# M06 — `acpus-store` journal/snapshot trait

Status: Completed on 2026-06-26.

## 目标

建立 durable run state 的独立边界。先完成 trait、FS journal、snapshot 和单测；runtime 接入放到 M10B。

## 允许修改

```text
crates/acpus-store/**
crates/acpus-runtime-api/**
Cargo.toml
```

## Codex 指令

```text
执行 M06。实现 acpus-store 的 RunStore trait、FsRunStore、events.jsonl append-only journal、snapshot.json 原子写入和单元测试。
不要修改 acpus-runtime 的真实 store 使用路径；runtime 接入在 M10B。
```

## 设计要求

目录格式：

```text
.acpus/state/
  runs/
    <run-id>/
      events.jsonl
      snapshot.json
      ir.json        # 可在后续模块加入
      artifacts/
```

Trait：

```rust
pub trait RunStore: Send + Sync {
    fn append_event(&self, run_id: &RunId, event: &RunEvent) -> Result<(), StoreError>;
    fn load_events(&self, run_id: &RunId) -> Result<Vec<RunEvent>, StoreError>;
    fn save_snapshot(&self, run_id: &RunId, snapshot: &RunState) -> Result<(), StoreError>;
    fn load_snapshot(&self, run_id: &RunId) -> Result<Option<RunState>, StoreError>;
}
```

## 测试要求

至少覆盖：

```text
append_and_load_events
save_and_load_snapshot
missing_events_returns_empty
corrupt_event_reports_line_number
snapshot_write_is_atomic_enough
```

## 必须通过

```bash
cargo test -p acpus-store
cargo fmt --all -- --check
cargo check --workspace
```

## 验收标准

- `acpus-store` 不依赖 `acpus-runtime`。
- event journal 是 append-only。
- corrupt event 能报告具体 line。
- snapshot 写入使用 tmp + rename。

## 禁止事项

- 不要在本模块切换 runtime 生产路径。
- 不要引入 SQLite。
- 不要让 TUI/CLI 直接读写 store 文件。
