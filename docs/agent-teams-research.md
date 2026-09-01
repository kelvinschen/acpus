# Claude Code Agent Teams 调研与 Acpus 落地

本文以 Claude Code **v2.1.241** 为版本基线，目标不是复刻其私有文件格式，
而是识别 Agent Teams 中能够跨 Agent 实现成立的协作语义，并说明这些语义如何
落到 ACP v1 与 Acpus 现有执行边界上。

## 结论

Agent Teams 的关键不是“同时启动多个 Agent”，而是把多个独立 Session 置于同一个
可见、可竞争且可追溯的控制平面中：固定 lead 负责建立团队和综合结果，teammate
拥有独立上下文，通过共享任务板和定向 mailbox 自主协调。任务依赖决定何时可以
工作，原子 claim 决定谁获得工作，消息让成员能够交换任务板之外的证据。

对 Acpus 而言，最小而完整的实现应当：

- 新建独立的 `@acpus/agent-teams`，而不是把动态协作塞进静态 Workflow Runtime；
- 复用 `@acpus/agent-executor` 打开真实且互相隔离的 ACP Session；
- 让所有 ACP agent 通过同一组 CLI 命令操作任务、mailbox 和成员状态；
- 由 SQLite 保存唯一权威状态，以事务和 compare-and-swap（CAS）处理竞争；
- 以前台 host 持有 Session，以持久化、按成员递增的 wake generation 合并并驱动
  后续 Turn；
- 记录 agent 可读的协调轨迹，用真实运行轨迹反复校准 prompt、CLI 回执和状态机。

这一路径保留了 Claude Code 的协作内核，又避免绑定其 tmux、JSON inbox、隐式工具
注入或历史版本 API。当前 MVP 不包含后台 daemon、MCP 适配、完整的崩溃后 Session
恢复或 plan approval 协议。

## 资料分级与版本边界

| 级别 | 用途 | 资料 |
| --- | --- | --- |
| 现行契约 | 判断 v2.1.241 中用户可以依赖的行为 | [Claude Code Agent Teams 官方文档](https://code.claude.com/docs/en/agent-teams)、[v2.1.241 changelog](https://github.com/anthropics/claude-code/blob/v2.1.241/CHANGELOG.md) |
| 协议契约 | 判断 ACP 能表达什么，不把 Agent Teams 私有机制误写进 ACP | [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview)、[ACP 官方仓库与版本说明](https://github.com/agentclientprotocol/agent-client-protocol)、[ACP v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json) |
| 实现版本边界 | 区分本仓实际 wire contract 与上游仍在演进的能力 | [Acpus 固定 SDK 1.3.0](../packages/acp/package.json)、[TypeScript SDK v1.4.0](https://github.com/agentclientprotocol/typescript-sdk/releases/tag/v1.4.0)、[delegation draft PR #855](https://github.com/agentclientprotocol/agent-client-protocol/pull/855)、[`session/fork` RFD 状态](https://agentclientprotocol.com/rfds/updates) |
| 早期逆向 | 理解首发实现的磁盘形态和故障，但不作为现行 API | [运行中团队的磁盘快照](https://gist.github.com/avocade/ca93ab36b6c01ab4f41cd1cf20d37b13)、[逆向分析文章](https://dev.to/nwyin/reverse-engineering-claude-code-agent-teams-architecture-and-protocol-o49) |
| 真实实践 | 检查哪些协调模式在实际任务中有效 | [并行 Claude 构建 C compiler](https://www.anthropic.com/engineering/building-c-compiler)、[Anthropic 多 Agent Research 系统](https://www.anthropic.com/engineering/multi-agent-research-system)、[v2.1.178+ orchestration skill](https://github.com/mttzzz/claude-code-agent-teams)、[跨 harness 的早期复刻](https://github.com/cs50victor/claude-code-teams-mcp) |

其中官方文档与 v2.1.241 changelog 是本报告描述 Claude Code 行为时的权威来源。
逆向资料只证明“某次运行曾观测到”，社区项目只证明某种实现或操作方式可行；两者
都不能覆盖官方契约。本文出现“推断”时，表示结论是从以上证据映射到 Acpus 后得到
的设计选择，而不是 Anthropic 或 ACP 的承诺。

## Claude Code v2.1.241 的现行设计

### 从独立 API 到隐式团队

Agent Teams 在 v2.1.32 以 research preview 发布。v2.1.178 删除了
`TeamCreate`/`TeamDelete`：启用实验开关后，每个交互 Session 只有一个隐式 team，
带 `name` 的 Agent spawn 直接成为 teammate，`team_name` 即使仍被接受也会被忽略。
v2.1.207 修复了畸形 mailbox 条目导致整条 mailbox 持续报错的问题；v2.1.234 移除
独立的默认 teammate model 配置；v2.1.239 修正 `ListAgents`/`SendMessage` 的成员发现
和寻址。v2.1.241 自身只标为 bug fixes and reliability improvements，
所以正确基线是“v2.1.178 后的隐式团队模型，加上截至 v2.1.241 的可靠性修正”，
而不是首发时的显式 team API。

这段演进带来两个长期信号：

1. team 是 lead Session 的协作作用域，而不是用户预先编排的持久拓扑；
2. `TeamCreate`、`TeamDelete`、`broadcast`、手工 inbox polling 等早期表面不应被
   当作可移植的核心抽象。

### 四个组成部分

官方文档把 team 分为四部分：

| 部分 | 稳定含义 |
| --- | --- |
| Lead | 创建 teammate、协调工作并综合最终结果的固定主 Session |
| Teammate | 具有独立上下文窗口和工具循环的完整 Claude Code Session |
| Task list | 所有成员可见、支持 owner、状态和依赖关系的共享工作板 |
| Mailbox | 按成员寻址、允许 teammate 彼此直接沟通的消息通道 |

teammate 会加载项目上下文、skills 和 MCP servers，并收到 spawn prompt，但不会继承
lead 的对话历史。这解释了为什么高质量 spawn prompt 必须自包含，也解释了共享任务
板与 mailbox 不能被“大家都看见 lead 的上下文”替代。

Team 与 subagent 的本质差别也在这里：subagent 的结果主要回到调用者；teammate
是可再次寻址的独立成员，能够读同一任务板并给任意 teammate 发消息。并行度只是
结果，自协调能力才是选择 Agent Teams 的理由。

### 任务板是协调协议

现行文档定义 `pending`、`in progress`、`completed` 三种任务状态。任务可以声明
依赖；未解决依赖的任务不能被 claim，依赖完成后被阻塞任务自动解锁。lead 可以
指派 owner，teammate 也可以从未分配、未阻塞的任务中自助 claim。官方实现使用
文件锁避免多个 teammate 同时获得同一任务。

这里真正可移植的是以下不变式，而不是“一个任务一个 JSON 文件”：

- claim 必须是原子状态转换；
- 可执行性必须由权威依赖状态判断，不能由 Agent 根据过期列表自行猜测；
- 列表是快照，写入必须重新验证；
- 完成任务应当在同一权威状态中解锁后继，而不是靠消息提示碰运气；
- owner、任务状态与成果说明是不同字段，不能用自然语言消息替代状态变更。

### Mailbox 是协作补充，不是第二个任务板

当前 Claude Code 会把每个成员的 mailbox 保存为本地 JSON 文件。只有在写入接收方
mailbox 成功后，发送才算成功；单条畸形消息会被报告和移除，合法消息仍能继续交付。
消息自动进入接收者上下文，lead 不需要轮询。普通文本、idle、shutdown 和 plan
approval 都可能使用该通道，但这些具体消息类型不等于 Agent Teams 的最小语义。

官方还明确把来自其他 Agent 的消息标记为“另一个 Claude Session”，而不是用户
输入。teammate 不能通过转述获得用户授权，也不能把被拒绝的操作转交给别的成员来
绕过权限。这提示 Acpus 保留两个边界：消息必须保留明确的 actor 归属；消息内容仍是
不可信协作输入，不能赋予新的执行权限。这里的归属是可信本地协作中的路由信息，不等于
密码学身份、操作系统凭据或不可伪造的授权主体。

### 固定拓扑和已知限制

Claude Code 当前每个 Session 只有一个 team，lead 在 team 生命周期内固定，
teammate 不能再 spawn teammate。in-process teammate 不支持完整 `/resume`/`/rewind`
恢复；任务状态可能因成员忘记更新而滞后；shutdown 也可能等待当前 tool call。
这些限制与模型能力无关，而是在抑制控制平面组合爆炸：固定根节点使权限、资源归属、
失败汇总和终止顺序都保持可判定。

因此本轮 Acpus MVP 也采用固定 lead、禁止 nested team，并明确把前台 host 退出后的
完整恢复留在当前边界之外。

## 早期逆向资料：保留启发，不复制格式

2026 年 2 月的团队磁盘快照和逆向文章记录了早期实现：`config.json` 保存成员，
每个任务是独立 JSON，`.lock` 与 `.highwatermark` 协调任务 ID 和并发，mailbox 是
按成员分开的 JSON 数组。任务指派、idle、shutdown、plan approval 等结构化消息
被序列化进 mailbox；观察者还记录到 inbox 单调增长、重复消息、死成员仍可接收写入、
依赖在一次运行中未被强制执行、共享工作树冲突等现象。

这些记录很有价值，但必须按时间解释：

| 早期观察 | v2.1.241 结论 |
| --- | --- |
| `TeamCreate`/`TeamDelete` 与显式 team name | v2.1.178 已移除，不能作为现行契约 |
| 手工读取或轮询 inbox | 当前消息自动交付；轮询属于历史实现观察 |
| JSON 文件、`.lock`、`.highwatermark` | 证明本地共享状态可行，不是可移植 API |
| 依赖仅为 advisory | 与现行官方“blocked task 不能 claim”冲突，只能视为早期缺陷或观察范围限制 |
| mailbox 写入即发送成功 | 现行官方仍明确保留此确认边界 |
| 独立 Session、固定 lead、任务板、按名寻址 | 已由现行官方文档确认，是可复用语义 |

社区的 `claude-code-teams-mcp` 进一步证明这套控制平面可以从 Claude Code harness 中
剥离，但它复刻的是早期显式 team、tmux 和文件布局，而且 teammate 通信权限也与
现行官方文档不同。Acpus 因而不采用“兼容 Claude 私有目录”或“先做 MCP server”
的路线。

## 真实实践给出的设计约束

### 并行只在工作可分时产生价值

Anthropic 的 C compiler 实验使用 16 个 Agent、近 2,000 个 Claude Code Session。
它同时展示了成功条件与失败条件：大量独立测试失败很容易分片；进入只有一条失败链的
Linux kernel 编译阶段后，所有 Agent 会撞上同一问题并互相覆盖。把问题重新构造成
可以随机切分、由 GCC 充当 oracle 的子集后，并行才重新有效。

因此 team 不应自动把“更多 teammate”视作进度。task description 需要写清验收证据和
文件边界；紧密串行工作应保留为依赖链或交给单个 Agent。

### 环境反馈比复杂编排更重要

C compiler 实验最有效的投入是高质量测试、短而可搜索的错误输出、持续集成、清晰的
README/progress artifact 和独立工作区。Anthropic 的多 Agent Research 系统也报告：
早期 Agent 会为简单问题 spawn 过多 worker、寻找不存在的来源、用过量状态更新互相
干扰；团队通过逐步观察真实轨迹来修改 prompt 和工具设计。

这支持本轮“至少五轮真实 ACP 运行再优化”的方法：优化对象首先应是 agent-computer
interface——命令名、回执、错误、可见状态 delta 与交接说明——而不是预先堆叠更复杂
的调度策略。

### 独立上下文既是收益也是成本

独立 Session 减少单一路径依赖，适合多视角研究、竞争假设、跨层实现和独立 review；
代价是 token 用量随成员数增长，spawn prompt 必须重复必要上下文，交接遗漏会形成新的
失败模式。社区 v2.1.178+ skill 的实践建议与官方文档一致：用清晰文件边界避免同文件
并发编辑，让成员通过显式消息分享结果，并在写任务前重新读取当前状态。

## 为什么不能直接复用 Acpus Workflow Runtime

| 维度 | Acpus Workflow | Agent Teams |
| --- | --- | --- |
| 拓扑来源 | 编译时声明并冻结的静态图 | team 运行中由 lead/teammate 创建和领取任务 |
| 推进权 | Runtime 根据冻结 IR 做权威调度 | Agent 根据共享状态选择下一项合法动作 |
| 通信 | 节点输出沿显式图边传递 | mailbox 支持任意现存成员之间的定向协作 |
| Agent 生命周期 | 节点 Attempt/Session 服从 Run 计划 | 成员 Session 跨多个动态任务保持身份 |
| 结果边界 | 根节点产生类型化、可持久结果 | lead 综合任务状态、消息和工作区证据 |
| 失败恢复 | durable scheduler、fencing、Retry/Fork/Steer | MVP 由前台 host 管理，保留协调状态但不承诺完整 Session 恢复 |

强行复用 Workflow Runtime 会出现两种坏结果：要么把运行时创建的任务伪装成静态 IR，
破坏冻结图契约；要么在 Runtime 旁边再实现一套动态例外，使 scheduler 不再是唯一推进
权威。独立包让两种产品保持各自简单：Workflow 继续擅长可重放编排，Agent Teams
专注于自治协作。

可复用的正确层级是 `@acpus/agent-executor`。它已经负责命名 Agent 解析、ACP Session
独占租约、Turn 收尾、取消和 owned-process 清理；Agent Teams 只需要决定“哪个成员何时
收到什么 team delta”，无需重做 ACP transport 或 Provider 特例。

## 基于 ACP v1 的实现映射

ACP v1 定义 Client 与 coding agent 之间的 JSON-RPC Session：初始化后创建或加载
Session，Client 发送 `session/prompt`，Agent 用 `session/update` 报告进度并最终返回
stop reason；Agent 还可以请求 Client 提供的文件系统和 terminal 能力。ACP 没有 team、
task board 或 peer mailbox 方法。

本实现的版本边界比“ACP v1”更精确：`@acpus/acp` 固定
`@agentclientprotocol/sdk` **1.3.0**，使用稳定 v1 entry point，并在 wire initialize 上
发送且只接受 `protocolVersion: 1`。截至 2026-08-24，上游 TypeScript SDK 最新版本是
**1.4.0**；SDK package 版本和 wire protocol version 是两个不同维度。上游正在讨论
原生 subagent discovery/delegation 的 [draft PR #855](https://github.com/agentclientprotocol/agent-client-protocol/pull/855)，
`session/fork` 也仍处于 [RFD Draft](https://agentclientprotocol.com/rfds/updates)。当前实现不调用
delegation 或 `session/fork`：每个 teammate 都是 Agent Executor 打开的独立新 Session，
team 语义完全由本地 CLI/SQLite 控制平面提供。

这不是缺口，而是合理分层：

```text
operator
   |
foreground Agent Teams host
   |-- SQLite: members + tasks + dependencies + mailbox + trajectory + wake generation
   |-- Agent Executor lease --> ACP Session: lead
   `-- Agent Executor lease --> ACP Session: teammate ...
                                  |
                                  `-- terminal/create: acp-teams <coordination command>
```

CLI 是 ACP 无关的 agent-computer interface。任何获得 terminal 能力的 ACP agent 都能
调用；host 把 team/member 上下文注入该 Session 的执行环境，CLI 再对 SQLite 做短
事务。每次 team run 可以选择 Claude、Codex 或其他受支持的 ACP provider，并使用同一
控制语义；同一个 team 内的所有成员当前使用 run 选择的同一 provider 和 model，不支持
逐成员混用。整个方案无需 provider 支持私有 tool injection，也无需先增加 MCP。

当前落地的操作者入口是 `acp-teams run --agent <name> "<goal>"`，也可以用
`--command` 选择显式 ACP agent 命令。host 向成员 Session 注入 `ACP_TEAM_STATE`、
`ACP_TEAM_ID`、`ACP_TEAM_MEMBER` 和 `ACP_TEAM_CLI`；成员通过
`node "$ACP_TEAM_CLI" ...` 使用同一个可执行文件：

| CLI 面 | 作用 |
| --- | --- |
| `status`、`task list` | 读取紧凑的成员与任务权威快照 |
| `wait --timeout-ms N` | 在 CLI 内等待全部共享任务完成、team 终止或超时，避免 Agent 自己编写轮询循环 |
| `task create/claim/complete` | 创建依赖任务、原子领取并提交结果证据 |
| `teammate spawn/list/stop` | 由固定 lead 管理 teammate；spawn 同时绑定一个既有任务 |
| `message send`、`inbox` | 向指定成员写消息并按 cursor 读取自己的 mailbox |
| `complete` | 由 lead 在任务完成且 teammate 不再执行时提交最终总结 |
| `trajectory` | 导出 task/member、Turn 与 ACP journal，供复盘和优化 |

### 信任、角色与权限边界

`ACP_TEAM_MEMBER` 是前台 host 注入的**可信本地路由身份**。CLI 用它在数据库中找到 member，
再以该 member 的 role 执行 supported-interface check，例如只有 lead 可以 spawn/stop
teammate 或完成 team。它不是认证令牌：能够控制同一进程环境、调用 CLI 时覆盖环境变量，
或直接写入 state database 的对手可以伪造路由身份。固定 lead 因此是协作协议与 CLI
状态机约束，不是 adversarial security boundary；MVP 没有按成员的 OS 隔离、签名 actor、
capability token 或数据库访问控制。

当前 runtime 还对**所有**成员 Session 使用 Agent Executor 的
`permissionMode: "approve-all"`。这意味着没有交互审批、lead 代批或逐成员 permission
policy；peer message 也不会触发新的权限判断。该模式只适用于调用者已经隔离并信任的本地
工作区，不应在包含秘密、生产凭据或不可信代码的共享环境中当作安全沙箱。

在 POSIX 本地部署中，持久化采用 least-access 默认值：已存在的 state path 必须是普通、
非 symlink 文件，SQLite 文件设为 `0600`，managed ACP worker/session 目录必须是
真实目录并设为 `0700`。
这些措施减少跨 OS user 的意外暴露，但不能阻止同一用户下的进程改写环境或数据库，因此
不改变上述 trusted-workspace 边界。

### 权威状态与竞争

每个 SQLite state database 只属于一个 team；在同一数据库中创建第二个 team 会被拒绝，
避免让两套成员身份和 host ownership 意外共享一个协调作用域。该数据库是 task、
dependency、message、member state 和 trajectory 的唯一权威来源。
claim 使用带状态前置条件的 compare-and-swap，并在事务中重新验证 owner、状态与依赖。
竞争失败返回明确冲突，Agent 必须重新读取权威状态再选择下一动作，不能把失败重试成
覆盖写。

supported teammate spawn 会在一个事务中创建 member、绑定既有 pending task 并写入首轮
direct guidance；guidance 非法时三者都不生效。Turn start 也在创建 Turn 的同一事务中统计
team 已使用的 Turn 并执行 `maxTurns` 准入，避免并发 member 同时越过全队预算。

mailbox 消息在提交后才算已发送，并按接收者维持稳定顺序。消息不会替代 task 状态；
例如“我完成了”这句话不会自动把任务改成 completed。当前明确 journal 的 mutation 是：
team create/complete/fail，member spawn/fail/stop/nudge，task create/claim/complete，direct
message send，以及 Turn start/finish/cancel；runtime 接受的 ACP observation 也单独追加 event。
这些 mutation 的状态与 event 在同一事务中提交。`inbox` 推进 cursor 属于读取进度，不写
journal event；因此 trajectory 不能被描述成“任何数据库写入都有事件”。

### Wake generation

每个成员都有单调递增的 wake generation。可能改变该成员下一步动作的 task、message
或 nudge 在提交时推进它；前台 host 记住该成员已经处理的 generation，只有发现更大的
generation 时才开始下一次 ACP Turn，并让 Agent 读取当前 task/mailbox 状态。
generation 只是持久化观察游标，不是另一份状态，也不允许绕开 CAS。

这个设计不会把时间流逝或重复观察误当成新工作，也不会因短生命周期 CLI 调用结束而
丢失已提交的唤醒。它不等于完整 crash resume：host 意外退出后
如何恢复每个 Provider Session，仍取决于 ACP capability、Agent Executor ownership 与
后续明确的恢复设计。

## MVP 边界

本轮落地范围是：

- 单一前台 host；
- 一个固定 lead 和若干不可再 spawn 成员的 teammate；
- 每个成员一个真实 ACP Session，并可在多个协调 Turn 中继续；
- Agent 通过 CLI 完成 task create/list、依赖、CAS claim、complete 和 mailbox 操作；
- SQLite 权威状态、wake generation 与可导出的 trajectory；
- 原子 spawn+guidance、事务内全队 Turn budget 准入和 owner-only state layout；
- host 终止时主动取消遗留 Turn、显式 shutdown Agent Executor supervisor、等待 member fiber；
  shutdown、Session cleanup 或取消持久化失败会使 run 失败，而不是报告 clean outcome。

以下能力不在本轮承诺中：后台 daemon 或远程服务、MCP 工具面、nested team、lead 转移、
plan approval、交互式或逐成员 permission policy、adversarial member isolation、tmux/多
pane UI、兼容 Claude Code 私有磁盘格式、完整 crash resume、自动 worktree/merge，以及
把 peer message 当作权限批准。

## 轨迹驱动的五轮优化、审查加固与最终回归

评估不能只看最终文本。每一轮都应保存 team、task、member、Turn、CLI mutation、message、
wake generation 与 ACP 观测的有序轨迹，并检查非法或重复 claim、遗漏消息、无状态变化的
空 Turn、无权威证据的完成结论和终态 Session ownership。优化以轨迹中可复现的
agent-computer interface 失败为输入，再在相同成功条件下复跑。

### 固定评测

本轮使用仓库中的 [`eval/agent-teams`](../eval/agent-teams/README.md) 作为固定 fixture。
它包含三个互不重叠、适合 teammate 并行实现的模块，以及一个只能由 lead 综合的
`report.js`；原始 fixture 的 7 个测试全部失败，完成态必须在不修改测试的前提下 7/7
通过。R0 基线、R1-R5 五次优化复跑，以及审查加固后的 R6 最终回归均使用：

- Trae `0.201.4` 的原生 ACP agent；
- fixture 的全新临时副本，避免上一轮文件污染；
- `max-teammates=3`、`max-turns=18`、`inactivity-ms=180000`；
- 同一个 goal、同一个 `node packages/agent-teams/dist/cli.js ... run --agent trae`
  操作者入口；
- SQLite 原始轨迹作为权威证据，再由 `trajectory` 命令导出检查视图。

可复现的命令形态如下，其中 `<cwd>` 是 fixture 的全新副本，`<db>` 位于该副本中：

```sh
node packages/agent-teams/dist/cli.js \
  --state <db> run --agent trae --cwd <cwd> \
  --max-teammates 3 --max-turns 18 --inactivity-ms 180000 \
  "Complete the evaluation fixture exactly as specified in README.md. Do not edit tests. Delegate the three independent work items, integrate report.js as lead, and make node --test pass."
```

原始数据库和大体积 transcript 是本机验证产物，不是发布契约，也不提交到仓库。精简的逐轮
证据保存在 [`results/rounds.json`](../eval/agent-teams/results/rounds.json)，保留策略见
[`trajectory/README.md`](../eval/agent-teams/trajectory/README.md)。下表中的事件数来自完整
SQLite journal，而不是受 `--limit` 约束的导出尾部。

| 运行 | 轨迹观察与本轮改动 | elapsed | Turn / message / event | provider-reported tokens | 导出大小 | 结果 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| R0 基线 | working 状态下的 reminder 让三个 worker 各多跑一轮；两条含 shell 片段的 message body 被展开后截空；team completed 后 lead 的 durable Turn 仍为 `in_progress`；4,433 个事件大多无法分类，500 条导出尾部淹没控制事件 | 129.227s | 7 / 13 / 4,433 | 678,254 | 474,560 B（仅末 500 条） | 7/7，但控制面未收敛 |
| R1 | 收紧 lead/teammate prompt：禁止向 working 成员 reminder、先读 inbox、限制 message 为安全纯文本；过滤 token message chunk、识别嵌套 ACP event，并在 team 终止时收敛 durable Turn | 130.631s | 4 / 6 / 193 | 417,678 | 722,829 B | 7/7；所有成员 stopped、`currentTurnId=null`，无 unknown 与重复 worker Turn |
| R2 | R1 虽减少事件数，完整 tool 与 outcome payload 仍使导出膨胀；改为保留 tool 身份、状态、受限输入和 outcome 汇总等有界证据 | 138.506s | 5 / 8 / 224 | 545,241 | 277,586 B | 7/7；相对 R1 导出 -61.6%，tool payload -81.5%，outcome payload -59.4%；但一次重复 reminder 又触发额外 Turn |
| R3 | 轨迹显示 lead 已拥有 task result 和完成消息却仍请求重复交接；把非空 `task.result` 定为唯一权威 completion handoff，日常完成不再重复发 message | 141.459s | 4 / 3 / 182 | 438,712 | 232,266 B | 7/7；mailbox 只剩 3 条 spawn guidance，无重复 worker Turn |
| R4 | R3 的 lead 用多次 `status`/`inbox` 自行轮询；新增有超时的阻塞式 `wait`，改为一次 wait 后各读一次最终 status/inbox | 145.595s | 4 / 3 / 199 | 495,510 | 251,770 B | 7/7；`wait` 调用 1 次；新暴露两个 teammate 原样执行 `task claim TASK_ID` |
| R5 | teammate prompt 和 wake prompt 不再展示占位符，而是动态渲染已分配任务的真实 ID；无 assignment 时不展示 claim 命令 | 159.959s | 4 / 3 / 178 | 439,435 | 221,986 B | 7/7；claim 3 次全部使用真实 ID，placeholder claim 0 次，wait 1 次，所有成员与 Turn 正常收尾 |
| R6 最终硬化回归 | 用真实 ACP 重跑审查后的原子 spawn+guidance、事务内 Turn budget、显式取消、supervisor shutdown/fiber 等待与私有 state 权限 | 110.216s | 4 / 3 / 177 | 415,358 | 228,946 B | 7/7；3 个 teammate Turn completed，lead 终态 Turn 明确 cancelled；全员 stopped、`currentTurnId=null`，worker ownership 文件清空，DB `0600`、目录 `0700` |

这里的 token 是 ACP outcome 中 provider 报告的 `totalTokens` 求和，只适合作为同一 harness
下的轨迹指标，不是账单数据。每轮只有一个真实样本，模型输出也具有随机性；elapsed 与
token 没有单调下降，所以不能从这组数据推出普遍的性能提升。可以直接归因的是控制面计数
与不变式：worker Turn 从基线的 6 个降到 3 个，message 从 13 条降到 3 条，终态不再残留
`in_progress` Turn，轨迹不再由 unknown 事件占满，R5 不再执行占位符命令，R6 则把
终止中的 lead Turn 明确记为 `cancelled`。

### R5 后的审查加固与 R6 最终回归

R0-R5 的原始轨迹固定保留当时的实际运行，不能用后来的代码改写历史。R5 后的实现审查又
增加了五项当前契约：spawn、task binding 和首轮 guidance 单事务提交；`maxTurns` 在 Turn
准入事务中按全队计数；主动停止或 team settlement 把仍活跃的 Turn 记录为 `cancelled` 和
`turn_cancelled`，不再伪装成 completed；host 显式 shutdown supervisor 并等待 member
fiber，cleanup/取消持久化失败会使 run 失败；在 POSIX 下 state DB 使用 `0600`，
worker/session 目录使用 `0700`，并拒绝直接 state symlink。

R6 不改写也不替代 R1-R5 的五轮优化；它是额外的真实 ACP 最终硬化回归。运行以 3 个
completed teammate Turn 和 1 个 cancelled lead 终态 Turn 收尾，3 个 provider outcome 共报告
415,358 tokens，177 个事件的导出视图为 228,946 B，fixture 测试 7/7。所有成员都是
`stopped` 且 `currentTurnId=null`，worker ownership 文件为空；POSIX state/managed directory
权限分别为 `0600`/`0700`。这证明加固在同一真实 fixture 上收敛，仍不构成对所有
ACP provider 或对抗安全的普遍声明。

R6 后又以 ACP fixture subprocess 做了中断回归：在 lead 的 prompt 仍活跃时向前台 CLI
发送 `SIGINT`，验证 team 先转为 failed、Turn 记录为 `cancelled`、lead 转为 stopped、
ownership 目录清空、Agent PID 消失，CLI 最后以 130 退出。该自动化回归补足信号竞态，
不冒充新的真实 Trae 优化轮次。

### 仍然存在的边界

R1-R5 五轮优化与 R6 硬化回归验证了前台单 host、真实独立 ACP Session、动态任务、
task result 交接、mailbox、wait、终态收敛和可复盘轨迹的最小闭环，但没有把以下内容
变成已验证承诺：

- 只有 Trae `0.201.4` 在这个固定 coding fixture 上被逐轮运行，尚不能外推到所有 ACP
  provider、长时研究任务或高冲突共享文件；
- 一个 team 当前只能为所有成员选择同一 provider/model；跨 team run 可以选择不同 agent，
  但这不等于单 team 内的 heterogeneous member 配置；
- 所有验证运行都使用 `permissionMode: "approve-all"` 和可信、临时、无秘密的隔离 fixture；
  没有验证交互审批、逐成员权限或恶意 teammate 隔离；
- `--body`、`--summary` 和 `--prompt` 仍经过调用者的 shell quoting；当前 prompt 要求纯文本，
  但尚未提供 stdin/file 形式来结构性消除 quoting 风险；
- `wait` 是前台 CLI 内的有限等待，不是 daemon、远程事件订阅或 crash-resume 服务；
- SQLite 协调状态可保留，但 host 崩溃后的 Provider Session 接管、完整 ACP transcript
  恢复和自动 workspace merge 仍不在 MVP 契约内；
- 轨迹为诊断证据而投影和截断，不是无损 ACP wire capture，也不应包含或承诺保存完整模型
  对话。
