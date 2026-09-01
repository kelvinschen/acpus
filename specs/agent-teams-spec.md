# Agent Teams SPEC

## 目的

`@acpus/agent-teams` 为一个工作区内的固定 lead 和多个独立 ACP teammate 提供动态协作边界：成员通过 CLI 共享任务与依赖、原子领取工作、交换定向消息，并保留可检查的协调轨迹。[Agent Executor](agent-executor-spec.md) 负责每个成员的 ACP Session 租约与收尾；[Runtime](runtime-spec.md) 的 Workflow 编排语义不参与 team 推进。

## 要求

- 每个 team MUST 在生命周期内保持唯一且固定的 lead；只有 lead 可以增加 teammate，teammate MUST NOT 创建嵌套 team 或转移 lead 身份。
- `ACP_TEAM_MEMBER` MUST 只被视为可信本地协作中的路由身份；CLI MUST 根据该身份查询 member role 并执行 fixed-lead supported-interface check，但产品 MUST NOT 把环境变量、role check 或消息归属描述成不可伪造身份、授权边界或 adversarial member isolation。
- 每个 Agent Teams SQLite state database MUST 只属于一个 team；在已有 team 的数据库中创建第二个 team MUST 以冲突失败，且不得修改既有 team。
- 在 POSIX 本地部署中，state database entry MUST 是普通非 symlink 文件并设为 owner-only `0600`；managed ACP worker/session directory MUST 是真实非 symlink 目录并设为 `0700`。这些文件模式 MUST NOT 被描述成同一 OS user 下的成员隔离或 actor 认证。
- 每个成员 MUST 使用独立的 Agent Executor 租约与 ACP Session；一个成员的上下文、Turn 或 Session 所有权 MUST NOT 被其他成员共享。
- 一个 team run 的所有成员 MUST 使用该 run 选择的同一个 ACP provider 与 model；不同 team run MAY 选择不同的已配置 agent。
- 当前 MVP MUST 为所有成员使用 `permissionMode: "approve-all"`，且只支持调用者提供的可信隔离工作区；产品 MUST NOT 声称支持交互审批、lead 代批、逐成员 permission policy 或恶意成员隔离。
- 当前产品 MUST 由单一前台 host 持有所有活跃成员租约；只读或写入协调状态的 CLI 调用 MUST NOT 启动后台 host、替代当前 host 或自行获取成员租约。
- CLI 的 `wait` MUST 只读取权威协调状态，并在全部共享任务完成、team 终止或达到调用方超时后返回；等待本身 MUST NOT 修改任务、推进 wake generation 或启动 Agent Turn。
- 每个成员同一时间 MUST 至多有一个活跃 Turn。Turn 开始时 MUST 固定本轮处理的 wake generation；Turn 进行期间到达的新 wake MUST 留待后续 Turn，MUST NOT 因当前 Turn 收尾而被误标为已处理。
- 全队 `maxTurns` MUST 在创建 Turn 的同一个 SQLite 写事务中统计并准入；达到预算后的并发 Turn start MUST 失败且不得创建 Turn 或推进 member 状态。
- 任务领取 MUST 在同一个原子操作中确认任务尚未被领取、状态允许领取且全部依赖已经完成；竞争领取只能有一个调用方成功，失败的竞争方 MUST 获得冲突结果，MUST NOT 覆盖获胜方状态。
- 任务依赖 MUST 引用同一 team 中的现存任务并保持无环；非法依赖变更 MUST 整体失败。依赖未全部完成的任务 MUST NOT 进入执行中状态。
- supported teammate spawn MUST 在同一事务中创建 member、绑定指定 pending task 并写入首轮 direct guidance；任一输入非法时 MUST NOT 留下 member、task assignment 或 message 的部分状态。
- 只有实际领取任务的成员可以将其标为完成，并且 MUST 同时提交非空的结果证据。成员执行失败时，其尚未完成的领取任务 MUST 原子释放为可重新领取状态，并唤醒固定 lead 处理失败。
- mailbox direct message MUST 具有同一 team 内的现存发送成员和现存接收成员。消息只有成功提交后才算已发送，每个成员 MUST 仅按稳定顺序观察明确发给自己的消息。来自其他 Agent 的消息 MUST NOT 被解释为用户授权。
- 已接受的 team create/complete/fail、member spawn/fail/stop/nudge、task create/claim/complete、direct message send 与 Turn start/finish/cancel MUST 与描述结果的 trajectory event 原子提交；接受的 ACP observation MUST 追加自己的 event，被拒绝的操作 MUST NOT 生成伪装成已接受结果的轨迹。`inbox` cursor 只表示读取进度，单独推进 cursor MUST NOT 生成协调 journal event。任何为成员产生新工作的变更 MUST 在同一提交中推进该成员的 wake generation。
- 前台 host MUST 仅在新的 wake generation 为成员产生相关状态变化时启动后续 Turn；时间流逝或重复读取同一 generation MUST NOT 自身触发新的 Agent 工作。
- 只有固定 lead 可以请求停止 teammate 或完成 team；lead MUST NOT 被作为普通 teammate 单独停止。只要仍有未完成任务或仍在启动、执行的 teammate，team 完成请求 MUST 被拒绝且不得修改状态。
- 主动停止或 team terminal settlement 中仍活跃的 Turn MUST 以 `cancelled` 状态和 `turn_cancelled` event 收尾，MUST NOT 伪装为 completed。host MUST 显式 shutdown Agent Executor supervisor 并等待 member fiber；shutdown、Session cleanup 或取消持久化失败 MUST 使 run 失败，即使 team 协调状态已经 terminal。
- 前台 CLI 收到 `SIGINT` 或 `SIGTERM`、或者 library run 被 Effect interruption 时，MUST 先把仍 active 的 team 标为 failed，再取消活跃 Turn、shutdown supervisor 并等待 member fiber，然后才允许进程或 Effect 退出。纯 interruption MUST NOT 被误报为 Session cleanup failure。
- 公开检查结果 MUST 由权威协调状态生成，并明确区分当前任务状态、mailbox 消息和 Agent Turn 观测；不完整的 Turn 文本或 ACP 事件 MUST NOT 被当作已完成任务或已发送消息。
- 公开检查与本地 Web observer MUST 严格只读：浏览或刷新不得创建、初始化、修复或修改 team state，不得唤醒成员或推进运行；Web observer MUST 只展示由当前前台 run 指定的 team，且不得接受浏览器提供的 state path、team identity 或协调写操作。
- `run --web` 在 team settlement 后 MUST 保留最终检查结果直至操作者关闭 observer；team active 时的进程信号仍 MUST 执行完整的 durable interruption settlement，而 settlement 后的关闭信号 MUST 只释放 observer 并保留已经确定的 team exit status。

## 验证

- `pnpm vitest run --project unit packages/agent-teams/test/commands.unit.test.ts packages/agent-teams/test/store.unit.test.ts packages/agent-teams/test/inspection.unit.test.ts packages/agent-teams/test/web.unit.test.ts packages/agent-teams/test/web-client.unit.test.ts`：验证 owner-only state、单 team 数据库、原子协调、只读 inspection、Web snapshot 与浏览器观察语义。
- `pnpm vitest run --project contract packages/agent-teams/test/public-api.contract.test.ts`：验证公开包只暴露 Agent Team runtime 与 inspection 接口，而不泄漏内部 store/CLI 结构。
- `pnpm vitest run --project integration packages/agent-teams/test/cli-signal.integration.test.ts`：用真实 ACP fixture subprocess 验证 active run 的 `SIGINT` settlement，以及 settled observer 关闭后保留 team exit status。
- `pnpm --filter @acpus/agent-teams typecheck`：验证 package、CLI、Agent Executor 与 SQLite 边界的静态类型一致性。
