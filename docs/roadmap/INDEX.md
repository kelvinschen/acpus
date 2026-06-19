# Acpus Roadmap 索引

本目录记录 Acpus 的未来计划、backlog 与能力缺口。当前已实现的行为由 `specs/` 承载，不在此重复。

## 写作约定

- 只写未来/计划/能力缺口。已落地的行为属于 `specs/`，roadmap 仅指向尚未完成的部分。
- 不使用 RFC 2119 规范动词（MUST/SHOULD/MAY）作为约束——那是 spec 专用。这里用「计划 / 目标 / 缺口 / 候选 / 待定」等描述性语言。
- 术语与 `CONTEXT.md` 保持一致：Workflow Spec、Run、Node、Composite Node、Executable Node、Agent Step、Program Step、Signal Node、Node Key、Node State Machine、Daemon、Artifact；并沿用 PRD/README 的 frozen IR、acpx-managed session 表述。
- 不得违反已锁定的架构决策：ADR 0001（`@acpus/core` 保持无副作用，I/O 与进程关注点归 runtime/CLI）、ADR 0002（M1 用 tsc 构建，bundling 仅作为未来发布优化）。
- 不引入分布式假设：Acpus 是单主机本地 CLI 工具，Temporal 仅作实现内核。`docs/archive/` 中的分布式/service-first 旧设计属历史，不作为当前真相。

## 现状评估基线

下表为基于代码与测试的现状评估（PRD `Milestones` 原编号对照）。

| PRD M | 状态 | 关键缺口（证据） |
|---|---|---|
| M1 编译 / lint / 冻结 IR / dry-run | 完成 | subworkflow 路径未在编译期解析（`packages/core/src/compiler.ts:316`）；非法表达式函数仅产生 warning，不阻断（`packages/core/src/expressions.ts:45`）；显式 `pipeline` Node 与 `do` 统一语义已实现（设计决策参考 [pipeline-and-do-design.md](pipeline-and-do-design.md)，行为见 `specs/`） |
| M2 本地 durable interpreter | 完成（R1 收尾） | 原缺口（fanout quorum/min_success、parallel race、subworkflow no-op、approval `decision`/`at`、自动 retry）已在 R1 全部实现并测试覆盖 |
| M3 Program Activity | 完成（R1 收尾） | 原缺口（stdout/stderr artifact、`exit_code` envelope、非零退出作为 step data、`capture.from: file`）已在 R1 全部实现并测试覆盖 |
| M4 Agent Activity via acpx | 完成（已归档） | Agent Step 经 acpx 真实驱动 ACP agent：session load/resume、固定 continuation prompt、协作式 cancel、partial transcript artifact、按 agent type 路由真实/mock executor、Acpus→acpx→Mock Agent 真实 e2e（#1/#2/#3）均已实现并测试覆盖。完成记录见 `docs/archive/R2-agent-acpx-integration.md` |
| M5 节点级本地控制 | 完成（已归档） | pause/resume/cancel/retry/inspect/ls 全实现；daemon 执行前注册 interpreter，重启后 resume/retry 从磁盘 lazy 冷恢复、pause/cancel 无 in-flight 时返回 409；retry/recover 通过专用 control-plane reset helper 复位；resume/retry 重建动态上下文（item/loop 快照）；`acpus replay` 确定性验证节点拓扑（PRD #9）；控制命令支持 `--json`。完成记录见 `docs/archive/R3-durable-controls-and-replay.md`。后续缺口并入 R4/backlog：event-sourced history、replay per-node 终态/output 逐字比对与执行期时钟对齐、approval escalate 持久通道 |
| M6 真实 agent 兼容矩阵 | 完成（薄范围，R4，已归档） | acpx 为 lockfile 精确 pin 的 bundled 依赖（`acpx@0.10.0`），Open Risk #2 由 pin 化解、不做运行时探测；agent/program 失败带 `node.id`(+`use`) 上下文前缀、acpx stderr 纯透传；声明 schema 时鲁棒提取 agent JSON 输出（balanced 扫描 + jsonrepair 兜底）。Open Risk #3（Temporal）当前架构不适用、关闭；#1 真实 adapter 端到端验证与 #4 artifact 压缩本轮不做。完成记录见 `docs/archive/R4-real-agent-compat-matrix.md` |

## 里程碑概览（按缺口重排）

里程碑按实际缺口重排，不沿用 PRD 编号。依赖顺序：R1 → R2 → R3，R4 贯穿全程。

| 里程碑 | 主题 | 对应 PRD | 状态 | 文档 |
|---|---|---|---|---|
| R1 | Runtime 原语缺口收尾（补 M2/M3 残留） | M2 / M3 | 已完成（已归档） | [docs/archive/R1-runtime-primitive-gaps.md](../archive/R1-runtime-primitive-gaps.md) |
| R2 | Agent Activity 经 acpx 真实集成 | M4 | 已完成（已归档） | [docs/archive/R2-agent-acpx-integration.md](../archive/R2-agent-acpx-integration.md) |
| R3 | 持久化控制与 replay 收尾 | M5 | 已完成（已归档） | [docs/archive/R3-durable-controls-and-replay.md](../archive/R3-durable-controls-and-replay.md) |
| R4 | 真实 agent 路径收敛（薄范围） | M6 | 已完成（已归档） | [docs/archive/R4-real-agent-compat-matrix.md](../archive/R4-real-agent-compat-matrix.md) |

### 依赖与排序理由

- **R1 已完成（已归档）**：Program Activity 的 artifact 捕获、`exit_code`、非零退出语义，以及 fanout/parallel/approval/retry/subworkflow 的运行时语义已全部落地，作为 R2 的前置。
- **R2 已完成（已归档）**：真实 acpx 集成依赖 R1 打通的 artifact 写入路径与自动 retry（agent parse/schema 失败续跑），现已落地。
- **R3 已完成（已归档）**：replay 的拓扑验证与跨进程 resume/retry 需要先有真实 agent 执行历史可重放，现已落地。
- **R4 已完成**：acpx 为 lockfile 精确 pin 的 bundled 依赖，Open Risk #2 由 pin 化解（不做运行时探测）；本轮交付 agent/program 失败的上下文前缀与 acpx stderr 纯透传、以及声明 schema 时的鲁棒 JSON 提取（balanced 扫描 + jsonrepair 兜底）。Open Risk #3（Temporal 内核易用性）当前自研 file-based daemon 架构不适用、关闭；#1 真实 adapter 端到端兼容验证与 #4 artifact 压缩本轮不做，留待后续按需开展。

## Backlog / 能力缺口

- **Signal Node 外部决策注入已落地**：`awaiting` 状态、schema-validated payload 注入（TUI `s` 与 CLI `acpus runs signal --payload`）、`on_timeout: fail|default` 策略、无 timeout 无限等待、payload 校验失败保持 `awaiting` 均已实现并测试覆盖（行为见 `specs/workflow-spec.md` Signal Node、ADR 0010）。
- **Signal 决策持久化恢复（缺口）**：当前决策通道为内存 resolver，Run Supervisor 在 Signal Node `awaiting` 期间重启会把节点重置为 `pending` 并重新等待外部决策，down 窗口内到达的 payload 会丢失。持久化决策通道留待后续（与整个 `awaiting` 家族的 durable 恢复一并处理，见 ADR 0010 Option A）。
- **TUI 同种 Composite 嵌套消歧（缺口）**：Node Key 的动态维度（item/lane/branch/round）按类型追加在 key 尾部，同类型维度 last-write-wins。因此 TUI 可视化器（`packages/tui/src/model.ts`）在 fanout-in-fanout / loop-in-loop 等同种 Composite 嵌套场景下，内层维度会覆盖外层，导致按维度重建的层级树无法正确消歧（fanout→parallel 等异种嵌套不受影响）。彻底修复需让 Node Key 采用带位置/复合的动态维度编码（`packages/runtime/src/keys.ts`），留待后续。
- **Mock script 依赖边界优化（已完成）**：`type: mock` 已移除，`MockAgentExecutor` 已删除；`@acpus/mock-agent` 不再是 runtime 的生产依赖（移至 devDep），所有 agent type 统一走 `AgentExecutor`（通过 acpx）。单元测试使用轻量 `StubAgentExecutor`（在 `packages/runtime/test/support/` 内），E2E 测试使用 `acpus-mock-agent` 作为 `type: command` agent 通过真实 acpx 路径执行。`specs/mock-agent-spec.md` 描述的 `@acpus/mock-agent` 包本身（ACP 服务器 + 脚本 DSL）行为不变。
- **Forked Run 跨进程 checkpoint 写入并发安全（缺口，F3）**：`RunStore.appendCheckpoint` 是 read-modify-write，跨 Workspace 多进程同时落 checkpoint 会丢条目（当前 supervisor lock 已在大多数路径上排除并发，但未来如果 CLI 子进程也直接 append 会触发）。候选方案：file lock 或 append-only journal。
- **Forked Run 跨 subworkflow 边界继承（缺口，F4）**：`fork.ts` 的 IR 索引只 walk `ir.root`；subworkflow 子 IR 在运行时编译，因此第一个落在 subworkflow 内的 checkpoint 会被识别为 `missing-in-new-spec` 并截断继承。要彻底修需要 fork planner 提前编译 subworkflow（同步走 `compileWorkflow` + `includeResolver`）并把它们也纳入索引。
- **Forked Run 拓扑序继承（缺口，F10）**：`planForkedRun` 当前按 checkpoint 写入顺序（终态完成时间）做线性截断。在 parallel/fanout 兄弟乱序完成的场景下，这会导致"实际可继承的 sibling 被截断"——是 *少继承*（语义安全但偏保守），不是错。彻底修复需要按拓扑序 walk 新 IR、对每个 Node 单独决定是否继承。代价是 fork planner 要复刻 interpreter 的控制流推导。先观察实际碰撞频率，必要时再做。
