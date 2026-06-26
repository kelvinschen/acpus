# M08 — `acpus-testkit` 与 integration harness

Status: Completed on 2026-06-26.

## 目标

建立后续 runtime/supervisor/CLI/E2E 测试共用的 test harness，避免每个测试复制 temp workspace、fixture、mock agent 启动逻辑。

## 允许修改

```text
crates/acpus-testkit/**
fixtures/**
Cargo.toml
```

后续如果需要让某 crate 的 dev-dependencies 引入 `acpus-testkit`，允许修改对应 `Cargo.toml`。

## Codex 指令

```text
执行 M08。实现 acpus-testkit 的 TestWorkspace、fixture loader、JSON writer、command helper skeleton。
不要改 runtime 业务逻辑；只准备测试工具。
```

## API 建议

```rust
pub struct TestWorkspace { temp: TempDir }

impl TestWorkspace {
    pub fn new() -> anyhow::Result<Self>;
    pub fn root(&self) -> &Path;
    pub fn acpus_dir(&self) -> PathBuf;
    pub fn write_workflow(&self, name: &str, source: &str) -> anyhow::Result<PathBuf>;
    pub fn write_json(&self, path: &str, value: &serde_json::Value) -> anyhow::Result<PathBuf>;
    pub fn fixture(name: &str) -> anyhow::Result<String>;
}
```

后续可扩展：

```rust
pub struct SupervisorHarness { ... }
pub struct MockAgentHarness { ... }
pub fn run_acpus_cli(args: &[&str]) -> assert_cmd::assert::Assert;
```

## 必须通过

```bash
cargo test -p acpus-testkit
cargo check --workspace
cargo fmt --all -- --check
```

## 验收标准

- testkit 不依赖 production runtime internals。
- fixture path 解析稳定。
- 后续 crate 可以把它作为 dev-dependency 使用。

## 禁止事项

- 不要在 testkit 里启动真实外部服务，除非明确作为 harness。
- 不要把 test-only API 暴露到 production crates。
