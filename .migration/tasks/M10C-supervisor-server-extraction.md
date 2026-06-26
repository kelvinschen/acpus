# M10C — Axum routes 迁入 `acpus-supervisor`

Status: Completed on 2026-06-26.

Execution note: completed as a module ownership move. The existing Axum supervisor server/routes and route tests moved from `acpus-runtime` into `acpus-supervisor/src/server.rs`; the existing reqwest client moved into `acpus-supervisor/src/client.rs`. `acpus-runtime` no longer depends on `axum` or `reqwest` in its normal dependency tree. The route tests remain colocated with the moved server module instead of being split into new `tests/api_runs.rs` and `tests/api_errors.rs` files.

## 目标

把 HTTP/SSE transport 从 `acpus-runtime` 拆到 `acpus-supervisor`。runtime 只保留 run semantics。

## 允许修改

```text
crates/acpus-supervisor/**
crates/acpus-runtime/**
crates/acpus-cli/**
crates/acpus-runtime-api/**
Cargo.toml
```

## Codex 指令

```text
执行 M10C。把 acpus-runtime 中的 Axum routes/server/SSE/client transport 迁入 acpus-supervisor。
acpus-runtime 不应再依赖 axum/reqwest。
CLI 若需要 supervisor，改用 acpus-supervisor。
不要拆 interpreter。
```

## 操作步骤

1. 找 transport 代码：

```bash
rg "axum|Router|route\(|Sse|Event|reqwest|Supervisor" crates/acpus-runtime/src crates/acpus-cli/src
```

2. 移动到：

```text
crates/acpus-supervisor/src/routes.rs
crates/acpus-supervisor/src/server.rs
crates/acpus-supervisor/src/client.rs
crates/acpus-supervisor/src/sse.rs
```

3. `acpus-runtime` 暴露 runtime service/engine trait 给 supervisor 调用。
4. `acpus-cli` 使用 supervisor crate 启动 server 或创建 client。

## API 测试

新增：

```text
crates/acpus-supervisor/tests/api_runs.rs
crates/acpus-supervisor/tests/api_errors.rs
```

覆盖：

```text
GET /health
GET /runs
GET /runs/:id
POST /runs/:id/signal
404 error shape
```

## 必须通过

```bash
cargo test -p acpus-supervisor
cargo test -p acpus-runtime
cargo test -p acpus-cli
cargo tree -p acpus-runtime --edges normal | grep -E 'axum|reqwest' && exit 1 || true
cargo test --workspace
```

## 验收标准

- `acpus-runtime` normal dependencies 不再含 `axum`/`reqwest`。
- `acpus-supervisor` 拥有 server/client/routes。
- CLI 行为不变。

## 禁止事项

- 不要改变 endpoint path，除非同时更新 contract tests。
- 不要让 TUI 直接依赖 Rust crate。
