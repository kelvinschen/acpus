<p align="center">
  <img src="page/logo/logo-opus-mark.svg" alt="Acpus 标志" width="120">
</p>

<h1 align="center">Acpus</h1>
<p align="center"><em>Every run is an opus.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/acpus?activeTab=versions"><img src="https://img.shields.io/npm/v/acpus/alpha?label=alpha" alt="npm alpha 版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-5FA04E" alt="Node.js 22.12 或更高版本">
</p>

<p align="center">
  <a href="README.md">English</a>
  &nbsp;·&nbsp;
  <a href="https://kelvinschen.github.io/acpus/">官网</a>
  &nbsp;·&nbsp;
  <a href="docs/acpus-next-user-guide.md">用户指南</a>
  &nbsp;·&nbsp;
  <a href="docs/migrate-to-next.md">迁移到 Next</a>
</p>

<p align="center"><strong>描述任务，让 Agent 编排 Agent。</strong></p>

Acpus 是让 Agent 编排 Agent 的工作流语言与持久化运行时。把任务交给 Authoring
Agent，它会写出 `workflow.ts`，自由组合任意兼容 ACP 的 Agent，并编排 Agent、Task、
Signal 与控制流。Acpus 负责检查工作流、执行整次运行，并追踪状态、artifact 与结果。

> **Agent 编写工作流。**
>
> **任意组合的 ACP-compatible Agent 协作执行。**
>
> **Acpus 运行并追踪结果。**

> [!IMPORTANT]
> **Acpus Next 仍处于 alpha。** 请安装 `alpha` 版本，并在运行重要任务前审查 Agent
> 生成的 workflow。Next 是 TypeScript-first 的基础重写，不是 Previous YAML 版本的
> 原位升级。编程模型与命令变化见[迁移到 Next](docs/migrate-to-next.md)。

## 工作方式

```text
描述任务
  → Authoring Agent 编写 workflow.ts
  → Acpus 检查并执行 workflow
  → ACP-compatible Agents 协作
  → Acpus 追踪状态、artifact 与结果
```

Authoring Agent 决定如何拆分任务、安排并行、独立验证和最终收敛。执行 Agent 分别负责
研究、实现、审查或综合。Acpus 提供独立的运行边界，负责检查、执行、观察、控制和恢复
这张工作流。

简单任务仍然适合直接交给单个 Agent。只有当任务需要多个独立上下文、不同 Agent
能力、本地命令或 artifact、人工输入，或者失败后不适合从头再来时，才值得使用 Acpus。

## 为什么是 `workflow.ts`

- **Agent 编写，人可以审查。** 编排结果是真实的 TypeScript 模块，可以阅读、修改、
  code review 和版本化。
- **原生面向 ACP。** 同一张 workflow 可以让不同角色使用不同的 ACP-compatible
  Agents，而不把整张图绑定到单一模型产品。
- **由 Acpus 运行。** 执行前，Acpus 检查 authored structure，并将其降低为冻结、可
  序列化的 `WorkflowIR`；执行中，Acpus 在当前 workspace 保存持久化状态。
- **一次性与持久化使用同一个文件。** 任务结束后可以删除，也可以提交进仓库或随 Skill
  分发，沉淀为工程资产。

## 快速开始

### 1. 安装 alpha CLI 与内置 Skill

```sh
npm install -g acpus@alpha
mkdir -p .agents/skills
acpus skill install --project
```

安装器只会写入已有的受支持 Skill 目录，所以上面的命令先创建通用项目目录。如果全局
Agent 环境中已经存在受支持的 Skill 目录，可以改用 `--global`。

### 2. 让 Agent 构建工作流

> [!TIP]
> 把下面的 prompt 交给能够使用 Skill 的 Agent：
>
> ```text
> 使用 Acpus skill 把这个任务写成 workflow.ts：从实现质量和风险两个独立视角检查
> 发布准备情况，分别使用不同的 ACP-compatible Agent，再综合为一个发布结论。
> 编写完成后先运行 acpus workflow check，并在执行前向我展示工作流图。
> ```

### 3. 审查生成的 TypeScript

下面这个紧凑示例让两个 ACP-compatible Agent 独立审查，再由第三个角色综合结果：

```ts
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
```

### 4. 检查、可视化、运行与观察

```sh
acpus workflow check workflow.ts --input '{"topic":"release readiness"}'
acpus workflow viz workflow.ts --out workflow.html
acpus workflow run workflow.ts --input '{"topic":"release readiness"}'
acpus runs inspect <run-id>
```

`workflow check` 会执行类型检查、编译与验证，但不会创建 run。`workflow viz` 会生成一份
自包含的静态 HTML 工作流图。`workflow run` 创建并执行持久化 run；`runs inspect`
读取它的结构、状态、attempt、artifact 与结果。

### 常用运行控制

```sh
acpus runs inspect <run-id> --follow
acpus runs pause <run-id>
acpus runs resume <run-id>
acpus runs retry <run-id> --target <node-key-or-frame-key>
acpus runs signal <run-id> --target <node-key> --payload '{"approved":true}'
acpus runs fork <run-id> --workflow workflow.ts
```

Retry 用于重试当前 run 中失败的部分。Fork 会创建新 run，并且只会在 Acpus 的兼容性与
依赖边界内复用已完成工作；它不是无条件缓存。

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
| Workflow module | Agent 编写的 `workflow.ts`：声明 Agent 角色、节点、值流与输出。 |
| `WorkflowIR` | 经过 authoring check 与 lowering 后得到的冻结、可序列化工作流图。 |
| Run | 一次已创建的执行，包含冻结的工作流数据、input 与 Agent mapping。 |
| Node | 稳定的 authored unit；运行时拥有 attempt，动态控制流还会产生可寻址实例。 |
| Artifact | 由 Task 或 Agent attempt 注册并关联到 run 的持久化文件。 |

## 运行一次，或长期保留

`workflow.ts` 可以只服务眼前这一次任务，结束后直接删除。如果 Agent 写出的编排值得
复用，就提交同一个文件、随 Skill 分发，或在下一次运行前继续修改。一次性与持久化版本
不需要两套格式。

## 从 Previous 迁移

Previous Acpus 使用 YAML Workflow Spec、不同的节点模型与 CLI。Next 改用 TypeScript
module、`Expr` 值流、Agent / Task / Signal、新的控制面和新的持久化 runtime，并且不会
添加兼容 shim。

请阅读[迁移到 Acpus Next](docs/migrate-to-next.md)，了解核心心智映射与实际重写步骤。
Previous 产品文档见
[Acpus 0.5.2 中文 README](https://github.com/kelvinschen/acpus/blob/acpus%400.5.2/README.zh.md)。

## 文档

- [Acpus Next 用户指南](docs/acpus-next-user-guide.md)
- [迁移到 Acpus Next](docs/migrate-to-next.md)
- [Specs 索引](specs/INDEX.md)
- [Core Spec](specs/core-spec.md)
- [Expression Spec](specs/expression-spec.md)
- [Workflow Compiler Spec](specs/workflow-compiler-spec.md)
- [Runtime Spec](specs/runtime-spec.md)
- [CLI Spec](specs/cli-spec.md)
- [WebUI Spec](specs/webui-spec.md)

当前行为以 `specs/` 为准；未来工作放在 `docs/roadmap/`；Previous release 保留在
repository tag 历史中。

## 开发

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## License

MIT
