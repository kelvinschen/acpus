# Runtime Hooks SPEC

## 目的

`@acpus/runtime` 通过 Runtime Hook 边界，在 [Runtime](runtime-spec.md) 持久化提交事件后运行已配置的外部观测命令。Hook 用于记录或转发执行活动，但不参与 Workflow 的调度决策、状态变更或输出生成。

## 要求

- Runtime MUST 按 [Configuration](configuration-spec.md) 定义的规则，同时加载项目级与全局级 Hook。具体支持的事件类型与配置格式由 Runtime 类型定义和配置帮助文档声明。
- Hook MUST 只由新的持久化提交事件触发。重建或读取只读视图（projection）、返回幂等重放结果或在事后追加 Hook 配置，都 MUST NOT 重新触发历史活动。
- Runtime MUST 按提交顺序将每项观测至多交给外部 Hook 一次，并持久化记录交接进度（at-most-once handoff）。一旦 Runtime 将某项观测标记为已交接，如果在外部命令实际启动前崩溃，该次 Hook 可能无法执行；恢复时 MUST NOT 为了达成精确一次投递而重放它。
- 已提交但尚未交接的观测项 MUST 作为未决工作持久化保留。Runtime 正常关闭或崩溃重启时，MUST 保留并继续处理这些观测项，直到每项完成交接、被明确延期或因不可恢复而被隔离。
- 每个 Hook 接收的事件负载 MUST 是大小受限且固定在发生时刻的只读事件快照。Hook MUST NOT 接收可变的 Workflow 状态，MUST NOT 重新计算声明的表达式，也 MUST NOT 用后续更新的 Attempt 替代事件发生时的原始 Attempt。
- `run.started` Hook MUST 包含 admission 后的完整规范化 input、冻结的 Agent 绑定来源与 injection，以及最终有效 Agent 定义。
- Hook 规则匹配与用于展示或记录的元数据 MUST NOT 改变事件的唯一标识，也 MUST NOT 抑制同时匹配的其他项目级或全局级 Hook。
- Hook 执行失败 MUST NOT 改变或阻塞 Workflow 的调度推进、内部状态、节点输出、Artifact 或对外公开的 Run 事件。遇到可重试的分发故障时，Runtime MAY 延后该观测项的交接；遇到不可恢复的故障时，Runtime MUST 只隔离该观测项，MUST NOT 中断或挂起 Run。
- Hook 的执行时间与资源消耗 MUST 受到限制。Hook MUST NOT 比触发它的 Runtime 存活更久；Runtime 失去当前工作区的执行权时，Hook MUST 结束。
- Hook 状态检查 MUST 只暴露数量与大小均受限的终态结果。进程崩溃后丢失的 Hook 历史 MUST NOT 被伪造成失败或运行中记录。

## 验证

- `pnpm test:unit packages/runtime`：验证大小受限的观测负载、匹配逻辑、生命周期限制、真实状态检查以及 Hook 不干扰 Workflow 的契约。
- `pnpm test:integration packages/runtime`：验证已提交事件的有序分发、持久化至多一次交接、重启恢复与有序关闭。
