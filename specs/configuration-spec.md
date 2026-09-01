# Configuration SPEC

## 目的

[Runtime](runtime-spec.md) 为命名 Agent、Agent Preset、Authoring Agent scale 与 [Runtime Hooks](hooks-spec.md) 提供统一的项目与全局配置接口。使用方直接接收校验后的配置对象，无需自行解析底层存储。

## 要求

- 项目配置的根路径 MUST 是 Runtime 的规范工作区；全局配置的根路径 MUST 是 Host 进程的主目录。这两个根路径 MUST NOT 随 Workflow 环境变量或 Agent 的实际工作目录改变。
- Runtime MUST 将每个配置文件作为一个整体校验。任何分区中出现无效值或未声明字段时，整个文件 MUST 对所有使用方报错，MUST NOT 返回部分解析结果。
- 解析命名 Agent 时，Runtime MUST 按 Host、项目、全局、内置的顺序选择首个匹配定义。解析相同 ID 的 Agent Preset 时，Runtime MUST 按 Host、项目、全局的顺序选择首个匹配定义。项目与全局作用域的 Hook 条目 MUST 取并集；来自两个作用域的所有匹配 Hook MUST 全部执行，任一方都 MUST NOT 覆盖或抑制另一方。
- `authoring.agentScale` MUST 接受正 safe integer 或 `small`、`medium`、`large`、`unrestricted`；前三个档位 MUST 分别归一化为 4、12、32 个建议 Agent execution occurrences，整数本身即建议上限，`unrestricted` MUST 不产生上限。有效值 MUST 按 `ACPUS_AUTHORING_AGENT_SCALE`、项目、全局的顺序解析；未配置时 MUST 保持缺省，而非推断默认档位。环境变量无效时统一 authoring context MUST 整体失败。
- Runtime MUST 提供一次读取的 `AgentAuthoringContext`，同时返回有效 scale 与按 Host、项目、全局去重后的 Preset 选择元数据。该元数据 MUST 只暴露 `id`、`guidance`、`scope`，MUST NOT 暴露具体 Agent 定义。
- Runtime MUST 统一负责配置校验、作用域组合与配置更新。更新任一分区时，MUST 完整保留其他已校验分区的现有语义。
- Runtime MUST 私密保存各作用域的配置，并使每次修改原子生效。修改一个作用域时，Runtime MUST NOT 影响其他作用域，也 MUST NOT 覆盖或丢失其他已接受的并发更新。无法保证这一点时，Runtime MUST 拒绝该修改，MUST NOT 基于陈旧状态写入。
- Preset 与 scale 更新 MUST 共用同一配置文件锁内的 read-modify-write。Scale unset MUST 幂等；作用域未配置且配置目录不存在时，MUST NOT 创建或重写文件。
- 配置变更 MUST 按明确的生命周期生效：Hook 在 Runtime 启动时加载并固定，命名 Agent 在新建 Session 时解析，Preset 在发现与准入时解析，scale 在 authoring context 读取时解析。Runtime MUST NOT 因后续配置变更而修改已准入的 Run。

## 验证

- `pnpm test:unit packages/runtime`：验证完整校验、优先级合并、作用域隔离以及分区更新时的无损保留。
- `pnpm test:integration packages/runtime packages/agent-executor`：验证 Runtime 边界上的作用域配置生效规则与可见性。
