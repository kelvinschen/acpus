# R4 — 真实 agent 路径收敛（薄范围）

> 对应 PRD Milestone 6。经评审，本里程碑从「构建 acpx 探测 / 兼容机制」收敛为「友好报错 + 文档声明」，并明确收尾各条 Open Risk。

## 收敛判断

acpx 是 lockfile 精确 pin 的 bundled 依赖（`acpx@0.10.0`，见 `packages/runtime/package.json`），经 `require.resolve("acpx/package.json")` 解析调用（`packages/runtime/src/executors/agent.ts`），**不是**用户外部安装、需在 `$PATH` 探测的二进制。因此 Open Risk #2（acpx 版本兼容）已被「精确 pin」结构性化解——任何运行时版本探测都只是校验我们自己 pin 的版本，零收益。

agent 背后真实工具（如 `claude`）是否安装、是否登录，是**运行时 / 环境**问题，不属于一份 YAML 的静态可复现判断，因此不进 lint。lint 维持现状：只校验 spec 内部引用完整性（步骤 `use` 必须指向已声明的 agent，`AGENT_REF`）。真实性留给运行时报错。

## 本轮交付

- **失败报错带 Acpus 上下文前缀**：agent / program 节点失败时，错误信息带上 `node.id`（agent 另带 `use`），acpx stderr 原样透传不改写、不做启发式诊断猜测。形如 `Agent step 'review' (use: claude) failed (exit): <acpx stderr>`。
- **鲁棒 agent output 提取**（仅声明 output schema 时）：agent 回复常把 JSON 包在自然语言 / Markdown code fence 中。提取采用三级流水线——整段 strict parse → 扫描平衡 `{...}`/`[...]` 取最后一个合法 JSON → `jsonrepair` 兜底；提取不到才判 `parse`（可重试），提取到的 JSON 仍走 schema 校验，不符判 `schema`。未声明 schema 时仍 `{ text }` 原样包装。
- **支持版本声明**：Acpus 目标 acpx 版本 `0.10.x`（lockfile pin）。acpx 已知 builtin adapter：`claude / codex / gemini / cursor / pi / openclaw`（来自 acpx `--help`，仅文档记录，不在代码中维护白名单）。

## Open Risks 处置

- **#2 acpx 版本**：由 lockfile 精确 pin 化解，仅文档声明支持版本，**不做运行时探测**。
- **#1 真实 adapter 兼容矩阵**：真实 adapter 端到端验证需真实 API key / 联网环境，非确定性，无法做成 CI 内自动化测试；本轮**不做**，留待需要时以人工验证 + 文档沉淀方式补。
- **#3 本地 Temporal 内核易用性**：当前为自研 file-based daemon，**未引入 Temporal**，启动不需要集群 / 基础设施安装步骤，该风险在当前架构下不适用，**关闭**。
- **#4 artifact 压缩**：与「真实 agent 兼容」无耦合，本轮**摘出**；如确有需要另开后续里程碑。

## 关联

- PRD Milestone：M6。Open Risks #1 / #2 / #3 / #4（`prd/PRD-acpus.md:125-130`）。
- 约束：保持单主机本地 CLI 边界；`@acpus/core` 维持纯净（无子进程 / FS 探测）。
