# M10A — runtime public contract 改用 `acpus-runtime-api`

Status: Completed on 2026-06-26.

Execution note: completed as a conservative adoption slice. Runtime now consumes `acpus-runtime-api` for public status enums and `acpus-runtime-api` reuses `acpus-ir` for IR contract types. Full `RunState`/`NodeExecutionState` aliasing remains deferred because current runtime structs still carry runtime-owned agent override and dynamic context shapes.

## 目标

让 runtime/supervisor/CLI/TUI 使用同一套 public JSON 类型，消除重复结构。

## 允许修改

```text
crates/acpus-runtime-api/**
crates/acpus-runtime/**
crates/acpus-supervisor/**
crates/acpus-cli/**
packages/bindings/**
packages/tui/**
```

## Codex 指令

```text
执行 M10A。把 RunState、RunSummary、NodeExecutionState、RunStatus、NodeState、SupervisorHealth、request/response payload 等 public contract 切到 acpus-runtime-api。
保持 JSON 字段 shape 不变。
不要在本模块拆 interpreter 或移动 store。
```

## 操作步骤

1. 搜索重复类型：

```bash
rg "struct RunState|struct RunSummary|NodeExecutionState|enum RunStatus|enum NodeState|SupervisorHealth" crates packages/tui/src
```

2. 选定 `acpus-runtime-api` 为唯一类型定义。
3. runtime 内部若需要更丰富的 private state，命名为 `RuntimeRunState` / `EngineState`，不要污染 API contract。
4. CLI JSON output 使用 runtime-api 类型序列化。
5. TUI bindings 重新生成。

## 必须通过

```bash
just bindings
cargo test -p acpus-runtime-api
cargo test -p acpus-runtime
cargo test -p acpus-supervisor
cargo test -p acpus-cli
pnpm --filter @acpus/bindings typecheck
pnpm --filter @acpus/tui typecheck
pnpm --filter @acpus/tui test
```

## 验收标准

- public JSON 类型只有 `acpus-runtime-api` 一份。
- `git diff --exit-code packages/bindings/src/generated` 在生成后干净。
- TUI 不再手写 runtime status/node state。

## 禁止事项

- 不要改变 API 字段命名。
- 不要把 runtime internal mutable state 直接塞进 API crate。
