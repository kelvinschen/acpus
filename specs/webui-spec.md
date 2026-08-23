# WebUI SPEC

## 目的

`@acpus/web` 负责提供用于查看 Workflow 与持久化 Run 状态的本地浏览器控制台，以及离线 Workflow 可视化页面。它适配公开的 [Workflow Compiler](workflow-compiler-spec.md) 与 [Runtime](runtime-spec.md) 接口，自身不作为第二套 Workflow、存储或控制状态来源。

## 要求

### Runtime 与可信工作区

- 启动 Web 服务和日常浏览 MUST 保持只读，不产生 Runtime 状态变更。只有用户在 Web 服务启动时选定的工作区中明确发起控制操作时，Web 服务 MAY 将该操作委托给 Runtime；除此之外，Web 服务 MUST NOT 启动、唤醒、修复或推进 Runtime 执行。
- 浏览 Workflow、Run、健康状态、Artifact 或详情时，Web 服务 MUST 调用公开的 Workflow Compiler 与 Runtime 接口。Web 代码 MUST NOT 直接查询底层 Runtime 存储、私自打开已注册 Artifact 的物理路径，也 MUST NOT 自行推导动态目标标识或控制操作是否有效。
- 浏览器端 MUST 仅通过服务端分发并校验的不透明标识来切换工作区；客户端传入的文件系统路径 MUST NOT 作为可信工作区凭据。每个 Run 的展示视图 MUST 将工作区与 Run 标识严格绑定，且视图 MUST NOT 混入来自其他工作区的数据。
- 其他已知工作区 MUST 保持只读，但 MUST 继续提供 Run、拓扑图、检查详情、执行进度与 Artifact 的查看能力；Web 服务 MUST NOT 为这些工作区启动后台守护进程，也 MUST NOT 接收其控制操作。
- 当所选工作区变为不可用时，系统 MUST 明确提示错误并提供返回路径，MUST NOT 静默展示来自其他工作区的数据。
- 工作区、Run 及顶级页面的切换 MUST 支持通过浏览器历史记录导航。拓扑图视口位置、运行实例（occurrence）选中状态与 Inspector 抽屉状态 MUST 保持为前端本地 UI 状态，MUST NOT 变更 Runtime 状态，也 MUST NOT 污染浏览器的路由历史记录。

### Workflow 与 Run 图

- 静态拓扑图与运行时 Run 图 MUST 使用同一份声明式 Workflow 拓扑。运行时 Run 图 MUST 在该拓扑上追加实际运行的节点实例与状态，但 MUST NOT 替换或隐藏用户声明的节点、分支或作用域关系。
- 未被选中的分支与尚未执行到的结构 MUST 在图中保持可见。对于已完成或已取消的控制流分支，前端 MAY 将未实际运行的后代节点展示为跳过；但在发生失败的 Run 中，前端 MUST NOT 仅因某项工作未执行到就推断其已被跳过。
- 静态可视化图 MUST NOT 包含 Attempt 记录、动态运行实例、仍在等待输入的 Signal、Signal 载荷或其他运行时状态。其声明的拓扑结构中 MAY 包含 Signal 节点。生成静态可视化图的过程 MUST NOT 创建 Run 或写入持久化预检数据。
- 由 Fanout 与 Loop 生成的多个运行实例 MUST 各自保留完整的父级上下文与稳定的 Runtime 目标标识。浏览器 MAY 选择展示其中一个具体实例，但 MUST NOT 凭空捏造实例，也 MUST NOT 根据图的局部状态自行拼凑公开目标。
- Run 标识、图状态以及当前可执行的控制操作 MUST 来自单一且一致的 Runtime 数据视图，防止因局部数据异步刷新而错误允许当前状态不支持的操作。
- 独立的 Workflow 可视化页面 MUST 保持为单个自包含的离线文档，其表达的静态图含义与浏览器控制台完全一致，且不依赖任何实时 API 或在线 Runtime。

### 检查、控制与 Artifact

- 查看 Workflow 详情时，系统 MUST 明确区分静态声明与准入后的运行时取值。检查节点状态 MUST 使用 Runtime 定义的目标标识，MUST NOT 在前端重新计算输入、Prompt、分支条件或输出。
- Agent 活动与 Token 用量 MUST 视为可选且可能不完整的遥测数据。数据缺失时，MUST NOT 将其解读为用量为零、Provider 正常、历史完整或从未产生活动。
- Forensics（深度诊断）所需的详细调用数据 MUST 只在操作者明确展开时按需加载，MUST NOT 混入持续刷新的 Summary（概览）数据流。Web 视图 MUST 限制数据量，只暴露当前 Inspector 所需的字段。
- 状态变更控制 MUST 依据 Runtime 视图提供的可用性判断，要求操作者明确确认，并通过 Runtime 控制接口一次只提交一种明确的控制操作。WebUI MUST NOT 根据图状态自行推断 Retry 或 Cancel 的目标。Fork 仍 MUST 由 CLI 执行，因为替换 Workflow 源码、输入或 Agent 绑定需要显式准备。
- Artifact 元数据与内容 MUST 只通过 Runtime 校验过的读取器获取。完整内容 MUST 只在用户明确查看时加载，关闭后 MUST NOT 保留为可复用的全局应用状态，并且 MUST 始终按不可信内容处理。
- 用户声明的 Markdown 与 HTML Artifact MUST NOT 获取宿主应用权限。其中的超链接、内嵌资源、动态脚本、window.opener 访问以及页面跳转，MUST 持续受到查看器的内容安全策略限制。
- 浏览器或 API 处理过程发生未预期异常时，MUST 对错误信息进行脱敏，MUST NOT 泄露文件系统路径、进程信息、存储细节、Agent 定义或私有 Runtime 实现。
- 执行 Runtime 存储修复 MUST 保持为显式触发的操作，且 MUST 仅在 Web 服务启动时选定的工作区中执行。修复后 MUST 立即重新读取最新状态；修复前的工作区与 Run 视图 MUST NOT 继续作为当前状态展示。

### 访问与交互语言

- Web 服务 MUST 默认允许从所有已绑定的监听地址直接访问，且 MUST NOT 自动启用访问令牌（token）保护。令牌保护 MUST 由启动选项明确启用，且每次启动 MUST 生成新令牌；系统 MUST NOT 因为绑定了非回环地址就自动启用令牌保护。启用后，受保护的浏览器与 API 请求 MUST 拒绝缺失或无效的令牌。
- 节点类别、Runtime 状态、选中状态与节点层级 MUST 使用相互独立的视觉表达。状态语义 MUST NOT 只依赖颜色区分，状态样式也 MUST NOT 覆盖节点自身的类别标识或层级关系。
- 正文与关键控制操作的对比度 MUST 符合 WCAG AA。鼠标悬停或点击交互 MUST 同时支持键盘操作与焦点恢复；截断文本 MUST 提供查看完整内容的方式；动画 MUST 支持减少动态效果（reduced motion）模式。
- Artifact 与 Prompt 的渲染排版 MUST 在桌面端与窄屏设备上均保持结构清晰可读，长文本内容 MUST NOT 遮挡操作者查看当前 Run 状态、目标节点或故障恢复操作入口。

## 验证

- `pnpm test:contract packages/web`：验证 Runtime 委托、工作区状态范围、隐私保护、Artifact 安全沙箱、控制操作及访问控制行为。
- `pnpm test:unit packages/web`：验证拓扑图语义、检查详情逻辑、交互无障碍性及视觉层分离。
- `pnpm test:integration packages/web`：通过公开编译器接口验证静态准备与离线可视化生成。
