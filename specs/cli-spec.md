# CLI SPEC

## 目的

`acpus` CLI 是面向人类与 Agent 的命令行交互适配器，用于 Workflow 声明、持久化运维与故障恢复。它呈现由 [Workflow Compiler](workflow-compiler-spec.md)、[Runtime](runtime-spec.md)、[Configuration](configuration-spec.md) 及 [Runtime Hooks](hooks-spec.md) 定义的契约，自身不作为第二套执行或持久化状态来源。

## 要求

### 产品边界

- 命令执行成功或处理已知故障时，MUST 使用简明自然的文本，并在后续存在可行操作时提供明确的操作建议。需要结构化数据的外部程序 MUST 调用底层包的程序接口，MUST NOT 通过解析 CLI 的文本输出来获取数据。
- 用法错误 MUST 与运行故障明确区分。退出状态码 MUST 保持稳定：成功返回 `0`，用法错误返回 `2`，其他运行故障或结果无法确认的操作返回 `1`。
- 非交互式输出 MUST NOT 包含 ANSI 样式或其他终端控制码。交互式提示与进度信息 MUST NOT 混入 stdout 的命令结果。

### Workflow 生命周期

- 无论 Workflow 源码由文件提供、从目录中发现还是来自 stdin，CLI MUST 交由同一套编译器契约处理。从目录中发现 Workflow 时，CLI MUST 只检查元数据，MUST NOT 导入 Workflow 模块；同名 Workflow 同时出现在项目级和全局目录时，MUST 要求用户显式指定作用域。
- 导入 Workflow 时，CLI MUST 将本地与远程包都视为不可信输入。CLI MUST 拒绝路径逃逸、链接越界或文件冲突，保持已有目录条目不变，MUST NOT 私自安装依赖，并且 MUST 要么完整写入一份私有快照，要么不留下任何内容。
- 执行 Workflow 检查与可视化时，CLI MUST 只准备 Workflow，MUST NOT 准入 Run，也 MUST NOT 向持久化存储写入执行状态。生成可视化图时 MUST NOT 捏造运行实例（occurrence）或运行状态。
- 执行 Workflow 时，CLI MUST 在准入前完成全部准备工作，并将持久化状态的写入交给工作区 Runtime。默认模式 MUST 在确认 Run 已准入后返回；`--follow` MUST 持续等待 Run 进入终态；`--await-decision` MUST 在出现需要人工处理的决策边界时返回。
- 中断正在准入或观测的 Run 时，CLI MUST 只脱离前台监听，MUST NOT 直接取消 Run。若中断发生时准入结果尚未确定，CLI MUST 查明这次准入最终是否已持久化；无法确认时，MUST 明确报告结果未知并提供恢复命令。

### Runtime 运维

- CLI 的读取命令与 Web 启动命令 MUST 保持只读且不产生 Runtime 状态变更；执行这些操作时，适配层 MUST NOT 顺带启动守护进程、自动修复存储或推进任务执行。
- 查看状态时，CLI MUST 保留 Runtime 定义的目标、观测结果与决策指引。若存在歧义状态，MUST 保持可见以供操作者显式选择，MUST NOT 根据时间流逝、心跳静默或遥测缺失自行推断或消除歧义。
- 执行状态变更命令时，CLI MUST 向 Runtime 守护进程提交明确的操作意图，并清楚区分“请求已被持久化接受”和“控制效果已经生效”。CLI 适配层 MUST NOT 擅自加入隐式修复或预先执行取消操作。
- 展示控制操作信息时，CLI MUST 保留面向操作者的公开选择器，同时隐藏内部的运行实例、Attempt 编号、写入隔离信息与准入细节。对于用户输入的 Steer 引导指令、Agent 定义及其他私有数据，MUST NOT 在操作回执或目录列表中回显。
- 状态诊断与数据修复 MUST 保持为独立、显式的 Runtime 操作。CLI MUST NOT 在常规读取时自动触发修复；在用户发起显式修复请求后，CLI MUST 重新读取并展示当前实际状态，MUST NOT 单凭修复操作已发起就推断修复成功。

### 内置 Skill 与更新感知

- 读取 Skill 时，CLI MUST 只能访问当前运行版本自带的内置 Skill。安装或移除 Skill 时，CLI MUST 先确认目标是该内置 Skill 的可识别副本，MUST 保留无关的用户内容，并且 MUST 原子发布更新；若无法完成恢复，MUST 报告上一版本的恢复位置。
- CLI MAY 在交互式使用时尽力检查新版本并提供提示。该检查 MUST NOT 在工作区创建任何持久化状态；即使遇到网络异常或缓存失效，CLI 也 MUST NOT 改变普通命令的输出、行为或退出状态码。

## 验证

- `pnpm test:contract packages/cli`：验证 CLI 与 Workflow Compiler、Runtime、Configuration、呈现层及安全契约之间的接口规范。
- `pnpm test:e2e packages/cli`：通过可执行接口端到端验证 Workflow 编写、准入、检查、控制、脱离监听及故障恢复路径。
