# Workflow 能力缺口梳理

> Roadmap: this document records future capabilities and known gaps. It is not current implementation truth.

这份文档整理了几个目标场景暴露出的 workflow 原子能力缺口：

- 条件路由汇合，例如 `A -> (B1, B2) -> C -> D/E/F -> G`；
- deep research，包括多源搜索、正文抽取、交叉验证、低置信度补搜、投票过滤和证据聚合；
- 设计系统到生产代码，包括 Figma 设计提取、组件匹配、复用/新建分支、代码与测试并行生成、视觉一致性验证和交付。

当前 workflow 模型是有意收敛的：

- 只能有一个无依赖 root stage；
- 只能有一个 terminal `summarize` stage；
- 依赖通过显式 `dependsOn` 表达；
- 不支持任意图环；
- 分支路由只能通过 `decisionGate`；
- 并发主要通过 `fanout` item 表达；
- 纯程序节点只支持内置 `discover`、`reduce`、`decisionGate` program mode。

下面把能力缺口拆成较小的原子能力，方便后续逐步优化框架，而不是一次性把 workflow spec 扩成无约束的通用编排器。

## 能力矩阵

| 场景诉求 | 当前支持情况 | 缺失原子能力 |
| --- | --- | --- |
| `A -> (B1, B2) -> C`，其中 B1/B2 是独立 stage | 不直接支持。普通 stage 有多个 downstream 会被 lint 拒绝，除非它是 `decisionGate`。 | 普通并行分支与汇合 |
| `decisionGate -> D/E/F -> G`，只有被选中的 route 运行，然后汇合到 G | 不支持。未选中 route 会变成 `skipped`，依赖解析只把 `completed` 视为满足。 | 条件汇合 / 选中路由汇合 |
| deep research 低置信度时回到搜索阶段 | 不支持图上的回环。任意 cycle 会被拒绝；当前只有 `fixLoop` 支持节点内部有界循环。 | workflow 级有界循环 |
| 学术/新闻/社区搜索分别使用不同 prompt、role 或工具 | 只能用一个 `fanout` role/prompt 加 item-local data 近似。 | 异构 fanout |
| 每个 fanout item 需要多步流水线，例如 search -> extract -> verify | 不支持 item 内部子图。只能折叠到一个 item prompt，或拆成全局 stage。 | per-item subgraph / map pipeline |
| Figma MCP 提取作为一等确定性节点 | workflow spec 不支持原生工具节点。只能藏在 agent turn 里，前提是 agent runtime 有 MCP 工具。 | 原生 tool/MCP task 节点 |
| 自定义纯程序节点 | 只支持少量内置 program 能力：glob/git discover、program reduce、program decision。 | 自定义 program/command task 节点 |
| 代码生成和测试生成并行，然后进入视觉验证 | 不支持两个普通 stage 并行后 join。只能串行、合并到一个 agent task，或用 fanout 近似。 | 普通并行分支与汇合 |
| 下游 stage 读取“被选中 route 的输出” | 不好表达。变量当前只能读取固定路径，例如 `outputs.D.summary`。 | route output alias / selected output binding |

## 原子能力 Backlog

### 1. 普通并行分支

**问题**

当前 graph lint 会拒绝非 `decisionGate` stage 拥有多个 dependent，因此不能直接表达普通并行工作：

```text
A -> B1
A -> B2
B1 + B2 -> C
```

**为什么现有 `fanout` 不够**

`fanout` 适合每个并行 item 共享同一个 role、prompt、contract 和 stage policy 的场景。  
如果 B1/B2 是不同 stage kind、不同 role、不同工具、不同 prompt 或不同输出契约，用 `fanout` 会比较别扭。

**可能的 spec 形态**

```json
{
  "id": "split",
  "kind": "parallel",
  "branches": ["B1", "B2"],
  "join": "allCompleted"
}
```

或者更小的第一步：

```json
{
  "id": "B1",
  "dependsOn": ["A"],
  "parallelGroup": "A_children"
}
```

**运行时语义**

- 分支可以在全局和 stage concurrency 限制下并发运行。
- all-join 下游必须等所有 required branch 都完成。
- blocked/failed 分支的行为需要显式声明：阻塞 join、允许部分结果，或进入诊断。

**主要场景**

- 设计到代码：React 代码生成和测试用例生成并行。
- deep research：多个研究分支差异太大，不适合共用一个 fanout prompt。

### 2. 普通并行汇合

**问题**

依赖解析本身已经支持 fan-in：一个 stage 可以依赖多个上游，且当前语义是所有依赖都 `completed` 后运行。  
但 graph lint 通常阻止产生普通 split，因此普通 split -> join 的整体形态不可用。

**可能的 spec 形态**

```json
{
  "id": "C",
  "kind": "agentTask",
  "dependsOn": ["B1", "B2"],
  "joinPolicy": { "type": "allCompleted" }
}
```

**运行时语义**

- `allCompleted` 保持为最安全的默认依赖语义。
- report graph 应显式展示 join，而不是让多依赖 stage 看起来像偶然的图形结构。

**主要场景**

- `A -> (B1, B2) -> C`。
- `code_generation + test_generation -> visual_validation`。

### 3. 条件汇合 / 选中路由汇合

**问题**

`decisionGate` 可以选择一个 route，并把未选中的直接下游 stage 标为 `skipped`。  
但如果后续 stage 依赖所有 route branch，它不会运行，因为依赖解析只把 `completed` 当成满足。

```text
C -> decisionGate -> D
                  -> E
                  -> F
D/E/F 中被选中的 branch -> G
```

**可能的 spec 形态**

```json
{
  "id": "G",
  "kind": "agentTask",
  "dependsOn": ["D", "E", "F"],
  "joinPolicy": {
    "type": "selectedRouteCompleted",
    "decision": "route_after_C"
  }
}
```

**运行时语义**

- 被选中的 route 必须 `completed`。
- 被指定 decision 跳过的 route 可以视为满足 join。
- 如果被选中 route 变成 `blocked` 或 `failed`，join 不能继续。
- 来自其他 decision 的 `skipped` 不能满足这个 join。

**必要配套**

当前 skipped state 只有人类可读的 `skippedReason`，不够结构化。建议记录：

```json
{
  "skippedByDecision": "route_after_C",
  "selectedRoute": "D"
}
```

**主要场景**

- 组件复用或新建的条件分支，最后汇合到生成/验证。
- research 投票后选择 pass / 补搜 / block，并继续进入公共后续阶段。

### 4. Route Output Alias / 选中输出绑定

**问题**

条件分支汇合后的公共 stage 通常需要读取“被选中 branch 的输出”。  
当前变量只能写固定路径：

```json
{ "name": "branchResult", "source": "outputs.D.summary" }
```

当被选中 branch 可能是 D/E/F 时，这种固定路径无法优雅表达。

**可能的 spec 形态**

```json
{
  "name": "branchResult",
  "source": "routes.route_after_C.selectedOutput.summary"
}
```

或者：

```json
{
  "name": "branchResult",
  "source": "outputs.$selected(route_after_C).summary"
}
```

**运行时语义**

- decision 输出需要记录 selected route id。
- source resolver 根据 selected route 找到对应 stage output。
- 如果 selected output 缺失，应视为确定性的 workflow 错误，而不是 agent 错误。

**主要场景**

- `D/E/F -> G`，G 总结或验证被选中分支的结果。
- 设计到代码：复用/新建分支结果进入公共视觉验证。

### 5. Workflow 级有界循环

**问题**

deep research 通常需要：

```text
search -> extract -> verify -> vote
  low confidence -> search again
  pass -> synthesize
```

当前 graph cycle 会被拒绝。`fixLoop` 只覆盖 validator/fixer 这种特定循环，不能泛化为多 stage research loop 或设计验证 loop。

**可能的 spec 形态**

```json
{
  "id": "research_loop",
  "kind": "loop",
  "maxRounds": 3,
  "body": ["search", "extract", "verify", "vote"],
  "continueWhen": { "source": "outputs.vote.confidence", "op": "lt", "value": 0.75 },
  "exitTo": "synthesize",
  "onExhausted": "blocked"
}
```

**运行时语义**

- 每一轮输出需要隔离，例如 `outputs.search.rounds[2]`。
- loop 需要稳定变量根，例如 `loop.round`、`loop.previousOutputs`。
- agent budget 估算必须按最坏轮数计算。
- report view 需要展示每轮历史，而不是覆盖前一轮输出。

**主要场景**

- deep research 低置信度补搜。
- 视觉验证失败后进行有界代码/测试修复，如果 `fixLoop` 不足以表达完整阶段序列。

### 6. 异构 Fanout

**问题**

当前 `fanout` 是一个 stage definition 跑多个 item。所有 item 共享同一个 role、prompt、contract 和 policy。  
这适合均质工作，但不适合每个 item 需要不同 agent、prompt 或工具的场景。

**可能的 spec 形态**

```json
{
  "id": "multi_source_search",
  "kind": "fanout",
  "items": { "source": "outputs.plan.sources" },
  "dispatch": {
    "source": "item.type",
    "cases": {
      "academic": { "role": "scholar", "prompt": "..." },
      "news": { "role": "newsSearcher", "prompt": "..." },
      "community": { "role": "communitySearcher", "prompt": "..." }
    }
  }
}
```

**运行时语义**

- attempt id 和 session key 仍需要基于 item identity 保持确定性。
- budget 估算需要按 dispatch 的最大成本计算。
- 输出契约可以采用共享 base contract，或允许 per-case contract 后再做 normalization。

**主要场景**

- deep research 中学术、新闻、社区等不同来源搜索。
- 设计到代码中不同组件策略：复用现有组件或新建组件。

### 7. Per-Item Subgraph / Map Pipeline

**问题**

一些 fanout item 本身需要多步处理：

```text
for each source:
  search -> fetch -> extract -> source-level validation
then aggregate
```

当前 fanout item 是单次 agent turn，然后由 orchestrator 聚合。

**可能的 spec 形态**

```json
{
  "id": "source_pipeline",
  "kind": "map",
  "items": { "source": "outputs.plan.sources" },
  "stages": ["search_item", "extract_item", "validate_item"],
  "reduceTo": "cross_source_verify"
}
```

**运行时语义**

- per-item stage 需要 item-scoped outputs，例如 `outputs.source_pipeline[itemId].extract_item`。
- per-item failure 需要明确 policy：fail item、retry item、allow partial，或 block 整个 map stage。
- concurrency limit 需要同时作用于全局和 map 内部。

**主要场景**

- deep research 多源流水线。
- 设计系统迁移中按组件执行：设计节点 -> 匹配 -> 实现 -> 验证。

### 8. 原生 Tool / MCP Task 节点

**问题**

workflow spec 不能声明确定性工具调用，例如 Figma MCP 提取。  
当前只能把工具调用藏在 agent turn 里，且依赖 agent runtime 暴露对应工具。

**可能的 spec 形态**

```json
{
  "id": "extract_figma",
  "kind": "toolTask",
  "tool": "figma.getNode",
  "args": {
    "fileKey": "${figmaFileKey}",
    "nodeId": "${figmaNodeId}"
  },
  "output": "designTree"
}
```

**运行时语义**

- run start 前应校验工具可用性。
- 工具输出应像 stage output 一样持久化。
- secrets 和 connector credentials 不能被序列化进 prompt 或 report artifact。
- retry policy 需要区分确定性工具错误和 transient transport 错误。

**主要场景**

- Figma MCP 设计提取。
- 搜索 API、文档库、浏览器截图、内部代码索引查询。

### 9. 自定义 Program / Command Task 节点

**问题**

当前纯程序能力比较窄，没有通用方式把 repo 命令、脚本或 checked-in helper 作为确定性 stage 运行。

**可能的 spec 形态**

```json
{
  "id": "visual_diff",
  "kind": "programTask",
  "command": "npm",
  "args": ["run", "test:visual"],
  "cwd": "${cwd}",
  "outputParser": "json"
}
```

**运行时语义**

- 需要严格限制 cwd、timeout、environment 和 output size。
- 默认应是 read-only，除非明确允许 mutation。
- 需要结构化 output contract，而不是随意 scrape stdout。
- report 需要记录 command、exit code、stdout/stderr 路径和 parsed data。

**主要场景**

- 浏览器截图与视觉一致性验证。
- typecheck、unit test、lint、codemod、design-token transform。

### 10. 动态 Worklist 扩展

**问题**

deep research 和设计迁移常常在运行中发现更多工作。  
当前 `fanout` 从一个 source list 初始化后只会 drain 固定集合。新增 item 需要后续显式 stage 或外部 resume/run。

**可能的 spec 形态**

```json
{
  "id": "research_search",
  "kind": "dynamicFanout",
  "items": { "source": "outputs.plan.initialQueries" },
  "appendItemsFrom": "outputs.verify.followUpQueries",
  "maxRounds": 3,
  "maxItems": 50
}
```

**运行时语义**

- 需要跨轮次去重和稳定 item id。
- 必须有 hard caps：最大轮次、最大 item 数。
- report 需要展示每个 item 何时、为何被加入。
- scheduler 需要避免新 work 持续出现导致 starvation。

**主要场景**

- deep research 中验证后生成 follow-up queries。
- 设计到代码中组件分析发现嵌套组件。

## 推荐实现顺序

1. **条件汇合 / 选中路由汇合**
   - 对 route convergence 场景收益最高。
   - 如果先限制为一个上游 `decisionGate`，概念和实现都相对可控。

2. **Route output alias**
   - 条件汇合后通常马上需要读取被选中分支输出。
   - 可以避免 prompt 里塞多个 optional variable。

3. **普通并行分支/汇合**
   - 解锁 `A -> B1/B2 -> C` 和 code/test 并行。
   - 建议显式声明，不要从多个 dependent 隐式推断。

4. **原生 tool/MCP task 节点**
   - 对设计到代码和 research ingest 很关键。
   - 可以先支持 read-only deterministic tool call，再考虑 mutation。

5. **自定义 program/command task 节点**
   - 对验证、构建、截图、确定性 transform 都有用。
   - 需要强约束 sandbox、timeout 和 output contract。

6. **异构 fanout**
   - 如果普通并行分支/汇合之后仍频繁需要 item-level dispatch，再引入。

7. **workflow 级有界循环**
   - 对 deep research 价值高，但会显著影响 state、budget 和 report。
   - 建议在 route metadata 和 join 语义稳定后再设计。

8. **per-item subgraph / 动态 worklist**
   - 能力很强，但会明显扩大 scheduler 语义。
   - 更适合作为第二阶段能力。

## 第一阶段 Non-Goals

- 不要把所有 `skipped` 全局等价为 `completed`。
- 不要支持无限制任意 graph cycle。
- 不要在没有 limits 和 output contract 的情况下支持任意 shell 执行。
- 不要从图形结构隐式推断 branch/join 语义；应使用显式 policy。
- 当 workflow 需要可复现执行元数据时，不要把 connector/tool 依赖藏在 prompt 里。

