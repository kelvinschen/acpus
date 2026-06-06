# R3 — 持久化控制与 replay 收尾

> 对应 PRD Milestone 5：节点级本地控制 pause / resume / cancel / retry / inspect / replay。

## 背景

节点级控制的多数命令已实现：pause/resume/cancel/retry（`packages/runtime/src/interpreter.ts:115/131/155/171` + `daemon.ts:89/104/119/134` + CLI `packages/cli/src/index.ts:172-233`），以及 inspect/ls。6 态状态机与父子传播也已就位。但存在两处削弱「durable」承诺与 CLI 完整性的缺口：

- daemon 重启后 resume/retry 失效。HTTP 层只认 in-memory `interpreters` map（`packages/runtime/src/daemon.ts:20,95-98`）；daemon 重启后该 map 为空，resume/retry 返回 404「No active interpreter」。而 `WorkflowInterpreter.resume(runId)` 能从磁盘冷恢复（`interpreter.ts:73-110`）却未被任何 HTTP 路由调用——跨进程重启的 resume/retry 实际不可用。
- `replay` / `agents` / `mock` CLI 命令完全缺失。`packages/cli/src/index.ts` 无对应 `.command()`。`replay` 在 runtime 层也无语义、无 HTTP 路由、无 client 方法。`mock` 功能存在于独立 bin `acpus-mock-agent`（`packages/mock-agent/src/index.ts:23`）但未作为 `acpus mock` 子命令暴露。对应 `specs/cli-spec.md:32-33`。

## 目标

让节点级控制在 daemon 跨进程重启后依然可用，并补齐 PRD CLI surface 中缺失的 `replay`、`agents`、`mock` 命令，使「durable 本地控制 + 可重放」承诺成立。

## 缺口清单

- 跨进程 resume/retry 断层。需让 HTTP 路由在 in-memory interpreter 缺失时回退到 `interpreter.resume(runId)` 的磁盘冷恢复（`daemon.ts:95-98` → `interpreter.ts:73`）。
- resume/retry 执行上下文重建不完整。R2 已让 resume/retry 透传完整 nodeKey 保持稳定 identity（agent session 名不变），但被恢复的叶子节点缺少父级动态上下文（fanout `item`/`item_id`、loop `loop.iter` 等）；当前 agent resume 走固定 continuation prompt 不重渲染原 prompt 故不受影响，但 program 重渲染 cmd 或 prompt 引用了 `item.*`/`loop.*` 的场景需要持久化并重建完整执行上下文（dynamic + item/loop 快照）。
- retry 绕过状态机。`interpreter.ts:178` 直接置 pending（注释自承），需经状态机合法转移（`failed → pending → running`）。
- `replay` 缺失。需要运行时确定性重放语义（从持久化 history 或 replay bundle 验证，不依赖可变 YAML / 系统时间 / 随机值 / 大 artifact 负载）+ CLI 命令 + HTTP 路由 + daemon-client 方法。对应 PRD 强制场景 #9。
- `agents` 缺失。`specs/cli-spec.md:32` 要求暴露本地 acpx 注册 agent 的管理命令。
- `mock` 缺失。`specs/cli-spec.md:33` 要求 `acpus mock` 子命令暴露 Mock Agent（功能已存在于独立 bin）。
- 控制命令测试与输出。CLI 无 pause/resume/cancel/retry 的校验测试（`specs/cli-spec.md:45` 要求），且这些命令无 `--json` 机器可读输出（仅文本 console.log）。

## 验收信号

- daemon 重启后对既有 Run 执行 resume/retry 能从磁盘冷恢复并继续，不再返回「No active interpreter」。
- retry 经状态机合法转移完成，不绕过状态机。
- `acpus replay <run_id>` 能确定性重放并验证工作流解释结果，且不依赖可变 YAML、系统时间、随机值或大 artifact 负载。
- `acpus agents` 可列出/管理本地 acpx 注册 agent；`acpus mock` 可运行 Mock Agent。
- pause/resume/cancel/retry 支持 `--json` 输出，并有覆盖状态校验的 CLI 测试。
- spec 若随实现更新，同步修订 `specs/cli-spec.md` 与 `specs/local-runtime-target-spec.md`。

## 关联

- PRD Milestone：M5。PRD 强制 runtime 场景 #9（replay 确定性）。
- 前置：R2（replay 与跨进程 resume/retry 需要真实 agent 执行历史可重放）。
- 约束：Run 执行冻结 IR 快照，replay 不得回读可变 YAML（与 `specs/local-runtime-target-spec.md` 的 frozen IR 一致）。
