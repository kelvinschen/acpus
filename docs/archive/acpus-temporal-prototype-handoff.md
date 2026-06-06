# Handoff：Acpus 能力归一化与 Temporal Prototype 设计

## 下一轮会话重点

设计一个新的 Temporal-native prototype，用成熟的 durable workflow runtime 替代当前 Acpus 的本地 runtime。下一位 agent 应该把当前 Acpus 支持的能力归一化到新的 YAML DSL runtime 模型里，并继续产出或细化 prototype 设计与实现材料。

这份 handoff 特意保存在仓库外的临时目录，不修改当前 Acpus workspace。

## 敏感信息处理

- 用户 home 路径和用户名已隐去。
- 本轮没有讨论 API key、token、密码或私有服务 URL。
- 本文中的 `<repo>` 表示当前 Acpus workspace。

## 参考资料

以下文件是当前实现真相：

- `<repo>/specs/INDEX.md` - specification 维护规则和模板。
- `<repo>/specs/workflow-spec.md` - 当前 YAML workflow authoring model。
- `<repo>/specs/runtime-orchestrator-spec.md` - 当前本地 runtime、scheduler、run state、resume、monitor 职责。
- `<repo>/specs/cli-spec.md` - 当前 CLI surface。
- `<repo>/specs/output-contracts-spec.md` - 当前 agent output schema、解析、continuation retry 行为。
- `<repo>/specs/error-codes-spec.md` - 当前 error code families 和 runtime blocked reasons。
- `<repo>/src/compiler/execution-plan.ts` - 当前 compiled execution-plan 类型。
- `<repo>/src/runtime/agent-runtime.ts` - 当前 ACPX agent runtime adapter。
- `<repo>/README.md` - 当前能力概览和 fanout 示例 workflow。

不要把 `docs/archive/` 当成当前实现真相。当前设计真相在 `specs/`。

## 对话摘要

用户最初提出：用 Temporal 作为 durable runtime，把 YAML DSL 编译成稳定 AST，在 deterministic Temporal Workflow 中解释 composite control flow，把 agent/program 执行下沉到 Activities 或 Child Workflows，并通过 `NodeExecutionKey`、Signals/Updates、external artifact/cache store 实现任意节点 pause/resume 和断点恢复。

经过设计追问后，用户明确了方向：

- 用 Temporal 完全替代当前 Acpus 本地 runtime，而不是在现有 runtime 外面包一层。
- 构建一个新的工具/runtime：上层是 YAML DSL，底层执行单元主要是 agent，同时也支持 program。
- 目标形态是 service-first 和 Temporal-native。
- 倾向新仓库重写，而不是在当前 Acpus 上增量改造。
- 复用 Acpus 的语义经验和测试场景，不复用本地 run-directory runtime 实现。

## 当前 Acpus 能力清单

Acpus 当前是一个本地 CLI 驱动的 ACP agent workflow orchestrator。

当前 authoring 与 compilation：

- 只支持 YAML `workflow.spec.yaml`。
- 通过 schema、input schema/default validation、graph linting、limit validation 做校验。
- 编译为 `execution-plan.json`。
- 使用 flat top-level stage graph，通过 `dependsOn` 显式声明依赖。
- Stage kinds：`task`、`fanout`、`loop`、`route`、`gate`。
- 支持 agent executable 和 program executable。
- input-sourced limits 在 run start 时解析，并 snapshot 到 execution plan。
- agent output 支持 output schema DSL。

当前 runtime：

- 本地 `.acpus/runs/<id>/` run directory 是恢复状态的权威源。
- runtime artifacts 包括 `workflow.spec.yaml`、`execution-plan.json`、`input.json`、`run.json`、`outputs/`、`attempts/`、`sessions/`、`acpx-state/`、`events.ndjson`。
- 本地 scheduler 负责推进 deterministic stages、收集 ready agent work、运行 fanout pools、处理 fanin、loop rounds、route branch skipping、gate verdicts、retry、stale recovery 和 status projection。
- background worker ownership 通过 PID、generation、heartbeat、stale detection 和 run status 记录。
- `resume` 通过读取和修改 `run.json`，reset recoverable stages，并可收紧 fanout policy。

当前 observation：

- `monitor` 和 `follow` 读取本地 run artifacts。
- Run Monitor View 暴露 stages、Stage Tasks、retry summaries、worker state、progress、final output 和 bounded task detail。
- diagnostics 依赖 run index 和 bounded event tail。

当前 output/error 语义：

- agent output 解析为最终 balanced JSON object。
- output schema failure 和 parse failure 会在共享 Agent Task Retry budget 下触发 continuation retry。
- program command 的非零 exit code 是数据，不是 blocking runtime error。
- stable error code families 覆盖 schema、input、graph、variables、actor、limits、route、fanout、program、output、loop、runtime、resume、ACPX 和 internal failures。

## 归一化后的目标能力模型

新的 Temporal 工具应被描述为：一个 service-first workflow runtime，前端是 YAML DSL，后端是 agent/program execution。

v1 目标能力：

- **Authoring**：YAML DSL 编译为 versioned stable AST。
- **Runtime authority**：Temporal Workflow history 是 durable control authority；external artifact store 保存大 artifacts。
- **Control flow**：Temporal workflows deterministic 地解释 composite AST nodes。
- **Execution units**：agent 和 program executable nodes 通过 Child Workflows 包装 Activities 来执行。
- **Node identity**：每个 executable/composite node 都有稳定 `NodeExecutionKey`。
- **Pause/resume**：node-level control 使用 Temporal Updates，而不是 fire-and-forget Signals。
- **In-flight cancellation**：正在运行的 agent node 可被取消；partial transcript 被保存，resume 时继续同一个 agent session，并使用固定 runtime continuation prompt。
- **Artifacts**：transcripts、raw outputs、parsed outputs、command logs、cache entries、partial state 都存放在 Temporal history 外部。
- **Observation**：monitor/list/detail 由 Temporal Query + artifact summaries 投影，不读取本地 `run.json`。
- **Failure policy**：每个 composite node 都有显式或继承的 structured failure policy。
- **Output contract**：每个 composite 的输出由其结构决定（parallel → branch map, fanout → array, switch → selected, loop → last iteration）。

## 当前能力到目标能力的映射

| 当前 Acpus 能力 | Temporal prototype 对应能力 |
| --- | --- |
| `workflow.spec.yaml` flat stage graph | YAML DSL 编译为 nested composite AST |
| `execution-plan.json` | run start 时冻结的 immutable AST snapshot |
| local scheduler | deterministic root Temporal Workflow interpreter |
| `run.json` 中的 stage/fanout/loop state | 小型 Temporal workflow control state，可按 node key 查询 |
| `outputs/`、`attempts/`、`sessions/`、`events.ndjson` | 由 `NodeExecutionKey` 和 attempt/session ids 索引的 external artifact store objects |
| background worker PID/heartbeat | Temporal task queues、worker leases、Activity heartbeats/cancellation |
| `resume` 修改 run index | Temporal Updates：`pauseNode`、`resumeNode`、`cancelNode`、`retryNode` |
| fanout lane work units | 每个 selected item/lane 或 executable node path 对应 child workflow |
| loop round state | 带 bounded rounds 和 round-scoped node keys 的 composite loop state |
| route/gate behavior | composite AST 中的 `branches` 和显式 terminal/evaluation nodes |
| output parser + continuation retry | 可复用 agent Activity output parser + Temporal retry/continuation policy |
| Run Monitor View | 基于 Temporal Query 和 artifact metadata 的 service projection |

## Prototype 设计

### DSL 与 AST

应创建新的 DSL，而不是直接扩展当前 Acpus `Stage` shape。

必须支持的 composite nodes：

- `pipeline`：顺序执行。
- `parallel`：并发执行 child nodes。
- `fanout`：展开 items，并对每个 item 执行 child template。
- `branches`：通过 condition 或 agent/program decision 选择一个或多个 branches。
- `loop`：有界重复执行 composite body。

必须支持的 executable nodes：

- `agent`：调用 agent session。
- `program`：运行受信单租户 command 或 deterministic program。

通用 node fields：

- `id`
- `type`
- `failurePolicy`
- optional `timeout`
- optional `retryPolicy`
- optional `cachePolicy`

Run-start AST 规则：

- YAML 被 parse、validate、compile，然后冻结成 AST snapshot。
- 记录 AST schema version。
- 冻结 input 和 resolved limits。
- 已启动 run 在 replay 或 resume 时绝不重新读取可变 YAML。

### Temporal Workflow 布局

推荐布局：

- `RunWorkflow`：root workflow。解释 AST，拥有 top-level run status，并暴露 Updates 与 Queries。
- `CompositeInterpreter`：供 `RunWorkflow` 使用的纯 deterministic interpreter functions。
- `ExecutableNodeWorkflow`：每个 agent/program executable node 的 Child Workflow。
- `AgentAttemptActivity`：执行一次 agent turn，发 heartbeat，处理 cancellation，写 transcript/output artifacts。
- `ProgramAttemptActivity`：执行 command/program，记录 stdout/stderr/exit/cancellation artifacts。
- `ArtifactStoreActivity`：可选薄封装，用于 deterministic workflow code 不能直接访问 storage 的场景。

不要把大 transcript、output、cache blobs 存入 Temporal history。Temporal history 中只保存 references。

### NodeExecutionKey

使用语义路径身份：

```text
runId
astVersion
nodePath
loopRound?
fanoutItemId?
parallelBranchId?
laneId?
attemptOrdinal?
```

规则：

- `nodePath` 基于稳定 DSL ids，不基于数组位置。
- `fanoutItemId` 优先使用 authored item id/path hash；没有稳定 item identity 时才 fallback 到 index。
- loop body nodes 必须包含 loop round。
- attempt ordinal 不属于 logical node identity，但属于 artifact/attempt identity。

### Control APIs

以 Temporal Updates 作为主要控制接口：

- `pauseNode(key)`
- `resumeNode(key)`
- `cancelNode(key)`
- `retryNode(key, options)`
- `getNodeState(key)` 可作为 Query，而不是 Update。

Update handlers 必须同步校验：

- run 存在，且 AST version 匹配；
- node key 合法；
- node 可被控制；
- 请求的 state transition 合法；
- cancellation/resume 已记录到 control state。

Signals 只用于不需要即时校验结果的异步通知。

### Agent Cancellation 与 Resume

已选择的语义：

- pause 命中正在运行的 agent node 时，请求 Activity cancellation。
- Activity 捕获 cancellation，写 partial transcript artifact，并记录 cancelled attempt。
- Node 保持 paused，并保存可 resume 的 session metadata。
- resume 时在同一个 agent session 中启动新 attempt。
- runtime 对所有 resumed agent nodes 使用固定 continuation prompt。
- 最终 output 归属于 resumed attempt；之前的 partial artifacts 保留用于 diagnostics。

这要求 agent adapter 支持：

- cooperative cancellation；
- session persistence；
- partial transcript capture；
- deterministic artifact references；
- idempotent attempt finalization。

### Program Execution

已选择的前提：

- 因为目标部署是受信单租户，program execution 可以完全开放。

即便如此仍必须：

- 记录 command、args、cwd、env policy、start/end times、exit code、signal、stdout/stderr artifact keys；
- 定义 cancellation behavior；
- 对非幂等 commands 避免自动隐藏 retry，除非显式允许；
- 在 attempt metadata 中暴露 duplicate/retry 风险。

### Monitor 与 Projection

Prototype monitor 应暴露归一化概念，而不是 Acpus 特有的本地状态：

- run summary；
- node tree；
- 按 `NodeExecutionKey` 查询的 node state；
- active/cancelled/resumable attempts；
- artifact references 和 bounded previews；
- failure policy 和 blocked/failed reason；
- composite subtree 的 progress counts。

不要在新 contract 中保留 worker PID 或 local run directory fields。

## 成本与收益判断

成本高，因为这是新的 Temporal-native runtime，不是 Acpus 本地 runtime refactor。

高成本区域：

- 新 nested composite DSL 和 compiler；
- Temporal deterministic interpreter；
- Child Workflow/Activity boundaries；
- artifact store contract；
- agent cancellation 和 session continuation；
- monitor/query projection model；
- service API 和 worker deployment；
- replay determinism、cancellation、partial artifacts、nested control flow 的测试。

如果产品目标是 service-first，则收益可以支撑该成本：

- Temporal 替代 custom durable scheduler logic；
- worker crash recovery 和 task queueing 成为平台能力；
- node-level control 成为一等 service API；
- nested fanout/parallel/loop execution 可以突破本地 CLI 限制；
- run state 不再依赖 local file locks、PIDs 或 stale worker heuristics。

## 建议 Prototype Milestones

1. 为 `pipeline`、`agent`、`program` 定义最小 AST 和 compiler。
2. 实现可解释 frozen AST snapshot 的 Temporal `RunWorkflow`。
3. 定义 external artifact store interface，prototype 可先用 local filesystem implementation。
4. 为 agent nodes 实现 `ExecutableNodeWorkflow`，包含 cancellation 和 continuation session metadata。
5. 实现 `NodeExecutionKey` 生成和 node state Query。
6. 实现 `pauseNode`、`resumeNode`、`cancelNode` Updates。
7. 依次加入 `parallel`、`fanout`、bounded `loop`。
8. 加入 `branches`。
9. 基于 Temporal Query + artifact summaries 构建 monitor projection。
10. 将部分 Acpus tests 作为 behavior specs 迁移，不迁移实现细节测试。

## First Prototype 验收标准

- 一个包含 nested `loop -> fanout -> pipeline -> agent` 的 YAML workflow 能编译成 immutable AST。
- run 可以通过 Temporal 启动，并能查询 node states。
- 正在运行的 agent node 可以通过 `NodeExecutionKey` pause。
- pause 会取消 in-flight Activity，并保存 partial transcript artifact metadata。
- resume 使用固定 runtime continuation prompt 继续同一个 agent session。
- 最终 parsed output 存入 artifact store，并通过 monitor projection 暴露。
- Temporal workflow replay 不读取可变 YAML、local clock、random values 或大型 artifacts。

## 未解决风险

- agent runtime 可能没有足够强的 cooperative cancellation primitives。当前 Acpus adapter 能观察 cancelled turns，但没有暴露显式 runtime-level cancel control。
- program execution 完全开放只在 trusted single-tenant 假设下成立。不要把它描述成适用于 multi-tenant shared workers 的安全模型。
- nested composite output contracts 需要清晰的结构化输出规则（parallel → branch map, fanout → array, switch → selected, loop → last iteration）。
- 如果把 composite state 或 transcripts 放进 workflow state，而不是 artifact references，Temporal history 会快速膨胀。
- 复用过多 Acpus 代码可能把 local run-directory assumptions 带进新的 service runtime。

## Suggested Skills

- `grill-me`：在锁定 DSL 和 Temporal workflow boundaries 前使用；这个设计有多个高成本分叉。
- `diagnose`：验证真实 agent runtime 的 cancellation/resume 行为时使用。
- `to-prd`：如果下一步要把 prototype 方向整理成 PRD，使用该技能。
- `to-issues`：prototype 设计确认后，用于拆分独立实现 issue。
- `github:github` 或 `github:yeet`：只有下一轮需要仓库 issue/PR 工作时使用。

## 推荐下一步

先在当前 Acpus runtime 之外做一个小 Temporal spike：

1. 定义 `pipeline`、`agent`、`program` 的最小 AST types。
2. 实现 deterministic AST interpretation 的 `RunWorkflow`。
3. 实现 `NodeExecutionKey` 和 node state Query。
4. 实现 agent Activity cancellation，并记录 partial transcript artifact。
5. 在加入 fanout/loop 之前，先证明单个正在运行的 agent node 可以 pause/resume。

