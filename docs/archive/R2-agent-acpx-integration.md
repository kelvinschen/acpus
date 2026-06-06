# R2 — Agent Activity 经 acpx 真实集成

> 对应 PRD Milestone 4：Agent Activity through acpx，含 Mock Agent 的 load/resume/cancel 覆盖。

## 状态：已完成（核心目标达成）

R2 的核心承诺——Agent Step 经 acpx 真实驱动 ACP agent，并覆盖 Mock Agent 的 load/resume/cancel 场景——已落地。剩余多 agent 串接、组合节点内真实 agent、`type: builtin` 路径、acpx 缺失时的友好错误等属于边界扩展，转入 R4/backlog 继续收敛。

## 背景

Agent Step 的执行抽象（`ExecutorAdapter`、interpreter 注入点、daemon DI）已就位，Mock Agent 本体是合规的 ACP stdio server（支持 initialize/new/load/prompt/cancel、stream、hang、crash、sequence、deterministic ids）。R2 核心 agent 路径已实现并接线：

- `AgentExecutor`（`packages/runtime/src/executors/agent.ts`）支持完整生命周期：派生稳定 session 名 → `sessions ensure` → `prompt -s <session>` 首次执行；`resume` 标志下复用同一 session 并发送固定 `CONTINUATION_PROMPT` 续跑。
- 协作式中途取消：on abort 时通过 `acpx cancel -s <session>` 请求协作式取消，设 `DEFAULT_CANCEL_GRACE_MS`（5s）超时后 SIGKILL 兜底（`wireCooperativeCancel`）。
- 取消/暂停时写 partial transcript artifact：interpreter 在 `executeAgent` 中当 executor 返回 `result.partial` 时，通过 `NodeAbortedError` 携带 `artifactRefs` 和 `output`，`executeNode` 将其持久化到节点状态。
- 真实 executor 已接线：`daemon-runner.ts:32-33` 同时创建 `MockAgentExecutor` 和 `AgentExecutor`，interpreter 按 `agent.type === "mock"` 路由到 mock 或 acpx executor。
- 真实 e2e 已存在：`packages/runtime/test/e2e/agent-cancel-resume.test.ts` 经 acpx spawn 并驱动 Mock Agent，覆盖基本轮次、场景 #1（mid-turn cancel → partial transcript + paused）、#2（resume 同 session）、#3（dead 子进程 crash → retry → acpx reload/resume）。

### 后续边界扩展

以下缺口不阻塞 R2 完成，已转入 R4/backlog：

- **多 Agent 步骤串接**：当前 E2E 仅测单 agent 步骤；多 agent 步骤场景下 acpx 多 session 管理（session 名不冲突、输出不串）未覆盖。
- **组合节点中的真实 agent**：fanout 每条 lane 调 agent、loop 里每轮调 agent——这些组合节点内的 agent 调用链未被真实 E2E 覆盖。
- **`type: builtin` 路径**：E2E 仅测 `type: command`（acpx `--agent` 模式），`type: builtin`（acpx 内置 adapter，如 `use: claude`）路径未覆盖。
- **acpx 缺失时的 graceful handling**：`AgentExecutor.resolveInvoker()` 在 acpx 不可 resolve 时抛异常，无 graceful degradation 或用户友好错误。
- **Daemon 模式真实 agent 链**：E2E 测的是 interpreter 直调；daemon HTTP API → interpreter → acpx → Mock Agent 这条更长链未覆盖。
- **R3 冷恢复与 agent 交互**：daemon 重启后内存 interpreter map 丢失，`AgentExecutor` 的 session 名虽稳定但 interpreter 实例需冷恢复才能重新调度 resume——此缺口属 R3 范畴，此处仅标注关联。

## 目标（已达成）

让 Agent Step 真正经 acpx 驱动本地 ACP agent，由 Acpus 拥有调度/状态/重试/暂停恢复，由 acpx 拥有 ACP session 生命周期；并以 Mock Agent 通过 acpx 的真实 e2e 覆盖 PRD 强制场景 #1/#2/#3。→ **核心路径已实现，R2 剩余为边界扩展。**

## 完成记录与后续缺口

> 原缺口 #1–#7 中，#1–#6 已在代码中实现；剩余项作为后续边界扩展跟踪：

- ~~session load/resume 缺失~~ → 已实现：`AgentExecutor.execute()` 检查 `resume` 标志，复用同一 session 名并改发 `CONTINUATION_PROMPT`；interpreter 的 `resumeNode`/`retryNode` 传入 `resume: true`。
- ~~固定 continuation prompt 缺失~~ → 已实现：`agent.ts:12` 定义 `CONTINUATION_PROMPT = "Continue the previous task from where you left off."`。
- ~~协作式 mid-turn cancel 缺失~~ → 已实现：`agent.ts:137-164` `wireCooperativeCancel()` 发 `acpx cancel -s <session>`，5s 超时后 SIGKILL 兜底。
- ~~partial transcript artifact 缺失~~ → 已实现：`interpreter.ts:392-399` 当 executor 返回 `result.partial` 时通过 `NodeAbortedError` 携带 `artifactRefs`；`executeNode:341-349` 持久化到节点状态。
- ~~真实 executor 未接线~~ → 已实现：`daemon-runner.ts:32-33` 创建 `new AgentExecutor()` 并传入 `createDaemonApp`；`interpreter.ts:383` 按 `agent.type` 路由到 mock 或 acpx executor。
- ~~真实 e2e 缺失~~ → 已实现：`agent-cancel-resume.test.ts` 使用 `createTestInterpreter({ useRealAgentExecutor: true })`，经 acpx spawn Mock Agent，覆盖基本轮次 + 场景 #1/#2/#3。
- ~~dead agent 子进程 reload/resume~~ → 已实现：场景 #3 测试 agent crash → retry → acpx respawn + resume 同 session → 完成。
- **多 Agent 步骤串联**：未覆盖多 agent 步骤场景下 acpx 多 session 管理。
- **组合节点中的真实 agent**：fanout/loop 内的 agent 调用链未覆盖真实 E2E。
- **`type: builtin` 路径**：E2E 仅覆盖 `type: command`，`type: builtin` 未测。
- **acpx 缺失时 graceful handling**：`resolveInvoker()` 抛异常，无用户友好降级。
- **Daemon 模式真实 agent 链**：daemon HTTP API → interpreter → acpx → Mock Agent 未覆盖。

## 验收信号

- [DONE] Agent Step 经 acpx 执行，session 名稳定且由 node 身份派生，支持同 session resume（`CONTINUATION_PROMPT` 续跑）。
- [DONE] 操作者暂停一个运行中的 Agent Step 时：协作式取消当前 acpx turn、写入 partial transcript artifact、node 置 `paused`；resume 复用同一 acpx-managed session 并以固定 continuation prompt 续跑。
- [DONE] agent 子进程死亡后，重跑 Agent Activity 时由 acpx reload/resume 已保存的 ACP session（retryNode 传入 `resume: true`）。
- [DONE] daemon/interpreter 按 agent `type` 接线真实 `AgentExecutor` 而非始终 mock。
- [DONE] 存在 Acpus→acpx→Mock Agent 真实 e2e，覆盖 PRD 强制场景 #1（mid-turn cancel → partial transcript + paused）、#2（resume 同 session）、#3（dead 子进程 reload/resume）。
- [DONE] `e2e/agent-cancel-resume.test.ts` 覆盖与命名一致。
- [GAP] 多 agent 步骤串接、组合节点内 agent、`type: builtin` 路径、daemon 模式真实链——尚未覆盖。

## 关联

- PRD Milestone：M4。PRD 强制 runtime 场景 #1 / #2 / #3 / #8（agent transcript artifact 路径）。
- 前置：R1（artifact 写入路径、自动 retry）。
- 关联风险：Open Risk #1（adapter 对 cancel/load/resume 支持差异）、#2（acpx alpha 待 pin）—— 真实兼容性收敛见 R4。
- 约束：Acpus 拥有 workflow 调度与 node 状态，acpx 拥有 ACP session 生命周期（不把 acpx 当 workflow 调度器，不用 `acpx flow run` 作运行时）。
