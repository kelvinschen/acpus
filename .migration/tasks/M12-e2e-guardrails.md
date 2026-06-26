# M12 — E2E 主链路护栏

Status: Completed on 2026-06-26.

Execution note: added a focused CLI-driven E2E target using temp workspaces, local program-only workflow fixtures, runtime-api JSON parsing, dynamic supervisor ports, and replay after YAML mutation. The tests avoid real network services and real AI agents.

## 目标

补齐从 workflow YAML 到 terminal run state 的薄 E2E，确保完整迁移后主路径仍可用。

## 允许修改

```text
tests/e2e/**
crates/acpus-testkit/**
crates/acpus-runtime/**
crates/acpus-supervisor/**
crates/acpus-cli/**
fixtures/workflows/e2e/**
Cargo.toml
package.json
justfile
```

## Codex 指令

```text
执行 M12。新增少量高价值 E2E，不追求覆盖所有细节。
E2E 要使用 testkit 和 mock agent，避免依赖真实外部网络/真实 AI agent。
```

## E2E 场景

最少三条：

```text
1. basic_run: workflow YAML -> start run -> terminal completed
2. cli_to_supervisor: start supervisor -> CLI query run -> JSON contract parse
3. replay_frozen_ir: start run -> 修改 YAML -> replay -> 仍使用 frozen IR
```

可选：

```text
tui_smoke: fake supervisor endpoint -> TUI model 能渲染 run state
```

## 命令

新增 just target：

```make
e2e:
    cargo test --test e2e --workspace
```

或根据实际 test layout 调整。

## 必须通过

```bash
cargo test --workspace
just e2e
pnpm --filter @acpus/tui test
```

## 验收标准

- E2E 不依赖互联网。
- E2E 不调用真实 agent。
- E2E 数量少但覆盖完整链路。

## 禁止事项

- 不要把大量单元语义塞进 E2E。
- 不要让 E2E 脆弱依赖固定端口；使用 `127.0.0.1:0`。
