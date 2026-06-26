# M05 — TUI 改为消费 generated bindings

Status: Completed on 2026-06-26.

## 目标

消除 TUI 中手写的 Rust runtime/domain facade，让 TUI 只拥有 client 和展示派生逻辑。

## 允许修改

```text
packages/tui/**
packages/bindings/**
package.json
pnpm-workspace.yaml
justfile
```

## Codex 指令

```text
执行 M05。把 packages/tui 中重复声明的 RunState/NodeExecutionState/AcpusIr 等 domain 类型改为从 @acpus/bindings 导入。
保留 parseNodeKey、HTTP client、view model 等 TUI 自有逻辑。
不要改 Rust runtime 行为。
完成后跑 TUI typecheck 和 tests。
```

## 重点文件

当前重点通常是：

```text
packages/tui/src/acpus.ts
packages/tui/src/model.ts
packages/tui/test/contract/**
packages/tui/package.json
```

## 改造规则

### 1. 删除或替换本地 domain 类型

以下类型不应继续由 TUI 手写维护：

```text
AcpusIr
IrNode
IrBranch
IrNodeKind
RunState
RunSummary
RunStatus
NodeState
NodeExecutionState
SupervisorHealth
ReplayResult
RunCleanResult
ForkPlan
AgentOverrides
AgentOverrideWarning
```

改成：

```ts
import type {
  AcpusIr,
  IrNode,
  RunState,
  NodeExecutionState,
  SupervisorHealth,
} from "@acpus/bindings";

export type { AcpusIr, IrNode, RunState, NodeExecutionState, SupervisorHealth } from "@acpus/bindings";
```

### 2. 保留 TUI 自有逻辑

这些可以保留在 TUI：

```text
parseNodeKey
RunSupervisorClient
poller
view-model transformation
render tree builder
keyboard handling
terminal components
```

### 3. 添加 contract test

新增：

```text
packages/tui/test/contract/generated-bindings.test.ts
```

测试内容：

- 构造一个 `AcpusIr`。
- 构造一个 `RunState`。
- 调用 TUI view model，例如 `buildRenderTree` / `countByState`。
- 证明 generated type 能进入 TUI 展示层。

## 必须通过

```bash
just bindings
pnpm --filter @acpus/tui typecheck
pnpm --filter @acpus/tui test
pnpm -r typecheck
```

## 验收标准

- TUI 不再定义 runtime/domain truth。
- TUI 只保留展示和 client 行为。
- Contract test 覆盖 generated bindings -> TUI view model。

## 禁止事项

- 不要把 Rust 语义搬到 TS。
- 不要为了通过 typecheck 把大量字段改成 `any`。
- 不要修改 runtime JSON shape，除非 M04 contract 同步更新。
