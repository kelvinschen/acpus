# Durable Runtime 交接与审计标注文档 - 2026-06-29（审计更新）

## 文档定位

本文档用于 durable runtime 实现阶段之后的人工审阅、能力盘点和后续目标选择。当前产品和设计真相仍以 `specs/` 为准；本文档是 roadmap/handoff 材料，不是规范文件。

> **审计注（2026-06-29）**：代码已从 monolithic `packages/acpus/` 拆分为五个独立 package（`cli`、`runtime`、`core`、`agent-executor`、`workflow-compiler`）。本文档证据路径已更新为当前代码结构。审计发现的新增能力和差异已在各条目中标注。

主要参考：

- Roadmap: `docs/roadmap/durable-runtime-workflow.md`
- Runtime spec: `specs/runtime-spec.md`
- CLI spec: `specs/cli-spec.md`
- Core spec: `specs/core-spec.md`
- Expression spec: `specs/expression-spec.md`
- CLI commands: `packages/cli/src/commands/run.ts`, `packages/cli/src/commands/runs.ts`
- Runtime store: `packages/runtime/src/store/store.ts`
- Runtime execution: `packages/runtime/src/execution/` (scheduler, advance, task-executor, agent-node, ir)
- Runtime evaluation: `packages/runtime/src/evaluation/` (evaluator, schema)
- Runtime control: `packages/runtime/src/control/apply-command.ts`
- Runtime supervisor: `packages/runtime/src/supervisor/` (loop, tick)
- Runtime admission: `packages/runtime/src/admission/input.ts`
- Runtime use-cases facade: `packages/runtime/src/runs/use-cases.ts`
- Agent executor: `packages/agent-executor/src/index.ts`
- Workflow compiler: `packages/workflow-compiler/src/` (compile, preflight, task-bundler)
- Core types/runtime: `packages/core/src/` (ir, nodes, runtime/task-context, runtime/dollar)
- Legacy runtime: `legacy/packages/runtime/`
- Legacy CLI: `legacy/packages/cli/`
- Legacy specs: `legacy/specs/`

## 标注方式

每个条目都提供一个"标注："段。人工 review 时直接在该段后补充结论即可。

建议短标签：

- `确认`: 当前判断正确。
- `需要实现`: 进入后续目标。
- `暂不做`: 明确排除，必要时迁入 `docs/roadmap/`。
- `需规格化`: 需要同步 `specs/`。
- `需验证`: 需要补测试或手工验证。
- `有争议`: 需要产品/设计决策。

可复制模板：

```md
标注：
- 决策：
- Owner：
- 范围：
- 不做范围：
- 验证方式：
- 备注：
```

## 上半部分：当前实现状态

### 总体判断

当前实现是一条 TypeScript-first durable runtime 主线，不是 legacy YAML runtime 的兼容迁移。它已经覆盖 durable admission、SQLite runtime store、冻结 IR/input/task bundle、scheduler、task/agent/signal 执行、durable controls、fork/replay 和 detached supervisor。

明确不按 legacy 回填的面：

- YAML Workflow Spec 兼容、YAML include/subworkflow、catalog、`workflows/wf` 命令。
- TUI 和 served visualizer。
- `supervisor.json` sidecar。
- 非 `bash` / custom task runner（类型表面已声明 `powershell`/`pwsh`/`custom`，但 runtime 拒绝）。
- first-class provider adapters。
- remote/container runner profiles。
- 自动清理所有 orphan `run_*` 目录（仅 supervisor tick 清理 `.staging-*`）。
- 完整 public dynamic `NodeInstanceKey`，除非后续目标重新定义。

**审计新增：**

- `blocked` 软状态：当 agent provider 未映射时，run 通过 `error_json` 标记 pending node 并从 `listRunnableRuns` 排除，非独立 RunStatus。
- 代码已拆分为五包；`@acpus/agent-executor` 是独立 package。
- 测试架构已按 package 和测试类型拆分（unit/contract/integration/e2e），P2 test cleanup 目标已部分完成。

标注：
- 决策：确认当前五包结构和不回填范围。
- 备注：`core-roadmap.md` 仍描述 runtime 为未来阶段，已过时。

### 已实现能力

#### Runtime admission

当前实现：`acpus run <workflow-module>` 已从 dry-run-only 变为可 durable admission。admission 会 check、compile、validate、normalize input，写 `.acpus/state/runtime.db` 和 `.acpus/runs/<run-id>/`。`--dry-run` 为显式 opt-in，仅产出 preflight artifact 不开 store。

证据：`packages/cli/src/commands/run.ts`, `packages/cli/src/workflow-preparation.ts`, `packages/runtime/src/store/store.ts` (`admitRun`), `packages/runtime/src/admission/input.ts`, `packages/runtime/src/runs/use-cases.ts` (`admitWorkflowRun`), `packages/workflow-compiler/src/preflight.ts`（dry-run 专用）

审计备注："Admission"本身负责冻结和入库；入库后立即 `advanceRun`，因此纯 workflow/task/可执行 agent 可能同步完成。

**审计新增：**
- Admission 通过 `admitWorkflowRun` facade 统一入口（open store → admitRun → advanceRun → close store）。
- `admitRun` 使用 `BEGIN IMMEDIATE` 事务，写 `run.admitted` event，失败回滚并清理 run dir。
- Run ID 格式：`run_<ISO-timestamp>_<sha256-suffix>`。
- 新增第四种终止结果 `blocked`（executor 缺失时），非独立 RunStatus。

标注：
- 决策：确认。
- 备注：需在 spec 中明确 `blocked` 语义。

#### Frozen run data

当前实现：运行时冻结 `WorkflowIR`、input JSON、lock metadata、workflow entry、IR digest、source graph digest、task bundle count、run directory path。

证据：`packages/runtime/src/store/store.ts` (`admitRun`, `RunWorkflowLockArtifact`), `specs/runtime-spec.md`

审计备注：当前 read-only inspection 不读 live workflow source。

**审计新增：**
- 额外冻结 `package_lock_digest`（package-lock 完整性）。
- 完成时冻结 `output_json`。
- Lock type 已从 preflight 移至 store（`RunWorkflowLockArtifact`），compiler 产出兼容的 `WorkflowLockArtifact`。
- Fork 时重写 `artifact://` URI 指向新 run id。

标注：
- 决策：确认。

#### SQLite runtime store

当前实现：SQLite 表覆盖 `schema_migrations`、`supervisor_lease`、`commands`、`runs`、`run_inputs`、`run_events`、`node_states`、`artifacts`。

证据：`packages/runtime/src/store/store.ts` (`migrate`)

审计备注：SQLite 是当前 run inspection 和 control 的事实源。WAL 模式、FK constraint 启用。

**审计新增：**
- `schema_migrations` 表 + `addColumnIfMissing` ALTER 助手（当前用于添加 `commands.owner_generation` fencing 列）。
- `node_states` 新增 `node_id`（与 `node_key` 分离，为 future dynamic NodeInstanceKey 预留）和 `attempt`（默认 0，retry 暂不 bump）。
- `commands` 新增 `owner_generation`（generation fence，防 stale supervisor 命令冲突）。
- `commands` 和 `run_events` 有 `idempotency_key` UNIQUE 约束。
- `supervisor_lease` 存储更丰富元数据：`endpoint`、`auth_token_hash`、`protocol_version`、`package_version`、`node_version`、`exec_path`（为未来 remote supervisor 预留）。
- Store 目前仍为单文件 ~1713 行，P2 modularization 未做。

标注：
- 决策：确认。

#### Initial projections

当前实现：admission 为 frozen IR 的静态节点创建初始 `pending` projection；完成后未执行静态节点会标记 `skipped`。

证据：`packages/runtime/src/store/store.ts` (`admitRun`, `collectNodeIds`, `completeRun`), `packages/runtime/src/execution/advance.ts`

审计备注：动态 fanout/loop instance 目前没有完整 public `NodeInstanceKey`。

**审计新增：**
- `blocked` 投影：`blockRun` 在 pending node 写 `error_json`，`listRunnableRuns` 排除有 blocked node 的 run。
- `failRun` 不强制 skip 剩余 pending nodes，支持 retry 恢复。
- `retryRun` 重置所有 nodes 为 pending；`retryNode` 仅重置指定 failed node。
- `persistCompletedNodes` 在 await/block/error 边界前 checkpoint 已完成 nodes。
- Replay projection 完整性校验：`verifyReplayProjection` 交叉验证 terminal events 与 run/node 状态。

标注：
- 决策：确认。
- 备注：`verifyReplayProjection` 是新增的 replay 校验能力，可在 spec 中明确。

#### Scheduler

当前实现：scheduler 覆盖 `assert`、`if`、`switch`、`parallel`、`fanout`、`loop`，并通过 executor 接入 `task`、`agent`、`signal`。

证据：`packages/runtime/src/execution/scheduler.ts`, `packages/runtime/test/runtime-scheduler.integration.test.ts`

审计备注：更准确地说，scheduler dispatch executable leaves；不是所有 leaf 都由纯 scheduler 自己执行。

**审计新增：**
- fanout 新增 `strategy: "quorum"`（需 `count` 个成功项，返回 `{ accepted, completed }`）。
- parallel branch / fanout item 有 per-branch/item output schema 校验（`normalizeValue(branch.outputSchema, ...)`）。
- `SignalAwaitingError` 和 `ExecutorRequiredError` 携带 `executedNodes` 快照，支持 durable resume。
- `options.completedNodes` 支持从 durable state 恢复预完成 nodes。
- 测试已移至 `runtime-scheduler.integration.test.ts`。

标注：
- 决策：确认。quorum strategy 需补充到 spec。
- 备注：quorum 是新增 fanout 策略，未在原 roadmap 中描述。

#### Composite scope

当前实现：composite child scope 隔离，父级只看到 composite 声明输出。

证据：`packages/runtime/src/execution/scheduler.ts` (`createChildScope`, `evaluateOutputs`)

审计备注：已覆盖 branch-local nodes 不泄漏。

**审计补充：**
- Child scope 通过 spread 浅拷贝 `nodes` map，child writes 不回流 parent。
- `parallel.race` 使用独立 `branchExecuted` 记录，仅 winner 的 nodes 合并回 scope。
- `runtime`/`fanout`/`loop` slots 按 node 类型覆盖（fanout/loop 显式设置 child slot）。
- `input` 跨 scope 共享引用（不可变，符合预期）。

标注：
- 决策：确认。

#### `parallel.race`

当前实现：executable race 使用保守的声明顺序 first-success；executable branch 是顺序执行（`for...of`），不启动 winner 之后的 branch。

证据：`packages/runtime/src/execution/scheduler.ts`, `specs/runtime-spec.md`

审计备注：这是当前合同，不是 legacy 的真并发 race。

**审计补充：**
- Non-executable branch（纯 composite 无 side-effect）失败被收集到 `failures` 列表而非立即 throw，允许后续 executable branch 胜出。
- Winner 输出 shape 为 `{ winner: key, result }`，经 `branch.outputSchema` normalize。
- `ExecutorRequiredError`/`SignalAwaitingError` 直接传播（非 failure，是暂停）。

标注：
- 决策：确认。

#### Runtime evaluator

当前实现：支持 `literal`、`ref`、`array`、`object`、`template`、`call`。refs 包含 `input`、`workflow.input`（归一化为 `input`）、`nodes`、`runtime`、`fanout`、`loop`。

证据：`packages/runtime/src/evaluation/evaluator.ts`, `packages/runtime/test/runtime-evaluator.unit.test.ts`

审计备注：`runtime` root 可解析，但 scheduler 注入 `runtime: {}`，表达式中 `runtime.*` 为 undefined；仅 JS TaskContext 有 runtime 字段注入，见 gap。

**审计新增：**
- 数组索引访问（`input.tags.0`）。
- `null`/`undefined` traversal 返回 undefined（safe navigation）。
- `loop` scope 暴露 `{ iter, previous, result }`（新增 `result` per-iteration）。
- Bare `workflow.*`（非 `workflow.input`）被拒绝。
- 所有 operator 调用做严格 arity/type 检查。

标注：
- 决策：确认。

#### Operators

当前实现：runtime 通过 `@acpus/expression/evaluator` 执行 expression package 拥有的当前 operator 集合，包括 `ifElse`、`get`、`map`、`filter`、lambda 版 `every`/`some`，以及基础逻辑、比较、字符串、长度、`coalesce`、`max`、`min` 等 helper lowered calls。

证据：`packages/runtime/src/evaluation/evaluator.ts`, `packages/expression/src/evaluator.ts`

审计备注：Boolean operator 不走 JavaScript truthiness。

**审计补充：**
- 严格类型检查覆盖所有 operand（不仅 boolean）：`booleanArg`/`numberArg`/`stringArg`/`arrayArg` 对类型不匹配直接 throw。
- Equality 使用 expression evaluator 的 JSON-compatible structural equality 和 SameValueZero primitive 语义。
- `coalesce` 仅在 `!== null && !== undefined` 时 short-circuit。

标注：
- 决策：确认。

#### Template rendering

当前实现：template rendering 委托 `@acpus/expression/evaluator`。string 直接渲染，number/boolean/null 使用 `String(value)`，array/object 使用 `JSON.stringify` 语义；missing、`undefined`、非 JSON-compatible value 直接失败。

证据：`packages/runtime/src/evaluation/evaluator.ts`, `packages/expression/src/evaluator.ts`

审计备注：此段已按 `@acpus/expression` 拆包后的 evaluator 语义更新，具体 operator 和 formatting contract 以 `specs/expression-spec.md` 为准。

**审计补充：**
- runtime 不再拥有 expression formatting 细节，只拥有 workflow ref scope adapter。

标注：
- 决策：确认。

#### Runtime schema

当前实现：workflow input、signal payload、node output 进入 durable completion 前集中校验/归一化。

证据：`packages/runtime/src/evaluation/schema.ts`, `packages/runtime/src/admission/input.ts`, `packages/runtime/src/execution/scheduler.ts` (`validateNodeOutput`)

审计备注：output schema violation 会 durable fail 并标记相关 node。

**审计新增：**
- Schema types 新增 `secret_ref` 和 `artifact`（artifact 校验 mediaType）。
- Defaults 递归应用（`applyDefaults`）。
- 错误路径带 JSON-path label（`$.foo.bar[0]`）。
- Per-branch/item output schema 校验（parallel/fanout）。
- If/switch/agent output 在有 `outputSchema` 时 normalize。

标注：
- 决策：确认。`secret_ref` 和 `artifact` schema types 需补充到 spec。

#### Task execution

当前实现：task 从 `.acpus/runs/<run-id>/task-bundles` 的 frozen run-local bundle 加载执行。default export task function 是执行单元。

证据：`packages/runtime/src/execution/task-executor.ts`, `packages/runtime/src/store/store.ts` (`admitRun` bundle writes), `packages/workflow-compiler/src/compiler/task-bundler.ts`

审计备注：

**审计新增：**
- 两种 task 形态：inline task（`toString()` 后 esbuild bundle）和 reusable/external task（`task.define()` token，路径导入后 esbuild bundle）。
- esbuild target node22 ESM，bundle ID 为 `task_<sha256 prefix 16 chars>`。
- Bundle 在 fork 时通过 `verifyFrozenRunFiles` 做 byte-level digest 校验。

标注：
- 决策：确认。

#### Task context

当前实现：TaskContext 提供 `input`、`params`、`$`、`artifact`、`log`、`env`、`runtime`、`signal`。

证据：`packages/core/src/runtime/task-context.ts`, `packages/runtime/src/execution/task-executor.ts`

审计备注：`log` 当前不持久化（no-op stub），需避免把它理解为 legacy telemetry/log artifact 等价物。

**审计新增：**
- `runtime` 对象在 JS task 中为 `{ runId, nodeId, nodeKey, attempt, workDir, outputDir }`（`workDir`/`outputDir` 为 `work/<nodeId>` 和 `outputs/<nodeId>`，框架预创建但不自动清理）。
- 注意：workflow expression 中 `runtime.*` 仍为空对象（见 gap）；仅 JS task function 可访问 runtime 字段。
- `env` 表达式求值时拒绝 secret ref（执行时校验）。

标注：
- 决策：确认。

#### Task runtime options

当前实现：支持 `cwd`、非 secret `env`、`retry.max`、node `timeout`、`execution.defaultCommandTimeout`、`$({ ... })` 保留默认 timeout、显式 per-command timeout。

证据：`packages/runtime/src/execution/task-executor.ts`, `packages/core/src/runtime/dollar.ts`

审计备注：只支持 `execution.shell: "bash"` 和 `execution.commandRunner: "acpus-zx-core"`（类型声明了 `powershell`/`pwsh`/`custom` 但 runtime 拒绝）。

**审计新增：**
- `$` 新增 `.nothrow()`、`.allowExitCode(codes)`、`.text()/.json()/.lines()` readers。
- `DollarConfig` 使用 configurator pattern（`$({ cwd, env, timeout, nothrow, allowExitCode })`cmd``），无 chainable `.cwd()/.env()`。
- `CommandSpan`/`onSpan` hook 已定义但未 wiring（spans 不记录）。
- `retry.on`/`retry.backoff` 类型存在但未消费（retry 所有错误，无 delay）。
- Per-attempt `AbortController`：timeout 触发 abort，abort 后 late artifact write 被拒绝；dollar command 传播 abort 为 SIGTERM。

标注：
- 决策：确认。

#### Artifact APIs

当前实现：支持 `writeText`、`writeJson`、`writeBytes`、`fromFile`，写入 run-local artifact 并登记 SQLite registry row。返回 `artifact://<runId>/<id>` URI。

证据：`packages/runtime/src/execution/task-executor.ts` (`createArtifactApi`), `packages/runtime/src/store/store.ts` (`registerArtifact`)

审计备注：registry 记录 run/node/attempt/media type/digest/size/relative path。路径为 `artifacts/<nodeKey>/<artifactUUID>-<safeName>`。

标注：
- 决策：确认。

#### Artifact hardening

当前实现：task timeout 后拒绝 late artifact write；fork/replay 校验 artifact bytes、digest、size、path containment、symlink escape。

证据：`packages/runtime/src/execution/task-executor.ts`, `packages/runtime/src/store/store.ts` (`verifyArtifactRegistry`, `readContainedFile`, `forkRun`, `verifyCopiedArtifacts`)

审计备注：这是当前比 legacy 更强的持久化完整性能力。

**审计新增：**
- Fork 使用 staging dir (`.staging-<forkId>`) + atomic rename，失败回滚。
- Fork 时 `artifact://` URI rewriting（inherited outputs 中 URI 指向新 fork run id）。
- `readContainedFile` 强制 path containment（realpath 检查、symlink 拒绝、`..` escape 拒绝）。
- Replay projection verification（`verifyReplayProjection`）额外校验 terminal event 与 node/run 状态一致性。

标注：
- 决策：确认。

#### Command-backed agents

当前实现：local command agent 支持 rendered prompt env、attempt env、cwd/env 表达式、retry、timeout、stdout/stderr cap、process-group SIGTERM/SIGKILL。

证据：`packages/runtime/src/execution/agent-node.ts`, `packages/agent-executor/src/index.ts`

审计备注：当前是 command protocol，不是 acpx session protocol。Agent executor 已拆分为独立 package `@acpus/agent-executor`。

**审计新增：**
- cwd/env 三层合并：process env → definition env → node.run env → extraEnv（`ACPUS_AGENT_PROVIDER`/`ACPUS_AGENT_MODEL`）。
- stdout/stderr 合并 cap 为 1,000,000 bytes。
- Timeout 升级：SIGTERM → 100ms → SIGKILL process group。
- Duration 解析支持 `ms|s|m|h`。
- `model` 字段通过 `ACPUS_AGENT_MODEL` env 传递（session/policy/options 未消费）。

标注：
- 决策：确认。

#### Built-in mock provider

当前实现：`mock` provider 从 rendered prompt 决定性执行（`JSON.parse`，失败 wrap 为 `{ text }`）。

证据：`packages/agent-executor/src/index.ts`, `packages/agent-executor/test/agent-executor.unit.test.ts`, `packages/cli/test/*.e2e.test.ts`

审计备注：用于 deterministic tests。E2E 测试已拆分为多个 focused 文件。

标注：
- 决策：确认。

#### Provider command mapping

当前实现：provider-backed agent 可通过 `ACPUS_AGENT_PROVIDER_COMMANDS` 本地命令映射执行。未映射 provider 进入 blocked 状态（ExecutorRequiredError → blockRun）。

证据：`packages/agent-executor/src/index.ts` (`getProviderCommandFromEnv`), `packages/runtime/src/execution/agent-node.ts`, `packages/runtime/src/execution/advance.ts`

审计备注：这是 escape hatch，不是 first-class provider adapter。

标注：
- 决策：确认。blocked 语义需在 CLI output 中更明确展示。

#### Signal execution

当前实现：signal node 无 payload 时进入 durable `awaiting`；`runs signal` 校验 payload、写 signal output/event、转回 pending 并从 frozen SQLite state 继续。

证据：`packages/runtime/src/store/store.ts` (`awaitSignal`, `signalRun`), `packages/runtime/src/control/apply-command.ts`, `packages/runtime/src/runs/use-cases.ts` (`signalRun`), `packages/cli/src/commands/runs.ts`

审计备注：duplicate signal 用 command idempotency key（`signal:${runId}:${nodeId}:${payload}`）+ SQLite UNIQUE 约束处理。

**审计新增：**
- Payload 在 use-case 层和 apply-command 层双重 normalize（无害冗余）。
- Supervisor tick 也可消费 signal commands（非仅 foreground CLI）。
- `signal.awaiting` event payload 为空对象 `{}`，不存 rendered prompt。

标注：
- 决策：确认。

#### Durable controls

当前实现：已实现 `runs list/show/status/pause/resume/retry/retry --node/fork/signal/replay/supervise --background/shutdown`。

证据：`packages/cli/src/commands/runs.ts`, `packages/runtime/src/control/apply-command.ts`, `packages/runtime/src/runs/use-cases.ts`, `packages/runtime/src/store/store.ts`

审计备注：mutating controls 写 `pending/running/applied/failed` command rows，带 idempotency key 和 generation fencing。

**审计新增：**
- `show` 和 `status` 当前调用同一 `showRun` 函数，输出完全相同（status 尚未成为更轻量的 live 视图）。
- Supervisor 是 detached subprocess（`packages/cli/src/supervisor-entry.ts`），通过 `runs supervise [--background]` 启动、`runs shutdown` 停止。
- Stale commands 通过 `recoverStaleCommands` generation-fenced 恢复。

标注：
- 决策：确认。show/status 合并可在富 inspection 时拆分。

#### Fork

当前实现：支持 plain fork、replacement workflow fork、input override fork、durable supervisor consumption。只继承匹配 node id 和 frozen node definition（nodeSignatures 深比较）的 completed nodes/artifacts。不继承 incomplete composite ancestor 下的 completed children。

证据：`packages/runtime/src/store/store.ts` (`forkRun`, `inheritableCompletedNodeKeys`, `nodeAncestors`, `rewriteArtifactRefs`)

审计备注：

**审计新增：**
- Input override fork 零继承（`inheritableNodeKeys = empty set`），全新开始。
- Replacement workflow fork 按新 IR signature 匹配继承。
- Completed source run 的 plain fork 直接创建为 completed 状态（含 rewritten outputs）。
- Staging dir + atomic rename + verifyCopiedArtifacts + verifyFrozenRunFiles。
- Artifact URI rewriting 在 node outputs 和 root output 中递归应用。

标注：
- 决策：确认。

#### Replay

当前实现：read-only replay 会重算 frozen root output、校验 artifact registry rows、校验 terminal event/projection consistency。

证据：`packages/runtime/src/store/store.ts` (`replayRun`, `verifyArtifactRegistry`, `verifyReplayProjection`), `packages/cli/src/output.ts`

审计备注：比 legacy topology replay 更偏 durable storage integrity。

**审计新增：**
- 结构化返回：`expected`/`actual` root output，`artifacts: { checked, missing, invalid, mismatched }`（mismatch 含 expected/actual digest+size），`projection.issues`。
- 未完成 run 的 replay 返回 `ok: false`，仅做 artifact/projection 校验。

标注：
- 决策：确认。

#### Supervisor

当前实现：detached supervisor 通过 Node detached spawn 启动（`runs supervise [--background]`），不使用 `supervisor.json` sidecar。SQLite lease 支持 acquire、active rejection、stale takeover、heartbeat generation fencing、release fencing。

证据：`packages/cli/src/commands/runs.ts` (`supervise`, `supervisorEntryArgs`), `packages/cli/src/supervisor-entry.ts`, `packages/runtime/src/supervisor/loop.ts`, `packages/runtime/src/supervisor/tick.ts`, `packages/runtime/src/store/store.ts` (`claimSupervisor`, `heartbeatSupervisor`, `releaseSupervisor`)

审计备注：tick 会清 stale staging dirs（默认 60s）、恢复当前 generation-owned stale commands、消费 commands（ASC by created，shutdown O(1) 短路）、advance pending runs、shutdown 后释放 lease 并退出。

**审计新增：**
- Default heartbeat 1s，stale lease 30s，可 override。
- `recoverStaleCommands` generation-fenced（仅恢复调用者自己 generation 的 stale commands）。
- Tick swallow per-command 和 per-tick errors 保持 supervisor alive。
- Supervisor spawn 支持 foreground（stdio inherit）和 background（detached + stdio ignore + unref）。
- `supervisor-entry.ts` 硬编码 `packageVersion: "0.6.0-alpha"`。

标注：
- 决策：确认。

### 当前有但 legacy 没有或语义明显不同

#### TypeScript-first entry

当前实现：顶层 `acpus run <workflow-module>` 是当前入口。admission 后立即同步 advance。

legacy 对比：legacy 主入口是 `workflows run <YAML/ref>`。

备注：不做 YAML 兼容，除非另立目标。

标注：
- 决策：确认。

#### SQLite truth

当前实现：SQLite 是 inspection/control truth。

legacy 对比：legacy 使用 `.acpus/state/runs/<run-id>/` 文件树和 supervisor HTTP API。

备注：当前 read-only inspection 不创建 state。

标注：
- 决策：确认。

#### Durable command queue

当前实现：控制命令持久化为 SQLite command rows，foreground CLI 或 supervisor 都可消费。支持 idempotency key 和 generation fencing。

legacy 对比：legacy 多为 live supervisor route / interpreter method 控制。

备注：更适合 crash recovery 和 detached supervisor。

标注：
- 决策：确认。

#### Source-independent signal continuation

当前实现：signal delivery 不需要 live interpreter resolver，通过 `getFrozenRun` 从 SQLite 加载 frozen IR/input 继续。

legacy 对比：legacy signal 依赖 in-flight resolver，否则会失败/冲突。

备注：这是当前 durable signal 的核心增量。

标注：
- 决策：确认。

#### Artifact registry

当前实现：artifact 有 SQLite registry、digest（sha256:hex）、size（bytes）、mediaType、relative path。返回 `artifact://` URI。

legacy 对比：legacy artifact store 主要是文件 URI/path。

备注：支撑 replay/fork integrity（含 URI rewriting）。

标注：
- 决策：确认。

#### Hardened fork/replay

当前实现：fork/replay 校验 artifact bytes、digest、size、path containment（realpath+symlink 检查）、frozen run files、task bundles。Fork 使用 staging+atomic rename。Replay 额外做 projection consistency 校验。

legacy 对比：legacy fork 主要依赖 checkpoint/hash 和文件复制。

备注：当前安全性更强。

标注：
- 决策：确认。

#### Stable structured template rendering

当前实现：object/array render 为 sorted-key pretty JSON（2-space indent）；undefined→""，primitives 使用 String()。

legacy 对比：legacy template 对 object 直接 `String()`，容易得到 `[object Object]`。

备注：当前行为更适合 prompts/commands。

标注：
- 决策：确认。

#### Provider command mapping

当前实现：`ACPUS_AGENT_PROVIDER_COMMANDS` 提供 provider-backed agent escape hatch。Agent executor 在独立 package `@acpus/agent-executor`。

legacy 对比：legacy 更偏 direct acpx session executor。

备注：不是 first-class adapter。

标注：
- 决策：确认。

## 上半部分：功能 gap

### 已发现 gap

#### `runs cancel`

当前状态：当前没有 CLI/control/store cancel command。`RunStatus` 类型声明了 `"canceled"` 但无代码写入。

legacy / 期望能力：legacy 有 cancel command、client route、RunControl cancel。

建议处理：若需要用户中断 running/awaiting run，应作为 control 目标补齐。现有 command state machine（pending→running→applied/failed）可自然容纳 cancel command。

标注：
- 决策：需要实现（P1）。

#### in-flight pause/cancel abort

当前状态：当前 pause 是纯状态转移（`transitionRun`），不中断 running executors。仅 task timeout 路径有 per-attempt `AbortController`；外部 pause/cancel/retry 无法到达该 controller。Agent executor 完全不接受 `AbortSignal`。

legacy / 期望能力：legacy 用 active `AbortController` 中断 running/awaiting nodes。

建议处理：和 `runs cancel`、task/agent process lifecycle 一起设计。需将 AbortSignal 沿 scheduler → executor 传递。

标注：
- 决策：需要实现（P1，与 cancel 耦合）。

#### `runs clean`

当前状态：supervisor tick 自动清理 stale `.staging-*`（默认 60s）；store helper `cleanupRunDirectories({ removeOrphanedRuns: true })` 存在但未暴露为 public CLI/use-case。无 `runs clean` 命令。

legacy / 期望能力：legacy 有 terminal run clean/dry-run。

建议处理：可作为 store maintenance/CLI 目标。

标注：
- 决策：需要实现（P2）。

#### 富 run inspection

当前状态：`RunDetails` 仅暴露 `id/name/status/workflowEntry/irDigest/sourceGraphDigest/createdAt/updatedAt/input/output/eventCount/nodeCount/taskBundleCount`。`runs show/status` 输出完全相同，不暴露 nodes、attempt、duration、artifact refs、agent activity、awaiting signal prompt/schema、events。`runs list` 仅四列 tab-delimited（id/status/name/workflowEntry）。

legacy / 期望能力：legacy `runs-show` 有紧凑但信息丰富的展示。

建议处理：建议优先补（P0），因为直接影响人工操作 durable runs。

标注：
- 决策：需要实现（P0）。

#### Public node/artifact inspection

当前状态：当前没有 `runs nodes`/`runs node`/`runs artifacts`/`runs ir`/`runs input` 等命令；runtime index 未导出 node/artifact query endpoints。artifact table 仅内部使用。

legacy / 期望能力：legacy supervisor/client 有相关 routes。

建议处理：可先做只读 CLI/API，不改变执行语义。

标注：
- 决策：需要实现（P1，与富 inspection 共用数据模型）。

#### Foreground follow / JSONL observations

当前状态：`acpus run` 仅支持 `--dry-run`/`--input`/`--json`，同步 advance 后退出，无 `--background` flag。无 follow stream、无 JSONL event subscription、无 EventEmitter/observer API。`runs supervise --background` 是后台 supervisor daemon，非单 run follow。

legacy / 期望能力：legacy 支持 follow、poll、JSONL observations、Ctrl-C detach。

建议处理：对长任务和 agent workflows 很关键。

标注：
- 决策：需要实现（P1）。

#### Closed IR validation hardening

当前状态：已由 expression language remediation 完成。`validateWorkflowIR` 会检查 `WorkflowIR`、node、scope、template、expression wrapper、agent、task bundle、`SchemaIR` 变体和 `ExprIR.type` 内嵌 `TypeIR` 的 closed shape，并为 schema/type nested paths 返回稳定 diagnostics。

当前 spec / 风险：`specs/core-spec.md` 要求 `WorkflowIR`、schema IR、expression IR 等序列化对象使用 closed shape，并要求 `validateWorkflowIR(...)` 诊断 unknown fields。该 closed-shape gap 已关闭；后续 durable work 只需关注新的 runtime 行为缺口。

建议处理：无剩余 remediation work。

标注：
- 决策：已完成。

#### Agent overrides

当前状态：当前 CLI 无 `--agents`，run/fork 不支持 submit-time agent override。`admitWorkflowRun` 签名仅接受 `cwd/prepared/input`。注意：legacy/ 目录仍有 `--agents` 支持，但非活跃代码。

legacy / 期望能力：legacy 支持 `--agents`，并持久化 warnings/overrides。

建议处理：需要 TypeScript-first 版本的 override model。

标注：
- 决策：需要实现（P2）。

#### Hooks

当前状态：当前 runtime/spec/CLI 没有 hooks loader、injectors、events、journal。Grep "hook" across packages/ 返回零匹配。内部 `run_events` 是 state-machine events，非可扩展 hook platform。

legacy / 期望能力：legacy hooks 是 runtime platform layer，不完全依赖 YAML。

建议处理：这是产品决策 gap；若保留，需要新 spec。

标注：
- 决策：有争议（P1 产品决策）。

#### acpx session-backed agent

当前状态：当前是 command/provider-command protocol，无 acpx `sessions ensure`、continuation、cancel、policy mapping。"acpx" 仅作为测试中 example command string 出现。

legacy / 期望能力：legacy agent executor 管 acpx session、prompt、cancel、权限 flag。

建议处理：当前 spec 已把 first-class provider adapters 延后；是否补 acpx 需决策。

标注：
- 决策：暂不做（P3，first-class provider adapters 时一并考虑）。

#### Agent `session` / `policy` consumption

当前状态：core authoring 字段存在（`policy`、`session.key`、`options`），但 runtime 仅消费 `model`（通过 `ACPUS_AGENT_MODEL` env）。`policy`/`session`/`options` 未读取、未传递给 executor。

legacy / 期望能力：legacy runtime 使用 session/policy 影响 acpx execution。

建议处理：要么实现，要么在 spec 标注当前不支持。

标注：
- 决策：需规格化——在 spec 中标注当前不支持 policy/session/options，仅 model 生效。

#### Agent schema prompting / JSON recovery

当前状态：当前 `parseAgentOutput` 仅做 `stdout.trim()` + `JSON.parse()`，失败 wrap 为 `{ text }`。无 schema prompt injection、无 code-fence/prose extraction、无 JSON repair。Executor 不接收 outputSchema（仅 post-parse normalize）。

legacy / 期望能力：legacy 会把 output schema 注入 prompt，并从 prose/code fence 抽取/repair JSON。

建议处理：可改善 agent UX 和 output reliability。

标注：
- 决策：需要实现（P1）。

#### Agent telemetry/artifacts

当前状态：当前 agent executor 为纯函数（`{command, prompt, cwd, env, maxAttempts, timeout, acceptOutput}`），无 runId/nodeKey/store 通道，不写 prompt/response/stderr/telemetry artifacts。Task 有 artifact plumbing，agent 完全未接入。stdout/stderr 仅 in-memory，parse 后丢弃。

legacy / 期望能力：legacy 持久化 prompt、response、stderr、telemetry、tool calls、token/context usage、acpxRecordId。

建议处理：与 follow/show 目标强相关。

标注：
- 决策：需要实现（P1）。

#### Agent retry details

当前状态：当前 task 和 agent 均支持 `retry.max`；`retry.on`、`retry.backoff` 在 IR 类型中声明但均未消费。Executor 对 timeout/overflow/nonzero-exit/parse-failure 统一 retry，无分类、无 delay。缺少 error taxonomy（AgentTimeoutError 等）来映射 `retry.on`。

legacy / 期望能力：legacy 有更细的 retry 分类和 recovery。

建议处理：与 current core retry type 对齐后补规格。

标注：
- 决策：需要实现（P1/P2，需先定义 error taxonomy）。

#### Signal timeout/onTimeout/default

当前状态：core IR 可表达 signal `timeout`/`onTimeout: { action: "fail", message? }`，但 runtime scheduler 仅检查 `signalPayloads`，不读取 `node.timeout`/`node.onTimeout`。Supervisor tick 无 signal-timeout scanner。审计探针确认：带 `timeout: "1ms"` 和 `onTimeout: { action: "fail" }` 的 signal 仍直接进入 awaiting，而不是触发 timeout fail。

legacy / 期望能力：legacy 支持 timeout default/fail、外部 signal 和 timeout 竞争。

建议处理：当前 runtime-spec 未完整覆盖，需要规格化。

标注：
- 决策：需要实现（P0，含 prompt persistence）。

#### Signal prompt visibility

当前状态：`awaitSignal` 不接收/持久化 rendered prompt/schema；`signal.awaiting` event payload 为 `{}`；`RunDetails` 不含 awaiting metadata；CLI output 不展示 signal prompt/schema。Rendered template + outputSchema 需从 frozen IR 重新求值（非已存储）。

legacy / 期望能力：legacy 会在 `runs show`/TUI 展示 signal prompt 和 expected schema。

建议处理：建议纳入富 inspection（P0）。

标注：
- 决策：需要实现（P0，与富 inspection 合并）。

#### `maxConcurrency`

当前状态：TS-first public/IR 字段存在（`ParallelNodeIR.maxConcurrency`、`FanoutNodeIR.maxConcurrency`），authoring DSL 和 validator 均接受，但 runtime scheduler 在 `parallel all`/`fanout` 使用裸 `Promise.all`，完全不读 `node.maxConcurrency`。Grep `packages/runtime/src` for `maxConcurrency` 返回零 hit。审计探针确认：`fanout.maxConcurrency: 1` 时 3 个 item 仍可同时运行（`maxActive: 3`）。

legacy / 期望能力：legacy 用 `pLimit(maxConcurrency)`，有并发测试。

建议处理：这是当前 API 和 runtime 行为不一致，P0 优先修正或明确不支持。

标注：
- 决策：需要实现（P0）。需定义 failure 和 cancellation 语义。

#### `fanout.key` / lane identity

当前状态：core 接收/lower `fanout.key`（template/string/function），但 runtime scheduler 不读 `node.key`，不计算 stable lane id，fanout scope 仅含 `{ item, itemIndex }`。**重要：concurrent fanout items 共享 body 中 static node ids，当前会在 `outputs/<nodeId>/`、`work/<nodeId>/`、artifact path 上产生目录冲突（latent correctness bug）。** 这也会影响 node projection、resume、fork/replay 和 artifact registry 的 per-item 语义。

legacy / 期望能力：legacy 有 dynamic node key/lane identity。

建议处理：与 dynamic `NodeInstanceKey` 目标相关。目录冲突需在 lane identity 方案中解决。

标注：
- 决策：目录冲突 hotfix 需要实现（P1）；完整 dynamic `NodeInstanceKey`/lane identity 可作为 P2 结构性完善。

#### `runtime.*` refs

当前状态：evaluator 支持 `runtime` root，但 scheduler `createRootScope` 注入 `runtime: {}`，workflow 表达式中 `$(runtime.runId)` 等返回 undefined。core 声明了 `runtime.runId/nodeId/workspaceDir/outputDir/now` tokens。仅 JS TaskContext 有 `{ runId, nodeId, nodeKey, attempt, workDir, outputDir }`（缺少 `workspaceDir`/`now`），但不注入 expression scope。

legacy / 期望能力：用户可能期望 runId/workspace/outputDir/now 等字段。

建议处理：需定义 public runtime scope contract，并在 scheduler 中注入。

标注：
- 决策：需要实现（P2）。

#### Composite cancellation propagation

当前状态：`parallel all`/`fanout` 使用 `Promise.all`，任一 rejection reject aggregate，但 in-flight siblings 无 AbortSignal 传入，继续在 floating promises 中运行。`parallel.race` 顺序执行，winner 后不启动后续 branch，但已启动的 executable branch 无 abort。

legacy / 期望能力：legacy 对并发失败有 cancellation/control-plane 传播。

建议处理：如果实现 cancel/abort，需要一起处理（依赖 in-flight abort 能力）。

标注：
- 决策：需要实现（P1，与 cancel/abort 耦合）。

#### First-class ProgramExecutor 等价能力

当前状态：当前可在 task 内用 `$` 手写命令逻辑（有 `.nothrow()`/`.allowExitCode()`/`.text()/.json()/.lines()` helpers），但没有 declarative program node、capture/file capture/expect/parse/output projection。`NodeIR` union 不含 `program`/`command` kind。

legacy / 期望能力：legacy `run: program` 有 cmd、capture、parse、expect、分类错误和标准 output。

建议处理：TypeScript-first 是否需要 declarative program node 要决策。当前 `$` API 对命令场景已有一定覆盖。

标注：
- 决策：有争议。可暂不做，观察 `$` 加 `.expect()/.parse()` 等链式方法是否足够。

#### `$` stdout/stderr artifacts

当前状态：`CommandResult` 类型预留 `stdoutArtifact/stderrArtifact`，但 `wrapProcess` 仅 resolve 为 string，不赋值 ArtifactRef 字段，`createTaskDollar` 不传入 artifact handle。

legacy / 期望能力：legacy program 每次执行写 stdout/stderr attempt artifacts。

建议处理：可先实现 opt-in 或 size-capped artifact capture。

标注：
- 决策：需要实现（P1/P2，与 agent telemetry 共用 artifact 通道）。

#### Artifact read/list/resolve

当前状态：`ArtifactApi` 仅暴露 write 方法（`writeText/writeJson/writeBytes/fromFile`），无 read/list/parse/resolve。内部 `readContainedFile` 为 private，不通过 `RuntimeStore` 接口暴露。

legacy / 期望能力：legacy ArtifactStore 支持 read/list/parse/resolve。

建议处理：对下游 task 消费 artifact 有价值。

标注：
- 决策：需要实现（P1）。

#### Atomic artifact write

当前状态：`writeArtifact` 直接 `writeFile(absolutePath, bytes)`，无 temp+rename。Post-abort 路径做 `rm` cleanup 但 crash-unsafe。Fork 使用 run-dir granularity atomic rename，但单 artifact 级别不是。

legacy / 期望能力：legacy `ArtifactStore.write` 使用 `.tmp` 后 rename。

建议处理：replay 能检测部分问题，但 hard crash 仍可能留下半写文件。

标注：
- 决策：需要实现（P1，与 read/list 同批）。

#### Append/streaming artifacts

当前状态：当前没有 append/create streaming artifact 能力。所有 write 走 fully buffered `writeArtifact(name, bytes: Uint8Array)`。

legacy / 期望能力：legacy 用于 acp debug/jsonl 等执行中追加。

建议处理：与 telemetry/follow 目标相关。

标注：
- 决策：需要实现（P2，与 telemetry/follow 同批）。

#### Per-attempt artifacts

当前状态：`attempt` 计数器已在 `artifacts` 表和 `ctx.runtime.attempt` 中存在，但框架不自动写 attempt-level lifecycle 文件（prompt/response/stderr/telemetry）。`log` API 是 no-op，`onSpan` hook 未 wiring。

legacy / 期望能力：legacy 有 AttemptArtifactRecorder（`attempt-NNN.prompt.md`、`response.md`、`stderr.log`、`telemetry.json`、`acp-debug.jsonl`）。

建议处理：与 agent observability 强相关。

标注：
- 决策：需要实现（P1，与 agent telemetry 同批）。

#### Bounded dynamic storage key

当前状态：artifact path 使用 `artifacts/<nodeKey>/<uuid-safeName>`，safeName capped at 120 chars。work/output 目录使用静态 `node.id`。fanout 动态 item 无 per-lane 目录，存在并发覆盖风险（见 fanout.key gap）。无 bounded lane-key-to-index mapping。

legacy / 期望能力：legacy 有 bounded node storage key 和 `node-index.jsonl`。

建议处理：若引入 dynamic `NodeInstanceKey`/fanout lane identity，需要一起设计。

标注：
- 决策：需要实现（P2，与 fanout.key 耦合）。

### 表述或语义需澄清标注

#### Scheduler leaf execution 表述

原表述问题："Runtime scheduler executes frozen `WorkflowIR` with `task`/`agent`/`signal`"。

为什么需要澄清：容易误解为纯 scheduler 直接执行所有 leaf。实际是 scheduler dispatch，task/agent/signal 依赖 executor 或 signal payload。

建议改法：表述为"scheduler 执行 composite/control nodes，并通过 executor/payload 接入 executable leaves"。

标注：
- 决策：确认，已在 Scheduler 节反映。

#### Admission 和 advance 混用

原表述问题："Admission can complete ... workflows"。

为什么需要澄清：admission 和 advance 被混在一起。当前 admission 写入 frozen state；随后立即 advance，才可能同步完成。

建议改法：区分"admission freezes state"和"admission 后的 immediate advance may complete"。

标注：
- 决策：确认，已在 Admission 节反映。

#### Task `log`

原表述问题："Task context supports `log`"。

为什么需要澄清：`log` 当前是 no-op / 非持久化，不等价 legacy runtime logs 或 attempt artifacts。

建议改法：标注为"提供 API 占位，当前不产生 durable log"。

标注：
- 决策：确认，已在 Task context 节反映。

#### `runtime` ref

原表述问题："Runtime refs include `runtime`"。

为什么需要澄清：evaluator 能解析 root，但 scheduler 注入 `runtime: {}`，workflow 表达式中字段为 undefined。仅 JS TaskContext 有部分 runtime 字段。

建议改法：定义 runtime scope contract，或在当前 spec 明确字段未在 expression scope 提供。

标注：
- 决策：需规格化（P2）。

#### Provider command mapping

原表述问题："Provider-backed agents via `ACPUS_AGENT_PROVIDER_COMMANDS`"。

为什么需要澄清：容易被读成 first-class provider adapters 已完成。未映射 provider 进入 blocked 状态。

建议改法：表述为"local provider command mapping escape hatch；first-class adapters 未实现；未映射 provider 导致 run blocked"。

标注：
- 决策：确认，已在 Provider command mapping 节反映。

#### Cleanup capability

原表述问题："Stale `.staging-*` cleanup and explicit orphan `run_*` cleanup are supported"。

为什么需要澄清：Store helper 支持（需 `removeOrphanedRuns: true`）和 public CLI 能力不同；当前没有 `runs clean`。

建议改法：区分 internal writable maintenance 和 public cleanup UX。

标注：
- 决策：确认。

#### Known gaps

原表述问题："Known gaps are not hidden TODOs"。

为什么需要澄清：原文同时列出 future goals 和 current contracts，容易掩盖仍需产品决策的 gap。

建议改法：改为"当前合同、已知限制和待决策能力"。

标注：
- 决策：确认。

#### Verification wording

原表述问题："Last full verification passed"。

为什么需要澄清：这是上一轮实现结束时的历史记录。

建议改法：表述为"上次报告的验证记录"。

标注：
- 决策：确认。

#### `parallel.race`

原表述问题："Executable `parallel.race` supported"。

为什么需要澄清：支持的是顺序、声明顺序 first-success 语义，不是 legacy 真并发 race。Non-executable branch 失败不阻塞后续 executable branch。

建议改法：始终写明"declaration-order sequential race"，并补充 non-executable branch 容错语义。

标注：
- 决策：确认，已在 parallel.race 节反映。

#### Dynamic `NodeInstanceKey`

原表述问题："Full Dynamic `NodeInstanceKey` future goal"。

为什么需要澄清：同时已有 `fanout.key` public/IR 字段，runtime 不消费；且当前 fanout item 共享 static node id 导致 work/output/artifact 目录冲突（latent bug）。这不只是未来增强，也有当前 API 语义缺口和 correctness 问题。

建议改法：将 `fanout.key` runtime 未使用和目录冲突列为高优 gap，将完整 NodeInstanceKey 作为后续目标。

标注：
- 决策：确认。fanout 目录冲突应提升优先级评估。

### 当前合同或暂不计入 gap 的 legacy 面

#### YAML Workflow Spec / catalog / `workflows` commands

当前判断：不计入当前 durable runtime gap。代码库无 YAML 解析（仅 pnpm-lock.yaml 在 preflight 中引用）；CLI 仅有 `run` 和 `runs` 命令。

备注：代码库正在围绕 TypeScript-first core 重建。

标注：
- 决策：确认，暂不做。

#### TUI / served visualizer

当前判断：不计入当前 gap。代码库无 tui/ink/blessed/visualizer 相关代码；CLI 为纯 text/JSON output。

备注：可作为独立 roadmap 目标。

标注：
- 决策：确认，暂不做。

#### `supervisor.json` sidecar

当前判断：不计入 gap。Grep "supervisor.json" 返回零匹配。

备注：当前 SQLite lease 是替代设计。

标注：
- 决策：确认，暂不做。

#### first-class provider adapters

当前判断：当前明确用 command mapping + `@acpus/agent-executor` package；first-class adapters 是未来目标。

备注：需要产品需求后再做。

标注：
- 决策：确认，P3。

#### non-bash/custom runner

当前判断：当前 IR 类型声明了 `powershell`/`pwsh`/`custom`，但 `validateExecutionOptions` 在 runtime 拒绝非 `"bash"`/`"acpus-zx-core"`，fail loudly。

备注：需要真实消费者后再做。建议在类型层面也标注不支持，避免误导。

标注：
- 决策：确认，暂不做。需规格化类型限制。

#### remote/container profiles

当前判断：当前 local-process runtime。无 container/docker/remote profile 相关代码。

备注：属于未来隔离/部署目标。

标注：
- 决策：确认，P3。

#### 自动 ordinary tick orphan cleanup

当前判断：supervisor tick 默认仅清理 `.staging-*`，不自动清理 orphan `run_*`（需显式 `removeOrphanedRuns: true`）。故意保守，避免 admission/fork publish 与 SQLite persistence 的 crash window race。

备注：若要自动化，先加 intent/staging 机制。

标注：
- 决策：确认。

## 下半部分：后续可实现目标

### 目标选择

#### P0：富 run inspection

为什么做：当前 durable runtime 已能运行，但人工排障信息不足。

主要交付件：`runs show/status` 展示 nodes、attempt、duration、errors、artifacts、awaiting signal prompt/schema、events；JSON 输出稳定；拆分 show（full detail）和 status（lightweight live view）。

依赖/风险：可能需要扩展 `node_states` schema 和 `RunDetails` 类型。

标注：
- 决策：P0。与 signal prompt visibility 合并。

#### P0：修正 `maxConcurrency` 行为

为什么做：当前 public/IR 字段存在但 runtime 未使用，是 API/行为不一致。

主要交付件：scheduler 对 `parallel all`/`fanout` 使用 concurrency limiter（p-limit 或等价 semaphore）；补 unit/integration tests。

依赖/风险：需要定义失败和 cancellation 传播行为（依赖 composite cancellation）。

标注：
- 决策：P0。

#### P0：Signal timeout/default/prompt persistence

为什么做：core 可表达 timeout/onTimeout，但 runtime 未实现；awaiting UX 也缺 prompt。

主要交付件：signal timeout/default/fail 执行语义（supervisor tick scanner）；rendered prompt/schema 持久化（在 awaitSignal 时写入 event/state）；`runs show` 展示。

依赖/风险：需要 spec 更新。

标注：
- 决策：P0。

#### P1：`runs cancel` 与 in-flight abort

为什么做：用户需要可中断长 task/agent/signal run。

主要交付件：CLI/control/store cancel command；AbortController/process kill propagation 贯穿 scheduler→executor（含 agent executor）；cancelled projections/events；composite cancellation propagation（parallel/fanout sibling abort）。

依赖/风险：与 scheduler cancellation、task/agent lifecycle 强耦合；需引入 error taxonomy（AgentTimeoutError 等）。

标注：
- 决策：P1。

#### P1：Foreground follow / background run UX

为什么做：长任务需要观察和 detach，而不是只同步 advance 或手动 supervisor。

主要交付件：`acpus run --background`、`runs follow` 或 equivalent JSONL observations、poll interval、Ctrl-C detach 行为。

依赖/风险：依赖 richer events/node metadata 和 event streaming 能力。

标注：
- 决策：P1。

#### P1：Agent observability artifacts

为什么做：当前 agent 缺 per-attempt 可审计材料；task 有 artifact plumbing 但 agent 未接入。

主要交付件：Agent executor 接收 runId/nodeKey/artifact channel；prompt/response/stderr/telemetry artifacts per attempt；output cap 行为；artifact refs 持久化；`CommandSpan`/`onSpan` wiring；task per-attempt 生命周期文件；`$` stdout/stderr artifact capture。

依赖/风险：与 artifact append/read、show output 相关。

标注：
- 决策：P1。

#### P1：Agent JSON recovery 和 schema prompting

为什么做：command/provider agent 输出对模型 prose 不够健壮。

主要交付件：output schema prompt injection、JSON fence/prose extraction、schema retry 分类。

依赖/风险：需避免把 prompt policy 写死到 executor 内部；error taxonomy 需支持 schema-retry 分类。

标注：
- 决策：P1。

#### P1：Hooks 产品决策和最小实现

为什么做：legacy hooks 是 platform layer，当前完全缺失。

主要交付件：新 hooks spec；project/global config loader；最小 lifecycle events 或 injectors；journal。

依赖/风险：需要判断是否仍是 TypeScript-first runtime 的核心能力。

标注：
- 决策：有争议，需产品决策。

#### P1：Artifact read/list/atomic write

为什么做：当前 artifact 写入能力强，但消费和 crash atomicity 不足。

主要交付件：read/list/resolve APIs（TaskContext + store facade）；temp+rename writes；optional append/create streaming。

依赖/风险：需保持 registry digest/size 一致性。

标注：
- 决策：P1。

#### P1：Public node/artifact inspection APIs

为什么做：CLI 和未来 UI/agent 都需要稳定只读接口。

主要交付件：`runs nodes`, `runs node`, `runs artifacts`, `runs ir`, `runs events` 或 JSON subcommands；store facade query methods。

依赖/风险：与富 show 共用数据模型。

标注：
- 决策：P1。

#### P1：fanout lane storage hotfix

为什么做：当前 concurrent fanout items 共享 body static node ids，会在 `work/<nodeId>`、`outputs/<nodeId>`、artifact path 上产生目录冲突，影响 resume/fork/replay 和 per-item inspection。

主要交付件：最小 per-lane work/output/artifact path 隔离；node projection 和 artifact refs 能区分 fanout item；补并发 fanout artifact/output 不互相覆盖的 regression tests。

依赖/风险：完整 dynamic `NodeInstanceKey` 可留给 P2，但 hotfix 需要避免之后迁移成本过高。

标注：
- 决策：P1。

#### Done：Closed IR validation hardening

为什么做：`specs/core-spec.md` 要求 schema/expression/type 等序列化 IR 使用 closed shape。该 gap 已由 expression language remediation 关闭，保留在此作为 durable-runtime audit 的历史记录。

主要交付件：`SchemaIR`/`TypeIR` 递归 unknown-field validator；稳定 diagnostic path；contract tests 覆盖 schema unknown field、nested type unknown field、valid schema 不误报。

依赖/风险：无剩余实现依赖。

标注：
- 决策：P2。

#### P2：Agent overrides

为什么做：submit-time provider/model/policy 覆盖仍缺。

主要交付件：`--agents` parser、validation、frozen metadata、fork override 行为。

依赖/风险：需对齐 TypeScript-first agent definitions。

标注：
- 决策：P2。

#### P2：`runtime.*` scope contract

为什么做：evaluator 支持 `runtime`，但 expression scope 为空；core 已声明 token 但不注入。

主要交付件：spec 定义 `runtime.runId`、`runtime.nodeId`、`runtime.workspaceDir`、`runtime.outputDir`、`runtime.attempt`、`runtime.now` 等；scheduler/advance 注入到 EvaluationScope；TaskContext 对齐补全 `workspaceDir`/`now`。

依赖/风险：需要避免泄漏不可序列化 runtime handles。

标注：
- 决策：P2。

#### P2：`fanout.key` 和 dynamic lane identity

为什么做：当前 core 接收 key 但 runtime 不消费；需要稳定 lane identity 支撑 replay、fork、inspection 和 bounded dynamic storage。

主要交付件：fanout lane identity、dynamic node key 或 internal stable key、fork/replay/inspection 语义、bounded lane-key-to-index mapping。

依赖/风险：与 full `NodeInstanceKey` 目标耦合；bounded dynamic storage key 需一并解决。

标注：
- 决策：P2（目录冲突 hotfix 已单独提升为 P1）。

#### P2：`runs clean`

为什么做：终端 run 和 orphan maintenance 需要用户入口。

主要交付件：dry-run/execute clean；只清 terminal runs 和明确 orphan dirs；保护 admitted runs。

依赖/风险：crash window 需要保守规则。

标注：
- 决策：P2。

#### P2：Fork dry-run plan / `--from`

为什么做：当前 fork 可用，但缺 plan 和人为 origin 控制。

主要交付件：fork inheritance plan 输出、`--from <node>`、lineage summary。

依赖/风险：依赖 node identity/inspection。

标注：
- 决策：P2。

#### P2：Store modularization

为什么做：`store.ts` ~1713 行，职责多。

主要交付件：拆 admission、controls、fork、replay、artifacts、lease、migrations internal modules。

依赖/风险：仅在行为稳定后做，避免重构掩盖 bug。

标注：
- 决策：P2。

#### P2：Test architecture cleanup（已部分完成）

为什么做：原 `cli.e2e.test.ts` 已很大且慢。

主要交付件：按 runtime area 拆 e2e/integration；保留高价值 cross-layer tests。

**审计新增：** 测试已按 package 拆分为 `unit`/`contract`/`integration`/`e2e`/`type-contract` vitest projects。Runtime 测试按 admission/controls/evaluator/scheduler/supervisor/lease 分文件；CLI E2E 拆分为 run-admit、run-check-failure、run-validate-failure、runs-inspect、runs-signal、supervisor 等 focused 文件。总计约 34 个测试文件。剩余工作：确保覆盖不降低，持续保持分层。

依赖/风险：拆测试不应降低覆盖。

标注：
- 决策：P2（大部分已完成，持续维护）。

#### P3：first-class provider adapters

为什么做：当前 command mapping 能工作，但直接集成体验有限。

主要交付件：provider adapter interface、config、tests。

依赖/风险：需要真实 provider 需求。

标注：
- 决策：P3。

#### P3：runner profiles

为什么做：当前 local-process only。

主要交付件：Docker/remote/profile spec 和 executor routing。

依赖/风险：需要隔离/部署需求。

标注：
- 决策：P3。

### 推荐实施顺序

1. **P0（当前 API 行为缺口 + 可观测性基础）：**
   - 富 `runs show/status`（含 signal prompt/schema 展示）
   - 修正 `maxConcurrency` 行为
   - Signal timeout/default + rendered prompt 持久化
2. **P1（控制面 + 可审计性）：**
   - `runs cancel` + in-flight abort（贯穿 scheduler→executor AbortSignal 传播，含 composite cancellation）
   - Artifact read/list/atomic write
   - Public node/artifact inspection APIs
   - fanout lane storage hotfix（先解决并发目录/产物冲突）
   - Agent observability artifacts（per-attempt prompt/response/stderr/telemetry，含 `$` stdout/stderr capture、onSpan wiring）
   - Agent JSON recovery + schema prompting（含 error taxonomy）
   - Foreground follow / background run UX（含 streaming/append）
   - Hooks 产品决策
3. **P2（结构性完善）：**
   - `runtime.*` scope contract
   - `fanout.key`/dynamic lane identity（完整 lane key、replay/fork/inspection 语义）
   - Agent overrides（`--agents`）
   - `runs clean`
   - Fork dry-run plan / `--from`
   - Store modularization
   - Test architecture 持续维护
4. **P3（扩展能力）：**
   - first-class provider adapters（含 acpx session 决策）
   - runner profiles

标注：
- 决策：调整推荐顺序，将 artifact read/list/atomic write 和 inspection APIs 提前到 P1（为 agent telemetry 和 follow 提供基础）。

## 验证记录

上一轮 handoff 报告的完整验证命令：

```sh
pnpm typecheck
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm test:e2e
```

上一轮报告的测试计数（monolithic 时期）：

- `pnpm test:unit`: 6 files / 36 tests
- `pnpm test:contract`: 2 files / 10 tests
- `pnpm test:e2e`: 1 file / 62 tests

**审计注（2026-06-29）：** 当前测试已按 package 和类型拆分（约 34 个测试文件），涵盖 core（7）、agent-executor（4）、workflow-compiler（5）、runtime（7-8）、cli（8-9）。本次审计未运行测试。若后续根据本文档修改实现或 specs，应按变更范围运行对应测试。

**审计补充（2026-06-30）：** 本轮 specs / roadmap gap review 已运行 `pnpm typecheck`、`pnpm test:unit`、`pnpm test:contract`、`pnpm test:integration`、`pnpm test:e2e`、`pnpm test:type`，均通过。当前文档补充仅更新 roadmap，验证为 `git diff --check -- docs/roadmap/durable-runtime-roadmap.md`。

当前测试计数：

- `pnpm test:unit`: 5 files / 29 tests
- `pnpm test:contract`: 8 files / 25 tests
- `pnpm test:integration`: 9 files / 47 tests
- `pnpm test:e2e`: 6 files / 7 tests
- `pnpm test:type`: 6 files / 24 tests

标注：
- 备注：测试计数已按 2026-06-30 审计补充更新；后续实现变更需按范围重跑对应测试。

## 当前状态

durable runtime 主干实现已经完成，并经过上一轮报告的验证。代码已拆分为五个独立 package（cli、runtime、core、agent-executor、workflow-compiler），测试架构已分层拆分。

本次审计确认：
- 所有"已实现能力"描述经代码核实基本准确，主要变更为文件路径和新增细节。
- 所有"已发现 gap"均未关闭，仍然有效。
- 新增发现：`SchemaIR`/`TypeIR` closed-shape validation 缺口、fanout 并发 item 目录冲突（latent correctness bug）、`blocked` 软状态、fanout quorum strategy、部分 runtime 类型超前于实现（powershell/pwsh/custom runner、retry.on/backoff、agent policy/session/options）、`runtime.*` expression scope 与 JS TaskContext 不一致。
- 下一步应先由人工在本文档中标注确认：哪些 gap 属于必须补齐的当前 runtime 能力，哪些属于明确暂不做的 legacy 面，哪些需要先更新 `specs/` 后再实现。

标注：
- 决策：需人工审阅确认 P0/P1 优先级和 hooks 产品决策。
