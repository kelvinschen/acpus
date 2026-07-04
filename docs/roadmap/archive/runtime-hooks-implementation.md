# Runtime Hooks Implementation Roadmap

## 目标

为 acpus 提供运行时 hook 能力：在 workflow 执行的流程中触发用户配置的 side effect shell 脚本（发消息通知、触发 CI、调用 webhook 等）。

## 产品决策

| 决策 | 结论 |
|---|---|
| 注入点 | 双轨：scheduler 事件源 + 独立 HookRunner 消费 |
| 与 scheduler 关系 | 不参与事件流，独立 `hook_journal` 表 |
| 失败语义 | non-interfering：hook 失败不影响 workflow，hook 输出不回传 workflow |
| Event 类型 | 6+2：`run.started/completed/failed/canceled` + `node.completed/failed` + 可选 `node.started`/`run.awaiting` |
| 执行模型 | 异步并行 spawn，不阻塞 scheduler；daemon 进程关闭前可 graceful drain |
| Context 传递 | stdin JSON：`run` + `node` + `agentPrompt`/`taskInput` |
| 配置方式 | JSON 文件，顶层直接按 event 配置 command hook，不支持 TS module |
| 配置层级 | project 级 `.acpus/hooks.json` + global 级 `~/.acpus/hooks.json`，直接合并执行，不按同名覆盖 |
| 过滤 | 可选 `match` 对象，字段值为 regex string，字段之间 AND |
| 资源限制 | 单 hook 默认 30s timeout；不做全局 hook 并发限制 |
| 触发幂等 | 仅对新 append 成功的 `run_events` row 触发，不因 snapshot load、projection rebuild、inspect、duplicate idempotency return 触发 |
| Journal | 独立 SQLite `hook_journal` 表，仅记录 terminal hook 结果，按 `event_sequence` + `trigger_order` 展示，保留 7 天，stdout/stderr 截断 4KB+4KB |
| CLI | 新增 `acpus hooks list` + `validate`，不提供 CRUD/path 命令；需同步更新 CLI spec/output contract |
| 启用/禁用 | 删除配置条目即禁用；trust/security 机制作为 future work，不进第一版 |

## 实现状态

| 阶段 | 状态 | 证据 |
|---|---|---|
| Phase 0 Spec 文档 | ✅ completed | `specs/hooks-spec.md`，`specs/INDEX.md`，`specs/cli-spec.md` 已更新 |
| Phase 1 配置层 | ✅ completed | `packages/runtime/src/hooks/config.ts`、`loader.ts`，`hooks-config.unit.test.ts` |
| Phase 2 事件/context 层 | ✅ completed | `events.ts`、`context.ts`、共享 `scheduler/event-codec.ts`，`hooks-events-context.unit.test.ts` |
| Phase 4 hook_journal 持久化 | ✅ completed | `hook_journal` schema、`RuntimeStore` journal API、7 天 prune、`hooks-journal.integration.test.ts` |
| Phase 3 HookRunner | ✅ completed | `runner.ts`，timeout process-tree kill，bounded stdout/stderr，trigger order metadata，`hooks-runner.unit.test.ts` |
| Phase 5 daemon/runtime 集成 | ✅ completed | shared daemon HookRunner、committed-row cursor trigger、short-session control trigger、shutdown drain、idle blocker，`hooks-runtime-integration.test.ts`、`daemon-lease.integration.test.ts` |
| Phase 6 CLI hooks 子命令 | ✅ completed | `acpus hooks validate/list`，scope grouped output，JSON envelope，`program.contract.test.ts` |
| Phase 7 runs inspect hook history | ✅ completed | terminal-only text `Hooks:` section，JSON `RunDetails.hooks`，`run-status-surface.contract.test.ts` |
| Phase 9 清理策略 | ✅ completed | `ON DELETE CASCADE` + daemon tick 7-day prune，schema/journal/daemon tests |
| 阶段性 subagent review | ✅ completed | Phase 0-2、Phase 3/4、Phase 5、Phase 6/7 均已由干净 subagent review，并修复 findings |

实现补充：daemon startup 遇到 invalid hooks config 会失败并报告配置错误，避免静默把已配置 hooks 当作空配置运行。

## Phase 1：配置层 — HookConfig 类型 + 加载 + 校验

### 1.1 定义 HookConfig schema

**文件：** `packages/runtime/src/hooks/config.ts`

```typescript
type HookEvent =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.canceled"
  | "run.awaiting"
  | "node.started"
  | "node.completed"
  | "node.failed";

type HookMatch = {
  workflow?: string;               // regex，匹配 workflow name，所有 event 生效
  nodeId?: string;                 // regex，node.* 与 run.awaiting 生效
  nodeKey?: string;                // regex，node.* 与 run.awaiting 生效
  kind?: string;                   // regex，node.* 与 run.awaiting 生效
};

type HookConfig = {
  id?: string;                     // 展示/journal/debug 标识，不参与覆盖语义
  match?: HookMatch;               // 可选；省略表示 match all
  command: string;                 // shell 命令，context 通过 stdin JSON 传入
  timeout?: string;                // duration，默认 "30s"
};

type HooksFile = Partial<Record<HookEvent, HookConfig[]>>;

type LoadedHookConfig = HookConfig & {
  event: HookEvent;
  source: "project" | "global";
  sourcePath: string;
  definitionIndex: number;         // 在来源文件 + event 数组中的 0-based 顺序
  definitionHash: string;
  effectiveId: string;             // id 缺省时由 source/event/index/hash 生成
};
```

配置文件本身就是 event map，不再包一层 `"hooks"` 字段：

```json
{
  "run.completed": [
    {
      "id": "slack-notify",
      "match": { "workflow": "^release(-.*)?$" },
      "command": "./scripts/notify.sh",
      "timeout": "30s"
    }
  ],
  "node.failed": [
    {
      "id": "build-alert",
      "match": { "nodeId": "^(build|test)$", "kind": "task|agent" },
      "command": "./scripts/alert.sh"
    }
  ]
}
```

### 1.2 实现配置校验

**文件：** `packages/runtime/src/hooks/config.ts`

- `validateHooksFile(config: unknown): Result<HooksFile, ValidationError[]>`
- 校验规则：
  - 顶层必须是 object，顶层 key 必须是合法 `HookEvent`
  - 顶层不接受 `"hooks"` 字段
  - 每个 event value 必须是 hook entry 数组
  - `id` 可选，非空字符串；不要求全局唯一，不参与合并/覆盖
  - `command` 必填，非空字符串
  - `timeout` 可选，合法 duration 格式（`^\d+(ms|s|m|h)?$`）
  - `match` 可选 object，仅允许 `workflow`/`nodeId`/`nodeKey`/`kind`
  - `match` 字段值必须是合法 JavaScript regex string
  - run 级 event 不允许 `nodeId`/`nodeKey`/`kind`，但 `run.awaiting` 例外，因为它携带 signal node identity
  - 拒绝未知字段

### 1.3 实现配置加载与合并

**文件：** `packages/runtime/src/hooks/loader.ts`

- `loadHooksConfig(workspaceDir: string): Result<LoadedHookConfig[], LoadError>`
- 加载 `<workspaceDir>/.acpus/hooks.json` 和 `~/.acpus/hooks.json`
- 合并规则：两级直接并集，project/global 同 `id` 或同 `command` 也都执行
- loader 将 event map flatten 成 `LoadedHookConfig[]`，补充 `source`、`sourcePath`、`definitionIndex`、`definitionHash`、`effectiveId`
- `definitionHash` 必须包含 `source`、`sourcePath`、`event`、`definitionIndex` 和 canonical hook config，确保 project/global 或同文件重复相同 command 仍可分别执行和记录
- 文件不存在时返回空数组（不是错误）
- JSON 解析失败时返回 `LoadError`
- 校验失败时返回 `LoadError`（含具体校验错误）

### 1.4 测试

- 空对象/文件不存在 → 空数组
- 合法配置加载成功
- JSON 语法错误 → `LoadError`
- 字段校验错误 → `LoadError`
- 两级合并：project/global 直接并集，不做同名覆盖
- 配置包含顶层 `"hooks"` 字段 → `LoadError`
- 非 `run.awaiting` 的 run 级 event 配置 node matcher → `LoadError`
- regex 字符串非法 → `LoadError`

---

## Phase 2：事件层 — HookContext 构造 + Event 映射

### 2.1 定义 HookContext

**文件：** `packages/runtime/src/hooks/context.ts`

```typescript
type HookContext = {
  event: HookEvent;
  eventSequence: number;     // 触发 hook 的新插入 run_events.sequence
  run: {
    id: string;
    workflowName: string;
    workflowPath: string;
    workspaceDir: string;
    status: string;
  };
  node?: {
    id: string;
    key: string;
    kind: "task" | "agent" | "signal";
    status: string;
    output?: unknown;        // 仅 completed event
    error?: { message: string }; // 仅 failed event
    agentPrompt?: string;    // 仅 agent 节点
    taskInput?: unknown;     // 仅 task 节点
  };
  output?: unknown;          // 仅 run.completed event
  error?: { message: string }; // 仅 run.failed event
  cancellation?: { reason: string }; // 仅 run.canceled event
  signal?: {                 // 仅 run.awaiting event
    nodeId: string;
    nodeKey: string;
    prompt: string;
  };
};
```

### 2.2 实现 CommittedRuntimeEventRow → HookEvent 映射

**文件：** `packages/runtime/src/hooks/events.ts`

- `mapRuntimeEventToHookEvent(row: CommittedRuntimeEventRow): HookEvent | null`
- `CommittedRuntimeEventRow` 是新增的 hooks 内部类型，表示本次事务中新插入的 `run_events` row，必须包含 `sequence`、`type`、`nodeKey`、`payload`、`createdAt`、`idempotencyKey`
- scheduler event row 的 `payload` 需要由当前 `{ schedulerEventVersion: 1, payload }` envelope 解码得到；public run event row 的 `payload` 直接来自 `payload_json`
- 映射表：

| Runtime event row | HookEvent |
|---|---|
| `frame.started` 且 `frameKey === "root"`、`frameKind === "root"` | `run.started` |
| `run.completed` | `run.completed` |
| `run.failed` | `run.failed` |
| `run.canceled` | `run.canceled` |
| `instance.completed` | `node.completed` |
| `instance.failed` | `node.failed` |
| `instance.started` | `node.started` |
| `signal.awaiting` | `run.awaiting` |

- 不映射的 scheduler events（非 root `frame.*`、group.*, attempt.*, branch.* 等）返回 null
- `run.started` 不从 `run.admitted` admission 事件触发；它表示实际 scheduler execution 已经启动
- 映射函数不得从历史事件扫描、snapshot load、projection rebuild、inspect/read API 触发 hook
- duplicate idempotency return 没有新插入 event row，必须触发 0 个 hook

### 2.3 实现 HookContext 构造

**文件：** `packages/runtime/src/hooks/context.ts`

- `buildHookContext(row: CommittedRuntimeEventRow, hookEvent: HookEvent, projection: SchedulerProjection, ir: WorkflowIR, workspaceDir: string): HookContext`
- 从 projection + frozen IR 中提取 run/workflow/node 信息
- `eventSequence` 来自触发 hook 的 `run_events.sequence`
- agent prompt 从 frozen IR 的 `AgentNodeIR.run.prompt` 获取并渲染
- task input 从 `TaskNodeIR.run.input` 基于 durable execution scope 计算；scope 只提供 prior outputs，不是 task input 本身

### 2.4 测试

- 每种可触发的 CommittedRuntimeEventRow 正确映射到 HookEvent
- 内部事件（frame.*, attempt.* 等）正确返回 null
- read/snapshot/projection rebuild 不触发 hook
- duplicate idempotency return 不触发 hook
- HookContext 包含所有必要字段
- HookContext 包含正确的 `eventSequence`
- node.agentPrompt 仅在 agent 节点出现
- node.taskInput 仅在 task 节点出现
- node.output 仅在 completed event 出现
- node.error 仅在 failed event 出现
- cancellation 仅在 run.canceled event 出现
- run.awaiting context 包含 signal node id/key/prompt

---

## Phase 3：执行层设计 — HookRunner spawn + timeout + trigger order

本节定义 Runner 语义；实际编码时必须先完成 Phase 4 的 `hook_journal` 表和读写 API，再接入 journal 写入。

### 3.1 实现 HookRunner

**文件：** `packages/runtime/src/hooks/runner.ts`

核心接口：

```typescript
type HookRunner = {
  /** 根据 event 匹配 hooks 并异步触发；不阻塞 scheduler advance，不影响 run 状态 */
  trigger(event: HookEvent, context: HookContext): void;
  /** 等待所有正在执行的 hooks 完成（仅用于 graceful shutdown/journal 完整性） */
  drain(): Promise<void>;
};
```

- `trigger()` 内部逻辑：
  1. 从预加载的 `LoadedHookConfig[]` 中匹配 `event`
  2. 应用 `match` regex 过滤，多个字段 AND
  3. 为每次匹配分配单调递增的 `trigger_order`
  4. 对每个匹配的 hook 调用 `spawnHook(config, context)`
- `trigger()` 不等待进程完成，hook 失败、timeout、journal 写入失败都不得改变 workflow 状态
- hook 输出只写 journal，不进入 runtime scope、IR、event payload、CLI JSON 的 workflow 结果字段

### 3.2 实现 spawnHook

**文件：** `packages/runtime/src/hooks/runner.ts`

- `child_process.spawn(command, { shell: true })`
- stdin 写入 JSON.stringify(context)，然后 `stdin.end()`
- 收集 stdout/stderr（截断前 4KB + 后 4KB）
- timeout 控制：`setTimeout` → SIGTERM → 2s 后 SIGKILL
- 记录 `duration_ms`
- 写入 `hook_journal`
- journal entry 写入 `source`、`source_path`、`handler_id`、`definition_hash`、`event_sequence`、`trigger_order`
- `handler_id` 使用用户配置的 `id`；缺省时使用 `effectiveId`
- 不写 `running` journal row；只有 hook 完成、失败、timeout 后写 terminal row

### 3.3 执行顺序与 drain

- 不限制 hook 进程全局并发；用户负责 hook 命令自身资源消耗
- runtime 不保证外部系统最终到达顺序，例如 Lark/webhook 消息送达顺序
- `trigger_order` 记录 runtime 触发顺序，用于 journal / inspect 审计排序
- `drain()` 等待所有 active spawn 完成，仅用于 graceful shutdown
- daemon-hosted run execution sessions 不等待 `drain()` 才推进 scheduler；daemon shutdown/idle-stop 前可调用 `drain()` 以补全 journal

### 3.4 测试

- 匹配 event 的 hook 被触发
- 不匹配 event/regex match 的 hook 不被触发
- `match` 多字段 AND 过滤正确
- `run.awaiting` 支持按 signal nodeId/nodeKey/kind 过滤
- stdin 传入正确的 JSON context
- timeout 超时后进程被 kill
- exit code 非零时 journal 记录 `status: "failed"`
- 多个匹配 hook 会记录稳定的 `trigger_order`
- `drain()` 等待所有进程完成
- hook 失败不影响 run 状态

---

## Phase 4：持久化层 — hook_journal 表 + 读写 API

### 4.1 设计 hook_journal 表

**文件：** `packages/runtime/src/store/store.ts`（schema 迁移）

```sql
CREATE TABLE IF NOT EXISTS hook_journal (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  event_sequence INTEGER NOT NULL,
  trigger_order INTEGER NOT NULL,
  event       TEXT NOT NULL,
  source      TEXT NOT NULL,  -- "project" | "global"
  source_path TEXT NOT NULL,
  handler_id  TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  node_key    TEXT,           -- NULL for run-level events without node context; set for node.* and run.awaiting
  status      TEXT NOT NULL,  -- "completed" | "failed" | "timed_out"
  exit_code   INTEGER,
  stdout      TEXT,           -- truncated head 4KB + tail 4KB
  stderr      TEXT,           -- truncated head 4KB + tail 4KB
  duration_ms INTEGER,
  error       TEXT,           -- error message for failed/timed_out
  triggered_at TEXT NOT NULL  -- ISO 8601 timestamp
);

CREATE INDEX IF NOT EXISTS idx_hook_journal_run_id ON hook_journal(run_id);
CREATE INDEX IF NOT EXISTS idx_hook_journal_triggered_at ON hook_journal(triggered_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hook_journal_event_handler
  ON hook_journal(run_id, event_sequence, definition_hash);
```

### 4.2 实现 journal 写入

**文件：**
- `packages/runtime/src/hooks/journal.ts`
- `packages/runtime/src/store/store.ts`

- `RuntimeStore.writeHookJournal(entry: HookJournalEntry): void`
- `writeHookJournal(store: RuntimeStore, entry: HookJournalEntry): void` 可作为薄 helper 调用 store 方法
- 在 hook 执行完成后（成功/失败/timeout）同步写入
- SQLite 访问必须封装在 `RuntimeStore` 内部；hooks 模块不直接访问 store 私有连接
- 重复写入同一 `(run_id, event_sequence, definition_hash)` 时必须幂等处理，不得创建重复 journal 行
- 只写 terminal 状态：`completed`、`failed`、`timed_out`
- hook 进程或 daemon 崩溃导致没有 terminal row 时，不补写 synthetic failure row

### 4.3 实现 journal 读取

**文件：**
- `packages/runtime/src/hooks/journal.ts`
- `packages/runtime/src/store/store.ts`

- `RuntimeStore.getHookJournal(runId: string): HookJournalEntry[]`
- `getHookJournal(store: RuntimeStore, runId: string): HookJournalEntry[]` 可作为薄 helper 调用 store 方法
- 按 `event_sequence ASC, trigger_order ASC, id ASC` 排序；`triggered_at` 只用于执行时间记录和 retention
- RunDetails 暴露在 Phase 7 处理；journal API 本层只负责读写 `hook_journal`

### 4.4 实现 journal 过期清理

**文件：**
- `packages/runtime/src/hooks/journal.ts`
- `packages/runtime/src/store/store.ts`

- `RuntimeStore.pruneHookJournal(cutoff: Date): number`
- 默认 retention 为 7 天，删除 `triggered_at < now - 7 days` 的 journal rows
- read-only API（`getRun`、`runs inspect`、`doctor`）不得触发 prune
- daemon tick 可 opportunistic 调用 prune；长期不启动 daemon 时，过期 journal 允许继续存在，直到下一次 daemon tick

### 4.5 测试

- 成功执行的 hook 正确写入 journal（status: "completed", exit_code: 0）
- 失败 hook 写入 journal（status: "failed", exit_code: 非零）
- timeout hook 写入 journal（status: "timed_out"）
- hook 启动但未 terminal 不写 journal row
- stdout/stderr 截断行为正确
- 按 run_id 查询返回正确的 hook 列表
- 重复 journal 写入不会产生重复行
- `pruneHookJournal()` 删除 7 天以前 rows，保留 7 天内 rows
- read-only inspect/getRun 不触发 prune

---

## Phase 5：集成层 — 接入 daemon-hosted runtime advancement

### 5.1 在 runtime advancement 中集成 HookRunner

**文件：**
- `packages/runtime/src/scheduler/runtime-runner.ts`
- `packages/runtime/src/scheduler/store-port.ts`
- `packages/runtime/src/runs/advance-runtime.ts`
- `packages/runtime/src/daemon/sessions.ts`
- `packages/runtime/src/store/store.ts`

修改 runtime advancement 路径：
1. daemon loop / workspace runtime owner 创建一个共享 `HookRunner`，通过 `loadHooksConfig(workspaceDir)` 加载 `LoadedHookConfig[]`
2. `advanceRuntimeRun()` / `advanceFrozenRun()` 接收共享 HookRunner 或 committed-row observer，不在每个 scheduler drive 内重新创建 Runner
3. scheduler append/public run event append 成功提交后，取得本次新插入的 `CommittedRuntimeEventRow[]`
4. 对每个新 row 调用 `mapRuntimeEventToHookEvent()`，命中后构造 `HookContext` 并调用 `hookRunner.trigger()`
5. run execution session 完成时不等待 hook；daemon shutdown/idle-stop 前可调用 `hookRunner.drain()`（graceful shutdown）

store append/public projection sync 边界需要向 runtime advancement 暴露本次新插入的 rows，或提供等价 committed-row observer：

- 成功写入新 rows → 返回/通知这些 rows
- duplicate idempotency return → 返回/通知空 rows
- snapshot load、projection rebuild、inspect/read API → 不返回/通知 rows
- 当前 `SchedulerStorePort` 的写方法返回 `SchedulerSnapshot`；实现时必须同步更新 `packages/runtime/src/scheduler/store-port.ts` 的返回类型，或增加明确的 committed-row observer 回调，避免 hooks 只能从 snapshot 反推新事件
- `syncPublicRunProjection()` 内部插入的 public `run.completed`/`run.failed` rows 也必须进入同一 committed-row observer；runtime-runner 不能只从 scheduler summary 推断这些 hook event
- observer 必须覆盖所有写入 `run_events` 的 runtime store 方法，包括 scheduler append、attempt start、attempt result commit、signal consume、pause/resume/retry/cancel/fork seed，以及 public run projection sync

伪代码：

```typescript
const hooksConfig = loadHooksConfig(workspaceDir);
const hookRunner = createHookRunner(hooksConfig, store);

// 在 append 事务成功提交后，只处理本次新插入的 rows：
for (const row of appendResult.appendedRows) {
  const hookEvent = mapRuntimeEventToHookEvent(row);
  if (hookEvent) {
    const context = buildHookContext(row, hookEvent, appendResult.afterProjection, ir, workspaceDir);
    hookRunner.trigger(hookEvent, context);
  }
}

// daemon shutdown/idle-stop 前：
await hookRunner.drain();
```

### 5.2 在 daemon loop 中集成

**文件：**
- `packages/runtime/src/daemon/loop.ts`
- `packages/runtime/src/daemon/sessions.ts`

- daemon-hosted `RunExecutionSessions` 共享同一套 HookRunner 逻辑
- daemon tick 之间 hook 进程可能仍在运行；tick 不等待 drain
- daemon idle-stop/shutdown 前可 drain active hooks，避免丢失 journal
- hook active count 可作为 idle-stop blocker，避免 daemon 在 hook journal 尚未落库时退出
- daemon tick opportunistically prune 7 天以前的 hook journal rows

### 5.3 测试

- foreground `workflows run` 通过 daemon-owned execution 触发 hook
- `workflows run --background` 通过 daemon-owned execution 触发 hook
- hook 触发不阻塞 scheduler advance
- hook 失败不影响 run 状态
- workspace 无 hooks.json 时正常运行（无 hook 触发）
- duplicate idempotency return 不触发 hook
- snapshot load/projection rebuild/inspect 不触发 hook
- daemon tick 不等待 hook 完成才继续调度
- daemon shutdown/idle-stop 前 drain active hooks
- daemon tick 清理过期 hook journal rows

---

## Phase 6：CLI — `acpus hooks` 子命令

### 6.1 实现 `acpus hooks validate`

```
acpus hooks validate [--project | --global]
```

- 加载指定层级配置文件
- 调用 `validateHooksFile()` 对配置文件校验
- 成功：exit 0，text 输出 "OK (N hooks)"
- 失败：exit 1，输出校验错误详情（行号、字段、原因）
- `--json`：使用标准 `CliResult` envelope，新增 hook-specific `hookValidation` 字段，例如 `{ "ok": true, "phase": "validate", "hookValidation": { "count": N } }`

### 6.2 实现 `acpus hooks list`

```
acpus hooks list [--project | --global]
```

- 加载并合并两级配置
- 默认按 scope 分组显示 project 与 global 的 hooks，并显示各自 hooks.json 路径
- `--project` 或 `--global` 只显示指定 scope
- text 输出格式：

```
Hooks (project + global):

Project: /workspace/.acpus/hooks.json
  run.completed
    slack-notify  →  ./scripts/notify.sh  (match: workflow=^release)

Global: /home/user/.acpus/hooks.json
  node.failed
    build-alert   →  ./scripts/alert.sh   (match: nodeId=^(build|test)$)
```

- `--json`：使用标准 `CliResult` envelope，新增 hook-specific `hooks` 字段；`hooks` 按 scope 分组，例如 `{ "project": { "path": "...", "hooks": [...] }, "global": { "path": "...", "hooks": [...] } }`，每条 hook 包含 `event`/`source`/`sourcePath`/`definitionHash`/`effectiveId`

### 6.3 在 CLI 入口注册命令

**文件：**
- `packages/cli/src/program.ts`
- `packages/cli/src/output.ts`
- `specs/cli-spec.md`

- 添加 `hooks` 子命令组
- 注册 `validate`、`list` 两个子命令
- 在 `CliResult`/`ResultPhase` 输出契约中加入 hook-specific 字段；如需新增 phase，必须同步更新 `specs/cli-spec.md`
- 在 CLI spec 的 command surface、JSON output、verification 中加入 `acpus hooks` 行为

### 6.4 测试

- `hooks validate` 校验成功/失败的 exit code
- `hooks list` 按 project/global scope 分组输出正确，并包含各 scope 的 hooks.json 路径
- `hooks list --project` 和 `hooks list --global` 只输出指定 scope
- `--json` 输出标准 `CliResult` envelope，且包含 hook-specific 字段
- 文件不存在时按空配置处理，输出 0 hooks，不作为错误

---

## Phase 7：Run 详情暴露 hook journal

### 7.1 在 RunDetails 中新增 hooks 字段

**文件：** `packages/runtime/src/store/store.ts`

```typescript
type RunDetails = {
  // ... existing fields
  hooks: HookJournalEntry[];  // 按 eventSequence + triggerOrder 排序；无 hook 时为空数组
};
```

### 7.2 在 `runs inspect` 中展示 hook 信息

**文件：**
- `packages/cli/src/commands/runs.ts`
- `packages/cli/src/run-status-surface.ts`
- `specs/cli-spec.md`

- `runs inspect` text 输出只在 terminal run 且 hook journal 非空时添加 hooks 区域
- text 格式需要先写入 `specs/cli-spec.md`；建议在 compact status surface 后追加 `Hooks:` 区域，使用明确状态标签 `completed`/`failed`/`timed_out`

```
Hooks:
  completed  slack-notify  run.completed  #42  120ms  exit=0
  failed     build-alert   node.failed     #57  5.0s   exit=1
  timed_out  health-check  run.started     #3   30.0s
```

- `--json`：terminal run detail JSON 中包含完整的 `hooks` 数组；terminal 但无 hooks 时为空数组；non-terminal run detail JSON 中 `hooks` 为空数组

### 7.3 测试

- run 无 hook 触发时 hooks 字段为空数组
- completed/failed/canceled run 有 hook 触发时 hooks 字段包含正确记录
- running/paused/awaiting run 不展示 hook history，即使已有 terminal hook journal rows
- text output 在无 hooks 时不展示 `Hooks:` 区域
- `runs inspect` text/JSON 对 terminal run 包含 hook 信息
- hook journal 按 `eventSequence` + `triggerOrder` 排序

---

## Phase 0：Spec 文档（实现前置）

### 0.1 编写 hooks spec

**文件：** `specs/hooks-spec.md`

参考模板（`specs/INDEX.md`）：
- Purpose：描述 hooks 功能边界
- Requirements：RFC 2119 语言，覆盖所有产品决策
- Verification：测试覆盖要求

### 0.2 更新 specs/INDEX.md

在 specs 表中添加 hooks spec 条目。

---

## Phase 9：清理策略

### 9.1 hook_journal 级联清理

- 当前 CLI 没有 `runs clean`/`runs delete` 命令；daemon tick 的 `cleanupRunDirectories()` 只清理 run-local directories，不应删除 `hook_journal`
- 若未来引入 run row 删除或数据库清理 API，必须级联删除关联的 `hook_journal` 行
- 可通过 SQLite `FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE` 或删除 API 中手动删除实现

### 9.2 测试

- daemon `cleanupRunDirectories()` 不删除 `hook_journal`
- 未来 run row 删除/数据库清理 API 删除 run 后，`hook_journal` 中对应行被清理
- 不相关 run 的 hook_journal 不受影响

---

## 实现顺序建议

```
Phase 0 (Spec) → Phase 1 (配置层) → Phase 2 (事件层) → Phase 4 (持久化层)
                                        ↓
                                   Phase 3 (执行层)
                                        ↓
                                   Phase 5 (集成层)
                                        ↓
                              Phase 6 (CLI) + Phase 7 (Run 详情)
                                        ↓
                                   Phase 9 (清理)
```

Phase 0 必须在实现前完成，因为当前产品/design truth 属于 `specs/`。Phase 1-2 可并行（配置加载与事件映射独立），Phase 4 在 Phase 3 之前（Runner 依赖 journal 写入）。

## 风险与依赖

- **Scheduler 事件稳定性**：依赖当前 `SchedulerEvent` 类型，如果 scheduler 重构需要同步更新映射
- **触发边界**：hook 必须只绑定本次新 append 成功的 `run_events` rows；duplicate idempotency return、snapshot load、projection rebuild、inspect/read API 不得触发 hook
- **Regex 过滤误配**：`match` 使用 JavaScript regex，配置校验必须提前编译 regex 并给出清晰错误
- **Hook 进程泄漏**：timeout kill 不保证子进程的子进程被清理，需监控
- **Journal retention**：hook journal 默认只保留 7 天；旧 run 的 hook 历史可能被清理，`runs inspect` 不保证长期审计可用性
- **SQLite 并发写入**：`hook_journal` 与 `run_events` 共享 SQLite 连接，需要确保不在同一个事务中竞争
- **Daemon lifecycle 差异**：daemon-hosted execution sessions 不等待 hook；daemon tick 不 drain；daemon shutdown/idle-stop 前可 drain，并可把 active hooks 计入 idle-stop blockers
- **Trust/security**：repo-local hook 可执行 shell，第一版不做 trust 机制；后续应评估 project hook trust/review/disable 设计

## 不做的

- TS module hook（用户明确拒绝）
- `blocking` 模式（第一版 hooks 只做 workflow side effect，不改变 workflow 状态）
- `hooks add/remove/edit` CLI 命令（删 JSON 即可）
- `hooks enable/disable` CLI 命令（删 JSON 即可）
- `hooks init` 模板生成（`hooks list` 会显示 project/global 配置路径）
- `hooks logs` 命令（journal 通过 `runs inspect` 查看）
- Hook 配置 schema version 字段（YAGNI）
- Hook 重试机制（用户脚本内部自行实现）
- glob matcher 和表达式 DSL（第一版只支持 regex matcher）
- Hook trust/review/allowlist 机制（future work）
- Hook 输出传递到 workflow（non-interfering side effect）
