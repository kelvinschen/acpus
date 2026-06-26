# M02 — 新 Rust crate 空壳与 workspace 接入

Status: Completed on 2026-06-26.

## 目标

创建 Rust-first 架构的 crate 边界，但暂不迁移复杂实现。所有新 crate 必须能独立编译，并尽量不影响旧行为。

## 允许修改

```text
Cargo.toml
crates/acpus-spec/**
crates/acpus-ir/**
crates/acpus-expr/**
crates/acpus-compiler/**
crates/acpus-runtime-api/**
crates/acpus-store/**
crates/acpus-supervisor/**
crates/acpus-testkit/**
crates/acpus-core/Cargo.toml
crates/acpus-runtime/Cargo.toml
crates/acpus-cli/Cargo.toml
```

## Codex 指令

```text
执行 M02。创建新 crates 的最小可编译骨架，并更新 Cargo workspace。
不要迁移 acpus-core/acpus-runtime 的内部实现。
若新增 crate 需要引用旧行为，只做 compatibility facade，不移动复杂代码。
完成后 cargo check/test 必须通过。
```

## 目标 crate

```text
acpus-spec          source AST、diagnostics、source resolver
acpus-ir            stable IR、IR digest、schedule summary
acpus-expr          expression/template API boundary
acpus-compiler      compiler facade；初期可 delegate 到 acpus-core
acpus-runtime-api   JSON contract types；先可放最小类型
acpus-store         RunStore trait；先可空实现或简单 FS 实现
acpus-supervisor    typed client/API boundary；先可只定义 client struct
acpus-testkit       TestWorkspace 等测试工具
```

## 实施顺序

### 1. 先创建目录与最小 manifest

每个 crate 都要有：

```text
Cargo.toml
src/lib.rs
```

`Cargo.toml` 使用 workspace package 字段。

### 2. 更新 root `Cargo.toml`

加入 workspace members 和 workspace dependencies。

注意：新增 member 前必须保证目录已存在，否则 `cargo metadata` 会失败。

### 3. 最小 API 要求

#### `acpus-spec`

至少包含：

```rust
pub enum DiagnosticSeverity { Error, Warning }
pub struct Diagnostic { severity, code, message, path }
pub struct WorkflowDocument { version, name, description, source, raw }
pub trait SourceResolver { ... }
pub fn parse_workflow_yaml(...) -> Result<WorkflowDocument, Vec<Diagnostic>>
```

#### `acpus-ir`

至少包含：

```rust
pub struct AcpusIr { ... }
pub struct IrNode { ... }
pub enum IrNodeKind { Pipeline, RunAgent, RunProgram, ... }
pub fn ir_digest(ir: &AcpusIr) -> Result<String, IrHashError>
```

#### `acpus-expr`

至少包含：

```rust
pub struct EvalScope;
pub fn render_template(template: &str, scope: &EvalScope) -> Result<String, ExprError>;
```

#### `acpus-compiler`

初期允许：

```rust
pub use acpus_core::{compile_workflow, compile_workflow_path, lint_workflow};
```

并提供 `compile_snapshot` 用于后续 golden tests。

#### `acpus-runtime-api`

先定义跨进程/跨语言的最小 contract：

```rust
RunId, NodeKey, RunStatus, NodeState, RunState, RunSummary, NodeExecutionState, SupervisorHealth, ApiErrorBody
```

#### `acpus-store`

至少包含：

```rust
pub trait RunStore { ... }
```

#### `acpus-supervisor`

至少包含：

```rust
pub struct SupervisorClient { ... }
```

#### `acpus-testkit`

至少包含：

```rust
pub struct TestWorkspace { ... }
```

## 必须通过

```bash
cargo metadata --format-version=1 >/dev/null
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
```

## 验收标准

- 新 crate 均在 workspace 中。
- 新 crate 均可编译。
- 旧 CLI/runtime/core 行为未迁移、未破坏。
- 依赖方向初步合理：`spec/ir/expr` 不依赖 runtime/cli/supervisor。

## 禁止事项

- 不要拆 `interpreter.rs`。
- 不要移动 store/supervisor 真实实现。
- 不要改 TUI。
