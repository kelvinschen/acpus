# 单工作区并发运行 Runtime Roadmap

本文记录提升 Acpus 单工作区并发 run 能力的重构路线。它是 roadmap
执行辅助文档，不是当前产品事实；已实现行为仍以 `specs/` 为准。

## 背景

当前 foreground `workflow run` 会在 CLI 进程内完成 workflow 准备，然后由
这个 CLI 进程直接写 runtime SQLite store 完成 run admission，之后再请求
workspace daemon observe 和推进 run。

当同一个 workspace 中同时启动多个 foreground run 时，多个 CLI 进程会并发
尝试 runtime admission。store 在 admission 和 scheduler commit 中使用
SQLite `BEGIN IMMEDIATE` 事务，因此一个进程拿到 writer lock 后，其他进程
可能直接暴露 `database is locked`。

database 本身不是产品问题。真正的问题是：workspace runtime mutation path
存在多个未协调的进程级 writer，而且部分事务承载了超过必要范围的 payload
和 projection 写入。

## 目标

让一个 workspace 能稳定接收并执行多个并发 run，不向用户泄漏 SQLite
writer lock 错误。

本 roadmap 的目标架构是：

```text
CLI / Web / future clients
  -> workspace daemon request
    -> daemon-owned runtime mutation path
      -> SQLite short transaction + run-directory files
```

daemon 成为 runtime mutation 的外部 seam。CLI 和其他 client 负责准备请求
和观察结果，不再直接修改 durable run state。

## 非目标

- 不做 per-run database。
- 不做 per-run table 布局。
- 不做完整 file-backed runtime 重写。
- 本 roadmap 中不删除现有 SQLite schema 字段。
- 不做大规模 inspect projection 重设计。
- 新路径确认后，不为旧内部写路径保留行为兼容层。

## 设计原则

- 将 SQLite 视为 workspace control-plane store，而不是 payload warehouse。
- 大型且不可变的 run material 尽量保存在 run directory。
- event log 写入保持权威；可行时 projection 应可重建。
- 相比让 client 调用多个浅层 store 方法，优先提供一个深的 daemon mutation
  interface。
- 事务保持短小，并局部于单个 runtime mutation。
- 并发行为必须能通过 public CLI 和 daemon interface 测试。

## 当前写入热点

- Run admission 会写 `runs`、`run_inputs`、`run_events` 和初始
  `node_states`。
- Scheduler advancement 会追加 scheduler events，并同步 public projection
  tables。
- Control operations 会写 lease、retry/fork/signal/cancel events，以及后续
  projection。
- Progress 写入会在 task 或 agent attempt 活跃期间更新 `node_progress`。
- Hook 执行会写 `hook_journal`。

第一刀并发修复不是拆分 database，而是移除未协调的进程级 writer，并缩短
剩余写入工作。

## Phase 0: 基线与复现测试

目的：把已观察到的 lock failure 固化成可重复的回归面。

计划工作：

- 增加一个低成本 workflow fixture：只包含一个短 task，不依赖 agent。
- 增加单 workspace 并发 foreground run 覆盖。
- 增加单 workspace 并发 background run 覆盖。
- 增加 foreground run、background run、inspect 混合场景。
- 捕获每个进程的 stdout/stderr，并断言没有进程输出
  `database is locked`。
- 断言每个 admitted run 都有唯一 run id，并到达预期 terminal output。
- 保留一个可选 stress script，用于默认测试套件之外的更大本地压力测试。

验收检查：

- 8 到 16 个并发 foreground run 完成，且没有 raw SQLite lock error。
- 8 到 16 个并发 background run admission 成功。
- `workflow check` 仍是只读操作，不创建 runtime state。

Tree grill 问题：

- 什么 workflow 形态足够触发 runtime 活动，同时不依赖 agent？
- 回归测试应该进入默认测试套件，还是只放到 opt-in stress suite？
- CI 稳定性下合理的并发数量是多少？
- 如何避免 retry timing 掩盖真正错误？

退出标准：

- 当前 failure 可以被确定性测试或 opt-in stress command 复现或防护。
- 后续阶段拥有清晰的 before/after 指标。

### Phase 0 Accepted Decisions

已知信息，不再 grill：

- 问题已经在临时 workspace 中复现：同一个 workspace 内并发启动 12 个
  foreground `workflow run --json`，失败进程会在输出 admitted JSON line 前
  退出，stderr 只有 `database is locked`。
- 失败发生在 admission 阶段，而不是 workflow 业务逻辑或 terminal observe
  阶段；失败 run 没有进入 `runs` 表。
- 当前测试基础设施已经足够：`runSourceCli()` 可以启动 source CLI 子进程，
  `withTestWorkspace()` 可以创建隔离 workspace 并清理 daemon，现有
  `cli-smoke.e2e.test.ts` 已覆盖 foreground JSON run 的基本输出形态。
- 并发复现 workflow 不需要 agent，也不需要 signal；一个短 task 足以拉开
  并发窗口，且成本可控。

实施决策：

- 新增并发专用 workflow fixture，放在
  `packages/cli/test/fixtures/workflows/concurrency/short-task.workflow.ts`。
- fixture 只包含一个 inline task，`run.input` 为空，`exec` 内使用
  `setTimeout` 延迟约 150 到 250ms，输出稳定 JSON，例如
  `{ ok: true }`。这个延迟只用于扩大 foreground observe 窗口，不承担锁复现
  的唯一责任。
- 新增 opt-in 并发压力脚本或测试 helper，默认 CI 不运行。原因是当前 mainline
  已知会失败，Phase 0 不能在修复前把默认测试套件变红。
- opt-in 基线使用 12 个并发 foreground run。这个数量已经在本地稳定复现
  lock failure，同时不会像更高并发那样显著拖慢本地反馈。
- Phase 3 切到 daemon admission 后，再把同一场景收敛为默认 e2e 回归测试；
  默认 e2e 的并发数可以降到 8，以降低 CI 抖动。
- Phase 7 最终验收仍使用 16 个并发 foreground run 和 16 个并发 background
  run 作为更强的完整矩阵。

Opt-in 基线断言：

- 每个子进程的 stdout、stderr、exit code 都必须被保留，失败时直接打印对应
  run index。
- 当前未修复状态下，脚本应能报告至少一个 `database is locked` 或非 0 exit；
  修复后同一脚本应报告 0 个 raw SQLite lock error。
- 对成功进程，stdout 第一条 JSON record 应为
  `{ ok: true, phase: "run", kind: "admitted" }`。
- 对成功进程，最后一条 JSON record 应为 terminal summary，run status 为
  `completed`，output 为 `{ ok: true }`。
- 成功进程产生的 run id 必须唯一。

Phase 0 暂不做：

- 不在默认 CI 中加入当前必然失败的并发 e2e。
- 不引入重试来让测试“偶然通过”；这会掩盖本轮要修复的锁竞争。
- 不加入 agent workflow；agent 子进程会引入与 database lock 无关的噪声。
- 不在此阶段修改 runtime 写路径。

## Phase 1: SQLite Busy 处理与错误表面

目的：在更大架构改造落地前，让现有 store 更耐受，并停止泄漏 raw SQLite
错误。

计划工作：

- 在 database open path 设置有界 SQLite busy timeout。
- 将 `SQLITE_BUSY` 和 `database is locked` 规范化为 runtime concurrency
  error。
- `--json` 模式返回结构化 JSON，包含稳定 phase 和 message。
- text output 保持可操作：workspace 正忙、run 未 admission、下一步是 retry
  或让 daemon 串行化写入。

验收检查：

- 被强制占用的 store 产生结构化错误，而不是 raw SQLite message。
- 正常 run、inspect、control 路径保持当前成功输出。
- 现有 runtime 测试不需要依赖 timing-sensitive sleep 才能通过。

Tree grill 问题：

- 什么 timeout 对本地 workload 足够保守，又不会掩盖死锁？
- busy timeout 现在应是内部常量，还是需要配置？
- admission-time store contention 最适合归属哪个 result phase？
- SQLite-specific error detection 应该放在哪里，才能不让 caller 学到
  SQLite 内部细节？

退出标准：

- 用户不再从正常 CLI 路径看到裸 `database is locked`。
- 代码中只有一个小 adapter 负责识别 store contention。

### Phase 1 Accepted Decisions

已知信息，不再 grill：

- 当前 Node `node:sqlite` 的 `DatabaseSyncOptions` 已支持 `timeout`，语义是
  SQLite busy timeout；当前 `openDatabase()` 没有设置该 option，默认值为
  0ms。
- 当前 CLI 顶层只处理 `CliError` 和 `CommanderError`。裸 SQLite error 会
  穿透到 `cli.ts` 的通用 error handler，并被直接打印为 message。
- 当前 `ResultPhase` 已有 `run`、`control`、`inspect` 等用户动作 phase；
  不需要为了 SQLite busy 新增一个通用 `store` phase。

实施决策：

- 在 runtime store 的 `openDatabase()` 中设置内部 busy timeout，初始值为
  `5_000ms`。
- busy timeout 暂不暴露配置项。它是 local runtime 的实现保护层，不进入
  public CLI surface 或 workflow authoring surface。
- 增加一个小的 runtime adapter 来识别 store contention，例如
  `isRuntimeStoreBusyError(error)`。adapter 可以识别 SQLite `SQLITE_BUSY`
  code 和历史上已出现的 `database is locked` message。
- CLI 不直接匹配 SQLite message；CLI 只消费 runtime 暴露的 store-busy
  语义，并按当前命令上下文转成 `CliError`。
- 对 `workflow run` admission 阶段的 busy error，JSON/text 输出使用
  `phase: "run"`，`errorCode: "STORE_BUSY"`，exit code 为 1。
- 对 `runs` control 阶段的 busy error，输出使用 `phase: "control"`，
  `errorCode: "STORE_BUSY"`。这保持 phase 语义与用户动作一致。
- 错误 message 不提 SQLite 实现细节。建议文本表达为：
  `Workspace runtime store is busy; retry the command or let the daemon finish current runtime writes.`
- Phase 1 不引入 retry loop 来“修复”并发 admission。retry 会让当前多 writer
  架构继续存在，并可能掩盖 Phase 2/3 要移除的根因。

测试决策：

- 增加 runtime unit/contract 测试覆盖 store-busy adapter 的识别逻辑。
- 增加 CLI contract 测试覆盖 store-busy error 被转换为结构化 JSON/text
  result。
- 不在 Phase 1 中修改 Phase 0 的 opt-in 并发基线；该基线仍允许复现当前多
  writer 根因。

Phase 1 暂不做：

- 不新增用户配置项。
- 不新增 `ResultPhase`。
- 不改变 daemon admission 或 CLI admission 路径。
- 不把 timeout 设置得很长；超过 5s 的等待更像隐藏架构问题，而不是提升用户
  体验。

## Phase 2: Daemon Admission Interface

目的：让 daemon 成为 admit run 的 runtime mutation entrypoint。

计划工作：

- 扩展 daemon socket request union，增加 admission request。
- workflow resolution、TypeScript loading、graph compilation、input
  normalization 和 agent override validation 仍保留在 CLI 进程。
- 将 prepared workflow、normalized input、agent overrides 和 start mode 发送
  给 daemon。
- 在 daemon 进程内完成 run admission。
- 返回 admitted run 的 `RunDetails`。
- 同时支持 submit-only 和 submit-and-start。

候选 request shape：

```ts
type DaemonAdmitRunRequest = {
  method: "admitRun";
  prepared: PreparedRunWorkflow;
  input: JsonValue;
  agentOverrides?: AgentOverrideMap;
  start: boolean;
};
```

候选 response shape：

```ts
type DaemonAdmitRunResult = {
  run: RunDetails;
};
```

验收检查：

- `admitRun(start: false)` 持久化 run，但不启动 session。
- `admitRun(start: true)` 持久化 run，并在 run 非 terminal 时启动 session。
- invalid request 在触碰 store 前失败。
- 现有 start/observe/control socket 行为保持兼容。

Tree grill 问题：

- prepared workflow JSON 通过 daemon socket 传输是否可接受，还是需要
  path-based handoff？
- 哪些 validation 属于 CLI，哪些属于 daemon，才能保持 daemon interface
  足够健壮？
- daemon admission 应如何报告部分 filesystem/write failure？
- 这个阶段是否需要 admission idempotency key？

退出标准：

- Runtime admission 可以通过 daemon 完成，不再需要 CLI 直接写 store。
- Daemon interface 足够小，caller 不需要知道 store 细节。

### Phase 2 Accepted Decisions

已知信息，不再 grill：

- `PreparedRunWorkflow` 已是可序列化结构：包含 workflow path、IR object、
  IR JSON、digest、package lock digest 和 lock object。它适合作为 daemon
  socket payload 的第一版输入。
- CLI 当前已经负责 workflow reference resolution、TypeScript module loading、
  workflow preparation、input normalization 和 agent override validation。
- runtime package 已导出 `PreparedRunWorkflow`、`AgentOverrideMap`、
  `RunDetails` 等 admission 所需类型。
- daemon socket 当前已有 request/response union、parse/dispatch、client helper
  和 daemon loop handler 结构；Phase 2 不需要替换 IPC 机制。

Interface 决策：

- Phase 2 采用 prepared-object-over-socket，不采用 path-based handoff。
  path-based handoff 会引入临时文件生命周期、清理和 crash window；当前 prepared
  object 大小在本地 IPC 中可接受。
- `admitRun` request 使用独立 method，而不是复用 `control`。Admission 创建
  run，不是已有 run 的 control intent。
- Request 增加必填 `requestId`，为后续 admission idempotency 和日志关联预留
  稳定 key。
- `start` 保持 boolean：`false` 表示 submit-only，`true` 表示 admission 后
  立即启动 daemon session。
- Response 只返回 `{ run: RunDetails }`。是否启动 session 是 request 行为，
  不需要在 response 里暴露 store 或 session 细节。

Accepted request shape：

```ts
type DaemonAdmitRunRequest = {
  id?: string;
  method: "admitRun";
  requestId: string;
  prepared: PreparedRunWorkflow;
  input: JsonValue;
  agentOverrides?: AgentOverrideMap;
  start: boolean;
};
```

Accepted response shape：

```ts
type DaemonAdmitRunResult = {
  run: RunDetails;
};
```

Validation 决策：

- CLI 继续做完整 user-facing validation，以保持当前错误 phase 和消息质量。
- daemon 仍做防御性 validation：结构上确认 `requestId`、`prepared`、`input`、
  `start` 存在且类型合理。
- daemon 在写 store 前重新执行 `normalizeWorkflowInput(prepared.ir, input)` 和
  `validateAgentOverrides(prepared.ir, agentOverrides)`。这让 socket interface
  即使被非 CLI caller 使用，也不会把未规范化 input 写进 durable state。
- daemon 不重新执行 TypeScript loading 或 workflow compilation；这是 CLI/
  loader seam 的职责。

错误与超时决策：

- daemon parse 阶段的非法 admission request 使用 daemon error code
  `INVALID_REQUEST`。如果为了减少第一版 churn，也可以先复用当前
  `INVALID_CONTROL`，但 Phase 2 的目标命名是 `INVALID_REQUEST`。
- store/filesystem admission failure 归类为 `STORE_ERROR`，message 保持
  implementation-neutral。
- `sendDaemonAdmitRun()` 不应在请求已经成功发出后盲目 retry admission，否则
  可能产生 duplicate run。它可以 retry daemon 尚未可连接的启动窗口，但一旦
  请求已连接并发送，timeout 应返回失败，等待后续 idempotency 设计处理。
- `admitRun` client request timeout 使用较长窗口，例如 `30_000ms`，与 control
  请求一致，避免 admission 已在 daemon 内执行但 client 1s 超时导致不明确状态。

Idempotency 决策：

- Phase 2 interface 必须携带 `requestId`。
- Phase 2 不强制完成 durable admission idempotency 表设计；该设计会影响 schema
  和 recovery 语义，可以在 Phase 4/5 结合 mutation queue 和 admission transaction
  再落地。
- 在 durable idempotency 落地前，CLI helper 的 retry 策略必须保守，避免因
  response timeout 自动重复 admission。

测试决策：

- 增加 daemon socket/loop 层测试：
  - `admitRun(start: false)` 创建 pending run，不启动 session。
  - `admitRun(start: true)` 创建 run，并对非 terminal run 启动 session。
  - invalid request 在 store 写入前失败。
  - daemon 重新 normalize input 和 validate agent overrides。
- 保留现有 `startRun`、`observeRun`、`control` 测试，确认 request union 扩展
  不破坏旧方法。

Phase 2 暂不做：

- 不把 workflow compilation 移入 daemon。
- 不做 path-based prepared handoff。
- 不做 durable admission idempotency schema。
- 不改变 CLI `workflow run` 的实际路径；CLI 切换属于 Phase 3。

## Phase 3: 将 `workflow run` 切到 Daemon Admission

目的：移除 foreground 和 background run 路径中的直接 CLI admission 写入。

当前路径：

```text
workflow run
  -> prepare in CLI
  -> admitPreparedWorkflowRun in CLI
  -> daemon start/observe
```

目标路径：

```text
workflow run
  -> prepare in CLI
  -> daemon admitRun(start: true|false)
  -> foreground observe or background return
```

计划工作：

- 替换 CLI workflow command 中对 `admitPreparedWorkflowRun` 的直接调用。
- 增加 CLI daemon admission helper。
- Foreground 模式在 daemon admission 后写 admitted JSON line。
- Foreground 模式 observe daemon-owned run。
- Background 模式在 daemon admission 和 start request handling 后返回。
- 如果没有 caller，移除未使用的 public CLI admission helper。

验收检查：

- Foreground JSON output 仍输出 admitted record，随后输出 observation records
  和 terminal summary。
- Background JSON/text output 仍包含 admitted run。
- 并发 foreground run 测试不再创建多个 CLI store writer。
- `workflow check` 继续只做 prepare 和 validate，不做 runtime admission。

Tree grill 问题：

- `workflow run --background` 应直接传 `start: true`，还是先 admit 再单独
  调 start daemon request？
- admission 发生在 daemon 后，如何保持 Ctrl-C detach 行为？
- daemon admission 变慢时，foreground JSON 的精确输出顺序是什么？
- 哪些 direct runtime use-case 仍然可以合法绕过 CLI？

退出标准：

- Public CLI run 路径不再直接写 runtime DB。
- Daemon 拥有 CLI-started run 的 admission。

### Phase 3 Accepted Decisions

已知信息，不再 grill：

- 当前 foreground JSON 输出已经有稳定顺序：第一条是 admitted record，最后一条
  是 terminal summary，中间是 bounded observations。
- 当前 Ctrl-C detach handler 只有在拿到 admitted run id 后才安装；admission
  前中断没有 run id 可报告。
- `sendDaemonObserveRun()` 当前会先 `startRun` 再 `observeRun`。如果 Phase 2 的
  `admitRun(start: true)` 已经启动 session，后续 `startRun` 仍应保持幂等。

实施决策：

- `workflow run --background` 使用 `sendDaemonAdmitRun(start: true)`，不再先
  CLI admission 再单独 `sendDaemonStartRun()`。
- foreground `workflow run` 也使用 `sendDaemonAdmitRun(start: true)`。拿到
  admitted run 后，CLI 立即输出 admitted JSON line 或 text summary，然后进入
  observe。
- foreground observe 可以继续复用 `sendDaemonObserveRun()`。重复 start 是
  daemon session 层的幂等行为，不应产生第二次执行。
- `workflow check` 继续只做 prepare/validate，不触碰 daemon admission。
- CLI 保留 workflow preparation 和 user-facing validation；daemon admission
  是 durable mutation seam。

输出顺序决策：

- Foreground JSON 模式：
  1. daemon admission 返回后，CLI 输出 `{ ok: true, phase: "run", kind:
     "admitted", run }`。
  2. CLI 安装 detach handler。
  3. CLI observe daemon-owned run，并输出 observation records。
  4. CLI 输出 terminal summary 或 action-required summary。
- Background JSON/text 模式：
  - daemon admission 返回后立即输出 admitted run result。
  - 不等待 terminal。
  - daemon 已被请求启动 run session。

Ctrl-C 决策：

- admission 前 Ctrl-C 仍没有 run id 可 detach；保持普通进程中断行为。
- admission 后 Ctrl-C 输出 detached record/message，daemon 继续执行 run。
- 如果 daemon admission 成功但 response 在 client 侧丢失，Phase 3 不试图用
  CLI 本地状态恢复；这需要 Phase 2 预留的 `requestId` 和后续 durable
  idempotency/recovery 支持。

Direct runtime use-case 决策：

- CLI 不再直接调用 `admitPreparedWorkflowRun()`。
- runtime package 可以暂时保留 `admitPreparedWorkflowRun()` 作为低层测试和
  embedding seam，但它不再是 CLI run path。
- 如果后续发现没有外部合法 caller，再单独收敛或标注该 helper 的稳定性。

测试决策：

- 更新现有 foreground JSON e2e，确保输出顺序不变。
- 增加 background run e2e，断言 output 包含 admitted run，且 daemon 后续能
  完成该 run。
- 将 Phase 0 的 opt-in 并发 foreground 场景升级为默认 e2e 回归，默认并发数
  使用 8。
- 增加断言或代码搜索，确保 `packages/cli/src/commands/workflow.ts` 不再调用
  `admitPreparedWorkflowRun()`。

Phase 3 暂不做：

- 不改变 daemon observe protocol 为 streaming socket。
- 不删除 runtime 低层 admission helper。
- 不解决 admission response 丢失后的 duplicate/recovery 问题；只确保 CLI 不
  盲目 retry 已发送 admission。

## Phase 4: Daemon 内 Runtime Mutation Queue

目的：让 daemon 写入顺序显式、局部、可测试。

计划工作：

- 增加一个 daemon 内部小队列，用于 daemon-owned runtime mutation。
- admission、control、signal、retry、fork、cancel 和未来写请求都经过该队列。
- 长时间运行的 task 和 agent execution 不进入该队列。
- 在测试或 debug trace 中记录 queue label。
- 确保一个失败 mutation 不会阻塞后续 mutation。

候选内部 interface：

```ts
class RuntimeMutationQueue {
  enqueue<T>(label: string, work: () => Promise<T> | T): Promise<T>;
}
```

验收检查：

- 并发 daemon admission request 按确定性写入顺序执行。
- 一个失败 admission 不会阻塞后续成功 admission。
- active run execution 在短 store mutation 串行化时仍保持并发。
- 不同 run 的 control request 并发到达时仍保持正确。

Tree grill 问题：

- 一个全局 workspace mutation queue 吞吐是否足够，还是后续需要 per-run
  lanes 加 workspace admission lane？
- 哪些操作是真正 mutation，哪些可以留在队列外？
- cancellation 如何影响已排队但尚未开始的 work？
- queue 积压时需要什么 observability？

退出标准：

- Daemon mutation serialization 显式、局部，并被测试覆盖。
- daemon 外的 store caller 要么只读，要么是有意保留的例外。

### Phase 4 Accepted Decisions

已知信息，不再 grill：

- daemon socket server 可以同时接收多个 socket request；handler 是 async 的，
  因此 request-level mutation 顺序目前不是显式模型。
- daemon 进程内使用同一个 `RuntimeStore`/`DatabaseSync`；同步 DB call 在同一
  Node event loop 中不会并行执行，但包含 filesystem await 的 mutation 仍可能
  在进入 DB transaction 前后交错。
- active run execution 已由 scheduler run lease、owner epoch 和 event
  idempotency 保护；不需要通过 Phase 4 queue 把所有 run execution 串行化。

Interface 决策：

- 第一版使用一个全局 workspace mutation queue。它是 daemon 内部 module，不是
  public runtime API。
- Queue interface 保持最小：

```ts
class RuntimeMutationQueue {
  enqueue<T>(label: string, work: () => Promise<T> | T): Promise<T>;
}
```

- `label` 只用于测试、debug 和错误上下文，不参与业务逻辑。
- queue 不暴露取消、优先级、per-run lane。若后续指标显示全局 lane 成为瓶颈，
  再扩展为 per-run lanes 加 workspace admission lane。

进入 queue 的操作：

- `admitRun`。
- `control` 入口中的 pause/resume/retry/cancel/signal。
- `fork`，因为它包含 run directory copy/rewrite 和 DB 写入。
- 未来所有 daemon-owned runtime mutation。

不进入 queue 的操作：

- `status`、`shutdown` 的只读检查部分。
- `observeRun` 等待已有 session 的过程。
- 长时间运行的 task/agent attempt。
- active run session 的完整生命周期。

特殊处理：

- `startRun` 本身不强制进入 queue；它主要创建/返回 session。Phase 3 的
  `admitRun(start: true)` 会在同一个 queued admission work 中完成 admission 后
  调用 session start，保证 admission 和初次 start 的顺序清晰。
- control 如果需要 abort active attempts，abort 动作发生在 durable control
  mutation 成功之后。
- queue 中某个 work 失败后必须释放链条，让后续 work 继续执行。

观测与测试决策：

- unit test 覆盖 FIFO ordering：并发 enqueue 的 mutation 按进入顺序执行。
- unit test 覆盖 failure isolation：第一个 work reject 后，第二个 work 仍执行。
- daemon integration test 覆盖并发 `admitRun` request 有确定结果，且不会相互
  污染。
- 不要求 queue 暴露用户可见状态；若后续出现积压问题，再增加 daemon diagnostics。

Phase 4 暂不做：

- 不实现 priority queue。
- 不实现 per-run lane。
- 不把 scheduler attempt start/commit 全部包进 queue。
- 不改变 scheduler lease 语义。

## Phase 5: 缩短 Admission 事务

目的：减少 writer lock 持有时间，并为更清晰的 storage 边界做准备。

计划工作：

- 将 immutable workflow material 作为 canonical file 保存在 run directory。
- DB 尽量只存 digest、relative path 和 compact summary。
- 将昂贵 serialization 移出 DB transaction。
- 评估初始 `node_states` row 是否必须在 admission 时写入。
- 在本 roadmap 期间保留现有 DB 字段的兼容 fallback。

候选方向：

```text
runs/<run-id>/workflow.ir.json  -> canonical IR
runs/<run-id>/lock.json         -> canonical lock
runtime.db run_inputs           -> path/digest/summary, compatible JSON fields for now
```

验收检查：

- daemon 在 commit 后崩溃时，admission 仍创建可恢复 run。
- admission failure 会清理 staged run directories，或留下可检测的 abandoned
  staging data。
- `getFrozenRun` 可以从 canonical run-directory files 加载。
- 现有 completed runs 仍可 inspect。

Tree grill 问题：

- 这个阶段后，哪些数据以 DB 为 canonical，哪些数据以 run directory 为
  canonical？
- 当前 inspect/list 行为是否需要 `node_states` preinitialization？
- run-dir writes 和 DB commit 之间有哪些 crash windows？
- orphan staging directories 应如何检测和清理？

退出标准：

- Admission transaction 只包含让 run 可发现、可恢复所需的最小 durable
  index/event writes。
- 大型 immutable payload 不再决定 DB transaction 成本。

### Phase 5 Accepted Decisions

已知信息，不再 grill：

- 当前 admission 已经把 `workflow.ir.json` 和 `lock.json` 写入 run directory，
  但同时也把完整 `workflow_ir_json` 和 `lock_json` 写入 `run_inputs`。
- 当前 `run_inputs.workflow_ir_json` 和 `run_inputs.lock_json` 是 `NOT NULL`；
  若要新 run 不再把完整 IR/lock 写入 DB transaction，Phase 5 需要 schema
  migration，而不是单纯改代码路径。
- `getFrozenRun()` 当前从 DB 中的 `workflow_ir_json` 读取 frozen workflow；
  fork 逻辑也读取 DB 中的 IR/lock，并校验 run directory 文件。

Canonical storage 决策：

- Phase 5 后，新 run 的 canonical workflow IR 是
  `runs/<run-id>/workflow.ir.json`。
- Phase 5 后，新 run 的 canonical lock 是 `runs/<run-id>/lock.json`。
- DB 的 canonical 职责是保存 run index、status、event、digest、relative path
  和必要的小型 query fields。
- `input_json`、`agent_overrides_json`、`output_json` 暂时仍保留在 DB 中作为
  canonical。大型 input/output 的文件化另开后续 storage-boundary roadmap，
  不混入本阶段。

Schema 决策：

- 增加新列，例如：
  - `workflow_ir_path`
  - `workflow_ir_digest`
  - `lock_path`
  - `lock_digest`
- 迁移 `run_inputs`，允许 `workflow_ir_json` 和 `lock_json` 对新 run 为 null。
  现有 run 的旧 JSON 字段保留，用作 compatibility fallback。
- 新 run 写 DB 时优先写 path/digest，不再在 transaction 中写完整 IR/lock JSON。
- 读取 frozen run 时优先从 run directory path 读取并校验 digest；旧 run fallback
  到 DB JSON 字段。

Admission filesystem 决策：

- 使用 staging run directory 写入 immutable files，并在文件完整写入和校验后
  rename 到最终 run directory。
- DB transaction 只在最终 run directory 存在且校验通过后开始。
- 如果 DB transaction 失败，尝试删除最终 run directory。
- 如果进程在 rename 后、DB commit 前崩溃，可能留下没有 DB row 的 orphan run
  directory。Phase 5 的 cleanup 只清理由 admission marker 标识且超过阈值的
  orphan staging/finalized-admission directory，不泛化删除所有未知 run id 目录。

`node_states` 决策：

- Phase 5 暂时保留 admission 时的静态 `node_states` preinitialization。
- 原因是当前 `getRun()` 的 `nodeCount`、inspect summary 和部分 public projection
  仍依赖这些 rows。移除 preinitialization 属于更大的 projection redesign，不放
  入本阶段。
- Phase 5 的性能收益主要来自 IR/lock 大 payload 出 DB transaction，而不是
  改变 static node projection。

测试决策：

- 新增 migration 测试：旧 DB 中只有 `workflow_ir_json`/`lock_json` 的 run 仍可
  inspect、advance、fork。
- 新增新 admission 测试：DB row 存 path/digest，run directory 文件为 canonical。
- 新增 digest mismatch 测试：run directory 文件被破坏时，`getFrozenRun()` 失败
  为明确 storage error，而不是静默使用错误内容。
- 新增 crash-window cleanup 测试：带 admission marker 的 orphan staging/final
  directory 可被清理；无 marker 的未知目录不被误删。

Phase 5 暂不做：

- 不移动 input/output payload。
- 不删除旧 `workflow_ir_json` 或 `lock_json` 字段。
- 不取消 `node_states` preinitialization。
- 不重写 fork 的 artifact inheritance 语义，只让 fork 读取 canonical file 并
  保留旧 DB fallback。

## Phase 6: Progress 写入合并

目的：降低并发 run 执行期间的高频写入压力。

计划工作：

- 将 `node_progress` 视为 latest summary，而不是完整历史。
- 合并同一个 run/node 的重复 progress writes。
- 按有界 interval 和 terminal transition flush progress。
- 可行时让 foreground observation 从 daemon session state 获取事件。
- file-backed full progress streams 留给后续 roadmap。

验收检查：

- 高频 task 或 agent progress 不会为每个 event 创建一次 DB write。
- terminal inspect 仍展示最新且有用的 progress summary。
- foreground 用户仍能及时看到 progress。
- hook 和 execution metadata 行为保持不变，除非明确进入同一 coalescing
  mechanism。

Tree grill 问题：

- progress event 到 CLI 可见更新之间，什么 latency 可以接受？
- 哪些 progress fields 可以安全 drop 或 overwrite？
- progress coalescing 应按 node、attempt，还是 run 聚合？
- terminal failure 如何强制 final flush？

退出标准：

- 并发 run 下，progress updates 不再主导 DB 写入频率。
- 用户可见 progress surface 仍然有用。

### Phase 6 Accepted Decisions

已知信息，不再 grill：

- `node_progress` 的 primary key 是 `(run_id, node_key)`，当前语义已经是 latest
  summary，而不是完整 progress history。
- 当前 agent execution 内已有一层 `PROGRESS_FLUSH_INTERVAL_MS = 1_000` 的局部
  节流，但它仍直接调用 `store.writeNodeProgress()`。
- `writeNodeProgress()` 每次都会开启 `BEGIN IMMEDIATE`，upsert `node_progress`，
  并 bump `runs.progress_version`。

Interface 决策：

- coalescing 放在 runtime progress writer adapter，而不是把
  `RuntimeStore.writeNodeProgress()` 改成异步 buffer。
- store 继续提供同步、立即、latest-summary 的写入能力；这让 terminal flush、
  测试和非 daemon 嵌入场景保持简单。
- daemon/session 创建一个 progress writer adapter，并把它传给 agent/task
  execution path。第一版可以只替换 agent progress path，task progress 后续按同
  一 interface 接入。

Coalescing 决策：

- 聚合 key 使用 `(runId, nodeKey)`，与 `node_progress` 表 primary key 对齐。
- 默认 flush interval 使用 `1_000ms`，沿用当前 agent progress 的用户可见节奏。
- 对同一 key，buffer 中只保留最新 snapshot。
- terminal progress status 立即 flush：`completed`、`failed`、`cancelled`、
  `timed_out`。
- attempt start 会清理旧 progress；清理逻辑仍留在 scheduler/store 事务里。
- run session drain、daemon shutdown、attempt terminal transition 都必须触发
  final flush。

数据保留决策：

- `output_tail`、`token_usage_json`、`tools_json`、`context_json` 仍按 latest
  summary 覆盖。
- 不尝试在 DB 中保存完整 progress stream。
- 如果后续需要完整 agent transcript 或 progress history，写入 run directory
  append-only 文件，另开 roadmap。

测试决策：

- unit test 覆盖同一 `(runId, nodeKey)` 多次 progress 只触发一次 scheduled
  flush。
- unit test 覆盖 terminal status bypass interval 并立即写入。
- integration test 覆盖 daemon shutdown/session completion 会 flush pending
  progress。
- inspect 测试确认 terminal run 仍可看到最新 progress summary。

Phase 6 暂不做：

- 不改变 `node_progress` schema。
- 不实现完整 progress history。
- 不把 hook stdout/stderr 或 execution metadata 合并进同一机制。
- 不引入用户可配置 flush interval。

## Phase 7: 完整验证矩阵

目的：证明重构提升了并发能力，同时不改变产品语义。

计划工作：

- 跑并发 foreground run 的 CLI e2e。
- 跑并发 background run 的 CLI e2e。
- 跑 foreground/background/inspect 混合场景。
- 在其他 run 正在 admission 时执行 control operations。
- 在并发 workspace activity 下运行 signal workflow admission 和 signal
  delivery。
- 跑 daemon crash/restart recovery tests。
- 跑完整 typecheck 和 test suite。

验收检查：

- 单 workspace 16 个并发 foreground run 完成，且 raw SQLite lock error 为 0。
- 单 workspace 16 个并发 background run admission 成功。
- 并发 control 和 signal request 不破坏 run state。
- 不存在没有可加载 run directory 的 orphan committed run。
- 不存在没有 discoverable run row 的 committed run directory，显式忽略的
  staging directory 除外。
- 现有 run inspect JSON/text surface 保持稳定，除非是明确的改善。

Tree grill 问题：

- 哪些测试进入默认 CI，哪些保留为本地 stress tests？
- 什么指标能说明 daemon queue 没有变成隐藏瓶颈？
- 实现结束前值得增加哪些 failure injection？
- 对现有 local workspace 需要什么 compatibility evidence？

退出标准：

- roadmap 可以用测试证明：目标并发 run 场景下没有用户可见 SQLite lock
  failure。

### Phase 7 Accepted Decisions

已知信息，不再 grill：

- 项目已有 test taxonomy：`*.unit.test.ts`、`*.contract.test.ts`、
  `*.integration.test.ts`、`*.e2e.test.ts`、`*.regression.test.ts`。
- CLI subprocess 行为属于 e2e；runtime daemon/socket/session 行为属于
  integration 或 unit，取决于是否启动真实 daemon loop。
- Phase 0 已定义 opt-in 基线，Phase 3 后会把核心并发场景升级为默认 e2e。

默认 CI 验证：

- `pnpm test:e2e` 覆盖 8 个并发 foreground `workflow run --json`，同一个
  workspace，断言 0 个 raw SQLite lock error。
- `pnpm test:e2e` 覆盖 background run admission，至少包含多个并发 background
  run，并验证 daemon 后续能完成这些 run。
- `pnpm test:integration` 覆盖 daemon `admitRun(start:false)`、
  `admitRun(start:true)`、mutation queue ordering、failure isolation 和
  shutdown final flush。
- `pnpm test:unit` 覆盖 store-busy adapter、runtime mutation queue、progress
  coalescer。
- `pnpm typecheck` 和 `pnpm test` 作为交付前完整验证。

Opt-in stress 验证：

- 保留 16 个并发 foreground run 的 stress command。
- 保留 16 个并发 background run 的 stress command。
- stress 输出必须包含：
  - 总 run 数。
  - 成功数。
  - 失败数。
  - raw SQLite lock error 数。
  - p50/p95 admission latency。
  - p50/p95 terminal latency。
- stress 不进入默认 CI，但作为 release 前或本地性能检查使用。

兼容性验证：

- 旧 workspace 中只有 DB `workflow_ir_json`/`lock_json` 的 run 仍可 inspect 和
  fork。
- 新 workspace 中 path/digest canonical run 可 inspect、advance、fork。
- `workflow check` 不创建 runtime state。
- `runs inspect --json` 和 text inspect 的既有字段保持稳定，除非某个阶段明确
  记录了 intentional change。
- `runs signal`、`runs retry`、`runs cancel` 在 daemon admission 并发活动下不
  破坏 run state。

完成指标：

- 单 workspace 16 个并发 foreground run：0 个 raw SQLite lock error。
- 单 workspace 16 个并发 background run：0 个 admission failure。
- 默认 8 并发 e2e 在 CI 中稳定。
- CLI `workflow run` 路径无 direct `admitPreparedWorkflowRun()` 调用。
- daemon admission、mutation queue、progress coalescing 都有对应测试。
- 没有 committed DB row 指向不可加载 run directory。
- 没有带 admission marker 的 orphan run directory 在 daemon cleanup 后残留超过
  阈值。

Phase 7 暂不做：

- 不要求证明 per-run DB/table 的收益。
- 不把 stress 性能指标设为严格 benchmark gate。
- 不为所有历史本地 workspace 形态做无限兼容；只覆盖当前 roadmap 明确涉及的
  schema 迁移和 canonical storage fallback。

## 实施顺序

1. Phase 0 建立 failure/protection 测试面。
2. Phase 1 落地即时 SQLite/error-surface 安全网。
3. Phase 2 添加 daemon admission，不改变 CLI 行为。
4. Phase 3 将 CLI run 路径切到 daemon admission。
5. Phase 4 让 daemon mutation ordering 显式化。
6. Phase 5 收缩 admission 写入成本。
7. Phase 6 降低 progress 写入压力。
8. Phase 7 验证完整行为和性能边界。

这个顺序让每个阶段都能独立 review。最关键的架构变化是 Phase 3；写入已经
进入 daemon 后，后续性能优化才更有价值。

## 待决问题

- Admission request shape：通过 socket 传 prepared object，还是使用
  path-based handoff。
- Admission idempotency：现在增加，还是等观察到 duplicate client request
  行为后再加。
- Busy timeout 的具体值和可配置性。
- Runtime mutation queue 形态：单 workspace lane，还是 per-run lanes 加
  workspace admission lane。
- 缩短 transaction 后，workflow IR 和 lock 的 canonical location。
- `node_states` 是否继续 preinitialize，还是成为 IR 加 events 的 projection。
- Progress flush interval 和 final-flush guarantees。

## Tree Grill 协议

每个阶段实现前，都使用同一棵树进行 grill：

1. Interface：这个阶段暴露给 caller 的最小 interface 是什么？
2. Invariants：阶段前后必须保持哪些事实为真？
3. Failure windows：process crash、socket disconnect 或 filesystem failure
   会在哪里留下 partial state？
4. Concurrency：哪些操作可能同时到达，由谁排序？
5. Observability：用户或测试如何知道发生了什么？
6. Compatibility：哪些已有 runs、commands 和 tests 必须继续工作？
7. Exit criteria：什么具体证据允许我们进入下一阶段？

每个阶段的 grill 输出可以在开始改代码前，作为简短 accepted-decision section
追加到本文档。
