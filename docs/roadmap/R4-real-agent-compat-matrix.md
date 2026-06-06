# R4 — 真实 agent 兼容矩阵与风险缓解

> 对应 PRD Milestone 6：Acpus 支持的 acpx 版本与 ACP adapter 的真实兼容矩阵。贯穿 R2 / R3。

## 背景

当前 acpx 在代码中唯一出现是 `AgentExecutor` 的 `this.acpxPath ?? "acpx"`（`packages/runtime/src/executors/agent.ts:25`），无版本探测、无校验、无真实 ACP adapter 集成。PRD Open Risk #2 已明确 acpx 仍处 alpha，Acpus 在依赖特定 CLI / 运行时 API 前应 pin 并校验兼容版本。本里程碑把真实 agent 路径从「Mock Agent 经 acpx」扩展到「真实 ACP adapter 经 acpx」，并系统性缓解四条 Open Risks。

## 目标

建立 Acpus 支持的 acpx 版本与 ACP adapter 兼容矩阵，pin 并校验 acpx 版本，验证真实 adapter 对协作式 cancel / `session/load` / `session/resume` / model selection / 结构化流式的支持，并把长运行的 artifact 压缩与本地 Temporal 内核易用性作为持续项收敛。

## 缺口清单

- acpx 版本无 pin / 探测 / 校验。需在依赖特定 acpx CLI/API 前确定支持版本范围并在运行时校验（Open Risk #2）。
- 无真实 ACP adapter 兼容矩阵。需枚举 Acpus 支持的 adapter，并记录各自对 cancel/load/resume/model/streaming 的支持差异（Open Risk #1）。
- artifact 压缩缺口。长本地 Run 的 history 与日志需压缩策略以保持可检视而不过大（Open Risk #4）。
- 本地 Temporal 内核易用性。嵌入式/本地 Temporal-compatible 服务需足够简单，使 Acpus 仍像 CLI 工具而非基础设施安装（Open Risk #3）。

## 验收信号

- 存在受支持 acpx 版本范围的声明，且运行时在不兼容版本下给出明确诊断而非隐性失败。
- 存在真实 ACP adapter 兼容矩阵，记录各 adapter 对协作式 cancel、`session/load`、`session/resume`、model selection、结构化流式的支持状态。
- 至少一个真实 ACP adapter（非 Mock Agent）通过 acpx 跑通 R2 的强制场景子集。
- 长 Run 的 artifact 有压缩/紧凑策略，state 仍只存紧凑值与 `artifact://` 引用。
- 本地 durable 引擎启动不要求显式集群/基础设施安装步骤。

## 关联

- PRD Milestone：M6。Open Risks #1 / #2 / #3 / #4（`prd/PRD-acpus.md:125-130`）。
- 前置：R2（真实 acpx 集成路径）、R3（replay 用于跨 adapter 行为验证）。
- 约束：保持单主机本地 CLI 边界，不引入分布式/远程 worker 假设；artifact 默认本地文件系统。
