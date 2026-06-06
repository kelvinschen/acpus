# Acpus Roadmap 索引

本目录记录 Acpus 的未来计划、backlog 与能力缺口。当前已实现的行为由 `specs/` 承载，不在此重复。

## 写作约定

- 只写未来/计划/能力缺口。已落地的行为属于 `specs/`，roadmap 仅指向尚未完成的部分。
- 不使用 RFC 2119 规范动词（MUST/SHOULD/MAY）作为约束——那是 spec 专用。这里用「计划 / 目标 / 缺口 / 候选 / 待定」等描述性语言。
- 术语与 `CONTEXT.md` 保持一致：Workflow Spec、Run、Node、Composite Node、Executable Node、Agent Step、Program Step、Approval Gate、Node Key、Node State Machine、Daemon、Artifact；并沿用 PRD/README 的 frozen IR、acpx-managed session 表述。
- 不得违反已锁定的架构决策：ADR 0001（`@acpus/core` 保持无副作用，I/O 与进程关注点归 runtime/CLI）、ADR 0002（M1 用 tsc 构建，bundling 仅作为未来发布优化）。
- 不引入分布式假设：Acpus 是单主机本地 CLI 工具，Temporal 仅作实现内核。`docs/archive/` 中的分布式/service-first 旧设计属历史，不作为当前真相。

## 现状评估基线

下表为基于代码与测试的现状评估（PRD `Milestones` 原编号对照）。

| PRD M | 状态 | 关键缺口（证据） |
|---|---|---|
| M1 编译 / lint / 冻结 IR / dry-run | 完成 | subworkflow 路径未在编译期解析（`packages/core/src/compiler.ts:316`）；非法表达式函数仅产生 warning，不阻断（`packages/core/src/expressions.ts:45`） |
| M2 本地 durable interpreter | 完成（R1 收尾） | 原缺口（fanout quorum/min_success、parallel race、subworkflow no-op、approval `decision`/`at`、自动 retry）已在 R1 全部实现并测试覆盖 |
| M3 Program Activity | 完成（R1 收尾） | 原缺口（stdout/stderr artifact、`exit_code` envelope、非零退出作为 step data、`capture.from: file`）已在 R1 全部实现并测试覆盖 |
| M4 Agent Activity via acpx | 完成（R2） | Agent Step 经 acpx 真实驱动 ACP agent：session load/resume、固定 continuation prompt、协作式 cancel、partial transcript artifact、按 agent type 路由真实/mock executor、Acpus→acpx→Mock Agent 真实 e2e（#1/#2/#3）均已实现并测试覆盖。daemon 跨重启冷恢复仍属 M5 |
| M5 节点级本地控制 | 存在断层 | pause/resume/cancel/retry/inspect/ls 已实现且 daemon 在执行前注册 interpreter（运行中可控）；但 daemon 重启后 `interpreters` map 丢失，`WorkflowInterpreter.resume()` 的磁盘冷恢复未接入任何 HTTP 路由；resume/retry 仅透传完整 nodeKey 续跑，尚无完整执行上下文（item/loop）快照重建；`replay` / `agents` / `mock` CLI 命令完全缺失 |
| M6 真实 agent 兼容矩阵 | 未开始 | acpx 无版本 pin / 探测 / 校验（`agent.ts:25`）；无真实 ACP adapter 集成；对应 Open Risk #1 / #2 |

## 里程碑概览（按缺口重排）

里程碑按实际缺口重排，不沿用 PRD 编号。依赖顺序：R1 → R2 → R3，R4 贯穿全程。

| 里程碑 | 主题 | 对应 PRD | 状态 | 文档 |
|---|---|---|---|---|
| R1 | Runtime 原语缺口收尾（补 M2/M3 残留） | M2 / M3 | 已完成（已归档） | [docs/archive/R1-runtime-primitive-gaps.md](../archive/R1-runtime-primitive-gaps.md) |
| R2 | Agent Activity 经 acpx 真实集成 | M4 | 已完成 | [R2-agent-acpx-integration.md](R2-agent-acpx-integration.md) |
| R3 | 持久化控制与 replay 收尾 | M5 | 进行中（下一个） | [R3-durable-controls-and-replay.md](R3-durable-controls-and-replay.md) |
| R4 | 真实 agent 兼容矩阵与风险缓解 | M6 | 待开始（贯穿） | [R4-real-agent-compat-matrix.md](R4-real-agent-compat-matrix.md) |

### 依赖与排序理由

- **R1 已完成（已归档）**：Program Activity 的 artifact 捕获、`exit_code`、非零退出语义，以及 fanout/parallel/approval/retry/subworkflow 的运行时语义已全部落地，作为 R2 的前置。
- **R2 承接 R1**：真实 acpx 集成依赖 R1 打通的 artifact 写入路径与自动 retry（agent parse/schema 失败续跑）。
- **R3 依赖 R2**：replay 的确定性验证与跨进程 resume/retry 需要先有真实 agent 执行历史可重放。
- **R4 贯穿**：acpx 版本 pin、真实 adapter 兼容矩阵、Open Risks（#1 adapter 差异、#2 acpx alpha、#3 Temporal 内核易用性、#4 artifact 压缩）作为持续项，随 R2/R3 推进逐步收敛。
