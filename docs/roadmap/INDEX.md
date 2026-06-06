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
| M4 Agent Activity via acpx | 完成（已归档） | Agent Step 经 acpx 真实驱动 ACP agent：session load/resume、固定 continuation prompt、协作式 cancel、partial transcript artifact、按 agent type 路由真实/mock executor、Acpus→acpx→Mock Agent 真实 e2e（#1/#2/#3）均已实现并测试覆盖。完成记录见 `docs/archive/R2-agent-acpx-integration.md` |
| M5 节点级本地控制 | 完成（已归档） | pause/resume/cancel/retry/inspect/ls 全实现；daemon 执行前注册 interpreter，重启后 resume/retry 从磁盘 lazy 冷恢复、pause/cancel 无 in-flight 时返回 409；retry/recover 通过专用 control-plane reset helper 复位；resume/retry 重建动态上下文（item/loop 快照）；`acpus replay` 确定性验证节点拓扑（PRD #9）；控制命令支持 `--json`。完成记录见 `docs/archive/R3-durable-controls-and-replay.md`。后续缺口并入 R4/backlog：event-sourced history、replay per-node 终态/output 逐字比对与执行期时钟对齐、approval escalate 持久通道 |
| M6 真实 agent 兼容矩阵 | 完成（薄范围，R4） | acpx 为 lockfile 精确 pin 的 bundled 依赖（`acpx@0.10.0`），Open Risk #2 由 pin 化解、不做运行时探测；agent/program 失败带 `node.id`(+`use`) 上下文前缀、acpx stderr 纯透传；声明 schema 时鲁棒提取 agent JSON 输出（balanced 扫描 + jsonrepair 兜底）。Open Risk #3（Temporal）当前架构不适用、关闭；#1 真实 adapter 端到端验证与 #4 artifact 压缩本轮不做。完成记录见 `R4-real-agent-compat-matrix.md` |

## 里程碑概览（按缺口重排）

里程碑按实际缺口重排，不沿用 PRD 编号。依赖顺序：R1 → R2 → R3，R4 贯穿全程。

| 里程碑 | 主题 | 对应 PRD | 状态 | 文档 |
|---|---|---|---|---|
| R1 | Runtime 原语缺口收尾（补 M2/M3 残留） | M2 / M3 | 已完成（已归档） | [docs/archive/R1-runtime-primitive-gaps.md](../archive/R1-runtime-primitive-gaps.md) |
| R2 | Agent Activity 经 acpx 真实集成 | M4 | 已完成（已归档） | [docs/archive/R2-agent-acpx-integration.md](../archive/R2-agent-acpx-integration.md) |
| R3 | 持久化控制与 replay 收尾 | M5 | 已完成（已归档） | [docs/archive/R3-durable-controls-and-replay.md](../archive/R3-durable-controls-and-replay.md) |
| R4 | 真实 agent 路径收敛（薄范围） | M6 | 已完成 | [R4-real-agent-compat-matrix.md](R4-real-agent-compat-matrix.md) |

### 依赖与排序理由

- **R1 已完成（已归档）**：Program Activity 的 artifact 捕获、`exit_code`、非零退出语义，以及 fanout/parallel/approval/retry/subworkflow 的运行时语义已全部落地，作为 R2 的前置。
- **R2 已完成（已归档）**：真实 acpx 集成依赖 R1 打通的 artifact 写入路径与自动 retry（agent parse/schema 失败续跑），现已落地。
- **R3 已完成（已归档）**：replay 的拓扑验证与跨进程 resume/retry 需要先有真实 agent 执行历史可重放，现已落地。
- **R4 已完成**：acpx 为 lockfile 精确 pin 的 bundled 依赖，Open Risk #2 由 pin 化解（不做运行时探测）；本轮交付 agent/program 失败的上下文前缀与 acpx stderr 纯透传、以及声明 schema 时的鲁棒 JSON 提取（balanced 扫描 + jsonrepair 兜底）。Open Risk #3（Temporal 内核易用性）当前自研 file-based daemon 架构不适用、关闭；#1 真实 adapter 端到端兼容验证与 #4 artifact 压缩本轮不做，留待后续按需开展。
