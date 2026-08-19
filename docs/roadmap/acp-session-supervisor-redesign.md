# ACP Session Supervisor 重构 Roadmap

> 状态：可实施；M0–M5 为本轮承诺范围。
>
> 评估基线：2026-08-19 的当前工作树。Acpus 已使用 <code>@acpus/acp</code>，
> 但 Runtime 到 <code>agent-executor</code> 的外部 seam 仍以 Attempt/Worker 为中心。
>
> 本文是迁移 Roadmap，不是当前产品契约。当前行为以
> [specs](../../specs/INDEX.md) 为准。每个 milestone 完成时同步替换 owner spec；
> 全部稳定结论进入 spec 后删除本文。

## 1. 结论先行

本次重构不把 Attempt、ACP Session 和进程强行做成 1:1，也不再新增一个
Conversation 实体来包住它们。目标关系固定为：

~~~text
AgentSession S1                         # 唯一的 Agent 会话身份
├── NodeAttempt A1  operation=start     # Scheduler authority epoch
│   └── AcpTurn T1  authored prompt
├── NodeAttempt A2  operation=continue
│   ├── AcpTurn T2  continuation prompt
│   └── AcpTurn T3  response repair

AgentSession Sx
├── NodeAttempt A3  operation=continue  # not_dispatched，没有创建 AcpTurn
└── NodeAttempt A4  operation=safe_retry
    └── AcpTurn T4  exact A3 prompt

NodeAttempt A5  operation=restart
└── AgentSession S2                     # 新 Session generation
    └── AcpTurn T5  authored prompt
~~~

核心不变量：

1. <strong>AgentSession 是唯一会话连续性身份。</strong>
   <code>sessionKey</code> 只是 authoring-time grouping input，不是第二个会话实体。
2. <strong>一个已进入 Provider 边界的 Agent Attempt 必须且只能绑定一个
   AgentSession；一个 AgentSession 可以串行绑定多个 Attempt。</strong>
3. <strong>Attempt 是 Scheduler 的 durable authority/fence epoch，Session 是 Agent
   history/continuity，Turn 是一次 ACP prompt-to-terminal lifecycle。</strong>
4. <strong>Retry 不再决定 Agent prompt。</strong> Runtime 必须先得到显式
   Session operation 与可信 checkpoint，才能选择 Start、Continue、Safe retry 或
   Restart。
5. <strong>Process capsule 是内部隔离手段，不是产品身份。</strong> 本轮仍为每次
   Session lease 创建 cold capsule，但外部 interface 不承诺此物理映射。

本轮同时冻结三项产品决策：

- 显式共享 <code>sessionKey</code> 时拒绝 target-local Restart；提示 run-level
  Restart 或 Fork。Runtime 不静默把一个共享组拆成两个 Session。
- Active-turn Queue 与 Steer 的 <code>in_place</code> delivery 是合理能力，但不属于
  stable ACP v1 的普通 <code>session/prompt</code> 语义。本轮只冻结边界，不实现扩展。
- <strong>Steer 是稳定的产品意图，不等同于某一种 ACP Turn 操作。</strong>
  <code>runs steer</code> 表示请求让 instruction 进入同一 AgentSession 的最早安全
  下一次 LLM 推理；delivery mode 必须显式可见。M0–M5 只实现
  <code>interrupt_continue</code>（新 Attempt/Turn），未来 capability 可增加
  <code>in_place</code>（同 Attempt/Turn），不改变产品命令。

## 2. 为什么现有抽象会产生歧义

当前实现把四种不同寿命临时对齐：

~~~text
durable attempt
  = managed worker lifetime
  = ACP connection host lifetime
  = one use of an ACP session
~~~

这本身不是 bug；cold worker 是有效的隔离策略。真正的问题是 Runtime 没有持久化：

- 当前 Attempt 绑定哪个 AgentSession；
- 它是在 Start、Continue、Safe retry 还是 Restart；
- 上一个 Turn 到达了哪个可信 checkpoint；
- 这次 prompt 是 authored、continuation、steering 还是 repair；
- Session continuity 是否仍可安全复用。

于是同一个 “Retry” 已经同时表示两种相反动作：

| 当前路径 | Session | Prompt | 实际语义 |
| --- | --- | --- | --- |
| Target retry / resume | 常复用原 Session | continuation prompt | Continue |
| Run-level retry | 仍可能复用原 Session | authored prompt | Replay/Restart |

同一 Session replay authored prompt 可能重复工具或外部副作用；新 Session 发送
continuation prompt 又可能缺少任务上下文。只改名或强制 Attempt:Session 1:1 都不能
解决这个问题，必须把 operation 和 checkpoint 变成 durable facts。

## 3. ACP 协议边界

### 3.1 Stable ACP v1

[ACP v1 Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) 将一个
Turn 定义为从 <code>session/prompt</code> 开始，到原 request 返回
<code>PromptResponse(stopReason)</code> 结束的完整周期；中间可以有多次 LLM 推理、
工具调用和 <code>session/update</code>。

ACP v1 没有规定：同一 Session 的第一个 Turn 尚未 terminal 时，第二个普通
<code>session/prompt</code> 应当排队、注入当前 Turn、并发执行还是拒绝。
它明确允许一个 Prompt Turn 完成后再发送新的 <code>session/prompt</code> 继续同一
conversation，因此 <code>terminal_observed</code> 是本轮 portable Continue gate。

### 3.2 v2 draft 与 Provider extension

[ACP v2 Prompt Lifecycle RFD](https://agentclientprotocol.com/rfds/v2/prompt) 把
prompt response 改为“已接受”，再用 running/idle state update 表示 foreground
lifecycle；该 RFD 同时明确 queueing 仍是后续工作。

Provider 可以提供扩展。例如
[Claude Agent ACP steering](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/examples/steering.ts)
的 <code>_session/steering</code> 能把消息加入 running turn；ACP 社区也在讨论
[session/inject](https://github.com/orgs/agentclientprotocol/discussions/1220)
的 queue/steer mode。这些能力必须显式协商，不能从普通
<code>session/prompt</code> 猜测。

### 3.3 Acpus 当前边界

当前 <code>@acpus/acp</code> 在同一 <code>AcpSession</code> 已有 active turn 时直接
拒绝第二次 <code>runTurn</code>；worker 和 parent executor 也各有一层相同保护。
当前恢复路径使用 <code>session/resume</code> 或 <code>session/load</code>，但 ACP v1
response 不证明旧 Turn 仍 active 或已经 terminal。

因此本轮采用：

- terminal 后的新 prompt = <strong>Continue</strong>，portable ACP v1；
- active Agent target 上的新 instruction = <strong>Steer</strong> 产品意图；M0–M5
  使用 <code>interrupt_continue</code> delivery；
- active 时等待下一 Turn = <strong>Queue</strong>，未来 capability；
- 保持同一 active Turn 并影响其下一次 LLM 推理 = <strong>in-place Steer</strong>，
  未来 capability；
- “Provider 也许仍在执行” = <strong>status unknown</strong>，不是 active proof。

## 4. 范围

### 4.1 本轮包含

- AgentSession、NodeAttempt、AcpTurn、ProcessCapsule 和 Fence 的正式关系；
- Agent Attempt → AgentSession 的 durable binding 与 operation lineage；
- Continue、Restart、Safe retry、response repair 和 Steer 的产品保证、delivery mode
  与当前 <code>interrupt_continue</code> 实现；
- Runtime Agent attempt 到 <code>agent-executor</code> 的 session-oriented interface；
- deadline、cancel、inactivity、terminal settlement 和 cleanup ownership；
- worker IPC、event delta、partial result、error 与 artifact 数据流；
- session lease、projection writer exclusion、quarantine 和 startup recovery；
- shared <code>sessionKey</code> binding compatibility；
- cold capsule 实现与未来 warm reuse 的清晰决策门。

### 4.2 本轮不包含

- active-turn Queue、Steer 的 <code>in_place</code> delivery 或其他 ACP v1 之外的
  协议扩展；
- 多客户端同时 attach 一个 Session；
- warm host 跨 Attempt 复用；
- 远程或跨机器 Agent host；
- 多 Runtime 同时拥有同一 workspace state root；
- Workflow authoring 语法改造；
- 旧 projection、manifest、IPC 或 control wire 的 compatibility shim。

最后一项遵循项目 greenfield 规则：直接替换 current shape，删除旧 reader 与旧测试。

## 5. 领域模型

### 5.1 概念定义

| 概念 | 稳定身份 | 生命周期 | Owner | 不负责 |
| --- | --- | --- | --- | --- |
| <strong>AgentSession</strong> | <code>agentSessionId</code> | 首次 Start 到明确 abandoned/closed | Runtime identity + <code>@acpus/acp</code> continuity | Scheduler lease、OS process |
| <strong>NodeAttempt</strong> | <code>attemptId</code> | Scheduler admission 到 durable terminal/fence | Runtime Scheduler | Agent history |
| <strong>AcpTurn</strong> | <code>turnId</code> | prompt dispatch 到 ACP terminal/verified loss | Session supervisor + <code>@acpus/acp</code> | 跨 Attempt identity |
| <strong>ProcessCapsule</strong> | <code>hostId</code> | spawn 到 process tree death proof | agent-executor internal | 产品 Session identity |
| <strong>SessionLease</strong> | <code>sessionLeaseId</code> | acquire 到 capsule cleanup proof | Session supervisor | Scheduler topology |
| <strong>Fence</strong> | <code>attemptId + ownerEpoch</code> | durable authority change时生效 | Runtime Store | 证明 Provider 已停止 |

<code>providerSessionId</code> 是 ACP Agent 返回的 opaque backend identity，只作为
AgentSession continuity 的一部分，不替代 <code>agentSessionId</code>。

### 5.2 身份与 generation

Runtime 从以下 scope 解析一个 Session lineage：

~~~text
没有显式 sessionKey:
  scope = { runId, nodeKey }

有显式 sessionKey:
  scope = { runId, renderedSessionKey }
~~~

每次 Restart 产生下一代 AgentSession：

~~~text
generation starts at 1

canonical scope =
  explicit key: { runId, kind: "key", value: renderedSessionKey }
  local node:   { runId, kind: "node", value: nodeKey }

scopeDigest =
  SHA-256("acpus:agent-session-scope:v1\0" +
    JSON.stringify({ runId, kind, value }))

agentSessionId =
  "acpus-" +
  base64url(first 16 bytes of
    SHA-256("acpus:agent-session:v2\0" +
      JSON.stringify({ runId, scopeDigest, generation })))
~~~

原始 <code>sessionKey</code> 不作为内部主键；Runtime 只持久化安全的 scope digest 与
是否 explicit-shared。本文不新增 AgentSessionFamily/Conversation 实体；lineage 只是
AgentSession 的字段和唯一约束。Canonical object 的 key/order 固定，M2 用 golden
vectors 锁定 local/shared/generation identity。

### 5.3 关系不变量

- 一个 provider-dispatching Agent Attempt 在首个 prompt 前必须已有一条 immutable
  Attempt–Session binding。
- Session identity 尚未解析就失败的 Attempt 是 zero-turn/unbound startup failure；
  它不能伪造 Session 或 Turn。
- 同一 Attempt 的 response repair 继续使用同一 AgentSession 和同一 SessionLease，
  但创建新的 AcpTurn。
- 同一 AgentSession 任意时刻最多一个 SessionLease、一个 projection writer 和一个
  active AcpTurn。
- 一个 AcpTurn 的 event、terminal 与 cleanup evidence 只能归属一个 Attempt。
- Attempt fence 可以早于 physical settlement；它禁止 durable late write，但不声称
  Provider 或 process 已停止。
- SessionLease 只有在 capsule tree 已证明死亡后才释放；无法证明时 Session 进入
  quarantine。

## 6. 产品操作模型

### 6.1 不再让 Retry 隐式选择 Agent 语义

| 产品/内部动作 | 新 Attempt | AgentSession | 首个 Prompt | 前置 checkpoint |
| --- | --- | --- | --- | --- |
| Start | 是 | 新 S1 | authored | Session 尚不存在 |
| Continue | 是 | 同 S1 | continuation | <code>terminal_observed</code> |
| Safe retry | 是 | 同 S1 | 原 authored/steering prompt | <code>not_dispatched</code> |
| Restart | 是 | 新 S2 generation | authored | 旧 capsule 已 neutralized；显式选择放弃 continuity |
| Response repair | 否 | 同 S1 | repair | 前一 Turn completed 但 output contract 不合格 |
| Steer / <code>interrupt_continue</code> | 是 | 同 S1 | steering instruction | 先有 active proof；被替代 Turn 随后到达 <code>terminal_observed</code> |
| Steer / <code>in_place</code> | 否 | 同 S1、同 Attempt、同 Turn | injected user message | future capability |
| Queue active input | 否；若已在 active Attempt 内 accepted | 同 S1；通常下一 Turn | queued user message | future capability |

注意：

- Scheduler 的结构化 Retry 仍可用于 Task、frame 和依赖 reopening；它不再直接推导
  Agent prompt。
- Agent target 的 inspection/control surface 暴露 Continue 与 Restart，而不是一个
  含义不明的 Retry。
- Continue/Restart 复用现有 exact-target resolution 与 ancestor reopening planner；
  不复制一套 scheduler topology 算法，只在 Agent leaf 上增加 Session operation。
- Continue/Restart 只对 planner-approved 的 non-active Agent target 或 terminal run
  开放；active target 使用 Steer 或 Cancel。Inspection 必须在 mutation 前展示 Steer
  将采用的 delivery mode 与副作用，不能并发创建 replacement。
- Run-level Restart 会为本次重新执行涉及的 Session scope 创建新 generation。
- Safe retry 是 Runtime 基于 checkpoint 选择的窄动作，不是用户用来绕过不确定状态的
  “force retry”。
- Steer 不是 AgentSession operation：<code>interrupt_continue</code> delivery
  创建的 replacement Attempt 绑定为 Continue；<code>in_place</code> 不创建新 Attempt，
  因而也不新增 operation。
- Pause/Resume 也是 Scheduler lifecycle control，不是 Session operation：
  Resume 后由 checkpoint 选择 Safe retry 或 Continue；unknown 时保持 blocked。

Greenfield control wire 直接替换为：

~~~ts
type RuntimeControlIntent =
  | { type: "retry"; runId: string; target: string }     // Task/frame only
  | { type: "continue"; runId: string; target: string }  // Agent target
  | { type: "restart"; runId: string; target?: string }  // Agent target or whole run
  | { type: "steer"; runId: string; target: string; instruction: string }
  | { type: "pause" | "resume" | "cancel"; runId: string; target?: string }

type RuntimeSteerControlResult = Readonly<{
  type: "steer"
  steerId: string
  requestedTarget: string
  target: string
  delivery: "interrupt_continue" // M0–M5 closed current shape
  fencedAttemptId: string
  continuation: "queued"
}>
~~~

CLI/Web/inspection 使用相同 vocabulary：删除 Agent target 的 Retry 选项；run-level
<code>runs retry</code> 由 <code>runs restart</code> 替换，不保留 alias；Steer 继续使用
<code>runs steer</code>。M0–M5 的 help、inspection capability 与 success receipt 都必须
显示 “Steer delivery: Interrupt & Continue”，不能只返回泛化的 “steered”。

### 6.2 Steer 产品意图与 delivery mode

Steer 的产品 interface 固定为：对一个 active Agent target 提交 instruction；保持同一
AgentSession；目标是在最早安全的下一次 LLM 推理中纳入该 instruction；不承诺回滚
已经发生的工具、文件或远程副作用。Attempt 与 AcpTurn 是否变化由显式 delivery mode
决定。

控制调用的 success receipt 只表示 Steer 已 durable accepted，并不表示 instruction
已经进入 Provider request。当前 result 中 <code>delivery</code> 是交付策略，
<code>continuation="queued"</code> 是进度；<code>dispatch_intent</code> 也只表示 Runtime
即将跨越 external boundary。只有后续按 Provider evidence 写出的 in-flight/terminal
checkpoint 才能证明交付已越过该边界；ACP v1 没有独立的“模型已消费 instruction”证明，
因此 inspection 不伪造 applied 状态。

M0–M5 只有 <code>interrupt_continue</code>：

~~~text
SteerIntent(instruction)
  → persist delivery=interrupt_continue
  → supersede old Attempt
  → cancel and drain old AcpTurn
  → require terminal_observed
  → new Attempt(operation=continue, promptOrigin=steering)
  → next admitted provider prompt includes <steering>instruction</steering>
~~~

如果旧 Turn 在 hard cleanup 后仍没有可信 terminal，replacement 不得自动发送。
它返回 <code>session_checkpoint_unknown</code>，由用户选择 Inspect 或可用的 Restart。
本轮删除“steering instruction 在任意中断后至少一次重发”的过强承诺。

未来 <code>in_place</code> delivery 进入独立 capability Roadmap：

~~~text
SteerIntent(instruction)
  → persist delivery=in_place + message lifecycle
  → inject at next safe provider-inference boundary
  → same AgentSession / Attempt / AcpTurn
~~~

两种 delivery 的共同目标是“下一次被 admission 的推理包含新 instruction”，但
对 Agent Client/Runtime 并不等价：当前工具是否取消、partial output、Attempt deadline、
terminal attribution 和 recovery evidence 都不同。因此 planner 必须在 mutation 前解析
mode；inspection 展示 planned mode；receipt 和 durable event 记录 actual mode。Provider
不支持 <code>in_place</code> 时可以使用 <code>interrupt_continue</code>，但不能静默声称已在
active Turn 内注入。

Attempt 的创建原因是旧 Scheduler execution 已经被 fence/settle 并重新 admission，
不是因为产品动作叫 Steer。未来 <code>in_place</code> 只追加绑定到同一
<code>agentSessionId + attemptId + turnId</code> 的 durable message lifecycle，不修改
Attempt 的 frozen initial input，也不创建 replacement Attempt。

### 6.3 Shared Session Key

显式共享 <code>sessionKey</code> 表达作者希望多个 occurrence 共享一个 AgentSession。
策略固定为：

| 操作 | Shared Session 上的规则 |
| --- | --- |
| Continue | Session idle、binding compatible 且无其他 lease 时允许 |
| Safe retry | 仅目标 prompt 可证明未 dispatch 时允许 |
| Target-local Restart | 拒绝 <code>shared_session_restart_requires_run</code> |
| Run-level Restart | 整个 Run 使用一致的新 generation |
| Fork | Fork 的新 runId 自然创建独立 Session lineage |
| Local silent split | 永远禁止 |

Target-local Restart 既不会把共享组整体偷偷切到 S2，也不会只把目标从共享组摘除。

### 6.4 Restart 的保证边界

Restart 表示明确放弃旧 Agent history，并用 authored prompt 创建新 Session。它不承诺
回滚旧 Turn 已经发生的文件、命令或远程副作用。执行 Restart 前仍必须先 neutralize
本地旧 owner；如果旧 Provider 的远程副作用状态未知，inspection 必须展示该 evidence。

## 7. Session checkpoint

Runtime Store 是 operation eligibility 的权威；ACP projection 只负责 continuity 和
bounded audit，不反向推断 Scheduler 操作。

### 7.1 状态

| Checkpoint | 含义 | 丢失 owner 后允许的动作 |
| --- | --- | --- |
| <code>not_dispatched</code> | 尚未提交 dispatch intent；能证明不会有 Provider request | Safe retry 或 Restart |
| <code>dispatch_intent</code> | 已 durable 承诺即将调用 Provider，但尚无 acceptance evidence | 恢复时降为 <code>acceptance_unknown</code> |
| <code>owned_in_flight</code> | 当前 lease 持有 pending request；只表示本地 owner 仍在等待 | 不创建第二 Attempt；继续等待或取消 |
| <code>terminal_observed</code> | ACP terminal barrier 已接收并 drain admitted events | Continue、Restart 或本地 result recovery |
| <code>acceptance_unknown</code> | request 可能已发出，但没有 Provider evidence | 不自动 replay，也不 Continue |
| <code>terminal_unknown</code> | 已见 Provider activity，但 owner 丢失且未见 terminal | 不自动 Continue；Inspect 或显式 Restart |

<code>dispatch_intent</code> 和 <code>owned_in_flight</code> 都不是可复用 recovery
checkpoint。Owner/capsule 丢失时必须根据已持久化 evidence 转成
<code>acceptance_unknown</code> 或
<code>terminal_unknown</code>。

### 7.2 Dispatch checkpoint 顺序

~~~text
bind Attempt → AgentSession + operation
  → persist not_dispatched
  → persist fenced agent_invocation
  → persist dispatch_intent                 # before external call
  → call session/prompt
  → owned_in_flight
      first provider update / reverse request
        → provider acceptance evidence
      terminal barrier
        → terminal_observed

owner/transport/capsule loss after dispatch_intent, before provider evidence
  → acceptance_unknown

transport/capsule loss after provider evidence, before terminal
  → terminal_unknown
~~~

Dispatch intent 必须早于 external call 持久化。这样 crash 最多把一个实际未发送的
Prompt 保守地标成 unknown，不会把一个可能已发送的 Prompt 错标成
<code>not_dispatched</code> 并自动重发。本轮不尝试从普通 transport error 推断
“request 一定没有写出”。

调用 <code>session/prompt</code> 到首次 Provider evidence 之间无法获得 exactly-once
证明；Roadmap 不用本地 projection 中“已经追加 user message”伪装成 Provider
acceptance。

### 7.3 Operation planner

~~~text
planAgentOperation(control, session, checkpoint)
  if first materialization
    return Start(new session generation)

  if control is Continue and checkpoint is terminal_observed
    return Continue(same session)

  if runtime recovery and checkpoint is not_dispatched
    return SafeRetry(same session, exact original prompt)

  if control is Restart
    if session is explicit-shared and control is target-local
      return shared_session_restart_requires_run
    return Restart(new session generation)

  return session_checkpoint_unknown
~~~

Planner 是一个 pure module；mutation admission、inspection applicability 和 replay 都
调用同一实现，不能从 Attempt status 或 progress view 各自猜测。

## 8. 当前实现评审

### 8.1 应保留的深模块

<code>@acpus/acp</code> 已用很小的 <code>openAcpSession → runTurn/close</code>
interface 隐藏：

- stable ACP v1 initialize/new/resume/load；
- desired configuration replay；
- prompt/update fencing；
- permission、filesystem、terminal reverse RPC；
- tagged errors、provider monitor 与 deterministic cleanup；
- run-local continuity/audit projection。

Worker/process group 也有独立价值：

- detached process-group leader；
- provider 与 reverse terminal 可加入同一 PGID；
- manifest 记录 PID、start token、owner generation；
- Runtime 崩溃后的 residual cleanup；
- cooperative close 后 TERM/KILL/liveness proof；
- ACP host 崩溃不直接带走 workspace Runtime。

本轮深化它们的外层 interface，不把 protocol 或 process-tree 逻辑搬回 Runtime。

### 8.2 已确认问题

| 优先级 | 问题 | 当前证据 | 目标修复 |
| --- | --- | --- | --- |
| P0 | Parent policy timer 与 worker terminal 双重 settle | <code>managed-executor.ts</code> 的 <code>settleActive</code> 与 worker <code>turn-result</code> | coordinated single settlement |
| P0 | Execution metadata 缺少完整 attempt fence | <code>writeExecutionMetadata</code> 未统一验证 owner epoch/active lease | M0 fenced write |
| P0 | Retry/Resume/Steer intent、delivery 与 Session operation 混合 | <code>agent-node.ts</code> 由 <code>initialPrompt.kind</code> 直接选 prompt | durable binding + pure planner + explicit Steer delivery |
| P1 | Projection writer exclusion 依赖 scheduler normal path | 两个绕过 scheduler 的 host 可 load/rename 同一 record | supervisor lease + quarantine |
| P1 | Attempt、worker、connection、session 同寿命泄漏到 public interface | <code>ManagedAcpExecutor.withAttempt</code> | session-oriented lease |
| P1 | Attempt input 与 Turn request 重复 agent/cwd/env/model/session | executor public types | SessionIntent + TurnInput |
| P1 | Startup failure 被伪装成空 Turn failure | <code>unavailableAttempt</code> | typed acquire failure，callback 不执行 |
| P1 | Event 在 worker、parent、Runtime 多次累计 | cumulative IPC progress + Runtime reducers | event delta pipeline |
| P1 | authoritative observation sink failure 被吞 | best-effort callback <code>notify</code> | ordered typed sink |
| P1 | synthetic <code>turn_end</code> 与 <code>turn-result</code> 重复 terminal | worker protocol | one terminal channel |
| P1 | ACP error 在多层被压成 provider exit | worker failure mapping | preserve originating cause |
| P1 | <code>sessionName</code> 同时承担 ID、record、mutex、manifest、metadata | Runtime session resolver | canonical AgentSession identity + named fields |
| P1 | shared Session binding 只靠作者约定 | Runtime spec 明示不验证 | binding digest before spawn |
| P2 | process、transport、reducer、policy 混在 <code>managed-executor.ts</code> | file responsibility | internal capsule modules |

### 8.3 Writer exclusion 的准确风险级别

当前支持路径已有 single WorkspaceRuntime authority 与 scheduler session resource
admission，普通执行不会主动并发打开同一 record。因此它是 resource owner 缺口，不是
当前正常路径 P0。

本轮保证边界是：一个持有 workspace Runtime authority 的 WorkspaceRuntime 只创建一个
SessionSupervisor，所有 Agent execution 都经过它。跨 Runtime/跨进程共享 state root
不在本轮支持范围。Projection revision 或 atomic rename 不是锁，不用它们伪装 CAS。

## 9. 目标架构

~~~mermaid
flowchart LR
    Control["Continue / Restart / scheduler control"] --> Planner["Agent operation planner"]
    Planner --> Store[("Runtime Store\nAgentSession + Attempt binding + checkpoint")]
    Runtime["Runtime Agent Attempt"] --> Supervisor["AgentSessionSupervisor"]
    Store --> Runtime

    subgraph Supervisor
      Lease["exclusive Session lease"]
      Policy["deadline / inactivity / cleanup"]
      Reducer["event delta → partial/outcome"]
    end

    subgraph Capsule["internal ProcessCapsule"]
      Host["@acpus/acp AcpSession"]
      Provider["ACP Agent + reverse terminals"]
      Host --- Provider
    end

    Projection[("ACP continuity/audit projection")]
    Durable[("observations / progress / artifacts")]

    Lease --> Capsule
    Capsule -->|"event deltas + one terminal"| Reducer
    Reducer --> Runtime
    Host --> Projection
    Runtime --> Durable
~~~

### 9.1 Ownership matrix

| 事实或行为 | Owner |
| --- | --- |
| Workflow Agent selection、sessionKey rendering | Runtime |
| AgentSession materialization、generation、Attempt binding、operation planner | Runtime Store/Execution |
| Durable Attempt、deadline、owner epoch、late-write fence | Runtime Scheduler |
| Named/configured Agent resolution | Session supervisor |
| Session descriptor compatibility | Session supervisor + <code>@acpus/acp</code> projection |
| Session lease、busy/quarantine | Session supervisor |
| Worker/process group、manifest、hard cleanup | ProcessCapsule implementation |
| ACP initialize/new/resume/load/config/prompt/update | <code>@acpus/acp</code> |
| ACP continuity state与providerSessionId | <code>@acpus/acp</code> |
| Dispatch checkpoint | Runtime Store，按 supervisor evidence fenced 更新 |
| Event envelope sequence/time、partial outcome | Session supervisor parent reducer |
| Durable observation、progress、artifact、inspection | Runtime |
| Scheduler status mapping | Runtime 的一个 seam |

### 9.2 Durable schema shape

实际 SQL 名称可在 M2 type/schema review 时收窄，但 authority 与唯一约束固定：

~~~sql
agent_sessions
  agent_session_id       primary key
  run_id
  scope_digest
  generation
  explicit_shared
  lifecycle              active | abandoned | closed
  binding_digest         nullable until first compatible open
  projection_ref         nullable until ready
  checkpoint
  last_attempt_id
  last_turn_id
  created_at
  updated_at
  unique(run_id, scope_digest, generation)
  unique active row per (run_id, scope_digest)

agent_attempt_sessions
  attempt_id             primary key references node_attempts
  agent_session_id       references agent_sessions
  operation              start | continue | safe_retry | restart
  predecessor_attempt_id nullable
  source_control_event_seq nullable
  input_digest
  bound_checkpoint
  created_at
~~~

规则：

- 两张表只存 JSON/SQLite scalar，不序列化 Result；
- binding 和 checkpoint write 必须验证 exact Attempt、ownerEpoch、active Scheduler lease 与
  <code>started</code>；
- Attempt binding 一旦写入不可改绑；
- <code>source_control_event_seq</code> 连接 Continue/Restart/Steer 与
  durable control；operation 不从该 reason 反向推断；
- Safe retry 从 frozen input/steering directive 重建 exact prompt，并要求
  <code>input_digest</code> 与 predecessor invocation 相等；不新增第二份 raw prompt store；
- Restart 在一个 transaction 内把旧 active Session 标为 abandoned、创建下一
  generation、写 control event；cleanup 未 neutralize 旧 owner 时 transaction 不开始；
- projection path/provider identity 不再散落在每个 progress snapshot；
- raw sessionKey、ambient env、raw launch argv 或 secret-bearing value 不进入新表。

### 9.3 External interface

M3 最终 public shape：

~~~ts
type AttemptContext = Readonly<{
  runId: string
  nodeKey: string
  attemptId: string
  ownerEpoch: number
  deadlineAt?: string
  signal: AbortSignal
  inactivityFailAfterMs?: number
}>

type AgentSessionIntent = Readonly<{
  agentSessionId: string
  agent: AgentSelector
  cwd: string
  env: Readonly<NodeJS.ProcessEnv>
  permissionMode: AcpPermissionMode
  configuration: Readonly<{
    model?: string
    options: Readonly<Record<string, string>>
  }>
}>

type AgentTurnEvent = Readonly<{
  sequence: number
  observedAt: string
  elapsedMs: number
  event: AcpEvent
}>

type TurnInput = Readonly<{
  turnId: string
  prompt: string
  onEvent: (event: AgentTurnEvent) => Result<void, AgentEventSinkError>
}>

type AgentSessionLease = Readonly<{
  agentSessionId: string
  projectionRef: string
  runTurn(input: TurnInput): ResultAsync<AgentTurnOutcome, AgentTurnFailure>
}>

type AgentSessionUseError<E> =
  | Readonly<{ type: "acquire"; error: AgentSessionAcquireError }>
  | Readonly<{ type: "use"; error: E }>
  | Readonly<{ type: "cleanup"; error: AgentSessionCleanupError }>
  | Readonly<{ type: "use_and_cleanup"; use: E; cleanup: AgentSessionCleanupError }>

type AgentSessionSupervisor = Readonly<{
  withSessionLease<T, E>(
    input: { attempt: AttemptContext; session: AgentSessionIntent },
    use: (lease: AgentSessionLease) => ResultAsync<T, E>,
  ): ResultAsync<T, AgentSessionUseError<E>>

  shutdown(): ResultAsync<void, AgentSessionShutdownError>
}>
~~~

关键性质：

- acquire/open failure 不执行 callback；
- 相同 AgentSession 已 leased 时 fail-fast，不形成第二套 scheduler queue；
- AgentSession facts 只在 <code>AgentSessionIntent</code> 出现一次；
- response repair 的 TurnInput 只变化 prompt/turnId/sink；
- attempt deadline 覆盖 acquire、open、所有 Turn 与 callback；cleanup 使用
  package-owned bounded budget，不被已过期 attempt deadline 跳过；
- inactivity timer 只覆盖 active ACP turn；
- callback settle 后 lease 持有到 process-tree death proof；
- callback 与 cleanup 同时失败时保留两者；
- originating ACP/process/policy cause 与 partial reducer snapshot 不丢失；
- active-turn Queue 与 <code>in_place</code> delivery 不出现在本轮 interface。

### 9.4 Error vocabulary

Error tags are closed by boundary so implementation and inspection do not infer meaning from
messages:

| Boundary | Tagged errors |
| --- | --- |
| Operation planner | <code>session_checkpoint_unknown</code>、<code>shared_session_restart_requires_run</code>、<code>invalid_agent_operation_target</code> |
| Acquire/open | <code>session_busy</code>、<code>session_quarantined</code>、<code>session_binding_mismatch</code>、<code>ownership_state_unsupported</code>、<code>session_open_failed</code>、<code>policy_timeout</code>、<code>cancelled</code> |
| Turn | originating <code>AcpError</code>、<code>capsule_lost</code>、<code>event_sink</code>、<code>policy_timeout</code>、<code>inactivity_stale</code> |
| Cleanup/shutdown | <code>cleanup_failed</code>、<code>cleanup_unverified</code>、<code>shutdown_failed</code>，均携带 bounded evidence |
| Durable write | existing precise store fence/system errors，不压成 Agent failure |

<code>session_busy</code> 是短暂 ownership failure；
<code>session_quarantined</code> 在 residual identity proven dead 前不可重试；
binding mismatch 与 unsupported ownership shape 是 deterministic failure。
Recoverable boundary failures 使用 Result/ResultAsync；Result 对象不进入 IPC、SQLite、
artifact 或 projection。

### 9.5 Internal IPC

~~~text
parent → capsule
  open(session descriptor)
  run(turnId, prompt)
  cancel(turnId, policyReason)
  close(reason)

capsule → parent
  ready(session binding)
  event(turnId, AcpEvent)
  terminal(turnId, AcpTurnResult | AcpError)
  failed(process-host error)
  closed
~~~

不再跨 IPC 发送 cumulative response/tool/progress、synthetic terminal、重复
agent/cwd/env/model/session、<code>timeoutMs</code> 或 Runtime projection。

Parent 为通过 validation 的 event 按 Turn 从 0 生成 sequence；terminal 不占 sequence，
并且必须位于同一 ordered channel 中所有 admitted event 之后。

### 9.6 Terminal settlement

~~~text
lease acquired → opening → ready

ready → run → running

running
  provider terminal
    → terminal barrier
    → reduce exactly once
    → ready                         # repair may start another Turn

  deadline / inactivity / operator abort
    → record policy reason
    → send cancel once
    → cancelling                   # caller not settled yet

cancelling
  event → continue reduce + observe
  ACP terminal before cleanup deadline
    → settle once with policy + ACP evidence
    → dirty / closing
  cleanup deadline
    → TERM/KILL + liveness proof
    → settle once with policy + cleanup evidence
    → dirty / closing

host loss
  → reject old host identity
  → preserve partial reducer
  → cleanup/liveness proof
  → one capsule_lost terminal

callback settles
  tree proven dead → release Session
  live/unverified  → persist degraded evidence + quarantine Session
~~~

Runtime durable fence 与 physical settlement 分开。Fence 后 progress/artifact/result commit
被拒绝，但 observation module 仍可保留 post-fence evidence。

Terminal disposition：

| Authority | Supervisor outcome | Runtime |
| --- | --- | --- |
| ACP completed，无 policy | completed | completed |
| pause/cancel/lease loss | cancelled + ACP/cleanup evidence | cancelled |
| authored deadline | policy_timeout + evidence | timed_out |
| inactivity | inactivity_stale + silence evidence | failed |
| ACP error | complete originating AcpError | failed |
| capsule/IPC loss | capsule_lost + partial state | failed |
| event sink error | event_sink after cancel/drain + partial state | failed |
| acquire/open abort | zero-turn cancelled acquire | cancelled |
| acquire/open deadline | zero-turn policy_timeout | timed_out |
| busy/quarantine/binding mismatch | zero-turn acquire failure | failed |

### 9.7 Persistence boundary

本轮继续保留一个 <code>@acpus/acp</code> projection 文件：

~~~text
acp/sessions/<agent-session-id>.json
  AgentSession record id
  canonical cwd / launch identity
  session binding digest
  provider session id / capabilities
  desired configuration
  bounded semantic conversation
  last stop / usage
  timestamps
~~~

它负责 Provider continuity 与 bounded audit；Runtime SQLite 的 Attempt binding/checkpoint
负责 product operation eligibility。两者不能互相替代。

Projection 直接升级 current schema，不加 v1 reader/migration。它没有 revision/CAS；
writer exclusion 来自 supervisor lease、cleanup proof 与 single Runtime authority。

## 10. 交付依赖

~~~mermaid
flowchart LR
    M0["M0 metadata fence"] --> M2["M2 AgentSession authority"]
    M1["M1 single settlement"] --> M3["M3 supervisor + cold capsule"]
    M2 --> M3
    M3 --> M4["M4 delta event pipeline"]
    M4 --> M5["M5 binding + projection"]
    M5 --> F["Final gate"]
    F --> Q{"Queue / in-place Steer gate"}
    F --> W{"Warm reuse gate"}
~~~

默认顺序 M0 → M1 → M2 → M3 → M4 → M5。M0 与 M1 可以在不同分支独立开发，但
M2 合入前二者必须进入主线。每个 milestone：

- 保持 buildable；
- 直接替换受影响 current contract；
- 通过 narrow gate；
- 同步更新 owner spec；
- 不增加 dual interface、legacy reader 或 compatibility test。

## 11. M0：Fence attempt-scoped metadata

<strong>目标：</strong>先关闭与 supervisor 无关的 late metadata 写入缺口。

### Production changes

- 所有 production execution metadata 都是 attempt-scoped；删除 optional
  <code>attemptId</code> path。
- <code>WriteExecutionMetadataInput</code> 要求 runId、attemptId、ownerEpoch。
- 同一 SQLite transaction 验证 exact attempt、started、active owner epoch/lease。
- <code>execution_metadata.attempt_id</code> 直接改为 NOT NULL 并关联 Attempt。
- <code>writeExecutionMetadata</code> 返回 typed scheduler store result。
- Agent invocation/attempt 与 Task attempt caller 一起更新。
- fence/system rejection 不映射成 provider failure。
- 首个 <code>agent_invocation</code> 写成功后才允许 provider dispatch。

### Primary files

- <code>packages/runtime/src/store/store.ts</code>
- <code>packages/runtime/src/store/schema.ts</code>
- <code>packages/runtime/src/scheduler/store-port.ts</code>
- <code>packages/runtime/src/execution/agent-node.ts</code>
- <code>packages/runtime/src/execution/task-executor.ts</code>
- <code>specs/runtime-spec.md</code>

### Regression evidence

- stale owner、terminal Attempt、expired lease 都返回精确 fence error，且不新增 row；
- runId/attemptId mismatch 返回 attempt-not-found，不依赖 foreign-key error；
- metadata failure 发生在 Agent dispatch/Task spawn 前；
- execution failure 与 terminal metadata failure 同时出现时两者都保留。

### Narrow gate

~~~sh
pnpm --filter @acpus/runtime typecheck
pnpm test:integration packages/runtime/test/scheduler-store-fencing.integration.test.ts
pnpm test:integration packages/runtime/test/scheduler-store-schema.integration.test.ts
pnpm test:integration packages/runtime/test/task-executor-lifecycle.integration.test.ts
pnpm test:integration packages/runtime/test/agent-node.integration.test.ts
~~~

<strong>Exit：</strong>production caller 无法绕过 Attempt authority 写 execution metadata。

## 12. M1：Coordinated single settlement

<strong>目标：</strong>在改 public interface 前消除 parent/worker 双重 terminal。

### Production changes

- active turn 显式建模 running/cancelling/terminal/cleaning；
- deadline、inactivity、abort 只记录 policy reason、发送一次 cancel、启动一个总
  cleanup deadline，不立即 resolve；
- policy 后继续接收同 host/turn observation，直到 terminal barrier 或 verified loss；
- worker terminal、verified host loss、hard cleanup 是唯一 settlement boundary；
- policy/Provider terminal race 由 policy 决定 Runtime disposition，Provider result
  保留为 evidence；
- 暂时保留现有 cumulative IPC，隔离 settlement 风险与 M4 数据流重写。

### Primary files

- <code>packages/agent-executor/src/managed-executor.ts</code>
- <code>packages/agent-executor/src/worker-entry.ts</code>
- <code>packages/agent-executor/src/process-tree.ts</code>
- <code>packages/agent-executor/test/fixtures/minimal-acp-agent.mjs</code>
- <code>specs/agent-executor-spec.md</code>

### Regression evidence

- cancel 后最后一个 update 仍到达，只产生一个 terminal；
- Provider 忽略 cancel 时，单一 cleanup deadline 后 TERM/KILL，保留 partial state；
- terminal/deadline 同 tick 使用确定 precedence；
- inactivity activity reset 与 silence evidence 精确；
- callback/notification throw 不能跳过 cleanup。

### Narrow gate

~~~sh
pnpm --filter @acpus/agent-executor typecheck
pnpm test:unit packages/agent-executor/test/managed-executor.unit.test.ts
pnpm test:integration packages/agent-executor
~~~

<strong>Exit：</strong>policy timer 与 worker terminal 不再竞争 resolve。

## 13. M2：建立 AgentSession authority 与 operation planner

<strong>目标：</strong>先在 Runtime 持久化 Session/Attempt 关系与产品语义；底层暂时仍可
使用当前 managed executor。

### Production changes

- 新增 <code>agent_sessions</code> 与 <code>agent_attempt_sessions</code> current schema；
- 把 <code>sessionName</code> 重命名为 <code>agentSessionId</code>，identity 加入
  generation；
- 实现唯一 canonical identity helper 与 golden vectors，不在 Store、Execution、
  inspection 各自计算 hash；
- 用一个 pure planner 生成 Start/Continue/Safe retry/Restart；
- Attempt binding 与 checkpoint update 全部 fenced；
- binding 后初始化 <code>not_dispatched</code>；external call 前先写
  <code>dispatch_intent</code>，之后按 Provider evidence 写
  in-flight/terminal/unknown；
- Agent target inspection/control 对 idle/terminal target 暴露 Continue 与 Restart，对
  active target 暴露 Steer 与 Cancel；Steer capability 同时返回 planned delivery；
- Task/frame 继续使用结构化 Retry；Agent prompt 不再由 attemptNo/start reason 推导；
- run-level Restart 创建一致的新 Session generation；
- run-level Restart transaction 为该 run 已 materialize 的每个 scope 创建下一
  generation 并切换 active row；尚未出现过的 dynamic scope 后续从 generation 1
  materialize，因为它没有可放弃的旧 continuity；
- explicit shared Session 的 local Restart 在 mutation 与 inspection 两侧都被同一
  planner 拒绝；
- M0–M5 的 Steer planner 只返回 <code>delivery=interrupt_continue</code>；旧 Turn
  terminal 后才 bind Continue Attempt；
- 保留 <code>type=steer</code>、<code>runs steer</code>、<code>steerId</code>、
  <code>control.agent_steer_requested</code>、steering prompt origin 与现有 durable
  directive identity；control result、inspection 和 event payload 新增 closed
  <code>delivery=interrupt_continue</code>；
- CLI help 与 text/JSON receipt 明示当前 Attempt 会 cancel/drain、Session continuity
  保留、已有副作用不回滚；不得使用暗示 in-place delivery 的文案；
- unknown checkpoint 不自动 Continue/replay；
- Safe retry 绑定 predecessor/inputDigest，重建 prompt 后先校验 exact digest；
- update daemon protocol、runtime contracts、inspection 与 Forensics vocabulary；
- 删除仅验证“retry 总会恢复同 Session 并选择某个 prompt”的旧测试。

### Implementation order inside M2

以下是同一 feature branch 内的构建顺序；M2 只有一个 merge boundary，步骤 1–2
不会作为同时支持旧/新 control 的发布状态：

1. 先提交 pure identity/planner module、golden vectors 与 Store schema/transaction tests；
2. 接入 Attempt binding/checkpoint writer，但暂不改变 external control；
3. 在一个 atomic switch 中替换 scheduler control wire、node-executor prompt selection 与
   daemon protocol，随即删除 Agent retry/run-retry old variants；
4. 同一 changeset 更新 inspection、CLI、Web、DSH generated artifacts 与 owner spec；
5. 最后跑 replay tests，确认历史 event 已按新 current schema 生成而不是兼容读取旧
   event。

### Primary files

- <code>packages/runtime/src/execution/agent-session.ts</code>
- <code>packages/runtime/src/execution/agent-node.ts</code>
- <code>packages/runtime/src/store/schema.ts</code>
- <code>packages/runtime/src/store/store.ts</code>
- <code>packages/runtime/src/store/scheduler-store.ts</code>
- <code>packages/runtime/src/scheduler/events.ts</code>
- <code>packages/runtime/src/scheduler/advance.ts</code>
- <code>packages/runtime/src/scheduler/control.ts</code>
- <code>packages/runtime/src/scheduler/node-executor.ts</code>
- <code>packages/runtime/src/scheduler/store-port.ts</code>
- <code>packages/runtime/src/scheduler/steer-plan.ts</code>
- <code>packages/runtime/src/runs/use-cases.ts</code>
- <code>packages/runtime/src/inspection/use-cases.ts</code>
- <code>packages/runtime/src/inspection/types.ts</code>
- <code>packages/runtime/src/runtime-contracts.ts</code>
- <code>packages/runtime/src/daemon/protocol.ts</code>
- <code>packages/cli/src/runs/command.ts</code>
- <code>packages/cli/src/runs/controls.ts</code>
- <code>packages/cli/src/presentation/output.ts</code>
- <code>packages/web/src/api-types.ts</code>
- <code>packages/web/src/client/ui/RunControls.tsx</code>
- <code>packages/web/src/server/routes/inspection-controls.ts</code>
- <code>packages/dsh/src/remote/types.ts</code>
- <code>specs/runtime-spec.md</code>

### Regression evidence

- Start creates S1/A1 binding；Continue creates A2→S1；Restart creates A3→S2；
- local/shared scope 与 generation 的 golden vectors 固定 agentSessionId；
- binding immutable，Attempt 不能改绑；
- shared key 两个 occurrence 绑定相同 S1；
- shared target-local Restart 返回
  <code>shared_session_restart_requires_run</code> 且不追加 event；
- run-level Restart 为所有 scope 使用新 generation；
- <code>not_dispatched</code> 只允许 exact Safe retry；
- dispatch-intent 与 external call 之间 crash 后稳定成为 acceptance_unknown，不会
  自动 replay；
- Safe retry prompt digest mismatch 在 dispatch 前返回 deterministic failure；
- acceptance/terminal unknown 不暴露 Continue；
- mutation 与 inspection 对每个 checkpoint 返回完全相同 applicability；
- scheduler replay 不重新解释历史 operation；
- Steer 的 <code>interrupt_continue</code> delivery 在 cancel terminal 前不 admission；
- accepted control 依次持久化 Steer intent、<code>delivery=interrupt_continue</code>、old
  Attempt fence、terminal barrier 与新 Continue Attempt；
- inspection 与 receipt 都显示 “Steer delivery: Interrupt & Continue”；M0–M5 不声称
  支持 <code>in_place</code>；
- Session resolution failure 产生 unbound zero-turn Attempt，不伪造 record；
- CLI、Web 与 DSH generated remote types 暴露 Continue/Restart/Steer，且 Steer result
  要求 closed delivery；不残留 Agent retry 或 run-level retry alias。

### Narrow gate

~~~sh
pnpm --filter @acpus/runtime typecheck
pnpm --filter acpus typecheck
pnpm --filter @acpus/web typecheck
pnpm --filter @acpus/dsh typecheck
pnpm --filter @acpus/dsh remote:check
pnpm test:unit packages/runtime/test/agent-session.unit.test.ts
pnpm test:unit packages/runtime/test/agent-operation-plan.unit.test.ts
pnpm test:unit packages/runtime/test/scheduler-steer-plan.unit.test.ts
pnpm test:integration packages/runtime/test/scheduler-store-schema.integration.test.ts
pnpm test:integration packages/runtime/test/scheduler-store-fencing.integration.test.ts
pnpm test:integration packages/runtime/test/agent-node.integration.test.ts
pnpm test:integration packages/runtime/test/runtime-controls.integration.test.ts
pnpm test:contract packages/runtime/test/daemon-protocol.contract.test.ts
pnpm test:contract packages/cli/test/runs-steer.contract.test.ts
pnpm test:contract packages/cli/test/output.contract.test.ts
pnpm test:unit packages/web/test/app-controls.unit.test.ts
~~~

<strong>Exit：</strong>任一 Agent Attempt 的 Session、generation、operation 和 checkpoint
均可由 durable store 精确回答；“Retry”不再隐式决定 Agent prompt。

## 14. M3：Session Supervisor + cold capsule

<strong>目标：</strong>把 external seam 从 managed Attempt/process 移到 AgentSession，
保持一 lease 一 cold capsule。

### Production changes

- 用 <code>createAgentSessionSupervisor</code>、AgentSessionIntent、AttemptContext、
  AgentSessionLease、TurnInput 替换 ManagedAcpExecutor surface；
- supervisor 以 agentSessionId 管理 available/leased/quarantined；
- lease 在 Agent resolution 前取得，覆盖 resolution、open、callback、cleanup；
- 每个 lease 创建 internal ProcessCapsule；PGID/manifest/TERM/KILL 不进入 public type；
- WorkspaceRuntime 在取得 authority 后创建一个 supervisor，并在所有 Agent execution
  与 shutdown 间共享；
- factory 内完成 bounded startup ownership recovery；删除 Runtime pre-call
  <code>recoverAcpOwnership</code>；
- manifest current schema 保存 agentSessionId、sessionLeaseId、hostId、run/attempt、
  Runtime owner generation、PID/start token/PGID、degraded evidence；
- unsupported manifest 使 factory fail closed，不猜测归属或杀进程；
- quarantined acquire 只做一次 bounded session-local liveness revalidation；
- open failure typed 返回，callback 不执行；删除 unavailableAttempt；
- ready 后才开始 observation/agent_invocation；
- callback 后 tree death proof 才 release，否则 cleanup error + quarantine；
- shutdown 停止 admission，并行清理所有 lifecycle phase，共享 bounded policy；
- 删除旧 public types、request duplication、fake startup tests。

### Target internal files

~~~text
packages/agent-executor/src/
├── session-supervisor.ts
├── process-capsule.ts
├── worker-entry.ts
├── worker-protocol.ts
├── agent-resolution.ts
└── ownership.ts
~~~

### Regression evidence

- 相同 AgentSession 第二 acquire 在 spawn 前 session_busy；不同 Session 并行；
- open failure/open-time abort/ready race 不执行 callback；
- cleanup 期间不可 acquire，death proof 后可再次 acquire；
- degraded/unverified residual 在同进程与 Runtime restart 后 quarantine；
- malformed manifest 使 factory fail closed；
- revalidation 只在所有 identity proven dead 时解除 quarantine；
- factory recovery 前拿不到 supervisor；
- shutdown 中新 acquire 稳定 closed，现有 lease 并行 cleanup；
- repair 在同一 lease 多 Turn；Continue/Safe retry 用新 lease/cold capsule恢复同一 S1；
- AgentSession ID 与 ProcessCapsule hostId 永不混用。

### Narrow gate

~~~sh
pnpm --filter @acpus/agent-executor typecheck
pnpm --filter @acpus/runtime typecheck
pnpm test:type packages/agent-executor
pnpm test:contract packages/agent-executor
pnpm test:unit packages/agent-executor
pnpm test:integration packages/runtime/test/agent-node.integration.test.ts
pnpm test:integration packages/runtime/test/acp-ownership-health.integration.test.ts
~~~

<strong>Exit：</strong>Runtime 不再理解 worker topology；startup、lease exclusion、
physical cleanup 由 SessionSupervisor 完整表达。

## 15. M4：Delta event pipeline

<strong>目标：</strong>transport 只传事实，每个 projection 有一个 owner reducer。

### Production changes

- IPC 直接升级 current version：event 只携带 turnId+AcpEvent，terminal 只携带
  AcpTurnResult|AcpError；
- child 在 ordered IPC 中把 terminal 放在 admitted events 后；
- terminal 后 event、重复 terminal、错误 turnId 是 protocol/capsule failure；
- parent 生成 sequence/observedAt/elapsedMs；
- parent pure reducer 生成 responses、completed-only final response、tools、usage、
  timing、acpEventCount 与 partial state；
- Runtime progress 与 semantic observation 消费同一 event envelope；
- durable fence 后继续收 evidence，但不再 progress/artifact/result commit；
- event 顺序：validate → envelope → parent reduce → authoritative Runtime sink；
- sink 首个 Err 被 latch，随后 cancel/drain，最终 event_sink failure；
- 删除 cumulative IPC、synthetic turn_end、重复 JSON vocabulary、dead stderr、
  per-turn projection path；
- preserve complete ACP error；只在 Runtime scheduler seam map 一次。

### Primary files

- <code>packages/agent-executor/src/worker-protocol.ts</code>
- <code>packages/agent-executor/src/worker-entry.ts</code>
- <code>packages/agent-executor/src/runtime-event.ts</code>
- <code>packages/agent-executor/src/turn-responses.ts</code>
- <code>packages/runtime/src/progress/agent.ts</code>
- <code>packages/runtime/src/observations/log.ts</code>
- <code>packages/runtime/src/observations/turn-semantics.ts</code>
- <code>packages/runtime/src/execution/agent-node.ts</code>

### Regression evidence

- N events 产生 N deltas，payload 不随累计 response 二次增长；
- response segmentation/final candidate 与 current stable contract 相同；
- provider loss/cancel/inactivity 保留 partial response/tool/usage；
- terminal 不增加 provider event count；
- terminal barrier 前 event 全部有序进入 reducer/sink；
- sink 第 N 个 event 失败只产生一个 event_sink failure并保留 1..N partial state；
- unknown/session/client-activity/cost 不经 stringify/parse 二次压缩；
- Pi 无 telemetry 时 unavailable，其余 Agent usage 保持。

### Narrow gate

~~~sh
pnpm --filter @acpus/agent-executor typecheck
pnpm --filter @acpus/runtime typecheck
pnpm test:unit packages/agent-executor
pnpm test:contract packages/agent-executor
pnpm test:unit packages/runtime/test/agent-progress.unit.test.ts
pnpm test:unit packages/runtime/test/agent-observation-semantics.unit.test.ts
pnpm test:integration packages/runtime/test/agent-observation-store.integration.test.ts
pnpm test:integration packages/runtime/test/agent-node.integration.test.ts
~~~

<strong>Exit：</strong>IPC 没有 Runtime read model；terminal fact 只有一个 channel。

## 16. M5：Session binding 与 projection current schema

<strong>目标：</strong>共享 Session compatibility 由产品验证，并让 Runtime checkpoint 与
ACP projection 边界一致。

### Production changes

- supervisor resolution 后计算 session binding digest；canonical shape 固定为
  launch、canonical cwd、effective model、sorted string options；
- canonicalization 只有一个实现与 golden vectors；
- env、permission、Attempt/Run identity 不进入 digest；
- <code>openAcpSession</code> 接受 expected agentSessionId/binding digest；
- <code>@acpus/acp</code> 在 provider spawn 前验证 projection；
- projection 直接替换 current schema，使用 agentSessionId，不读取旧 shape；
- mismatch 返回 typed <code>session_binding_mismatch</code> 与安全 category，不回显
  argv/env/secret；
- 同 Session model/options immutable；不依赖 set_config_option 的偶然可变行为；
- 调整 projection 写入顺序：本地 audit 中追加 user message 不作为 Provider acceptance
  evidence；
- Runtime checkpoint 只由 dispatch/Provider event/terminal evidence fenced 更新；
- 更新 advanced authoring：shared key compatibility 从作者约定变成 Runtime failure。

### Primary files

- <code>packages/acp/src/types.ts</code>
- <code>packages/acp/src/session.ts</code>
- <code>packages/acp/src/persistence.ts</code>
- <code>packages/agent-executor/src/session-supervisor.ts</code>
- <code>packages/runtime/src/execution/agent-node.ts</code>
- <code>packages/cli/skills/acpus/references/advanced-authoring.md</code>
- <code>specs/acp-spec.md</code>
- <code>specs/agent-executor-spec.md</code>
- <code>specs/runtime-spec.md</code>

### Regression evidence

- same Session + equal descriptor 恢复原 providerSessionId；
- launch/cwd/model/options 任一 mismatch 在 spawn 前失败；
- option key order 不改变 digest；env/permission/Attempt 变化不改变 digest；
- projection 不含 ambient env、raw argv 或新增 secret；
- invalid/mismatched current projection 保持文件不变；
- old projection 作为 unsupported current shape 直接失败；
- Runtime restart 后 binding/checkpoint enforcement 仍生效；
- projection user message 不能单独把 acceptance_unknown 提升为 accepted。

### Narrow gate

~~~sh
pnpm --filter @acpus/acp typecheck
pnpm --filter @acpus/agent-executor typecheck
pnpm --filter @acpus/runtime typecheck
pnpm test:unit packages/acp
pnpm test:integration packages/acp
pnpm test:contract packages/acp
pnpm test:integration packages/agent-executor
pnpm test:integration packages/runtime/test/agent-node.integration.test.ts
pnpm check docs
~~~

<strong>Exit：</strong>AgentSession compatibility、continuity projection 与 Runtime
operation checkpoint 各有单一 owner，且在恢复后仍可验证。

## 17. 后续决策门

### 17.1 Active-turn Queue / in-place Steer delivery

不属于 M0–M5。创建后续 Roadmap 前必须具备至少一个真实 Provider capability 与
端到端测试，并用文本 show-me 展示：

- Queue 与 Steer 的不同交付语义；
- accepted → delivered → applied/terminal message lifecycle；
- messageId/idempotency 与 transport timeout 去重；
- reconnect 后 active/idle 与 queued message reconciliation；
- cancel active turn 是否保留 queued messages；
- terminal attribution：<code>in_place</code> 不创建第二个 Attempt 或 AcpTurn；Queue 若在
  active Attempt settle 前 accepted，保持该 Attempt，但可在 idle 后创建下一 AcpTurn；
- delivery selection：Provider capability 支持时同一个产品 Steer 可选择
  <code>in_place</code>；否则继续使用 <code>interrupt_continue</code>，planned/actual mode
  必须可见；
- multi-client ordering（若纳入范围）。

没有 capability 时，<code>runs steer</code> 仍可用，但只提供
<code>interrupt_continue</code>：先 cancel/drain 到 terminal，再创建 Continue Attempt，
不能伪装成消息已注入 active Turn。

### 17.2 Warm host reuse

M5 后收集 supported Agent 的 spawn/initialize/resume wall time。只有冷启动已证明是主要
瓶颈，并且 clean handoff 可验证时，才创建 warm reuse Roadmap。该设计必须展示：

- host state machine 与 generation；
- attempt-scoped env 处理；
- idle retirement；
- reverse RPC pending work；
- provider health；
- shutdown/recovery ownership；
- 收益数据。

永久停在 cold capsule 是完整结果，不是未完成。

## 18. Greenfield delivery rules

- 直接替换 ManagedAcpExecutor interface；
- 直接升级 IPC、manifest、projection、daemon control current schema；
- 删除旧 codec/reader/adapter/tests，不保留 dual behavior；
- schema 变化不增加 migration、fallback、warning 或 compatibility shim；
- specs 只描述新的 current behavior，不记录迁移历史；
- 每次改 spec/test/Skill guidance 前分别遵循
  [Specification Maintenance](../specification-maintenance.md)、
  [Testing Maintenance](../testing-maintenance.md)、
  [Skill Maintenance](../skill-maintenance.md)；
- 每个 public package/schema replacement 在对应 milestone 更新 changeset 与 generated
  artifacts。

## 19. Final integration gate

Milestone evidence 放在最低稳定 interface，不在 unit/integration/e2e 重复同一断言。
M5 后运行：

~~~sh
pnpm build
pnpm test
pnpm typecheck
pnpm test:dist
pnpm check docs
~~~

Real Agent smoke 是 release evidence，不替代 hermetic tests：

| Agent | Normal | Continue/Restart | Steer (<code>interrupt_continue</code>) | Failure |
| --- | --- | --- | --- | --- |
| Claude | multi-turn + context/token | terminal Continue；new-generation Restart | cancel/drain 后同 Session steering prompt | timeout/cancel 后 checkpoint 精确 |
| Pi | multi-turn，telemetry unavailable | resume/load Continue；Restart | old Attempt terminal 后 replacement Attempt | no old process |
| Codex（显式 model） | multi-turn + usage | terminal Continue；Restart | receipt 明示 Interrupt & Continue delivery | dirty Attempt 不复用 host |
| Trae（显式 model） | multi-turn + usage | terminal Continue；Restart | same Session、new Attempt/Turn | dirty Attempt 不复用 host |

每次 smoke 记录 Agent version/launch、model、agentSessionId、generation、operation、
resume/load、projectionRef、terminal disposition 与 residual ownership health；不保存
prompt/output secret 或 raw ACP wire。

额外 shared-session smoke：

1. 两个 occurrence 使用同一 explicit sessionKey，串行绑定 S1；
2. 第二 occurrence Continue 成功；
3. target-local Restart 被拒绝且无 Provider spawn；
4. run-level Restart 后两者统一使用 S2；
5. binding mismatch 在 spawn 前失败。

## 20. 已冻结决策

| 决策 | 结论 | 直接后果 |
| --- | --- | --- |
| Canonical identity | AgentSession；不新增 Conversation | sessionKey 只是 scope input |
| Attempt:Session | 每个 dispatching Attempt 恰好绑定一个 Session；Session 1:N Attempt | durable binding 必须可查询 |
| Retry semantics | 拆成 Continue、Safe retry、Restart | control reason 不再直接选 prompt |
| Continue | 同 Session，新 Attempt，新 Turn，terminal-only | unknown checkpoint 不可强制 |
| Restart | 新 Session generation + authored prompt | 明确放弃旧 continuity |
| Shared local Restart | 拒绝 | 使用 run Restart 或 Fork |
| Steer intent | 产品/CLI 保留 <code>steer</code>；同 Session 的下一次安全 LLM 推理纳入 instruction | Attempt/Turn 变化不是产品 identity |
| M0–M5 Steer delivery | 仅 <code>interrupt_continue</code>；cancel/drain 后创建 replacement Continue Attempt | inspection/receipt/event 明示 mode 与副作用 |
| Active Queue / <code>in_place</code> delivery | 延后独立 capability Roadmap | 未来不改变 <code>runs steer</code>；<code>in_place</code> 保持同 Attempt/Turn |
| Response repair | 同 Attempt/Lease/Session 的额外 Turn | 不创建新 Attempt |
| Worker | internal ProcessCapsule | process identity 不进入产品模型 |
| Topology | SessionSupervisor + cold capsule | M0–M5 完成即完整交付 |
| Lease collision | fail-fast session_busy | scheduler 仍是 normal admission owner |
| Cleanup unknown | quarantine Session | degraded host 与新 writer 不并存 |
| Terminal authority | coordinated single settlement | timer 不直接 resolve |
| Event transport | delta + one terminal | 删除 cumulative/synthetic terminal |
| Event sink | ordered typed sink | failure 可见并 cancel/drain |
| Projection | one current file | 不加 revision/CAS/compat reader |
| Session binding | launch+cwd+model/options immutable equal | mismatch pre-spawn |
| Attempt env | 本轮保留 | cold capsule 无 stale process env |
| Metadata/checkpoint | 全部 Attempt-fenced | 无 optional authority path |
| Warm reuse | 独立决策门 | 无证据时保持 cold |

实施中若新证据推翻任何结论，暂停受影响 milestone，并用文本 show-me 展示 current
shape、候选 shape、状态迁移与上下游影响后请求决策，不在实现中暗自引入第三套语义。

## 21. 完成定义

M0–M5 全部满足以下条件才完成：

1. Runtime 只通过 AgentSession-oriented supervisor 调用 Agent executor，不理解 worker
   topology。
2. AgentSession 是唯一会话身份；没有额外 Conversation entity 或含义重叠的
   sessionName。
3. 每个 provider-dispatching Agent Attempt 都有 immutable AgentSession/operation
   binding；zero-turn pre-identity failure 明确 unbound。
4. Start、Continue、Safe retry、Restart 与 response repair 的 prompt/checkpoint 规则
   由一个 pure planner 决定，mutation/inspection/replay 一致。
5. M0–M5 的 <code>runs steer</code> 只采用可见的
   <code>delivery=interrupt_continue</code>；queued receipt 只表示 accepted，旧 Turn 未到
   terminal 前不 dispatch replacement，Provider evidence 之前不声称 instruction 已应用。
6. explicit shared Session target-local Restart 被拒绝；run Restart 使用统一新 generation。
7. unknown acceptance/terminal 不会自动 replay 或 Continue。
8. 同 Session 在 supervisor 严格排斥；cleanup 未证明时 Runtime restart 也保持
   quarantine。
9. startup acquire failure 不执行 callback，不生成 invocation、Turn 或 Turn artifact。
10. deadline/cancel/inactivity/provider terminal/capsule loss race 只产生一个 outcome，
   保留 admitted evidence。
11. IPC 只传 ACP event delta 与一个 terminal；没有 cumulative progress、
    synthetic turn_end 或 Runtime projection。
12. Supervisor outcome、Runtime progress、durable semantic observation 各有一个 owner
    reducer。
13. Metadata、Session binding/checkpoint、artifact、progress、result commit 都验证 exact
    Attempt、ownerEpoch、active lease 与 started。
14. Projection current schema pre-spawn 验证 Session binding；无旧 reader/migration。
15. Process ownership、start-token recovery、TERM/KILL、quarantine、Doctor evidence 有
    hermetic coverage。
16. ACP error origin/operation/code/retryability 与 cleanup evidence 穿过 executor，只在
    Runtime 映射一次。
17. M0–M5 narrow gates、全仓 gate、Four-Agent smoke、shared-session smoke 全部通过。
18. Owner specs、实现导览、Skill guidance、changeset、generated artifacts 已更新，旧
    interface/tests 删除。
19. 稳定结论已进入 owner specs，本文与 roadmap index entry 随完成提交删除。

## 22. 关键代码导航

| 关注点 | 当前入口 |
| --- | --- |
| Session identity | [agent-session.ts](../../packages/runtime/src/execution/agent-session.ts) |
| Agent prompt/repair/metadata/artifact | [agent-node.ts](../../packages/runtime/src/execution/agent-node.ts) |
| Scheduler control/store | [scheduler-store.ts](../../packages/runtime/src/store/scheduler-store.ts) |
| Scheduler operation/control types | [store-port.ts](../../packages/runtime/src/scheduler/store-port.ts) |
| Steer intent/delivery planner | [steer-plan.ts](../../packages/runtime/src/scheduler/steer-plan.ts) |
| Runtime DB/schema | [store.ts](../../packages/runtime/src/store/store.ts)、[schema.ts](../../packages/runtime/src/store/schema.ts) |
| Workspace supervisor lifetime | [workspace-runtime.ts](../../packages/runtime/src/workspace-runtime.ts) |
| Current managed executor | [managed-executor.ts](../../packages/agent-executor/src/managed-executor.ts) |
| Worker bridge | [worker-entry.ts](../../packages/agent-executor/src/worker-entry.ts) |
| Worker IPC | [worker-protocol.ts](../../packages/agent-executor/src/worker-protocol.ts) |
| Process ownership | [ownership.ts](../../packages/agent-executor/src/ownership.ts)、[process-tree.ts](../../packages/agent-executor/src/process-tree.ts) |
| ACP session lifecycle | [session.ts](../../packages/acp/src/session.ts) |
| ACP projection | [persistence.ts](../../packages/acp/src/persistence.ts) |
| Runtime progress | [progress/agent.ts](../../packages/runtime/src/progress/agent.ts) |
| Durable observation | [log.ts](../../packages/runtime/src/observations/log.ts) |
| Semantic reducer | [turn-semantics.ts](../../packages/runtime/src/observations/turn-semantics.ts) |
| Current implementation guide | [ACP Session Runtime](../acp-session-runtime.md) |
