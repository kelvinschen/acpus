# R1 — Runtime 原语缺口收尾

> 状态：已完成并归档（2026-06）。本文为历史 roadmap 记录，不代表当前实现真相；当前行为以 `specs/workflow-spec.md` 与 `specs/local-runtime-target-spec.md` 为准。
> 完成证据：8 类缺口全部实现，`pnpm -r build` 通过、`pnpm -s test` 256 测试全绿；spec 已同步更新。
> 对应 PRD Milestone 2 与 3 的残留缺口。这是后续里程碑的前置。

## 背景

M2（本地 durable interpreter）与 M3（Program Activity）在代码中大体落地，但若干 `specs/workflow-spec.md` 与 `specs/local-runtime-target-spec.md` 已声明的行为在运行时缺失或与 spec 相悖。这些缺口集中在 Composite Node 的完成语义、Program Step 的 artifact / 退出码契约、以及自动 retry。它们会放大 R2 真实 agent 场景的不确定性，因此先收尾。

## 目标

让 interpreter 与 Program Executor 的运行时行为对齐已声明的 spec 契约：Composite Node 的等待与成功判定、Program Step 的 artifact 捕获与退出码暴露、Agent/Program 失败的自动 retry，以及 subworkflow 的真实执行。

## 缺口清单

### Program Step（M3 核心承诺）
- stdout / stderr 未落地为 artifact。interpreter 已构造 `ArtifactStore`（`packages/runtime/src/interpreter.ts:39`），但 `executeProgram`（`interpreter.ts:326`）从不调用 `.write()`，program 产出零 artifact。`specs/workflow-spec.md:48` 与 `specs/local-runtime-target-spec.md:67-68` 期望暴露 stdout/stderr artifact 引用。
- `steps.<id>.exit_code` 未暴露。`ProgramExecutor` 返回 `exitCode`（`packages/runtime/src/executors/program.ts:81`），但 `executeProgram`（`interpreter.ts:339`）丢弃它，node 输出不携带 `exit_code`。对应 `specs/workflow-spec.md:47`。
- 非零退出码被当硬失败。`program.ts:50-56` 对任意非零退出返回 error，interpreter 据此抛出使 node `failed`，与 `specs/workflow-spec.md:49`「非零退出应作为 step data，除非运行时契约显式标记不可恢复」相悖。`packages/runtime/test/e2e/program-timeout.test.ts` 与 `test/interpreter/program.test.ts` 当前固化了这一错误行为，需一并修订。
- `capture.from: file` 未实现。`program.ts:64` 无论 `from` 为何都读 stdout，忽略 `capture.path`，对应 `specs/workflow-spec.md:44-46`。

### Composite Node 完成语义（M2）
- fanout `quorum` 与 `success_criteria.min_success` 运行时被忽略。`interpreter.ts:408-413` 只处理 `race` / `all`，`quorum` 落入 `all`，`min_success` 从不读取。编译器已校验这些字段（`packages/core/src/compiler.ts:376-390`），但运行时未消费。对应 `specs/workflow-spec.md:61-65`。
- parallel `join: race` 被忽略。`executeParallel`（`interpreter.ts:343-366`）总是 `Promise.all` 所有分支，`join` 元数据未使用。对应 `specs/workflow-spec.md:56`。
- subworkflow 为 no-op。`executeSubworkflow` 返回 `{}`（`interpreter.ts:513-516`），且编译期未解析其引用路径（`compiler.ts:316-322` 仅做字符串类型检查）。对应 `specs/workflow-spec.md:73-74`。

### 控制语义（M2）
- approval 输出缺字段。当前返回 `{approved, timedOut}` 或 `{approved:true}`（`interpreter.ts:487-509`），缺 `specs/workflow-spec.md:82` 要求的 `decision` 与 `at`。`on_timeout: escalate` / `reject` 无独立运行时语义。
- 无自动 retry。`node.metadata.retry` 被编译但运行时从不读取；`retryNode`（`interpreter.ts:171-193`）只是手动控制操作。`specs/workflow-spec.md:34` 期望 agent parse/schema 失败在剩余尝试内作为续跑 retry。

## 验收信号

- Program Step 运行后，node 状态携带 `exit_code`，且 stdout/stderr 可经 `artifact://runs/<runId>/nodes/<nodeKey>/...` 引用访问；非零退出在未标记不可恢复时作为 step data 向下游表达式可见。
- `capture.from: file` 能从 `capture.path` 读取并按 `parse` 解析。
- fanout 在 `quorum` 等待策略 + `min_success` 成功判定下产生正确整体结果；parallel `race` 以首个完成分支为结果。
- subworkflow 真实执行被引用的 Workflow Spec 并被 await。
- approval 输出包含 `approved` / `decision` / `at`，`on_timeout` 各分支行为可区分。
- agent/program parse 或 schema 失败在剩余 retry 次数内自动续跑。
- 上述行为各有对应测试；过时的「非零退出即失败」测试同步修订。spec 若需随实现更新，同步修订 `specs/workflow-spec.md` 与 `specs/local-runtime-target-spec.md`。

## 关联

- PRD Milestone：M2、M3。
- 后续依赖：R2 的 partial transcript artifact 路径依赖本里程碑打通的 artifact 写入与自动 retry。
- 约束：artifact 写入归 runtime，不得渗入 `@acpus/core`（ADR 0001）。
