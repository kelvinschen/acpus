<p align="center">
  <img src="page/logo/logo-lockup.svg" alt="Acpus mark" width="300">
</p>

<h1 align="center">acpus</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/acpus"><img src="https://img.shields.io/npm/v/acpus" alt="npm 版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/node-22.18%2B%20%7C%2024%2B-5FA04E" alt="Node.js 22.18+（限 22.x）或 Node.js 24+">
</p>

<p align="center">
  <a href="README.md">English</a>
  &nbsp;·&nbsp;
  <a href="https://kelvinschen.github.io/acpus/">官网</a>
  &nbsp;·&nbsp;
  <a href="docs/migrate-to-next.md">迁移指南</a>
</p>

<p align="center"><strong>描述你的任务，让 Agent 编排 Agents。</strong></p>

把任务交给 Orchestrator Agent。它使用 TypeScript 设计工作流，指挥任意组合的 ACP-compatible Worker Agents，并随着工作推进始终掌控全局。Acpus 提供持久化 runtime，负责检查和执行工作流图，同时追踪状态、artifact 与结果。

> **Orchestrator Agent 掌控工作流。**
>
> **ACP-compatible Worker Agents 负责执行。**
>
> **Acpus 让每次运行持久可靠。**

## 工作方式

```text
描述任务
  → Orchestrator Agent 通过 TypeScript 编排 Worker Agents
  → Acpus 检查并运行，Orchestrator Agent 持续观察
  → Orchestrator Agent 向你报告结果
```

一个 Orchestrator Agent 端到端负责整项工作：拆解任务、分配角色、编写 TypeScript Workflow、启动 run、观察进展，并通过 Acpus 介入，直到工作收敛。Worker Agents 专注于各自节点中的研究、实现、审查或综合任务；它们不负责整体计划或整次运行。

Acpus 是持久化执行与控制边界。它检查工作流图、调度节点、记录状态、artifact 与结果，并提供 inspect、pause、resume、局部 retry 和 fork 等控制能力，供 Orchestrator Agent 使用。

简单任务仍然适合直接交给单个 Agent。当任务需要多个独立上下文、不同 Agent 能力、本地命令或 artifact、人工输入，或者失败后不适合从头再来时，再使用 Acpus。

## 为什么使用 TypeScript Workflow

- **Agent 编写，人可以审查。** 编排结果是真实的 TypeScript 模块，可以直接输入，也可以保存为文件。
- **原生面向 ACP。** 同一张 workflow 可以让不同角色使用不同的 ACP-compatible Agents，而不把整张图绑定到单一模型产品。
- **由 Acpus 运行。** 执行前，Acpus 检查 authored structure，并将其降低为冻结、可序列化的 `WorkflowIR`；执行中，Acpus 在当前 workspace 保存持久化状态。
- **一次性或可复用。** 自包含的一次性模块通过 stdin 运行；模块化或需要复用时使用 TypeScript 文件路径。

## 快速开始

### 1. 安装 CLI 和内置 Skill

```sh
npm install -g acpus
# use bundled skill install
acpus skill install
# or use skills cli
npx skills add kelvinschen/acpus/packages/cli/skills/acpus
```

在交互式终端中，`acpus skill install` 可以提示选择 scope 和 Agent 目标。脚本中必须同时传入 `--project` 或 `--global`，以及 `--agent universal`、`--agent claude` 或 `--agent universal,claude`。安装会自动创建所选目录，并把 Skill 写入项目或操作系统 home 下的 `.agents/skills/acpus` 和/或 `.claude/skills/acpus`。
如果你不想要安装 acpus skill 也没有问题，agent 可以通过 `acpus skill read` 获取内置使用指南，在你的 prompt 里加上 "使用 acpus" 即可。

### 2. 从目标开始

> [!TIP]
> 在支持 Skill 的 Agent 中调用 Acpus，只需说明你想要的结果：
>
> ```text
> /acpus 启动一个 workflow，判断这个 release 是否已经可以发布
> ```
>
> 这就够了。Orchestrator Agent 会决定如何组织、运行和观察整个工作。你也可以指定要编排的 Worker Agents，例如让 Claude 负责审查、Codex 负责总结。

### 3. 审查并运行生成的 TypeScript

下面这个示例让两个 ACP-compatible Agent 独立审查，再由第三个角色综合结果，因此可以直接通过带引号的 heredoc 运行：

```sh
acpus workflow run --input '{"topic":"release readiness"}' - <<'WORKFLOW'
import { defineWorkflow, z } from "acpus/core";
import { md } from "acpus/expression";

const Review = z.object({
  summary: z.string(),
  ready: z.boolean(),
});

export default defineWorkflow({
  name: "quick-review",
  inputSchema: z.object({ topic: z.string() }),
  agents: {
    implementation: { use: "codex" },
    risk: { use: "claude" },
    synthesizer: { use: "codex" },
  },
}).build(({ input, agents, meta, step }) => {
  const reviews = step("reviews").parallel({
    branches: {
      implementation() {
        const review = step("implementation_review").agent({
          agent: agents.implementation,
          cwd: meta.workspaceDir,
          outputSchema: Review,
          prompt: md`Review implementation readiness for: ${input.topic}`,
        });
        return review.output;
      },
      risk() {
        const review = step("risk_review").agent({
          agent: agents.risk,
          cwd: meta.workspaceDir,
          outputSchema: Review,
          prompt: md`Challenge hidden risks for: ${input.topic}`,
        });
        return review.output;
      },
    },
  });

  const decision = step("synthesize").agent({
    agent: agents.synthesizer,
    cwd: meta.workspaceDir,
    outputSchema: Review,
    prompt: md`Synthesize these independent reviews: ${reviews.output}`,
  });

  return {
    reviews: reviews.output,
    decision: decision.output,
  };
});
WORKFLOW
```

### 4. 观察运行，或保存以便复用

```sh
# 作为前述 heredoc 的替代：需要本地 Task/helper 模块、后续修改或复用时保存为 workflow.ts。
acpus workflow check workflow.ts --input '{"topic":"release readiness"}'
acpus workflow viz workflow.ts
acpus workflow viz workflow.ts --out workflow.html
acpus workflow run workflow.ts --input '{"topic":"release readiness"}'

# 观察通过任一 source form 创建的 run。
acpus runs inspect <run-id>
```

`workflow check` 会执行类型检查、编译与验证，但不会创建 run。`workflow viz` 默认在终端输出紧凑的静态工作流树；`--out` 则生成一份自包含的 HTML 工作流图。`workflow run` 创建并执行持久化 run；`runs inspect` 从紧凑的持久化状态视图开始。

### 常用运行控制

```sh
acpus runs inspect <run-id> --follow
acpus runs pause <run-id>
acpus runs resume <run-id>
acpus runs retry <run-id> --target <node-key-or-frame-key>
acpus runs signal <run-id> --target <node-key> --payload '{"approved":true}'
acpus runs fork <run-id> --workflow workflow.ts
```

Retry 用于重试当前 run 中失败的部分。Fork 会创建新 run，并且只会在 Acpus 的兼容性与依赖边界内复用已完成工作；它不是无条件缓存。

## 配置 Agent

Acpus 的具名 Agent 配置以 `acpx` 为准。在 `~/.acpx/config.json` 中配置全局 custom agent，或在项目的 `.acpxrc.json` 中配置：

```json
{
  "agents": {
    "my-agent": { "command": "node ./scripts/agent-acp-bridge.mjs" }
  }
}
```

然后在 workflow 中通过 `{ use: "my-agent" }` 引用该名称。更多配置方式请参考 `acpx`文档：[pin-a-custom-agent-name](https://github.com/openclaw/acpx/blob/main/docs/config.md#pin-a-custom-agent-name-without-colliding-with-a-built-in) 和 [config-defined agents](https://github.com/openclaw/acpx/blob/main/docs/custom-agents.md#3-config-defined-agents)。

## 核心概念

### 执行单元

| 元素 | 适合什么 |
| --- | --- |
| **Agent** | 通过 ACP-compatible Agent 完成开放式判断、研究、实现、审查与综合。 |
| **Task** | 完成文件、命令、验证与 artifact 等可信本地工作；每次 attempt 在新的 Node.js 进程中执行。 |
| **Signal** | 持久化外部输入；让当前执行路径进入等待，直到用户或外部控制者提交类型化 payload。 |
| **控制流** | `if`、`switch`、`parallel`、`fanout` 与 `loop` 把节点组合成可检查的图；`assert` 用于强制条件成立。 |

### 持久化模型

| 概念 | 含义 |
| --- | --- |
| Workflow module | 通过 stdin 或文件路径提供的 TypeScript：声明 Agent 角色、节点、值流与输出。 |
| `WorkflowIR` | 经过 authoring check 与 lowering 后得到的冻结、可序列化工作流图。 |
| Run | 一次已创建的执行，包含冻结的工作流数据、input 与 Agent mapping。 |
| Node | 稳定的 authored unit；运行时拥有 attempt，动态控制流还会产生可寻址实例。 |
| Artifact | 由 Task 或 Agent attempt 注册并关联到 run 的持久化文件。 |

## 运行一次，或长期保留

新的自包含一次性 Workflow 优先使用带引号的 heredoc；其他情况保留现有路径，或按惯例新建 `workflow.ts`。临时文件式源码可以放在项目外。

## 从旧版本迁移

旧版 Acpus 使用 YAML Workflow Spec、不同的节点模型与 CLI。现在的 Acpus 使用TypeScript module、`Expr` 值流、Agent / Task / Signal、新的控制面和新的持久化runtime，并且不会添加兼容 shim。

请阅读[迁移指南](docs/migrate-to-next.md)，了解核心心智映射与实际重写步骤。旧版产品文档见
[Acpus 0.5.2 中文 README](https://github.com/kelvinschen/acpus/blob/acpus%400.5.2/README.zh.md)。

## 文档

- [内置 Acpus Skill](packages/cli/skills/acpus/SKILL.md)
- [迁移指南](docs/migrate-to-next.md)
- [发布指南](docs/releasing.md)
- [Specs 索引](specs/INDEX.md)
- [Core Spec](specs/core-spec.md)
- [Expression Spec](specs/expression-spec.md)
- [Workflow Compiler Spec](specs/workflow-compiler-spec.md)
- [Runtime Spec](specs/runtime-spec.md)
- [CLI Spec](specs/cli-spec.md)
- [WebUI Spec](specs/webui-spec.md)

当前行为以 `specs/` 为准；未来工作放在 `docs/roadmap/`；旧版本保留在 Git tag 历史中。

## 开发

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## License

MIT
