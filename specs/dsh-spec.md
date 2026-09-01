# DeepSeek Harness 集成 SPEC

## 目的

`@acpus/dsh` 以能力受限的方式将 Acpus 嵌入 DeepSeek Harness，并提供 Acpus Supervisor（下称 Supervisor）。该集成将模型声明的 Workflow 准入为持久化 Run，以 DSH Task 的形式监管这些 Run，在 Host 重启后恢复监管，并向模型与 DSH Client 提供经过信息裁剪的安全活动视图。Runtime 行为仍由 [Runtime](runtime-spec.md) 负责；Agent 启动仍由 [Agent Executor](agent-executor-spec.md) 负责。

## 要求

### 集成边界

- 激活操作 MUST 只安装或更新本包提供的 `acpus` Preset。若已有同名 Preset 并非由本包提供，激活 MUST 失败，且 MUST NOT 修改该 Preset。
- 该集成 MUST 向模型提供统一 Agent authoring context 发现、Preset 修改、Task 发现、准入、状态检查、控制以及 Artifact 访问能力。具体 Schema 由 Host 工具定义；本 SPEC 只规定产品与安全边界，不重复具体 Schema。
- 面向模型的操作 MUST 使用易读的 Task 选择器，并返回大小受限且符合安全约束的 JSON 数据。这些操作 MUST NOT 泄露 Runtime 内部的 Run ID 或准入 ID、存储路径、工作区标识、内部节点 key、进程数据、凭据或解析后的 Agent 启动信息。
- 若 Workflow 源码、输入参数或 Agent 选择无效，集成 MUST 向模型返回可恢复的无效结果，且 MUST NOT 准入或持久化可运行的 Task。遇到 Host、存储、目录或 Runtime 基础设施故障时，集成 MUST 返回操作失败，MUST NOT 将其伪装成 Workflow 声明无效。
- 嵌入式 Runtime MUST 使用独立于 Acpus CLI 存储的集成专属状态。它 MUST NOT 发现或操作属于 CLI 的 Run。

### Agent 与 Preset 隔离

- 解析命名 Agent `dsh` 时，MUST 遵循 [命名 Agent 解析](agent-executor-spec.md#命名-agent-解析) 契约，并将本集成内置且不可篡改的启动配置作为唯一可信来源。用户定义的同名 Agent 配置 MUST NOT 覆盖它；解析 `dsh` 时 MUST NOT 再经过 DSH / Acpus 集成而递归回到自身。
- 集成 MUST 提供无参数、只读且并发安全的 `acpus_agent` 工具，一次返回 effective scale 与 Host、项目、全局 Preset 的选择建议。Supervisor MUST 在设计 topology 前调用一次，按 scale 指导规模并依据 guidance 选择 Preset。集成 MUST NOT 将 Host、全局、项目 Preset 或 scale 动态提升进 system prompt。
- Scale MUST 统计预计 Agent execution occurrences，包括 fanout、loop 及每个分支执行；Task、Agent slot 与复用 Session 数 MUST NOT 计数。该值 MUST 作为软指导而非准入限制，并明确声明：“This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale.”
- 面向模型的 `acpus_presets` MUST 只接受显式作用域与非空 changes 的原子修改，不得兼具 list operation；本集成不提供 scale set/unset 工具。
- Preset 更新 MUST 原子完成；系统 MUST 拒绝修改保留 ID `dsh`。变更 MUST 只影响此后新准入的 Task；已经准入的 Task MUST 保持其冻结的 Agent 绑定不变。

### 持久化委托与监管

- 准入操作 MUST 根据其 DSH Task 上下文生成持久化的幂等标识。在发起可能出现“结果未知”的准入请求前，系统 MUST 先持久化足以恢复并核对结果的状态。结果未知时，系统 MUST 使用同一幂等标识核对最终结果，MUST NOT 创建重复的 Run；请求载荷完全一致时，系统 MAY 使用该标识重放请求。
- Host 重启后，系统 MUST 恢复未决的准入、对非终态 Task 的监管、待处理的用户控制以及待投递的 attention 通知（用于主动唤醒 Supervisor），且 MUST NOT 为此扫描其他工作区。已经保留的终态历史 MUST 在不重新启动对应 Runtime 的情况下继续可读。
- 当 Runtime 不可用时，系统 MUST 保留最后一次已知状态的只读视图（projection），并明确标记状态不确定。系统 MUST NOT 擅自取消 Run、捏造执行进度、静默重新绑定工作区，或影响对其他委托 Task 的监管。
- 状态检查 MUST 立即返回经过信息裁剪的当前视图。Supervisor MUST NOT 在准入后轮询状态，也 MUST NOT 通过状态检查唤醒模型。常规活动 MAY 刷新 Client 的展示视图，但 MUST NOT 唤醒 Supervisor。
- Supervisor MUST 只在 Run 等待已声明的 Signal 输入、Run 进入终态或收到显式用户控制时，主动发送 attention 通知。通知投递 MUST 支持持久恢复与去重；即使恢复过程或通知父 Session 失败，系统也 MUST NOT 影响 Run 的执行，且 MUST NOT 丢失待投递的通知。
- 控制操作 MUST 验证目标持久化 Task 的当前控制权限，并阻止过期或冲突的操作，确保控制只作用于该 Task。已确认的控制结果 MUST 先持久化，再投递 attention 通知；Retry MUST 复用同一请求标识。当替换 Workflow 准备失败或 Agent 绑定无效时，Fork MUST NOT 创建子 Run。

### 面向人的展示视图

- Client 的 Task 活动视图 MUST 只展示实际运行的节点及其层级，并限制展示深度和数据量；它 MUST NOT 暴露 Runtime 内部术语、私有标识、Provider 传输内容、Agent 思考过程、未完成的响应、工具参数与结果、底层命令、环境变量或敏感凭据。
- 当 Runtime 不可用时，非终态 Task MUST 保留最后已知的节点树与状态，明确标记数据可能已经过期，并禁用需要当前 Runtime 的操作。界面根据本地时钟更新耗时显示时，MUST NOT 让用户误以为 Runtime 产生了新活动，也 MUST NOT 唤醒模型。
- Client 发起取消操作时，MUST 验证当前 DSH Session 中选中的 Task，并阻止过期或冲突的请求，确保取消只作用于该 Task；在控制结果持久化确认之前，MUST NOT 向用户报告成功。结果一旦确认，后续通知投递失败 MUST NOT 回滚取消结果。
- 面向人的 Preset 视图 MAY 显示用户声明的配置，但 MUST 过滤凭据、环境变量、工作目录（cwd）、Runtime 绑定数据以及是否可执行等内部状态。该视图 MUST 保持只读；面向模型的 Preset 视图 MUST 进一步裁剪为只包含选择建议。

## 验证

- `pnpm test:contract packages/dsh`：验证模型能力与操作者视图之间的职责分离及隐私边界。
- `pnpm test:unit packages/dsh`：验证隔离机制、持久化监管、信息裁剪、attention 通知、防止过期控制以及 Client 过期状态处理。
- `pnpm test:integration packages/dsh`：验证嵌入式准入、命名 DSH Agent 执行、Host 重启恢复、通知机制以及与 Runtime 存储的隔离。
