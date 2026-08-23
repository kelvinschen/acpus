# Agent Executor SPEC

## 目的

`@acpus/agent-executor` 将 Runtime 的 Agent Session 执行意图转化为独占的、限定在当前工作区内的 ACP Session 租约。它负责解析启动配置、处理 Turn 收尾、清理 Session 资源并持久化所有权记录。[Runtime](runtime-spec.md) 负责持久化调度与 Retry 决策；[ACP](acp-spec.md) 负责协议层 Session 行为与恢复数据（projection）。

## 要求

### 命名 Agent 解析

- 使用显式命令选择器时，Agent Executor MUST 按该命令启动 Agent 并跳过命名 Agent 解析；使用命名选择器时，MUST 严格遵循 [Configuration](configuration-spec.md) 定义的配置优先级，MUST NOT 自行维护另一套独立的 Agent 目录。
- 配置中声明的启动命令 MUST 完整保留其原有的 shell 执行语义。若命令解析失败，MUST 在授予 Session 所有权之前返回失败；配置错误引起的失败 MUST 作为不可重试的 Agent 解析失败处理。
- Session 租约创建时生效的启动配置 MUST 在该租约存续期间保持不变；后续新申请的租约 MUST 使用申请时的最新配置；Agent Executor 自身 MUST NOT 持久化存储已解析出的启动数据。

### Session Supervisor

- Session Supervisor MUST 在对外提供租约前读取当前工作区保存的所有权记录。记录格式不受支持时，Session Supervisor MUST 启动失败；所有权无法确认时，MUST 阻止相应 Session 获取新租约。Session Supervisor MUST NOT 让多个租约并发共享同一个活跃 Session。
- 对于同一个逻辑 Agent Session，同一时刻 MUST 至多存在一个活跃租约或正在进行的所有权清理操作（neutralization）；若检测到所有权冲突，MUST 在激活新租约前返回失败。
- 在等待所有权、解析 Agent 配置、打开 ACP Session、运行 Turn 和清理资源的整个过程中，Agent Executor MUST 响应 Runtime 传入的取消信号，并以 Runtime 声明的截止时间为准。
- ACP 绑定关系的校验 MUST 在 Session 激活之前完成；如果绑定不匹配或启动配置未成功解析，Agent Executor MUST NOT 分配或占用任何外部 Session 资源。
- 每个租约同一时间 MUST 至多接受一个活跃 Turn；后续的会话延续、Retry 以及 Steer 产生的 Attempt，MUST 依据 Runtime 确定的 Session 执行计划重新申请并获取租约，MUST NOT 隐式复用旧租约的所有权。
- 批量释放多个 Session 时，Agent Executor MUST 在通知 Runtime 提交状态变更前，确认所有目标 Session 的所有权都已移除；只要有一个 Session 未清理完成，MUST NOT 向 Runtime 提交废弃标记或修改调度器状态。
- Agent Executor 关闭时，MUST 立即停止接受新的租约申请，并在受限时间内尝试清理其负责的所有 Session 资源；若无法确认清理已完成，MUST 返回类型化结果，明确列出仍可能存在的 Session 所有权。

### 取消与 Turn 收尾

- 多个取消来源竞争时，Agent Executor MUST 采用最先生效的取消原因，并据此确定唯一的清理截止时间。被取消的 Turn MUST 继续独占原租约，直到以下任一收尾条件满足：已收到终态结果并处理完所有已接收事件；已确认 Worker 进程退出；已在截止时间内完成强制清理。
- Turn 正常完成时，Agent Executor MUST 仅向外部暴露最新有效的完整响应；对于执行失败或被取消的 Turn，Agent Executor MAY 保留信息量受限的部分观测和收尾证据供调试使用，但 MUST NOT 把未完成的局部文本输出伪装成已完成的最终响应。
- ACP 协议事件 MUST 严格按照底层 Provider 发送的原始顺序转发给调用方；如果调用方处理事件时失败，Agent Executor MUST 将该失败归入当前 Turn，并启动同一套取消与收尾流程；该失败 MUST NOT 在租约释放后作为无归属异常继续传播。
- 上下文窗口占用指标与 Turn 的 Token 消耗量 MUST 作为互相独立的可选观测数据；如果底层未提供相关遥测数据，系统 MUST 明确将其标记为不可用，MUST NOT 虚构填补为零。
- Agent Executor 通过租约暴露的接口 MUST 在租约之间保持隔离，MUST NOT 暴露能够跨租约操作底层 Session 的写入权限或控制接口。

### 所有权与恢复

- Session 变为活跃状态之前，MUST 先写入持久化的所有权记录，以防止其他租约或恢复后的 Session Supervisor 错误接管其占用的资源。
- 持久化的所有权记录 MAY 仅在确认 Session 占用的外部资源已彻底释放后删除；状态未知的残留所有权记录 MUST 继续阻止访问，MUST NOT 被误判为可以安全分配给其他租约。
- Session Supervisor 启动恢复时，MUST 只扫描指定工作区内的所有权记录。恢复逻辑 MAY 仅在记录的进程身份仍与实际进程匹配时向残留进程树发送信号；无法确认时 MUST 保留不确定的所有权证据，MUST NOT 操作该进程。
- 公开的所有权检查接口 MUST 是只读的；如果无法判定所有权状态，返回结果 MUST 如实标记为无法确认，且 MUST NOT 泄露敏感的启动参数或主机资源细节。
- 外部系统资源的终止与清理 MUST 完整保留 [Owned Process](owned-process-spec.md) 所定义的安全性与生命周期保证；Agent Executor 仅负责制定 Session 管理策略与维护持久化所有权记录。

## 验证

- `pnpm test:contract packages/agent-executor`：验证独占 Session 租约与 Session 权限隔离。
- `pnpm test:unit packages/agent-executor`：验证独占性、Turn 收尾、Session 资源释放、取消机制以及不确定所有权的访问拦截。
- `pnpm test:integration packages/agent-executor`：验证命名 Agent 解析、ACP Session 生命周期、资源清理与启动恢复。
