# Runtime SPEC

## 目的

`@acpus/runtime` 是持久化执行边界：它接收 [Workflow Compiler](workflow-compiler-spec.md) 准备好的 Workflow，创建不可变的 Run，执行已冻结的 Workflow，并在进程崩溃或故障后可靠保留执行结果。Runtime 同时为 Host 和操作者提供长时运行所需的控制与检查能力。其中，IR 与值语义由 [Core](core-spec.md) 和 [Expression](expression-spec.md) 定义；Agent Turn 交由 [Agent Executor](agent-executor-spec.md) 执行；外部副作用的观测交由 [Runtime Hooks](hooks-spec.md) 处理。

## 要求

### 工作区分片、准入与存储

- 规范化后的真实工作区路径 MUST 对应唯一且私有的 Runtime 状态。面向不可信 Client 的接口 MUST 只接受不透明的 Runtime 标识，MUST NOT 接受文件系统路径。
- CLI 管理的状态与显式指定根目录的 Host 状态 MUST 各自保持独立的写入权限与存储。Runtime MUST NOT 在工作区内创建或使用 Runtime 状态。
- 每个 Runtime Read Session（只读会话）MUST 始终观测同一段连续的工作区事件历史。一旦新的 Runtime 实例接管该工作区，该 Read Session MUST 立即结束并报错，MUST NOT 静默切换到新实例的历史。
- 执行只读发现、健康检查、状态检查或生成控制计划时，Runtime MUST NOT 创建任何状态、启动后台守护进程、自动修复存储，或以任何方式修改工作区。
- Runtime 内部状态、已冻结源码、Run 数据与 Artifact MUST 严格保存在私有存储中，且 MUST 拒绝路径逃逸、符号链接替换和任何可观测的外部篡改。当持久化数据缺失或损坏时，Runtime MUST 显式失败，MUST NOT 将其伪装成“数据不存在”。
- 发现已知工作区时，Runtime MUST 隔离单个无效或不可用的工作区，确保其余有效工作区仍可正常列出；在可信的服务端调用方显式打开并解析目标工作区之前，Runtime MUST NOT 向外暴露该工作区的 Run 记录。
- 执行存储检查或调用公开只读 API 时，Runtime MUST 保持只读，并明确区分“需要人工干预的存储故障或所有权冲突”与“Run 或 Artifact 不存在”。
- 执行存储修复时，Runtime MUST 保留完整的源码内容以及可恢复的运行摘要（Run Summary），且操作范围 MUST 严格限制在指定的工作区内；修复过程 MUST NOT 强制终止持有所有权的进程，也 MUST NOT 删除源码存储。若修复被中断或存在并发修复，系统 MUST 收敛到唯一结果；当目标工作区的活跃所有权不明确时，Runtime MUST 阻止对该工作区的一切状态写入。
- 遇到更高版本、由外部系统创建或无法识别的存储格式时，Runtime MUST 保持数据原样且拒绝加载。Runtime MUST NOT 自行推测迁移方式，也 MUST NOT 通过部分兼容路径冒险读取。
- 在 Run 进入可执行状态之前，准入阶段 MUST 完成对准备好的 Workflow 的校验、将输入参数规范化、解析并绑定全部 Agent，并发布执行所需的全部已冻结数据。任何可恢复的校验错误或 Agent 绑定拒绝，MUST 在实际创建 Run 之前发生并报错。
- 准入请求 ID MUST 具备严格的幂等性：以相同请求 ID 重放具有相同准入含义的请求时，Runtime MUST 返回最初创建的 Run；若将同一请求 ID 复用于不同的输入、Workflow 定义或 Agent 注入项，Runtime MUST 拒绝请求并报错，且 MUST NOT 修改任何状态。
- 准入一旦完成，Runtime MUST 冻结 Workflow IR、规范化输入、实际生效的 Agent 绑定以及选定的源码来源。此后外部调用方修改自身对象、Preset、配置文件或编译器输出，都 MUST NOT 影响已准入的这套冻结数据。
- 对于以快照形式准入的 Workflow，Runtime MUST 完整保留并校验可复用 Task 所依赖的本地源码。对于直接引用实时工作区源码的 Workflow，Runtime MUST 在运行时从准入时确定的规范工作区解析可复用 Task 模块；后续修改这些模块，可能影响尚未加载它们的 Attempt。Runtime MUST NOT 静默切换到其他源码加载模式或篡改源码根目录。
- Run 执行完成时，Runtime MUST 持久化保存规范化后的根节点输出。已识别的 Workflow 失败 MUST 持久化记录为 Workflow 失败状态；基础设施或存储损坏导致的失败，MUST 始终与 Workflow 声明产生的失败明确区分开来。
- 删除 Run 时，若仍存在活跃所有权，Runtime MUST 拒绝删除操作；删除过程中，持久化数据库记录与私有文件清理之间 MUST 保持崩溃一致性。若删除中途崩溃，恢复后 MUST 保留仍能有效表示该 Run 的数据；无法确认删除是否完成时，Runtime MUST 保留未决数据供后续恢复，MUST NOT 将其当作无主数据清理。
- 归档存储 MAY 提供已进入终态的 Run 的只读运行摘要，供检索与列表发现；当详细执行记录或观测历史已被清理而不可用时，归档存储 MUST 明确指出详情不可用，MUST NOT 将其伪装成“该 Run 不存在”。

### 持久化调度与恢复

- Runtime MUST 严格执行 [Core](core-spec.md) 所定义的已冻结节点与 Composite 组合逻辑。计算表达式时，MUST 仅使用在当前声明作用域内可见且已持久化冻结的值，MUST NOT 读取后续步骤的值或正在运行中的活跃状态。
- Runtime 从存储中重新打开同一 Run 状态时，MUST 做出与此前一致的调度决策；内存中的观测或缓存 MUST NOT 改变该决策。若无法保证一致，Runtime MUST 报告持久化数据已损坏。
- 每个 Run 在同一时刻 MUST 至多存在一个活跃的调度所有者。写入 Attempt 结果、Artifact、进度更新或控制指令前，Runtime MUST 确认写入方仍是该 Run 当前的调度所有者；调度所有权已经更替时，MUST 拒绝过期写入（ownership fencing），确保迟到或已被取代的工作无法覆盖已接受的有效状态。
- 已就绪的工作 MUST 严格遵守 Run 级别的最大并发上限，以及外层 Parallel 或 Fanout 所配置的并发限制策略。因局部并发受限而排队的工作，MUST NOT 阻碍其他满足条件的独立工作启动执行。
- 无论是 Task 还是 Agent 的 Attempt，在配置、启动、实际执行与崩溃恢复的全生命周期中，MUST 共享同一个持久化的截止时间预算。当超时或取消操作与迟到的执行结果发生竞争时，超时与取消 MUST 优先胜出并生效；故障恢复流程 MUST NOT 重置或延长该截止时间预算。
- 故障恢复过程中，Runtime 在启动新的替代工作之前，MUST 先完成对已过期工作的收尾处理（settlement），并在持久化存储中将过期的 Attempt 标记为已被取代。已被取代的 Attempt MUST NOT 继续占用并发执行配额，也 MUST NOT 重新获得写入状态的权限。
- 写入隔离机制 MUST 完整覆盖 Acpus 内部的持久化结果、进度记录以及 Artifact 注册。当发生超时、取消、Retry、崩溃恢复或 Steer 时，Runtime MUST NOT 承诺外部 Task 或 Agent 所产生的外部副作用具备精确一次交付或自动回滚。
- 单个 Run 意外崩溃时，Runtime MUST NOT 因此阻塞其他并发 Run。发生故障的 Run MUST 保持可检查；当其持久化状态再次满足推进条件时，后续恢复流程 MUST 能够重新推进该 Run。
- 若系统中仅剩下已暂停的 Run 或没有设置超时时限的 Signal 等待，Runtime MUST NOT 因此保持本地守护进程后台常驻。所有带有超时的等待以及可立即推进的持久化工作，MUST 能够直接从存储中恢复，无需操作者手动重建内存状态。

### Task、Signal 与 Artifact 执行

- 不同的 Task Attempt 之间 MUST NOT 共享任何可变模块或进程内存状态；每次 Attempt 启动时 MUST 获得独立初始化的全新执行环境。
- Task 的当前工作目录（cwd）MUST 默认指向 Run 所在的工作区，并以该工作区为基准解析声明的相对路径。Task 的环境变量 MUST 以 Host 进程的环境变量为基础，并叠加声明的环境变量覆盖项。模块初始化代码、Task 业务逻辑以及命令行辅助工具，MUST 看到完全一致的生效 cwd 与环境变量。
- 每个 Attempt 的实际输入、cwd、环境变量覆盖项与截止时间，MUST 在启动前确定并在该 Attempt 存续期间保持不变；实际使用的值 MUST 与 Forensics（深度诊断）视图展示的数据一致。
- Runtime 在准入、执行、持久化和检查 Task 输入与结果时，MUST 始终使用 [Core](core-spec.md) 定义的同一套数据语义。
- Task 执行结果 MUST 保持为持久化的结构化数据值，MUST NOT 隐式创建文件。Runtime MUST 仅通过显式的 Artifact 写入接口，创建并注册属于当前 Run 的 Artifact。
- Artifact 引用 MUST 严格限制在当前 Run 作用域内，且只能解析为已注册并校验通过的普通文件。凡是格式错误、跨 Run 越权、未注册、文件缺失或存在路径穿越风险的引用，Runtime MUST 拒绝并报错，MUST NOT 向外暴露未经安全检查的本地文件路径。
- Signal 等待状态 MUST 持久化记录渲染后的 Prompt、规范化后的 Payload Schema 以及剩余超时时间。执行暂停与恢复操作时，Runtime MUST 正确挂起和恢复带超时的等待计时器，且 MUST NOT 接受超时后到达或重复提交的 Payload。
- 处于等待状态的 Signal MUST 继续占用其所在外层 Composite 节点的局部并发槽位，同时 MUST NOT 占用 Run 级别的 Task 或 Agent 执行并发配额。

### Agent 绑定与执行

- 在准入阶段，Runtime MUST 为 Workflow 中声明的每个 Agent 解析出唯一的具体定义。如果仍有未解析的 Slot 或无效的 Agent 注入，Runtime MUST 在准入时报错；成功解析后，Runtime MUST 冻结实际生效的 Agent 定义及其来源信息。
- Agent Preset 的选择、合并优先级与持久化规则 MUST 遵循 [Configuration](configuration-spec.md) 契约。常规的 Run 状态与只读检查视图中，MUST NOT 泄露展开后的 Preset 原始内容、具体执行命令、敏感配置、环境变量或冻结的注入细节。
- Runtime MUST 仅依据 [Agent Executor](agent-executor-spec.md) 返回的规范化结果与结构化执行证据来做出持久化调度决策；MUST NOT 将底层的 ACP 传输协议帧或子进程拓扑直接当作调度器状态。
- Agent Session 的上下文连续性 MUST 严格限制在当前 Run 内。Turn 正常完成后，或 Runtime 正常关闭并重启后，Runtime MUST 保持 Session 连续有效；Runtime MUST 仅允许 Retry、Steer 或 Fork 按照后文的控制契约重置或调整该连续性。
- 未指定输出 Schema 时，Agent 结果 MUST 是该 Turn 正常完成后的最终文本响应，Runtime MUST NOT 为其发起格式修复 Turn。指定输出 Schema 时，Agent 结果 MUST 是符合已冻结 Schema 的 JSON 值；该值被接受后，Runtime MUST 按声明转换并持久化为节点结果。
- 当配置了 Schema 校验且修复次数受限时，Runtime MAY 在同一 Attempt、同一 Agent Session 且当前截止时间未到期的前提下，向 Agent 发起修复请求以获取完整的替换输出。模型、Provider 或传输层故障 MUST NOT 被误判为输出 Schema 不匹配。
- Agent 的失败元数据与进度更新 MUST 只包含必要信息且大小受限，MUST NOT 被当作已接受的节点最终输出。每个 Turn 的完整执行证据 MUST 单独保存在其注册的私有 Artifact 中；[ACP](acp-spec.md) Session 的恢复数据（projection）仅作为大小受限的恢复状态，MUST NOT 替代完整的 Turn 执行历史。

### Agent 语义观测

- 大小受限的语义活动、进度更新、检查点证据与最终 Turn 完成证据，对外 MUST 呈现为一个逻辑一致的视图。
- 常规公开的观测数据中，Runtime MUST NOT 持久化或向外泄露原始的 Provider 协议帧、精确的 Prompt 内容、Steer 指令原文、最终响应文本、工具调用的详细入参与输出，以及 Provider 内部标识。公开观测数据 MAY 包含大小受限的当前活动描述、近期已结束的语义活动摘要、规范化的工具标识与调用状态，以及聚合后的 Token 用量。
- 观测记录并非严格完整的审计日志。因保留策略清理而遗漏的数据、未知的 Provider 内部行为、丢失的生命周期边界或缺失的收尾证据，MUST 在记录中明确标为缺失；Runtime 生成状态视图时，MUST NOT 凭空补全 Provider 执行结果、最终响应文本或语义事件。
- 控制操作生效后，Runtime MUST NOT 让此前的活动或迟到返回的 Provider 活动再修改 Run。Runtime MAY 继续跟踪被取代的 Provider 直至其完成收尾，但其迟到返回的输出、常规 Artifact 写入、进度更新或执行结果，MUST NOT 再对 Run 的状态产生任何修改。
- 任何不完整的观测记录 MUST 始终保持仅供展示参考：它们 MUST NOT 参与调度器的任何控制与流转决策，在故障恢复期间也 MUST NOT 被伪装成完整无缺的历史记录。

### 控制与守护进程

- 进程内嵌入的 Runtime 与本地常驻守护进程 MUST 执行同一套工作区所有权、准入、控制与检查契约。不同根目录下的 Runtime 状态 MUST 各自独立；Host 与 CLI MUST NOT 跨根目录共享状态，也 MUST NOT 根据一个根目录的状态推断另一个根目录的状态。
- 本地守护进程 MUST 始终作为仅供本机调用的私有本地适配器运行，MUST NOT 作为对外开放的网络服务暴露。
- 工作流提交与控制操作的请求 ID MUST 具备严格的幂等性。使用相同的请求 ID 重放相同操作意图时，Runtime MUST 返回最初执行的结果；若将同一请求 ID 用于任何不同的操作意图，Runtime MUST 拒绝请求并报错，且 MUST NOT 修改任何状态。
- 控制操作被拒绝时，Runtime MUST 保持当前状态完全不变；被拒绝的 Fork MUST NOT 创建子 Run。Client 展示的控制可用性仅代表查询时刻的快照；实际提交控制指令时，Runtime MUST 在同一原子操作中重新校验目标节点、当前写入权限与操作合法性。
- Runtime 在任何状态变更提交前，MUST 确认调用方提供的 Runtime authority（当前 Runtime 实例身份）仍与该工作区的有效 Runtime 实例一致。Client 意外断开 MUST NOT 导致正在准入或已准入的 Run 被取消；若准入结果尚未确定，调用方 MUST 使用幂等请求 ID 重新查询，MUST NOT 直接假定请求已超时失败。
- 执行 Pause（暂停）时，Runtime MUST 先持久化暂停状态，使调度器不再接受新的工作，然后再停止该 Pause 覆盖范围内的活跃工作。执行 Resume（恢复）时，Runtime MUST 在确立新的调度所有权后，直接从持久化状态中恢复执行。这两种操作自身都 MUST 支持安全的幂等重放。
- Cancel（取消）MUST 支持取消整个 Run，也 MUST 支持取消指定的非终态目标。取消操作在返回之前，MUST 禁止所有受影响的执行活动继续写入，保留与之无关且已接受的有效成果，并确保针对整个 Run 的重复取消具备幂等性。
- Retry（重试）MUST 显式指向处于失败或超时状态的 Task、Agent 或 Composite 执行帧；Runtime MUST NOT 提供隐式的全 Run Retry。Retry MUST 只重新激活目标以及产出其结果所必需的失败祖先或依赖项闭包，同时 MUST 保留该闭包之外所有已接受的成功成果。
- 对局部 Agent 节点执行 Retry 时，Runtime MUST 先释放每个受影响 Agent Session 的现有所有权（neutralize）。若重试目标涉及与其他节点显式共享的 Session，Runtime MUST 拒绝该请求且 MUST NOT 修改状态，并提示操作者通过 Fork 创建独立分支。
- Steer（动态干预）MUST 明确指向当前唯一处于活跃状态的 Agent Turn。Runtime 接受 Steer 操作后，在向调用方返回前 MUST 持久化撤销当前 Attempt 的写入权限。新的替代 Attempt MUST 等到被取代的 Turn 完成收尾后方可启动，随后在同一个已冻结的 Run 与同一个 Agent Session 中接收新的干预指令继续执行。
- Fork MUST 创建一个新的待执行子 Run，同时保持原始 Run 的状态完全不变。除非在调用时显式指定替换，子 Run MUST 完整继承原始 Run 中已冻结的 Workflow 定义、输入参数与 Agent 绑定，随后从初始调度状态开始推进。
- Fork 在复用原始 Run 的历史结果时，MUST 仅复用那些生效定义与解析后的 Workflow 数据值均未发生改变的已接受成果。外部环境文件、网络状态、系统时间、随机数生成、Provider 内部行为以及开发者声明的函数纯度，都 MUST NOT 被擅自推测为可靠的复用依赖条件。
- 多个 Agent 节点若显式共享同一个 Session，它们在原始 Run 中的执行结果 MUST 按照在源 Run 中被接受的顺序整体复用（要么全部复用，要么全不复用）。当针对特定目标节点执行定向 Fork 时，Runtime MUST 重新执行该目标节点以及在它首次就绪之后才完成的所有原始工作，MUST NOT 尝试从中间阶段部分重放该 Session。
- 触发 Signal 控制操作时，Runtime MUST 消费且仅消费一个处于打开状态的明确 Signal 等待项及其规范化 Payload，并从持久化状态恢复调度推进。若指定的等待项存在歧义、已关闭或 Payload 格式不兼容，操作 MUST 失败并报告错误，且 MUST NOT 误消费其他等待项。
- Runtime 对外报告某项控制是否可用时，MUST 使用与实际提交时相同的合法性规则；该结果仅代表查询时刻的状态。Client MUST NOT 仅凭界面展示数据或局部状态，自行推导 Retry、Steer、Cancel 或 Signal 是否合法。
- 执行有序关闭（graceful shutdown）时，若当前工作区仍有 Run 正由 Runtime 执行，Runtime MUST 拒绝关闭请求，且 MUST NOT 篡改任何 Run 状态。Runtime MUST NOT 提供强制关闭控制。

### 修剪（Prune）

- 执行修剪时，Runtime MUST 只选择已处于终态的 Run，以及已不再是当前存储且内容完整的归档存储。修剪 MUST 默认只作用于当前工作区；若要跨工作区清理，调用方 MUST 显式指定范围。
- 演练模式（dry-run）MUST 执行与实际修剪完全相同的过滤规则与空间占用统计，且 MUST NOT 修改任何 Run 记录、底层存储、源码文件或工作区状态。
- 执行实际修剪时，Runtime MUST 重新校验预览阶段所获取的终态标记与保留截止时间。凡是在预览之后状态发生变更、已被恢复运行或已不存在的 Run，Runtime MUST 自动跳过，MUST NOT 基于陈旧的预览快照强行删除。
- 修剪 MUST 将每个 Run 或归档存储作为一个完整单元删除。只有在没有其他现存 Run 引用某份已冻结的 Workflow 源码时，Runtime MAY 删除该源码；只有在某个工作区不再包含需要保留的状态，且不存在活跃所有者进程时，Runtime MAY 移除该工作区目录。
- 某个工作区在修剪过程中发生失败，MUST NOT 阻碍其他工作区继续执行修剪；最终生成的修剪报告 MUST 准确记录已成功删除的条目数，即使后续条目的修剪失败，也 MUST NOT 丢失已完成的统计数据。

### 读取 API 与守护进程生命周期

- 读取 Run 详情、Artifact、健康状态、流程可视化或检查数据时，Runtime MUST 直接读取持久化的冻结数据，MUST NOT 加载工作区中当前的 Workflow 源码，也 MUST NOT 启动后台守护进程。涉及多个组成部分的读取和实时观测流 MUST 固定使用同一个存储快照；该快照不再有效时，观测流 MUST 立即关闭。
- 健康检查 MUST 始终保持只读。发现需要人工干预的存储损坏或所有权冲突时，Runtime MUST 明确报告原因并给出可执行的下一步，MUST NOT 笼统报告为“服务不可用”。
- 持有活跃写入权限的 Runtime 实例，MUST 阻止任何其他竞争进程获取可写所有权。一旦检测到所有权丢失，Runtime MUST 在释放存储资源前立即终止后续的调度流转与状态写入；在执行有序关闭时，Runtime MUST 尝试每个独立的资源清理阶段，并完整记录可能出现的多处清理失败错误。

#### 检查

- Runtime 负责为 Run 详情、节点目标、实时观测、Forensics 深度诊断以及歧义消解提供统一连贯的检查模型。展示层 Client MUST 通过该模型获取数据，MUST NOT 绕过 Runtime 自行查询持久化存储，也 MUST NOT 自行推导动态执行拓扑。
- 检查目标 MAY 是根节点、声明的静态节点、具体运行实例（occurrence）或特定 Attempt。目标格式错误或不存在时，Runtime MUST 报错；若指定的静态节点对应多个运行实例，Runtime MUST 返回顺序稳定的候选列表供调用方选择，MUST NOT 自动选中其中一个。
- 检查接口 MUST 仅将调度器正式接受的运行实例结果或根节点输出，作为最终有效的执行结果。已经执行完成但随后被取代或未被调度器接受的 Attempt，MUST NOT 将其候选输出作为正式的节点结果对外暴露。
- Summary（摘要）与 Timeline（时间线）对外 MUST 只提供大小受限的必要状态信息，且 MUST NOT 包含原始 Provider 通信数据、敏感配置、环境变量、Steer 指令明文、Hook 详情或内部实现标识。历史记录存在缺口时，展示层 MUST 明确标出缺失的部分，且当前状态仍 MUST 保持可读。
- Forensics 视图在重建冻结定义、实际调用参数和已接受结果时，MUST 严格依据准入时记录的 IR 以及持久化的调度决策与执行证据。它 MUST NOT 读取工作区中当前的 Workflow 源码或 Preset，MUST NOT 重新计算表达式，也 MUST NOT 从进度上报或 Provider 原始响应中自行推测节点输出。
- Forensics 深度诊断接口 MUST 仅允许本机调用方显式访问；该接口 MAY 展示未截断的调用数据，包括 Prompt 原文、声明的配置项以及由 Acpus 管理的环境变量。这类可能包含敏感信息的诊断数据 MUST 与通用的 Summary 和 Timeline 公开视图严格隔离。
- 默认呈现的 Run 执行树 MAY 折叠显示重复的 Composite 结构，但 MUST NOT 把多个运行实例各自的耗时、遥测指标或需要人工关注的告警合并成一条共享数据。实际展开的执行视图中，MUST 完整保留每个可独立寻址的运行实例。
- 观测流启动后 MUST 始终锁定最初解析出的目标。监听运行实例时，观测流 MUST 跟随其重试后的替代 Attempt 继续展示；监听特定 Attempt 时，该 Attempt 失去写入权限或完成收尾后，观测流 MUST NOT 自动重定向到其他 Attempt。
- 决策级观测事件 MUST 只在发生能够改变调用方后续决策的连贯状态变更时发出。活动级观测事件 MUST 显式发出且大小受限；单纯的时间流逝、资源用量增加、一段时间没有消息或心跳过期，MUST NOT 被当作决策事件发出。
- 监听特定主体的观测流 MUST 仅在该主体自身完成收尾并达到终态时关闭。监听决策边界的观测流 MUST 仅在关联的 Run 或目标节点达到终态、进入暂停，或停在需要人工处理的 Signal 交互边界时关闭；与当前决策无关的局部失败或已被上层容错吸收的分支失败，MUST NOT 导致决策观测流提前关闭。

## 验证

- `pnpm test:type packages/runtime` 与 `pnpm test:contract packages/runtime`：验证调用方可见的 Runtime、Host 和守护进程边界。
- `pnpm test:unit packages/runtime`：验证调度、控制、检查、隐私以及决策契约。
- `pnpm test:integration packages/runtime`：验证持久化准入、执行、修复、所有权、恢复、Artifact 与观测。
