# MCP SPEC

## 目的

`acpus` 包提供本地 MCP 适配器，使客户端通过结构化工具完成 Workflow 编写、准备、准入、观察、控制与 Artifact 读取。执行、配置和持久化语义分别由 [Runtime](runtime-spec.md)、[Configuration](configuration-spec.md) 与 [Workflow Compiler](workflow-compiler-spec.md) 负责。

## 要求

- 每次涉及项目的 MCP 调用 MUST 显式选择工作区，MUST NOT 依赖启动目录或连接中的可变项目状态。并发调用 MUST 保持各自工作区归属；规范化后的结果与业务失败 MUST 保留已知工作区和 Run 身份。
- MCP 与 CLI 在相同 ACPUS Home 和工作区下 MUST 共享配置与持久化 Run。连接生命周期 MUST NOT 成为 Run 的执行生命周期。
- MCP 服务 MUST 随包提供可发现、可读取的编写与操作知识入口，MUST NOT 要求安装 Skill 或由用户补充 ACPUS 使用说明。
- MCP 标准输出 MUST 只承载协议消息；日志、诊断和其他人类可读提示 MUST NOT 混入标准输出。
- 服务启动、工具发现和读取 MUST 保持 Runtime 只读。
- 试运行 MUST 只准备和校验 Workflow，不准入 Run 或执行其节点；工具元数据 MUST 如实反映准备过程仍会执行模块代码。
- 工作流提交 MUST 在确认持久化准入后返回 Run 身份。请求中断时，适配器 MUST 使用原幂等请求确认已发起的状态变更；无法确认时 MUST 保留结果未知，并引导查询而非假定失败或另建请求。
- 限时等待 MUST 依据 Runtime 的观测契约返回决策边界或终态；期限届满时 MUST 返回当前快照并明确区分等待超时与 Run 失败。取消等待、连接断开和服务正常关闭 MUST NOT 隐式取消 Run。
- 工具业务结果 MUST 提供语义一致的结构化与文本内容。可恢复业务失败 MUST 保留可操作的错误信息和下一步；目标歧义 MUST 保留候选选择器。摘要和控制回执 MUST 遵循 Runtime 的信息裁剪契约。
- Artifact 读取 MUST 使用 Runtime 的校验接口；文本裁剪 MUST 明确标记，二进制结果 MUST 提供经验证的本地来源而非伪装为文本。

## 验证

- `pnpm test:contract packages/cli/test/mcp`：验证协议工具发现、输入与输出、编译诊断及只读行为。
- `pnpm test:unit packages/cli/test/mcp`：验证限时观察与中断后的有界确认。
- `pnpm test:e2e packages/cli/test/mcp`：验证真实 stdio、CLI 互操作、断开连接和持久化工作流闭环。
