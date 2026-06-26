# M07 — `acpus-supervisor` typed client/API boundary

Status: Completed on 2026-06-26.

## 目标

把 supervisor transport 的类型边界独立出来。先实现 typed client，Axum server 迁移放到 M10C。

## 允许修改

```text
crates/acpus-supervisor/**
crates/acpus-runtime-api/**
Cargo.toml
```

## Codex 指令

```text
执行 M07。实现 acpus-supervisor 的 typed SupervisorClient，并全部使用 acpus-runtime-api 中的类型。
不要移动现有 Axum routes；server 迁移在 M10C。
```

## Client API 建议

```rust
pub struct SupervisorClient { endpoint: String, http: reqwest::Client }

impl SupervisorClient {
    pub fn new(endpoint: impl Into<String>) -> Self;
    pub async fn health(&self) -> Result<SupervisorHealth, SupervisorClientError>;
    pub async fn list_runs(&self) -> Result<Vec<RunSummary>, SupervisorClientError>;
    pub async fn get_run(&self, run_id: &RunId) -> Result<RunState, SupervisorClientError>;
    pub async fn get_ir(&self, run_id: &RunId) -> Result<AcpusIr, SupervisorClientError>;
    pub async fn signal(&self, run_id: &RunId, request: &SignalRequest) -> Result<RunState, SupervisorClientError>;
    pub async fn replay(&self, run_id: &RunId) -> Result<ReplayResult, SupervisorClientError>;
    pub async fn fork(&self, run_id: &RunId, request: &ForkRequest) -> Result<serde_json::Value, SupervisorClientError>;
}
```

## Error shape

```rust
pub enum SupervisorClientError {
    Transport(reqwest::Error),
    Json(serde_json::Error),
    Http { status: StatusCode, body: String },
}
```

## 必须通过

```bash
cargo test -p acpus-supervisor
cargo check --workspace
cargo fmt --all -- --check
```

## 验收标准

- Client 不暴露 raw `serde_json::Value`，除非某 endpoint 仍没有稳定 contract。
- 所有 request/response 类型来自 `acpus-runtime-api`。
- `acpus-supervisor` 暂不依赖 `acpus-runtime`，除非 M10C 开始 server 迁移。

## 禁止事项

- 不要改 TUI client。
- 不要改 CLI command 行为。
- 不要移动 Axum server。
