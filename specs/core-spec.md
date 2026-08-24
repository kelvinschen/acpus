# Core SPEC

## 目的

`@acpus/core` 负责定义将类型化 Workflow 声明转换为持久化 Workflow 图的稳定编写模型。[Expression](expression-spec.md) 负责运行时值的计算，而 [Workflow Compiler](workflow-compiler-spec.md) 负责源码分析与准备。

## 要求

### 编写模型

- 构建 Workflow 时 MUST 同步声明静态图；MUST NOT 实际执行 Agent、Task、Signal 或任何其他 Workflow 工作。
- Workflow 输入、Run 元数据、Composite 局部值以及节点输出结果 MUST 保持为不透明的类型化表达式，且仅在 Run 期间求值。声明阶段传入的值 MUST 保持为纯配置。
- 编写者 MUST 通过表达式声明运行时计算，并通过图节点声明运行时控制；图构建期间的 JavaScript 求值 MUST NOT 替代这两者。
- `step` ID MUST 唯一标识静态图节点，且在整个 Workflow 中不可重复。循环轮次与扇出项 MUST 为这些节点创建运行时实例（occurrence）；节点 ID MUST NOT 动态生成。
- 节点引用 MUST 仅用于表达控制关系；其执行结果 MUST 通过显式的输出表达式读取。每个 Workflow 或 Composite 作用域 MUST 返回一个可持久化的输出值，其中 `{}` 表示显式的纯控制流结果，`null` 则作为显式返回值保留。
- Composite 回调 MUST 声明静态子图。分支产生的结果 MAY 保持为类型化的联合类型；每次循环状态流转 MUST 完整替换上一轮状态，MUST NOT 隐式合并字段。
- 顶层 Agent 声明 MUST 为 Workflow 建立类型化的 Agent 绑定。已指定具体身份的 Agent 声明，MUST 与未指定身份、留待准入时绑定的 Slot 明确区分。

### 持久化边界

- 跨 Workflow、节点与 Task 边界持久存储或返回的数据 MUST 是兼容 JSON 的基础类型、数组、普通对象或受支持的 Acpus 引用。顶层值或数组元素 MUST NOT 为 `undefined`；对象中缺失的可选字段 MAY 直接省略。
- 图边界处的 Schema 在执行前 MUST 能够转换为可序列化的 Schema 数据。仅在运行时生效的动态 Schema 行为 MUST NOT 写入持久化的 Workflow IR。
- 可复用 Task 的输入 Schema MUST 仅用于编写阶段的 TypeScript 类型推导；MUST NOT 承诺在运行时自动校验、填充默认值或转换数据。
- Task 代码 MUST 被视为由 Workflow 编写者指定的受信任本地代码。沙箱隔离与第三方代码策略 MUST 由执行环境显式控制，MUST NOT 依赖 Task 语法隐式生效。
- Workflow 传递给 Task 的数据 MUST 通过显式 Task 输入传入，Task 执行结果 MUST 作为可持久化数据返回。内联 Task 代码除了使用传入的 Task 上下文外 MUST 保持自包含。

### 冻结 Workflow 契约

- Workflow 编译成功后 MUST 生成确定性、自包含且完全可序列化的 Workflow IR，且每个可执行作用域都拥有明确且唯一的输出。
- 遇到无效的图引用、不可持久化的值、格式错误的 Task 定义或未解析的可复用 Task 链接时，编译或校验 MUST 失败并报告错误；Core MUST NOT 输出包含未解析占位目标的残缺 IR。
- Core MUST 区分两类 IR：编写完成的 Workflow IR MAY 包含未绑定的 Agent Slot，而已完成准入的 Workflow IR 中，所有 Agent 绑定 MUST 已实际确定；下游执行模块 MUST NOT 接收到包含未解析 Slot 的 IR。
- 无论 IR 通过何种方式生成，结构化 IR 校验 MUST 对 Workflow Compiler、Runtime 及外部 IR 使用方统一应用相同的自包含图完整性规则。
- Workflow 源图的唯一标识 MUST 采用规范化格式，且仅由逻辑入口和文件内容决定，MUST NOT 受调用方指定的顺序或 Host 环境元数据影响。具体的传输数据格式属于共享实现细节。
- 遇到可恢复的图转换与校验失败时，Core MUST 保留充分的结构化上下文，便于调用方定位具体哪处边界被拒绝。Workflow 编译过程 MUST NOT 吞掉或掩盖底层的构建与转换异常。

## 验证

- `pnpm --filter @acpus/core typecheck`：验证静态编写模型能够拒绝无效的图与运行时值用法。
- `pnpm test:contract packages/core` 与 `pnpm test:type packages/core`：验证其他包所消费的 Workflow 编写与持久化图边界。
- `pnpm test:unit packages/core`：验证确定性的图结构转换、校验、Schema 转换与内容标识。
