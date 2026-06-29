# Durable Runtime 交接与审计标注文档 - 2026-06-29

## 文档定位

本文档用于 durable runtime 实现阶段之后的人工审阅、能力盘点和后续目标选择。当前产品和设计真相仍以 `specs/` 为准；本文档是 roadmap/handoff 材料，不是规范文件。

主要参考：

- Roadmap: `docs/roadmap/durable-runtime-workflow.md`
- Runtime spec: `specs/runtime-spec.md`
- CLI spec: `specs/cli-spec.md`
- Runtime modules: `packages/acpus/src/runtime/`
- CLI commands: `packages/acpus/src/commands/run.ts`, `packages/acpus/src/commands/runs.ts`
- Main e2e evidence: `packages/acpus/test/cli.e2e.test.ts`
- Legacy runtime: `legacy/packages/runtime/`
- Legacy CLI: `legacy/packages/cli/`
- Legacy specs: `legacy/specs/`

## 标注方式

每个条目都提供一个“标注：”段。人工 review 时直接在该段后补充结论即可。

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
- 非 `bash` / custom task runner。
- first-class provider adapters。
- remote/container runner profiles。
- 自动清理所有 orphan `run_*` 目录。
- 完整 public dynamic `NodeInstanceKey`，除非后续目标重新定义。

标注：

### 已实现能力

#### Runtime admission

当前实现：`acpus run <workflow-module>` 已从 dry-run-only 变为可 durable admission。admission 会 typecheck、compile、validate、normalize input，写 `.acpus/state/runtime.db` 和 `.acpus/runs/<run-id>/`。

证据：`packages/acpus/src/commands/run.ts`, `packages/acpus/src/preflight.ts`, `packages/acpus/src/runtime/store.ts`

审计备注：“Admission”本身负责冻结和入库；入库后立即 `advanceRun`，因此纯 workflow/task/可执行 agent 可能同步完成。

标注：

#### Frozen run data

当前实现：运行时冻结 `WorkflowIR`、input JSON、lock metadata、workflow entry、IR digest、source graph digest、task bundle count、run directory path。

证据：`packages/acpus/src/runtime/store.ts`, `specs/runtime-spec.md`

审计备注：当前 read-only inspection 不读 live workflow source。

标注：

#### SQLite runtime store

当前实现：SQLite 表覆盖 `supervisor_lease`、`commands`、`runs`、`run_inputs`、`run_events`、`node_states`、`artifacts`。

证据：`packages/acpus/src/runtime/store.ts`

审计备注：SQLite 是当前 run inspection 和 control 的事实源。

标注：

#### Initial projections

当前实现：admission 为 frozen IR 的静态节点创建初始 `pending` projection；完成后未执行静态节点会标记 `skipped`。

证据：`packages/acpus/src/runtime/store.ts`, `packages/acpus/src/runtime/advance.ts`

审计备注：动态 fanout/loop instance 目前没有完整 public `NodeInstanceKey`。

标注：

#### Scheduler

当前实现：scheduler 覆盖 `assert`、`if`、`switch`、`parallel`、`fanout`、`loop`，并通过 executor 接入 `task`、`agent`、`signal`。

证据：`packages/acpus/src/runtime/scheduler.ts`, `packages/acpus/test/runtime-scheduler.unit.test.ts`

审计备注：更准确地说，scheduler dispatch executable leaves；不是所有 leaf 都由纯 scheduler 自己执行。

标注：

#### Composite scope

当前实现：composite child scope 隔离，父级只看到 composite 声明输出。

证据：`packages/acpus/src/runtime/scheduler.ts`

审计备注：已覆盖 branch-local nodes 不泄漏。

标注：

#### `parallel.race`

当前实现：executable race 使用保守的声明顺序 first-success；executable branch 是顺序执行，不启动 winner 之后的 branch。

证据：`packages/acpus/src/runtime/scheduler.ts`, `specs/runtime-spec.md`

审计备注：这是当前合同，不是 legacy 的真并发 race。

标注：

#### Runtime evaluator

当前实现：支持 `literal`、`ref`、`array`、`object`、`template`、`call`。refs 包含 `input`、`workflow.input`、`nodes`、`runtime`、`fanout`、`loop`。

证据：`packages/acpus/src/runtime/evaluator.ts`, `packages/acpus/test/runtime-evaluator.unit.test.ts`

审计备注：`runtime` root 可解析，但当前注入字段较少，见 gap。

标注：

#### Operators

当前实现：支持当前 lowered operator 集合：`not`、`and`、`or`、`eq`、`ne`、`lt`、`lte`、`gt`、`gte`、`len`、`includes`、`startsWith`、`endsWith`、`matches`、`coalesce`、`all`、`any`、`max`、`min`。

证据：`packages/acpus/src/runtime/evaluator.ts`

审计备注：Boolean operator 不走 JavaScript truthiness。

标注：

#### Template rendering

当前实现：object/array template value 渲染为稳定 pretty JSON。

证据：`packages/acpus/src/runtime/evaluator.ts`

审计备注：比 legacy 直接 `String(object)` 更安全。

标注：

#### Runtime schema

当前实现：workflow input、signal payload、node output 进入 durable completion 前集中校验/归一化。

证据：`packages/acpus/src/runtime/schema.ts`, `packages/acpus/src/runtime/scheduler.ts`

审计备注：output schema violation 会 durable fail 并标记相关 node。

标注：

#### Task execution

当前实现：task 从 `.acpus/runs/<run-id>/task-bundles` 的 frozen run-local bundle 加载执行。

证据：`packages/acpus/src/runtime/task-executor.ts`

审计备注：default export task function 是当前执行单元。

标注：

#### Task context

当前实现：TaskContext 提供 `input`、`params`、`$`、`artifact`、`log`、`env`、`runtime`、`signal`。

证据：`packages/core/src/runtime/task-context.ts`, `packages/acpus/src/runtime/task-executor.ts`

审计备注：`log` 当前不持久化，需避免把它理解为 legacy telemetry/log artifact 等价物。

标注：

#### Task runtime options

当前实现：支持 `cwd`、非 secret `env`、`retry.max`、node `timeout`、`execution.defaultCommandTimeout`、`$({ ... })` 保留默认 timeout、显式 per-command timeout。

证据：`packages/acpus/src/runtime/task-executor.ts`, `packages/core/src/runtime/dollar.ts`

审计备注：只支持 `execution.shell: "bash"` 和 `execution.commandRunner: "acpus-zx-core"`。

标注：

#### Artifact APIs

当前实现：支持 `writeText`、`writeJson`、`writeBytes`、`fromFile`，写入 run-local artifact 并登记 SQLite registry row。

证据：`packages/acpus/src/runtime/task-executor.ts`, `packages/acpus/src/runtime/store.ts`

审计备注：registry 记录 run/node/attempt/media type/digest/size/relative path。

标注：

#### Artifact hardening

当前实现：task timeout 后拒绝 late artifact write；fork/replay 校验 artifact bytes、digest、size、path containment、symlink escape。

证据：`packages/acpus/src/runtime/task-executor.ts`, `packages/acpus/src/runtime/store.ts`

审计备注：这是当前比 legacy 更强的持久化完整性能力。

标注：

#### Command-backed agents

当前实现：local command agent 支持 rendered prompt env、attempt env、cwd/env 表达式、retry、timeout、stdout/stderr cap、process-group SIGTERM/SIGKILL。

证据：`packages/acpus/src/runtime/agent-executor.ts`

审计备注：当前是 command protocol，不是 acpx session protocol。

标注：

#### Built-in mock provider

当前实现：`mock` provider 从 rendered prompt 决定性执行。

证据：`packages/acpus/src/runtime/agent-executor.ts`, `packages/acpus/test/cli.e2e.test.ts`

审计备注：用于 deterministic tests。

标注：

#### Provider command mapping

当前实现：provider-backed agent 可通过 `ACPUS_AGENT_PROVIDER_COMMANDS` 本地命令映射执行。未映射 provider 保持 pending/blocked。

证据：`packages/acpus/src/runtime/agent-executor.ts`, `packages/acpus/src/runtime/advance.ts`

审计备注：这是 escape hatch，不是 first-class provider adapter。

标注：

#### Signal execution

当前实现：signal node 无 payload 时进入 durable `awaiting`；`runs signal` 校验 payload、写 signal output/event、转回 pending 并从 frozen SQLite state 继续。

证据：`packages/acpus/src/runtime/store.ts`, `packages/acpus/src/runtime/control.ts`, `packages/acpus/src/commands/runs.ts`

审计备注：duplicate signal 用 command idempotency 处理。

标注：

#### Durable controls

当前实现：已实现 `runs list/show/status/pause/resume/retry/retry --node/fork/signal/replay/supervise --background/shutdown`。

证据：`packages/acpus/src/commands/runs.ts`, `packages/acpus/src/runtime/control.ts`

审计备注：mutating controls 写 `pending/running/applied/failed` command rows。

标注：

#### Fork

当前实现：支持 plain fork、replacement workflow fork、input override fork、durable supervisor consumption。只继承匹配 node id 和 frozen node definition 的 completed nodes/artifacts。

证据：`packages/acpus/src/runtime/store.ts`, `packages/acpus/src/runtime/control.ts`

审计备注：不继承 incomplete composite ancestor 下的 completed children。

标注：

#### Replay

当前实现：read-only replay 会重算 frozen root output、校验 artifact registry rows、校验 terminal event/projection consistency。

证据：`packages/acpus/src/runtime/store.ts`, `packages/acpus/src/output.ts`

审计备注：比 legacy topology replay 更偏 durable storage integrity。

标注：

#### Supervisor

当前实现：detached supervisor 通过 Node detached spawn 启动，不使用 `supervisor.json` sidecar。SQLite lease 支持 acquire、active rejection、stale takeover、heartbeat generation fencing、release fencing。

证据：`packages/acpus/src/runtime/supervisor.ts`, `packages/acpus/src/supervisor-entry.ts`, `packages/acpus/test/supervisor-lease.unit.test.ts`

审计备注：tick 会清 stale staging dirs、恢复当前 generation-owned stale commands、消费 commands、advance pending runs、shutdown 后退出。

标注：

### 当前有但 legacy 没有或语义明显不同

#### TypeScript-first entry

当前实现：顶层 `acpus run <workflow-module>` 是当前入口。

legacy 对比：legacy 主入口是 `workflows run <YAML/ref>`。

备注：不做 YAML 兼容，除非另立目标。

标注：

#### SQLite truth

当前实现：SQLite 是 inspection/control truth。

legacy 对比：legacy 使用 `.acpus/state/runs/<run-id>/` 文件树和 supervisor HTTP API。

备注：当前 read-only inspection 不创建 state。

标注：

#### Durable command queue

当前实现：控制命令持久化为 SQLite command rows，foreground CLI 或 supervisor 都可消费。

legacy 对比：legacy 多为 live supervisor route / interpreter method 控制。

备注：更适合 crash recovery 和 detached supervisor。

标注：

#### Source-independent signal continuation

当前实现：signal delivery 不需要 live interpreter resolver，可从 frozen SQLite state 继续。

legacy 对比：legacy signal 依赖 in-flight resolver，否则会失败/冲突。

备注：这是当前 durable signal 的核心增量。

标注：

#### Artifact registry

当前实现：artifact 有 SQLite registry、digest、size、mediaType、relative path。

legacy 对比：legacy artifact store 主要是文件 URI/path。

备注：支撑 replay/fork integrity。

标注：

#### Hardened fork/replay

当前实现：fork/replay 校验 artifact bytes、digest、size、path containment、symlink、frozen run files、task bundles。

legacy 对比：legacy fork 主要依赖 checkpoint/hash 和文件复制。

备注：当前安全性更强。

标注：

#### Stable structured template rendering

当前实现：object/array render 为 pretty JSON。

legacy 对比：legacy template 对 object 直接 `String()`，容易得到 `[object Object]`。

备注：当前行为更适合 prompts/commands。

标注：

#### Provider command mapping

当前实现：`ACPUS_AGENT_PROVIDER_COMMANDS` 提供 provider-backed agent escape hatch。

legacy 对比：legacy 更偏 direct acpx session executor。

备注：不是 first-class adapter。

标注：

## 上半部分：功能 gap

### 已发现 gap

#### `runs cancel`

当前状态：当前没有 CLI/control/store cancel command。

legacy / 期望能力：legacy 有 cancel command、client route、RunControl cancel。

建议处理：若需要用户中断 running/awaiting run，应作为 control 目标补齐。

标注：

#### in-flight pause/cancel abort

当前状态：当前 pause 主要是状态转移，不能可靠中断正在执行的 task/agent/process。

legacy / 期望能力：legacy 用 active `AbortController` 中断 running/awaiting nodes。

建议处理：和 `runs cancel`、task/agent process lifecycle 一起设计。

标注：

#### `runs clean`

当前状态：当前只有 stale `.staging-*` 自动清理和显式 orphan run dir maintenance helper，没有 public terminal run clean UX。

legacy / 期望能力：legacy 有 terminal run clean/dry-run。

建议处理：可作为 store maintenance/CLI 目标。

标注：

#### 富 run inspection

当前状态：`runs show/status` 输出较薄，不暴露完整 nodes、attempt、duration、artifact refs、agent activity、awaiting signal prompt/schema。

legacy / 期望能力：legacy `runs-show` 有紧凑但信息丰富的展示。

建议处理：建议优先补，因为直接影响人工操作 durable runs。

标注：

#### Public node/artifact inspection

当前状态：当前没有完整 public get nodes/get node/get IR/get input/artifact path/read/list 命令。

legacy / 期望能力：legacy supervisor/client 有相关 routes。

建议处理：可先做只读 CLI/API，不改变执行语义。

标注：

#### Foreground follow / JSONL observations

当前状态：当前 `acpus run` 尽量同步 advance，没有 run-level `--background` 和 follow stream。

legacy / 期望能力：legacy 支持 follow、poll、JSONL observations、Ctrl-C detach。

建议处理：对长任务和 agent workflows 很关键。

标注：

#### Agent overrides

当前状态：当前 CLI 无 `--agents`，run/fork 不支持 submit-time agent override。

legacy / 期望能力：legacy 支持 `--agents`，并持久化 warnings/overrides。

建议处理：需要 TypeScript-first 版本的 override model。

标注：

#### Hooks

当前状态：当前 runtime/spec/CLI 没有 hooks loader、injectors、events、journal。

legacy / 期望能力：legacy hooks 是 runtime platform layer，不完全依赖 YAML。

建议处理：这是产品决策 gap；若保留，需要新 spec。

标注：

#### acpx session-backed agent

当前状态：当前是 command/provider-command protocol，无 acpx `sessions ensure`、continuation、cancel、policy mapping。

legacy / 期望能力：legacy agent executor 管 acpx session、prompt、cancel、权限 flag。

建议处理：当前 spec 已把 first-class provider adapters 延后；是否补 acpx 需决策。

标注：

#### Agent `session` / `policy` consumption

当前状态：core authoring 字段存在，但 runtime 未完整消费。

legacy / 期望能力：legacy runtime 使用 session/policy 影响 acpx execution。

建议处理：要么实现，要么在 spec 标注当前不支持。

标注：

#### Agent schema prompting / JSON recovery

当前状态：当前主要 `JSON.parse(stdout)`，失败后按 text/schema failure 处理。

legacy / 期望能力：legacy 会把 output schema 注入 prompt，并从 prose/code fence 抽取/repair JSON。

建议处理：可改善 agent UX 和 output reliability。

标注：

#### Agent telemetry/artifacts

当前状态：当前没有 per-attempt prompt/response/telemetry artifacts，也没有 live compact telemetry projection。

legacy / 期望能力：legacy 持久化 prompt、response、stderr、telemetry、tool calls、token/context usage、acpxRecordId。

建议处理：与 follow/show 目标强相关。

标注：

#### Agent retry details

当前状态：当前支持 `retry.max`；未实现 `retry.on`、backoff、schema-backed 默认重试策略等细节。

legacy / 期望能力：legacy 有更细的 retry 分类和 recovery。

建议处理：与 current core retry type 对齐后补规格。

标注：

#### Signal timeout/onTimeout/default

当前状态：core 可表达 signal `timeout/onTimeout`，但 runtime 仅处理 awaiting/payload delivery。

legacy / 期望能力：legacy 支持 timeout default/fail、外部 signal 和 timeout 竞争。

建议处理：当前 runtime-spec 未完整覆盖，需要规格化。

标注：

#### Signal prompt visibility

当前状态：当前 awaiting state 没有保存 rendered prompt/schema 展示字段。

legacy / 期望能力：legacy 会在 `runs show`/TUI 展示 signal prompt 和 expected schema。

建议处理：建议纳入富 inspection。

标注：

#### `maxConcurrency`

当前状态：当前 TS-first public/IR 字段存在，但 `parallel all` / `fanout` runtime 使用 `Promise.all`，未限流。

legacy / 期望能力：legacy 用 `pLimit(maxConcurrency)`，有并发测试。

建议处理：这是当前 API 和 runtime 行为不一致，建议优先修正或明确不支持。

标注：

#### `fanout.key` / lane identity

当前状态：core 接收/lower/validate `fanout.key`，runtime scheduler 未使用它形成 stable lane identity。

legacy / 期望能力：legacy 有 dynamic node key/lane identity。

建议处理：与 dynamic `NodeInstanceKey` 目标相关。

标注：

#### `runtime.*` refs

当前状态：evaluator 支持 `runtime` root，但 scheduler/advance 注入的 runtime object 基本为空。

legacy / 期望能力：用户可能期望 runId/workspace/outputDir/now 等字段。

建议处理：需定义 public runtime scope contract。

标注：

#### Composite cancellation propagation

当前状态：`parallel all` / `fanout` 没有 legacy fail-fast cancel sibling/queued lane 语义。

legacy / 期望能力：legacy 对并发失败有 cancellation/control-plane 传播。

建议处理：如果实现 cancel，需要一起处理。

标注：

#### First-class ProgramExecutor 等价能力

当前状态：当前可在 task 内用 `$` 手写命令逻辑，但没有 declarative capture/file capture/expect/parse/output projection。

legacy / 期望能力：legacy `run: program` 有 cmd、capture、parse、expect、分类错误和标准 output。

建议处理：TypeScript-first 是否需要 declarative program node 要决策。

标注：

#### `$` stdout/stderr artifacts

当前状态：`CommandResult` 类型预留 `stdoutArtifact/stderrArtifact`，当前未填充；命令 stdout/stderr 不自动持久化。

legacy / 期望能力：legacy program 每次执行写 stdout/stderr attempt artifacts。

建议处理：可先实现 opt-in 或 size-capped artifact capture。

标注：

#### Artifact read/list/resolve

当前状态：当前 task artifact API 主要是写入；缺少 read/list/parse/resolve safe path。

legacy / 期望能力：legacy ArtifactStore 支持 read/list/parse/resolve。

建议处理：对下游 task 消费 artifact 有价值。

标注：

#### Atomic artifact write

当前状态：当前 artifact write 不是 temp+rename 原子写。

legacy / 期望能力：legacy `ArtifactStore.write` 使用 `.tmp` 后 rename。

建议处理：replay 能检测部分问题，但 hard crash 仍可能留下半写文件。

标注：

#### Append/streaming artifacts

当前状态：当前没有 append/create streaming artifact 能力。

legacy / 期望能力：legacy 用于 acp debug/jsonl 等执行中追加。

建议处理：与 telemetry/follow 目标相关。

标注：

#### Per-attempt artifacts

当前状态：当前缺少 `attempt-NNN.prompt.md`、`response.md`、`stderr.log`、`telemetry.json`、`acp-debug.jsonl` 等生命周期。

legacy / 期望能力：legacy 有 AttemptArtifactRecorder。

建议处理：与 agent observability 强相关。

标注：

#### Bounded dynamic storage key

当前状态：artifact path 当前主要用安全 `node.id`；尚未处理未来长 dynamic node keys 的 bounded storage/index 映射。

legacy / 期望能力：legacy 有 bounded node storage key 和 `node-index.jsonl`。

建议处理：若引入 dynamic `NodeInstanceKey`，需要一起设计。

标注：

### 表述或语义需澄清标注

#### Scheduler leaf execution 表述

原表述问题：“Runtime scheduler executes frozen `WorkflowIR` with `task`/`agent`/`signal`”。

为什么需要澄清：容易误解为纯 scheduler 直接执行所有 leaf。实际是 scheduler dispatch，task/agent/signal 依赖 executor 或 signal payload。

建议改法：表述为“scheduler 执行 composite/control nodes，并通过 executor/payload 接入 executable leaves”。

标注：

#### Admission 和 advance 混用

原表述问题：“Admission can complete ... workflows”。

为什么需要澄清：admission 和 advance 被混在一起。当前 admission 写入 frozen state；随后立即 advance，才可能同步完成。

建议改法：区分“admission freezes state”和“admission 后的 immediate advance may complete”。

标注：

#### Task `log`

原表述问题：“Task context supports `log`”。

为什么需要澄清：`log` 当前是 no-op / 非持久化，不等价 legacy runtime logs 或 attempt artifacts。

建议改法：标注为“提供 API 占位，当前不产生 durable log”。

标注：

#### `runtime` ref

原表述问题：“Runtime refs include `runtime`”。

为什么需要澄清：evaluator 能解析 root，但 runtime scope 没有明确 public 字段，用户表达式可能得到 `undefined`。

建议改法：需要定义 runtime scope contract，或在当前 spec 明确字段未提供。

标注：

#### Provider command mapping

原表述问题：“Provider-backed agents via `ACPUS_AGENT_PROVIDER_COMMANDS`”。

为什么需要澄清：容易被读成 first-class provider adapters 已完成。

建议改法：表述为“local provider command mapping escape hatch；first-class adapters 未实现”。

标注：

#### Cleanup capability

原表述问题：“Stale `.staging-*` cleanup and explicit orphan `run_*` cleanup are supported”。

为什么需要澄清：Store helper 支持和 public CLI 能力不同；当前没有 `runs clean`。

建议改法：区分 internal writable maintenance 和 public cleanup UX。

标注：

#### Known gaps

原表述问题：“Known gaps are not hidden TODOs”。

为什么需要澄清：原文同时列出 future goals 和 current contracts，容易掩盖仍需产品决策的 gap。

建议改法：改为“当前合同、已知限制和待决策能力”。

标注：

#### Verification wording

原表述问题：“Last full verification passed”。

为什么需要澄清：这是上一轮实现结束时的历史记录；本文档重写没有重新运行这些命令。

建议改法：表述为“上次报告的验证记录”，避免被误读为本次编辑已验证。

标注：

#### `parallel.race`

原表述问题：“Executable `parallel.race` supported”。

为什么需要澄清：支持的是顺序、安全语义，不是 legacy 真并发 race。

建议改法：始终写明“declaration-order sequential race”。

标注：

#### Dynamic `NodeInstanceKey`

原表述问题：“Full Dynamic `NodeInstanceKey` future goal”。

为什么需要澄清：同时已有 `fanout.key` public/IR 字段，runtime 不消费；这不只是未来增强，也有当前 API 语义缺口。

建议改法：将 `fanout.key` runtime 未使用列为 gap，将完整 NodeInstanceKey 作为后续目标。

标注：

### 当前合同或暂不计入 gap 的 legacy 面

#### YAML Workflow Spec / catalog / `workflows` commands

当前判断：不计入当前 durable runtime gap。

备注：代码库正在围绕 TypeScript-first core 重建。

标注：

#### TUI / served visualizer

当前判断：不计入当前 gap，除非后续明确恢复可视化产品面。

备注：可作为独立 roadmap 目标。

标注：

#### `supervisor.json` sidecar

当前判断：不计入 gap。

备注：当前 SQLite lease 是替代设计。

标注：

#### first-class provider adapters

当前判断：当前明确用 command mapping；first-class adapters 是未来目标。

备注：需要产品需求后再做。

标注：

#### non-bash/custom runner

当前判断：当前明确 fail loudly。

备注：需要真实消费者后再做。

标注：

#### remote/container profiles

当前判断：当前 local-process runtime。

备注：属于未来隔离/部署目标。

标注：

#### 自动 ordinary tick orphan cleanup

当前判断：当前故意保守，避免 admission/fork publish 与 SQLite persistence 的 crash window race。

备注：若要自动化，先加 intent/staging 机制。

标注：

## 下半部分：后续可实现目标

### 目标选择

#### P0：富 run inspection

为什么做：当前 durable runtime 已能运行，但人工排障信息不足。

主要交付件：`runs show/status` 展示 nodes、attempt、duration、errors、artifacts、awaiting signal prompt/schema；JSON 输出稳定。

依赖/风险：可能需要扩展 `node_states` schema。

标注：

#### P0：修正 `maxConcurrency` 行为

为什么做：当前 public/IR 字段存在但 runtime 未使用，是 API/行为不一致。

主要交付件：scheduler 对 `parallel all` / `fanout` 使用 concurrency limiter；补 unit/integration tests。

依赖/风险：需要定义失败和 cancellation 行为。

标注：

#### P0：Signal timeout/default/prompt persistence

为什么做：core 可表达 timeout/onTimeout，但 runtime 未实现；awaiting UX 也缺 prompt。

主要交付件：signal timeout/default/fail 执行语义；rendered prompt/schema 持久化；`runs show` 展示。

依赖/风险：需要 spec 更新。

标注：

#### P1：`runs cancel` 与 in-flight abort

为什么做：用户需要可中断长 task/agent/signal run。

主要交付件：CLI/control/store cancel command；AbortController/process kill propagation；cancelled projections/events。

依赖/风险：与 scheduler cancellation、task/agent lifecycle 强耦合。

标注：

#### P1：Foreground follow / background run UX

为什么做：长任务需要观察和 detach，而不是只同步 advance 或手动 supervisor。

主要交付件：`acpus run --background`、`runs follow` 或 equivalent JSONL observations、poll interval、Ctrl-C detach 行为。

依赖/风险：依赖 richer events/node metadata。

标注：

#### P1：Agent observability artifacts

为什么做：当前 agent 缺 per-attempt 可审计材料。

主要交付件：prompt/response/stderr/telemetry artifacts，output cap 行为，artifact refs 持久化。

依赖/风险：与 artifact append/read、show output 相关。

标注：

#### P1：Agent JSON recovery 和 schema prompting

为什么做：command/provider agent 输出对模型 prose 不够健壮。

主要交付件：output schema prompt injection、JSON fence/prose extraction、schema retry 分类。

依赖/风险：需避免把 prompt policy 写死到 executor 内部。

标注：

#### P1：Hooks 产品决策和最小实现

为什么做：legacy hooks 是 platform layer，当前完全缺失。

主要交付件：新 hooks spec；project/global config loader；最小 lifecycle events 或 injectors；journal。

依赖/风险：需要判断是否仍是 TypeScript-first runtime 的核心能力。

标注：

#### P1：Artifact read/list/atomic write

为什么做：当前 artifact 写入能力强，但消费和 crash atomicity 不足。

主要交付件：read/list/resolve APIs；temp+rename writes；optional append/create streaming。

依赖/风险：需保持 registry digest/size 一致性。

标注：

#### P1：Public node/artifact inspection APIs

为什么做：CLI 和未来 UI/agent 都需要稳定只读接口。

主要交付件：`runs nodes`, `runs node`, `runs artifacts` 或 JSON subcommands；store facade。

依赖/风险：与富 show 共用数据模型。

标注：

#### P2：Agent overrides

为什么做：submit-time provider/model/policy 覆盖仍缺。

主要交付件：`--agents` parser、validation、frozen metadata、fork override 行为。

依赖/风险：需对齐 TypeScript-first agent definitions。

标注：

#### P2：`runtime.*` scope contract

为什么做：evaluator 支持 `runtime`，但 scope 字段未定义。

主要交付件：spec 定义 `runtime.runId`、workspace/run dirs、attempt/now 等；scheduler/advance 注入。

依赖/风险：需要避免泄漏不可序列化 runtime handles。

标注：

#### P2：`fanout.key` 和 dynamic lane identity

为什么做：当前 core 接收 key 但 runtime 不消费。

主要交付件：fanout lane identity、dynamic node key 或 internal stable key、fork/replay/inspection 语义。

依赖/风险：与 full `NodeInstanceKey` 目标耦合。

标注：

#### P2：`runs clean`

为什么做：终端 run 和 orphan maintenance 需要用户入口。

主要交付件：dry-run/execute clean；只清 terminal runs 和明确 orphan dirs；保护 admitted runs。

依赖/风险：crash window 需要保守规则。

标注：

#### P2：Fork dry-run plan / `--from`

为什么做：当前 fork 可用，但缺 plan 和人为 origin 控制。

主要交付件：fork inheritance plan 输出、`--from <node>`、lineage summary。

依赖/风险：依赖 node identity/inspection。

标注：

#### P2：Store modularization

为什么做：`store.ts` 体积大，职责多。

主要交付件：拆 admission、controls、fork、replay、artifacts、lease internal modules。

依赖/风险：仅在行为稳定后做，避免重构掩盖 bug。

标注：

#### P2：Test architecture cleanup

为什么做：`cli.e2e.test.ts` 已很大且慢。

主要交付件：按 runtime area 拆 e2e/integration；保留高价值 cross-layer tests。

依赖/风险：拆测试不应降低覆盖。

标注：

#### P3：first-class provider adapters

为什么做：当前 command mapping 能工作，但直接集成体验有限。

主要交付件：provider adapter interface、config、tests。

依赖/风险：需要真实 provider 需求。

标注：

#### P3：runner profiles

为什么做：当前 local-process only。

主要交付件：Docker/remote/profile spec 和 executor routing。

依赖/风险：需要隔离/部署需求。

标注：

### 推荐实施顺序

1. 先补可观测性和当前 API 行为缺口：富 `runs show/status`、`maxConcurrency`、signal prompt/timeout。
2. 再补控制面：`runs cancel`、in-flight abort、foreground follow/background UX。
3. 然后补 agent/task 可审计能力：agent per-attempt artifacts、JSON recovery、artifact read/list/atomic write。
4. 最后做结构性工作：hooks 决策、agent overrides、dynamic lane identity、store/test modularization。

标注：

## 验证记录

上一轮 handoff 报告的完整验证命令：

```sh
pnpm typecheck
pnpm test:unit
pnpm test:contract
pnpm test:e2e
```

上一轮报告的测试计数：

- `pnpm test:unit`: 6 files / 36 tests
- `pnpm test:contract`: 2 files / 10 tests
- `pnpm test:e2e`: 1 file / 62 tests

本次文档重写没有改代码，也没有重新运行测试。若后续根据本文档修改实现或 specs，应按变更范围运行对应测试。

标注：

## 当前状态

durable runtime 主干实现已经完成，并经过上一轮报告的验证。下一步应先由人工在本文档中标注确认：哪些 gap 属于必须补齐的当前 runtime 能力，哪些属于明确暂不做的 legacy 面，哪些需要先更新 `specs/` 后再实现。

标注：
