# R2 — Agent Activity 经 acpx 真实集成

> 对应 PRD Milestone 4：Agent Activity through acpx，含 Mock Agent 的 load/resume/cancel 覆盖。

## 背景

Agent Step 的执行抽象（`ExecutorAdapter`、interpreter 注入点、daemon DI）已就位，Mock Agent 本体是合规的 ACP stdio server（支持 initialize/new/load/prompt/cancel、stream、hang、crash、sequence、deterministic ids）。但真实 agent 路径是「接口已就位、实现未接线」：

- `AgentExecutor`（`packages/runtime/src/executors/agent.ts`）只做单次 prompt：派生 session 名后 `execa("acpx", ["--session", ..., "--cwd", ...])` 执行一次，`execute()` 无 resume 分支，无固定 continuation prompt。
- mid-turn cancel 仅靠 `cancelSignal` 发 SIGTERM 强杀（`agent.ts:50,54`），不是 ACP 协作式 `session/cancel`；取消时把 stdout 塞进 `output`，从不写 partial transcript artifact。
- 真实 `AgentExecutor` 从未被接线：daemon 硬编码 `MockAgentExecutor`（`packages/runtime/src/daemon-runner.ts:29`），全仓库无 `new AgentExecutor(...)` 实例化使用。
- 无 Acpus→acpx→Mock Agent 真实 e2e：`packages/runtime/test/e2e/agent-cancel-resume.test.ts` 名为 cancel/resume，实则只用 `MockAgentExecutor` 验证 node 成功/失败，既不取消也不恢复，也不经 acpx。Mock Agent 仅被自身协议测试用 SDK 直连驱动（`packages/mock-agent/test/protocol.test.ts`）。

## 目标

让 Agent Step 真正经 acpx 驱动本地 ACP agent，由 Acpus 拥有调度/状态/重试/暂停恢复，由 acpx 拥有 ACP session 生命周期；并以 Mock Agent 通过 acpx 的真实 e2e 覆盖 PRD 强制场景 #1/#2/#3。

## 缺口清单

- session load/resume 缺失。`agent.ts:38` 仅派生 session 名传 `--session`，无 `session/load`、无第二次带 continuation prompt 的 resume 调用。对应 PRD User Story #9 / #13、`specs/local-runtime-target-spec.md` 的 session loading/resumption 委派。
- 固定 continuation prompt 缺失。`agent.ts:31,35` 只解析一次 `node.metadata.prompt`，无恢复续跑提示逻辑。
- 协作式 mid-turn cancel 缺失。当前 SIGTERM 强杀（`agent.ts:14,50`），需改为请求 acpx 协作式取消当前 ACP turn。
- partial transcript artifact 缺失。取消时只返回字符串 output，不调用 ArtifactStore、不返回 `artifactRefs`；interpreter 在暂停路径期望 `result.artifactRefs`（`interpreter.ts:318`）但 agent executor 从不产出。
- 真实 executor 未接线。`daemon-runner.ts:29` 硬编码 mock，且无 CLI flag / env / 配置可按 agent `type` 切换到真实 `AgentExecutor`。
- 真实 e2e 缺失。无任何测试经 acpx spawn 并驱动 Mock Agent；现有 agent 测试均为 mock 伪覆盖。
- dead agent 子进程 reload/resume（PRD 强制场景 #3）无实现、无测试。

## 验收信号

- Agent Step 经 acpx 执行，session 名稳定且由 node 身份派生，支持 `session/load` 与 `session/resume` 续跑。
- 操作者暂停一个运行中的 Agent Step 时：协作式取消当前 acpx turn、写入 partial transcript artifact、node 置 `paused`；resume 复用同一 acpx-managed session 并以固定 continuation prompt 续跑。
- agent 子进程死亡后，重跑 Agent Activity 时由 acpx reload/resume 已保存的 ACP session。
- daemon/interpreter 按 agent `type` 接线真实 `AgentExecutor` 而非始终 mock。
- 存在 Acpus→acpx→Mock Agent 真实 e2e，覆盖 PRD 强制场景 #1（mid-turn cancel → partial transcript + paused）、#2（resume 同 session）、#3（dead 子进程 reload/resume）。
- `e2e/agent-cancel-resume.test.ts` 的命名与覆盖错配被修正。

## 关联

- PRD Milestone：M4。PRD 强制 runtime 场景 #1 / #2 / #3 / #8（agent transcript artifact 路径）。
- 前置：R1（artifact 写入路径、自动 retry）。
- 关联风险：Open Risk #1（adapter 对 cancel/load/resume 支持差异）、#2（acpx alpha 待 pin）—— 真实兼容性收敛见 R4。
- 约束：Acpus 拥有 workflow 调度与 node 状态，acpx 拥有 ACP session 生命周期（不把 acpx 当 workflow 调度器，不用 `acpx flow run` 作运行时）。
