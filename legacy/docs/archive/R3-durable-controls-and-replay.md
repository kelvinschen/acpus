# R3 — 持久化控制与 replay 收尾

> 对应 PRD Milestone 5：节点级本地控制 pause / resume / cancel / retry / inspect / replay。

## 状态：已完成（核心目标达成）

R3 的核心承诺——「durable 本地控制 + 可重放」——已落地：daemon 跨进程重启后 `resume`/`retry` 可从持久化 Run 冷恢复，`pause`/`cancel` 明确限定为 live in-flight 控制；retry/recover 通过专用 control-plane reset helper 复位而不污染普通生命周期；resume/retry 重建动态上下文；`acpus replay` 提供只读拓扑验证。`agents`/`mock` 子命令经评估不做（见下）。

## 已落地

- 跨进程 resume/retry 冷恢复：`resume`/`retry` 控制路由在内存 interpreter 缺失时按需从磁盘 lazy 重建 interpreter，并复位残留 `running` 节点（`daemon.ts` `getOrRecoverInterpreter` + `interpreter.recoverStaleNodes`），不再返回「No active interpreter」；未知 Run 才 404。`pause`/`cancel` 不做冷恢复，因为它们语义上是中止 live in-flight Activity；已有 Run 但无 live interpreter 时返回 409 conflict。
- retry/recover 经专用 control-plane reset：普通状态机只表达业务生命周期 `pending → running → {completed, failed, paused, cancelled}`，不暴露 `failed → pending` 或 `running → pending` 边；operator retry 通过 `resetFailedForRetry()` 复位 failed Node，crash recovery 通过 `resetRunningForCrashRecovery()` 复位 stale running Node（`state-machine.ts` + `interpreter.ts`），不再裸赋值绕过，也不会让通用 `transition()` 获得 retry/reset 权限。
- resume/retry 动态上下文重建：执行叶子时持久化父级动态值上下文快照（fanout `item`/`item_id`/`item_index`、loop `loop.iter`/`loop.last`）入 `NodeExecutionState.dynamicContext`；resume/retry 读回合并进 ctx，使 program 重渲染 cmd/prompt 不丢父级上下文。
- `acpus replay <run_id>`：纯验证、零副作用。从 frozen IR 重走解释流程，回灌已记录 per-node output，校验重建的**节点拓扑**（触达的 node key 集合）与持久化一致；replay 内部用固定 runId + 冻结时钟（`createdAt`）保证自身确定性，不读 YAML/不跑 agent/program/不依赖随机值或大 artifact。runtime `replay()` + `POST /runs/:runId/replay` + `DaemonClient.replay()` + `acpus replay`（`--json`/不一致退出码 20，结构化 diff）。对应 PRD 强制场景 #9。注：per-node 终态与 output 逐字比对、执行期时钟对齐归后续。
- 控制命令 `--json`：pause/resume/cancel/retry 增 `--json`，输出最新 `NodeExecutionState`，与 inspect/ls 一致。
- spec 同步：`specs/cli-spec.md`（replay + 控制 `--json` + 验证项；移除 agents/mock MUST）、`specs/local-runtime-target-spec.md`（control-plane reset 与业务生命周期分离、动态上下文持久化、daemon 冷恢复边界、Replay 小节、验证项）、`CONTEXT.md`（Replay 术语）。

## 不做（已评估）

- `acpus agents`：acpx 无 agent 注册表（顶层命令是内置 adapter `pi`/`claude`/`codex`/`gemini`/`openclaw`，无注册管理面），agent 由用户自行在系统中安装与管理。已从 `specs/cli-spec.md` 移除该 MUST。
- `acpus mock`：保留独立 bin `acpus-mock-agent`，不再额外包装为子命令。已从 `specs/cli-spec.md` 移除该 MUST。

## 后续项（归 R4/M6 或 backlog）

- append-only event-sourced history：当前持久化为 last-write-wins 快照，足以支撑本期 replay（拓扑验证）；若未来需要 per-node 终态/output 逐字比对、重建「如何到达某状态」的转移序列与时序审计，需新增 history event log。
- replay 加强：per-node 终态与 output 逐字比对、执行期时钟对齐到 `createdAt`（使 now()-依赖的控制流可逐字重放）、replay bundle 导出。
- approval `escalate` on-timeout 持久通道：`interpreter.ts` 的 approval 超时 `escalate` 策略目前无运行时通道（已标注），归后续。
- 完整 resumption frontier：当前 resume 从根 re-walk + completed 短路，未持久化「续跑前沿」；大规模深嵌套场景可再优化。
