# M10D — interpreter 拆成 engine/state_machine/effects

Status: Completed on 2026-06-26.

Execution note: completed as a conservative boundary-preparation slice. Added pure event-folding state-machine APIs, explicit runtime effect/runner traits, and a thin `RuntimeEngine` orchestration wrapper while preserving the existing interpreter execution path. Full interpreter file decomposition into `agent/program/composite/control` submodules remains a follow-up gap because doing that safely requires smaller mechanical slices with repeated runtime validation.

## 目标

把大体量 interpreter 拆成 Rust-first runtime：纯 state machine、effect planning、effect execution、engine orchestration。

## 允许修改

```text
crates/acpus-runtime/**
crates/acpus-store/**
crates/acpus-runtime-api/**
crates/acpus-testkit/**
fixtures/**
```

## Codex 指令

```text
执行 M10D。将 runtime interpreter 拆成 engine/state_machine/effects/interpreter 子模块。
保持功能行为不变，先搬代码再重构逻辑。
每个子步骤都跑 runtime tests；不要一次性改完整个 interpreter。
```

## 推荐子 PR

### M10D-1：抽纯 state machine

新增：

```text
crates/acpus-runtime/src/state_machine.rs
```

目标 API：

```rust
pub fn apply_event(state: RunState, event: &RunEvent) -> Result<RunState, StateError>;
pub fn derive_state(events: &[RunEvent]) -> Result<RunState, StateError>;
```

测试：

```text
node_succeeded_advances_state
pause_prevents_new_scheduling
cancel_terminal_state_is_stable
failed_node_marks_run_failed
```

### M10D-2：抽 effects

新增：

```text
crates/acpus-runtime/src/effects.rs
```

目标：把外部副作用表达成 enum：

```rust
pub enum RuntimeEffect {
    RunAgent(...),
    RunProgram(...),
    AwaitSignal(...),
    ExecuteHook(...),
}
```

### M10D-3：抽 runners traits

```rust
pub trait AgentRunner { ... }
pub trait ProgramRunner { ... }
pub trait Clock { ... }
pub trait IdGenerator { ... }
```

测试使用 fake clock/fake id/mock agent。

### M10D-4：engine orchestration

新增：

```text
crates/acpus-runtime/src/engine.rs
```

负责：

```text
load state -> plan effects -> append scheduled event -> execute effect -> append result event
```

### M10D-5：整理 interpreter 子模块

```text
interpreter/
  mod.rs
  step.rs
  agent.rs
  program.rs
  composite.rs
  control.rs
```

只在通过测试后删除旧大文件逻辑。

## 必须覆盖的 runtime integration

```text
basic workflow succeeded
agent retry succeeds after failure
program json output captured
pause/resume
cancel
signal wait/continue
fork from completed node
replay uses frozen IR even if YAML changed
resume after process restart
```

## 必须通过

每个子 PR：

```bash
cargo test -p acpus-runtime
cargo test --workspace
cargo fmt --all -- --check
```

最终：

```bash
cargo test -p acpus-runtime --tests
cargo test --workspace
```

## 验收标准

- interpreter 不再是单个巨型文件承载所有语义。
- state machine 可以纯函数测试。
- side effects 可以 mock。
- replay/resume/fork 有 integration tests。

## 禁止事项

- 不要在没有测试的情况下改调度语义。
- 不要让 state machine 执行 shell/agent/network。
- 不要让 engine 直接操作 HTTP/TUI。
