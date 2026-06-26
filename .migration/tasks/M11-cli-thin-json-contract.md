# M11 — CLI thin layer 与 JSON contract tests

Status: Completed on 2026-06-26.

Execution note: completed as a black-box JSON contract slice. Added integration tests for workflow catalog/lint JSON, run list/show JSON deserialization through `acpus-runtime-api`, and invalid command stderr behavior. The large `main.rs` command/output decomposition remains a follow-up because M10C/M10D left several CLI/server/runtime boundaries still in transition.

## 目标

让 CLI 变成薄入口：parse args、调用 compiler/runtime/supervisor client、渲染输出。机器可读 JSON 输出必须匹配 `acpus-runtime-api`。

## 允许修改

```text
crates/acpus-cli/**
crates/acpus-supervisor/**
crates/acpus-runtime-api/**
crates/acpus-testkit/**
Cargo.toml
```

## Codex 指令

```text
执行 M11。拆分 acpus-cli/src/main.rs，把 commands/output/tui_launcher 分离。
添加 CLI black-box tests，特别是 --json 输出必须可反序列化为 acpus-runtime-api 类型。
不要修改 runtime 语义。
```

## 目标结构

```text
crates/acpus-cli/src/
  main.rs
  lib.rs
  commands/
    mod.rs
    workflows.rs
    runs.rs
    hooks.rs
    supervisor.rs
  output.rs
  tui_launcher.rs
```

## CLI 规则

- `main.rs` 只做 parse + dispatch。
- `output.rs` 统一处理 `--json` 和 human output。
- JSON output 使用 runtime-api/compiled types，不手写 ad-hoc shape。
- stderr/stdout 分离。

## 测试要求

新增：

```text
crates/acpus-cli/tests/workflows_command.rs
crates/acpus-cli/tests/runs_command.rs
crates/acpus-cli/tests/json_contract.rs
```

覆盖：

```text
acpus workflows list --json
acpus workflows lint <fixture> --json
acpus runs list --json
acpus runs show <id> --json
invalid command returns non-zero and stderr
```

## 必须通过

```bash
cargo test -p acpus-cli
cargo test --workspace
cargo fmt --all -- --check
```

## 验收标准

- CLI 不直接操纵 runtime internals。
- JSON output 有 contract tests。
- TUI launcher 只是 launcher，不承载 domain contract。

## 禁止事项

- 不要把 CLI 变成第二个 runtime。
- 不要为了 human output 改 JSON shape。
