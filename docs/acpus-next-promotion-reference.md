# Acpus Next 宣传物料参考

> 内部宣传与内容创作参考。产品事实以当前 `specs/`、实际 CLI 行为和
> `docs/acpus-next-user-guide.md` 为准。Acpus Next 仍处于 alpha / foundation
> rewrite 阶段，不把工程评估包装成生产成熟度或客户效果证明。

## 核心叙事

### 品类定义

> **A workflow language and runtime for agents orchestrating agents.**

> **让 Agent 编排 Agent 的工作流语言与运行时。**

Acpus 让用户只需描述任务，由 Authoring Agent 编写 `workflow.ts`，自由编排任意组合的
ACP-compatible Agents。Acpus 检查并执行这张工作流，持续记录状态与结果，并在失败或
中断后提供恢复控制。

### 核心主张

> **Describe the task. Let agents orchestrate agents.**

> **描述任务，让 Agent 编排 Agent。**

### 产品链路

```text
用户描述任务
  → Authoring Agent 编写 workflow.ts
  → Acpus 检查并执行 workflow
  → 任意组合的 ACP Agents 协作
  → Acpus 追踪状态、产物与结果
```

### 三句产品表达

> **Your agent writes the workflow.**
>
> **Any mix of ACP agents can carry it out.**
>
> **Acpus runs and tracks the work.**

中文：

> **Agent 编写工作流。**
>
> **任意组合的 ACP Agent 协作执行。**
>
> **Acpus 运行并追踪结果。**

### 生命周期补充

`workflow.ts` 可以只服务当前任务，结束后删除；也可以保存、提交进仓库或随 Skill
分发，成为可检查、可观察、可恢复的持久工程资产。

> **Run it once—or keep the workflow durable.**

## 用户得到的转变

传统 workflow 工具要求用户先成为流程设计者：拆步骤、选择执行者、编写编排逻辑，再
负责运行和排障。普通 Agent 会话则常把规划与执行塞进同一个上下文，复杂工作结束后也
很难留下可复用的执行结构。

Acpus 改变的是工作分工：

- 用户表达目标与约束；
- Agent 根据任务设计并写出 `workflow.ts`；
- workflow 调用适合各个角色的 ACP Agents、Task 与 Signal；
- Acpus runtime 负责检查、调度、观察、控制和恢复；
- 用户决定任务结束后删除 workflow，还是把它沉淀为工程资产。

第一层价值不是“用户可以手工编排很多 Agent”，而是：

> **用户可以把编排本身也委托给 Agent。**

## 受众与使用时机

### 首要受众

- 已经使用 coding agent，希望把更复杂工作整体委托出去的开发者；
- 需要组合不同 Agent 能力，而不愿绑定单一模型产品的团队；
- 构建 Agent 工具、自动化与内部平台的工程团队；
- 需要执行、观察和恢复长时间 AI 工作的技术负责人。

### 最适合宣传的任务

- 需要多个独立上下文、专业角色或相互竞争的假设；
- 可以 fan-out，或者需要独立验证、汇总与收敛；
- 需要不同 Agent 分别研究、实现、审查或反驳；
- 包含本地代码、命令、artifact 或人工审批；
- 会持续较长时间，失败后不适合从头重跑；
- 方法可能只用一次，也可能在验证有效后沉淀为团队能力。

### 不应暗示的范围

- 不是每个任务都值得使用 workflow；简单任务直接交给单个 Agent 更合适。
- “任意 Agent”必须写成“任意兼容 ACP 的 Agent”，不包含无法通过 ACP 调用的产品。
- Agent 编写 workflow 不保证第一次生成就正确；`workflow check` 和人工审查仍然重要。
- TypeScript workflow 是使用 Acpus authoring API 的模块，不应宣传成无需 Acpus
  runtime 就能独立运行的普通 Node.js 脚本。
- Acpus 追踪运行状态与结果，不承诺每次 run 都必然成功完成。

## 信息层级

宣传内容应按以下顺序展开，不从节点类型或 durable feature list 开始：

1. **把编排委托给 Agent**：用户描述任务，Agent 负责编写 workflow。
2. **Agent 产出真实的 TypeScript 文件**：`workflow.ts` 可以阅读、修改、审查和版本化。
3. **workflow 对 ACP Agent 开放**：不同兼容 Agent 可以在同一 run 中承担不同工作。
4. **Acpus 负责运行和追踪**：检查工作流、执行节点、记录状态、结果与 artifact。
5. **一次性与持久化使用同一种表达**：跑完删除，或者保存并继续运行。
6. **重要工作可以恢复**：暂停、恢复、定向重试和修复后 fork。

“可检查、可观察、可恢复”是 Acpus runtime 的可信度证明；“任意 ACP Agent”是开放性；
而第一层承诺始终是“Agent 替用户完成编排”。

## 官网首屏

### 推荐版本

**Eyebrow**

> Agent-authored ACP workflows

**Headline**

> Describe the task. Let agents orchestrate agents.

中文：

> 描述任务，让 Agent 编排 Agent。

**Subheadline**

> Give your agent a task. It writes a TypeScript workflow to coordinate any mix
> of ACP-compatible agents. Acpus executes the graph, tracks every state and
> result, and keeps the run recoverable.

中文：

> 把任务交给 Agent。它会写出 `workflow.ts`，自由编排任意组合的 ACP Agent；Acpus
> 负责检查并执行整张工作流，持续追踪每一步状态与结果，并让失败后的恢复成为可能。

**Value line**

> Agent-authored · ACP-native · Acpus-operated

中文：

> Agent 编写 · ACP 协作 · Acpus 运行

**Primary CTA**

> Ask my agent to build a workflow

中文：

> 让我的 Agent 构建工作流

**Secondary CTA**

> See `workflow.ts` in action

中文：

> 查看 `workflow.ts` 如何运行

### 标题备选

1. **Your agent writes the workflow. Acpus runs the agents.** — 最直接地解释分工。
2. **From one task to a coordinated team of agents.** — 强调从意图到协作的转变。
3. **Let your agent build the workflow it needs.** — 更强调动态 authoring。
4. **Agent-authored. ACP-native. Acpus-operated.** — 适合技术受众和图形物料。

中文备选：

1. **Agent 写工作流，Acpus 跑 Agent。**
2. **从一句任务，到一组协作的 Agent。**
3. **让 Agent 写出任务需要的工作流。**
4. **把任务交给 Agent，把运行交给 Acpus。**

### CTA 备选

- 让 Agent 写一个 `workflow.ts`
- 运行第一个 Agent-authored workflow
- 查看多 Agent workflow
- 查看可运行示例

## 首页核心段落

### Section 1：把编排也交给 Agent

复杂任务不只需要更多 Agent，还需要决定如何拆分工作、哪些步骤可以并行、谁负责验证、
什么时候汇总，以及什么条件才算完成。

这些不必再全部由用户手工设计。把目标、约束和工作环境交给 Agent，它可以根据当前任务
编写一套 Acpus workflow，再交给 runtime 执行。

> **You describe the work. Your agent writes the orchestration.**

### Section 2：编排结果是 `workflow.ts`

Agent 产出的不是藏在当前对话里的临时计划，而是一个项目可以拥有的 TypeScript 模块。
你可以阅读、修改和 code review。运行前，Acpus 会检查类型、值流与 authored
structure，再将其降低为冻结、可序列化、可视化的 WorkflowIR。

> **Agent-authored. Human-reviewable.**

### Section 3：让任意 ACP Agent 加入协作

workflow 可以为不同工作声明不同 Agent 角色，并通过 ACP 调用相应执行者。同一张图中，
研究、实现、审查和综合可以交给不同的 ACP Agent；执行 mapping 也可以在需要时调整。

Acpus 的开放性不是把 workflow 绑定到另一个固定 Agent 名单，而是让任何兼容 ACP 的
Agent 都能进入同一种编排与运行模型。

> **Any ACP agent. One coordinated run.**

### Section 4：Acpus 运行并追踪整项工作

Acpus 执行 Agent、Task、Signal 与控制流，持续记录节点状态、attempt、artifact 和结果。
CLI 与 Web 图提供同一份 durable state 的不同视图；运行可以被暂停、恢复、定向重试，
也可以在修改 workflow、input 或 Agent 后 fork。

> **The agents do the work. Acpus keeps the run on track.**

### Section 5：跑一次，或者留下来

一次性研究、迁移或审查结束后，可以删除 `workflow.ts`。如果这套编排值得复用，就保存
文件、提交进仓库，或者随 Skill 一起分发，不需要重写成另一种工作流格式。

> **Disposable for the task. Durable when retained.**

## 发布文章参考稿

### 标题

> **描述任务，让 Agent 编排 Agent**

### 摘要

> Acpus 让 Agent 根据任务编写 `workflow.ts`，自由编排任意组合的 ACP-compatible
> Agents。Acpus 负责检查、执行和追踪整张工作流；跑一次即可，也可以把同一个文件保留
> 为持久工程资产。

### 正文

当我们把复杂任务交给 Agent 时，真正困难的往往不只是完成某一个步骤。

一次偶发故障调查可能需要多个独立假设、重复采集证据和对抗验证。一次大型迁移可能需要
先识别所有修改点，再并行实现、逐项审查，最后运行测试并汇总遗漏。要把这些工作整体
委托出去，Agent 不只需要执行任务，还需要为任务建立合适的执行结构。

过去，这部分编排仍然留给用户。用户需要手工拆分步骤、选择 Agent、处理并发、保存中间
结果，再从日志里判断整项工作进行到了哪里。

Acpus 的目标是把编排本身也交给 Agent。

用户描述目标和约束，Agent 根据当前任务编写一个 `workflow.ts`。这个 TypeScript 模块
描述 Agent、Task、Signal、分支、parallel、fan-out 和 loop，并为不同工作分配适合的
Agent 角色。它不是一段只存在于当前会话里的计划，而是一个可以被检查、修改、审查和
版本化的工作流文件。

```text
描述任务
  → Agent 编写 workflow.ts
  → Acpus check / visualize / run
  → ACP Agents 协作执行
  → Acpus 追踪状态、artifact 与结果
```

Acpus 使用 ACP 运行 Agent。这意味着 workflow 不必只调度写出它的那个 Agent，也不必
固定在单一模型产品中。一个 run 可以组合不同的 ACP-compatible Agents：让一个 Agent
研究，让另一个实现，让第三个独立验证，再把结果交给综合节点。Agent 负责写出这套协作，
Acpus 负责让它真正运行起来。

运行开始前，Acpus 会检查 workflow，并把 authored structure 降低为冻结、可序列化的
WorkflowIR。运行过程中，CLI 和 Web 图持续展示节点状态、attempt、artifact 与 Agent
执行信息。工作可以暂停和恢复，局部失败可以定向重试；当 workflow、input 或 Agent
mapping 发生变化时，可以 fork 新 run，并在兼容边界内复用已经完成的工作。

不是每个 workflow 都需要永久存在。一次性任务结束后，可以删除 `workflow.ts`。如果
Agent 写出的编排解决了一个会重复出现的问题，同一个文件可以被保存、提交进仓库，或者
随 Skill 分发，成为团队长期使用的工程资产。

这形成了一条完整的委托链：用户描述任务，Agent 设计并写出工作流，任意 ACP Agent 在
其中协作，Acpus 负责执行和追踪。

> **Describe the task. Let agents orchestrate agents.**

## 示例 Prompt 卡片

宣传时优先展示用户如何让 Agent 创建 Acpus workflow，以及生成的 workflow 如何组合
不同 ACP Agent，而不是只展示手写 DSL。

### 偶发故障

> 为这个大约每 50 次失败一次的测试生成 Acpus workflow。让多个独立 Agent 提出竞争
> 假设，用 Task 重复采集证据，再调用另一种 ACP Agent 反驳每个假设，直到只剩下能够
> 解释全部证据的原因。生成 `workflow.ts` 后先运行 check，再开始执行。

### 大型迁移

> 为这次 API 迁移编写 Acpus workflow。先让 Agent 识别所有调用点，再按模块 fan-out
> 给实现 Agent；每项修改交给独立审查 Agent，最后用 Task 运行测试并汇总未迁移路径。

### 技术事实核验

> 把这篇文章的核验过程写成 Acpus workflow。提取每项技术声明，分别交给 ACP Agent
> 对照代码和一手文档核验，再让不同 Agent 拒绝证据不足的结论，最终生成带引用的报告。

### 事故复盘

> 根据过去六个月的事故记录生成 Acpus workflow。让不同 Agent 分析日志、代码和跟进
> 记录，汇总重复根因；提出建议后等待 Signal，由我批准哪些建议可以创建任务。

### 方案竞赛

> 为这个模块设计问题生成 Acpus workflow。让多个 ACP Agent 独立提出方案，再根据统一
> rubric 进行两两比较，输出排名最高的三个方案和各自代价。

### 一次性研究

> 为这个问题生成一个 quick Acpus workflow：选择合适的 ACP Agents 并行寻找三类一手
> 资料，交叉验证关键事实并合成结论。任务完成后不需要保留 `workflow.ts`。

## README 与目录短文案

### 一句话

> Acpus lets agents write TypeScript workflows that orchestrate any mix of
> ACP-compatible agents, then executes and tracks every run durably.

### 一段话

> Acpus is a workflow language and durable runtime for agents orchestrating
> agents. Give an agent a task and it writes `workflow.ts` to coordinate Agent,
> Task, Signal, and control flow across any mix of ACP-compatible agents. Acpus
> checks the graph, executes the run, and tracks its state, artifacts, and
> results. Run the workflow once, or keep the same file as an engineering asset.

### 中文短介绍

> Acpus 是让 Agent 编排 Agent 的工作流语言与持久化运行时。把任务交给 Agent，它会
> 写出 `workflow.ts`，自由组合任意兼容 ACP 的 Agent，并编排 Task、Signal 与控制流。
> Acpus 负责检查、执行和追踪整次运行。跑一次即可，也可以把同一个文件保留为工程资产。

## 社交传播文案

### 中文短版

> 复杂任务不只需要 Agent 执行，还需要有人决定如何拆分、并行、验证和收敛。
>
> Acpus 把这部分也交给 Agent：描述任务，它来写 `workflow.ts`，自由编排任意组合的
> ACP Agent；Acpus 负责执行整张图并追踪结果。
>
> **描述任务，让 Agent 编排 Agent。**

### 英文短版

> Complex work needs more than agents executing isolated steps. It needs an
> orchestration built for the task.
>
> With Acpus, your agent writes `workflow.ts` to coordinate any mix of
> ACP-compatible agents. Acpus executes the graph and tracks every state,
> artifact, and result.
>
> **Describe the task. Let agents orchestrate agents.**

## 与 Claude Dynamic Workflows 的叙事关系

Claude Dynamic Workflows 已经建立了一个重要认知：Agent 可以针对当前任务即时编写
定制 harness，而不必让所有问题适应固定流程。它的官方宣传从具体 prompt 和单上下文
失败模式出发，再介绍 classify-and-act、fan-out-and-synthesize、adversarial
verification、tournament 等模式，并明确 workflow 更适合复杂、高价值工作。

Acpus 不复述 “a harness for every task”，而是把差异集中在完整委托链与开放执行边界：

| Claude Dynamic Workflows 的核心故事 | Acpus 的核心故事 |
| --- | --- |
| Claude 为任务编写并运行 workflow | 用户的 Authoring Agent 编写 `workflow.ts`，Acpus 负责运行 |
| workflow 主要编排 Claude subagents | workflow 可以自由组合任意 ACP-compatible Agents |
| JavaScript workflow 可以保存和分享 | TypeScript workflow 可以检查、审查、版本化并随项目或 Skill 分发 |
| 动态计划、并行执行与独立验证 | Agent 动态 authoring，Acpus 在执行前检查并冻结 authored structure |
| 产品负责呈现 workflow 进度 | Acpus 保存 workspace-local durable state，并提供 inspect、retry 与 fork |

对外不建议使用“Claude workflow 不能保存”或“Claude workflow 不能恢复”等表述。Claude
官方已经宣传保存、分享和中断续跑。Acpus 应强调：Authoring Agent 与执行 Agents 都不被
固定在单一产品中；ACP-compatible Agents 可以自由进入同一套 TypeScript workflow，
而 Acpus 提供独立的检查、运行与追踪边界。

参考：

- [A harness for every task: dynamic workflows in Claude Code](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)
- [Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)

## 语言规范

### 推荐使用

- 描述任务，让 Agent 编排 Agent
- Agent-authored workflow
- Agent 编写 `workflow.ts`
- 任意组合的 ACP-compatible Agents
- Acpus 检查、执行并追踪
- 从一句任务到一组协作的 Agent
- 运行一次，或者保留为持久工作流
- 可检查、可观察、可恢复
- 在兼容边界内复用已完成工作

### 谨慎使用

- **任意 Agent**：必须限定为 ACP-compatible；不要暗示可直接调用不支持 ACP 的产品。
- **Agent 编排 Agent**：Agent 负责编写 orchestration，Acpus runtime 负责实际执行与控制。
- **自动生成**：生成结果仍需要 `workflow check`，重要工作仍应接受人工审查。
- **动态工作流**：应说明“动态”指 Agent 针对任务按需 authoring；不要暗示运行时可任意
  改变完整 authored structure。
- **Portable**：应说明是 TypeScript 源码和 ACP Agent 选择上的可携带；不要暗示无需
  Acpus runtime。
- **Durable**：指 workspace-local 状态、控制和恢复；不要等同于高可用分布式平台。
- **缓存**：fork reuse 是带兼容性边界的已完成事实复用，不是无条件 memoization。

### 避免使用

- A harness for any task
- 用户手工配置一支 Agent team
- 又一个多 Agent 编排框架
- 所有 Agent 都可以无差别替换
- 任何任务都能自动完成
- 永不失败 / 无限运行 / 完全自主
- 无条件复用所有已完成结果
- 可在任何环境直接运行的普通 TypeScript
- 已达到生产成熟度

## 证据与演示清单

宣传物料必须证明“Agent 编排 Agent”，不能只展示人手写的 workflow 或单一 Agent run。

优先准备一段端到端演示：

1. 用户向 Authoring Agent 描述一个复杂目标；
2. Agent 生成可读的 `workflow.ts`，其中包含不同 Agent 角色、Task 和控制流；
3. `workflow check` 暴露或排除 authoring 问题；
4. `workflow viz` 在执行前展示完整 authored structure；
5. 同一 run 至少调用两种不同的 ACP Agent，并展示它们如何交接或互相验证；
6. Web/CLI 展示 Agent、Task、Signal 的状态、artifact 与结果；
7. 人为制造一个局部失败并定向 retry；
8. 修改 Agent mapping 后 fork，展示兼容结果复用；
9. 最后展示删除源文件、提交仓库或随 Skill 保存分发三种结局。

建议至少保留三类可运行案例：

- Agent 生成、半小时内完成的一次性 quick workflow；
- 组合多个 ACP Agent、包含 fan-out 与独立验证的高价值 workflow；
- 包含 Signal、失败恢复和 replacement fork 的长时间 workflow。

当前仓库内的受控 authoring evaluation harness 采用 10 个 implementation-neutral
requirements × 3 个 named Agents × 3 次 trials 的固定设计，共 90 个独立 authoring
sessions。它可以证明评估反馈机制的存在，但不能作为客户采用、生产稳定性或结果准确率
的替代证据；对外引用实际结果前还必须核对一次已授权 run 的分析产物。

## Meta 内容

**Page title**

> Acpus — Let agents orchestrate agents

**Meta description**

> Give an agent a task. It writes a TypeScript workflow to coordinate any mix of
> ACP-compatible agents. Acpus executes the graph and tracks every run.

**中文页面标题**

> Acpus — 描述任务，让 Agent 编排 Agent

**中文描述**

> 把任务交给 Agent，由它编写 `workflow.ts`，自由编排任意组合的 ACP Agent；Acpus
> 负责检查、执行并追踪整张工作流。
