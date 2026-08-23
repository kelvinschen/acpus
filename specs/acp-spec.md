# ACP SPEC

## 目的

`@acpus/acp` 负责维护稳定的 ACP v1 Session 边界：规范化协议事件与失败、约束由 Agent 发起的 Client 操作，并持久化保存恢复 Acpus Agent Session 所需的最小私有恢复数据（projection）。Provider 进程的生命周期与安全保障委托给 [Owned Process](owned-process-spec.md)。

## 要求

### 公开 Session 边界

- 公开 Session 边界 MUST 只暴露由本包定义的公开数据与类型化失败；底层 Provider 协议与传输层表示 MUST 保持私有。
- Session MUST 遵循稳定的 ACP v1 协议、仅向 Provider 声明已实现的 Client 能力、同一时间至多接受一个活跃 Turn，并保证关闭操作具备幂等性。
- Agent Session 创建后的模型与配置选项 MUST 保持不可变。恢复或加载后端 Session 时，系统 MUST 完整还原当时生效的值；若传入冲突的 Turn 配置，MUST 在分发至 Provider 之前报错失败。
- ACP 自身 MUST NOT 为打开 Session 预设截止时间。取消策略和截止时间由调用方决定；ACP 在连接、恢复与协议收尾的全过程中 MUST 始终遵循并传递调用方的取消语义。
- 返回的可恢复失败 MUST 明确标明失败发生的边界、执行的操作、是否可重试以及可以公开的 Provider 证据，且 MUST NOT 泄露私有协议或进程内部数据。

### Turn 与取消语义

- Provider 返回稳定 v1 prompt 响应时，该响应 MUST 标志当前 Turn 结束。在该响应到达前收到的更新全部处理完之前，当前 Turn MUST NOT 结束；响应到达后、下一次 prompt 发出前收到的迟到更新 MUST NOT 归入后续 Turn。
- 收到取消请求时，ACP MUST 向底层协议发起取消，并通过 prompt 响应或类型化失败完成收尾；若打开操作在尚未就绪时被取消，在证实已释放全部已获取的 Provider 资源之前 MUST NOT 报告取消完成，若无法确认清理完成则 MUST 报告为清理失败。
- Turn 以 `completed` 或 `cancelled` 结束时，ACP MUST 向外提供 Agent 返回的规范化停止原因；如果 Agent 提供 Token 用量，ACP MUST 一并提供。事件消费方的处理失败 MUST 仅作为调用方侧的观测失败，MUST NOT 改变协议行为，也 MUST NOT 篡改协议结果。
- ACP MUST 使用 [Owned Process](owned-process-spec.md) 管理 Provider 进程以及由 Agent 请求创建的终端进程，并保留其存活性检测、进程身份校验、信号发送与清理保证。ACP MUST NOT 暴露任何削弱或绕过这些保证的其他路径。

### Client 操作

- 当 Agent 请求权限时，ACP MUST 按调用方配置的策略选择授权或拒绝；若 Provider 未提供符合该策略的选项，ACP MUST 取消该权限请求，MUST NOT 改用更宽松的权限。
- Agent 请求执行的文件系统与终端操作，在完成路径解析后 MUST 严格限制在当前有效工作目录（cwd）内。终端输出的大小 MUST 受限，且所有已接纳的终端在 Session 关闭时 MUST 全部关闭。
- Session 开始关闭后，ACP MUST NOT 再接受 Provider 向 Client 发起的新操作请求（reverse operation）；此前已接受的请求 MUST 要么完成，要么被明确取消，MUST NOT 被无结果地遗留。任何通过验证的 Client 操作 MUST 生成 Client activity，作为 Provider 活动证据；即使该操作不显示在语义输出中，展示过滤也 MUST NOT 阻止这条证据产生。

### Session 恢复数据

- 用于恢复 Session 的数据 MUST 作为私有数据原子持久化；其中的语义对话历史 MUST 限制大小，并保留恢复所需的 Provider 能力证据。它 MUST NOT 包含原始协议输出、环境变量值、凭证、机密信息或序列化的 Runtime 包装对象。
- 在让 Provider 分配任何资源之前，ACP MUST 先验证已有恢复数据的格式完整性、Agent Session 标识与绑定关系。数据损坏或绑定不匹配时 MUST 保持原有恢复数据不变，并返回明确的类型化失败。
- Session 恢复时，若 Provider 支持 resume 则 MUST 执行 resume，若不支持 resume 但支持 load 则 MUST 执行 load。当已有 Session 无法恢复时，要求使用已有 Session 的调用方 MUST NOT 静默创建替代 Session；系统 MAY 仅在调用方显式声明 Session 为空时，根据其新建策略创建新的后端 Session。
- 持久化保存的绑定关系 MUST 准确区分具有不同稳定恢复标识的 Session，同时在保存时排除机密信息、易失性执行上下文以及不相关的 Runtime 或 Provider 观测数据。

## 验证

- `pnpm test:contract packages/acp`：验证持久化 Session 的隐私性与 Provider 隔离边界。
- `pnpm test:unit packages/acp`：验证权限限制、Turn 结束边界、恢复数据隐私性、恢复标识与失败规范化。
- `pnpm test:integration packages/acp`：验证稳定 v1 协议的恢复、Turn、取消、Client 操作与进程清理。
