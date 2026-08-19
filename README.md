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
  <a href="README.en.md">English</a>
  &nbsp;·&nbsp;
  <a href="https://kelvinschen.github.io/acpus/">官网</a>
  &nbsp;·&nbsp;
  <a href="docs/migrate-to-next.md">迁移指南</a>
</p>

<p align="center"><strong>让你的 Agent 以 Dynamic Workflow 编排 ACP Agent</strong></p>

> [!TIP]
> **使用 DeepSeek Harness？** 安装 [`@acpus/dsh`](packages/dsh/README.md)
> 后，可以在 DSH 中选择 **Acpus 模式**。
> [查看插件的安装和使用说明 →](packages/dsh/README.md)

Acpus 可以调用任何已配置且支持 ACP 协议的 Agent, 包括但不限于: ***Claude Code*、*Codex*、*OpenCode*、*Pi*、*Kimi*、*Trae***。

使用 Acpus 时，你的 Agent 根据目标**动态地**生成的 TypeScript Workflow: 通过 `step.agent` 来程序化地调用其他 ACP Agent，通过组织 **串行、并发、条件分支、循环** 等控制结构来实现一个复杂的长程任务。

Acpus 运行时负责调度并持久化每个运行的节点的状态、Artifact 和结果。 一个节点失败后，可以只重试该部分，不必重跑整个任务，已有的运行结果不会丢失。


## 什么时候用 Acpus

一个 Agent 能稳定完成的小任务，直接交给一个 Agent 更省事。Acpus 更适合工作量大、容易漏项，或需要独立复核的任务：

- **大型迁移和重构。** 在多个模块中修改同一类代码，逐项运行测试并审查结果，避免漏掉调用点。
- **调查疑难问题。** 为偶发故障、线上事故或数据异常提出几种可能原因，再用日志、代码和数据逐一验证。
- **深入研究和事实核查。** 从网页、协作记录或代码库收集材料，核对关键结论，并整理成带来源的报告。
- **批量处理待办。** 对大量工单、简历、候选方案或历史记录做分类、去重、排序，并复核最重要的结果。
- **从多个角度评审。** 从用户、投资人、竞争对手、安全或实现风险等角度检查同一个方案，再汇总成一份结论。
- **把反复纠正变成规则。** 从历史会话和代码审查意见中找出重复问题，整理成规则，再验证这些规则能否防止真实错误。

这些任务通常会持续很多轮，容易漏项或偏离目标，也需要独立复核。Acpus 保存运行状态，方便中途检查，并在失败后继续。

## 工作方式

```text
你描述目标
  → Orchestrator Agent 生成 TypeScript Workflow
  → Acpus 检查 Workflow，并按依赖和控制流运行节点
  → Worker Agent 或 Task 执行节点
  → Acpus 保存状态、Artifact 和结果
  → Orchestrator Agent 检查运行状态，并处理需要判断的情况
  → Orchestrator Agent 返回结果
```

Orchestrator Agent 负责拆分任务、定义节点和依赖、启动 Run，并查看运行状态。
需要人工判断时，它可以暂停 Run、重试节点、创建新 Run 或请求输入。

## 快速开始

### 1. 安装 CLI 和 Skill

> [!TIP]
> acpus cli 提供了 bundle skill， agent 会自己根据帮助命令来使用 acpus， 比如你可以和 Agent 说：
> "使用 acpus cli 工具来启动一个 workflow，判断这个 release 是否可以发布"

```sh
npm install -g acpus
acpus skill install # 可选
```


### 2. 描述目标

> [!TIP]
>
> ```text
> /acpus 启动一个 Workflow，判断这个 release 是否可以发布
> ```

Orchestrator Agent 会选择 Workflow 结构和 Worker Agent。
你也可以指定角色，例如让 Claude 审查，让 Codex 汇总结果。

## 为什么使用 TypeScript Workflow

- **可以审查。** Workflow 是真实的 TypeScript 模块，可以直接查看和修改。
- **可以混用 Agent。** 同一 Workflow 可以为不同角色配置不同的 ACP-compatible Agent，你可以让 Claude Code 来写代码，让 Codex 来 review。
- **运行前会检查。** Acpus 会先检查类型和 Workflow 结构，再创建 Run。
- **源码位置灵活。** 一次性 Workflow 可以从 stdin 传入；需要修改或复用时，可以保存为文件。

## 一个完整示例

下面的 Workflow 并行运行两次审查，再由第三个 Agent 汇总结果。

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

## 运行与控制

> [!TIP]
> 通常不需要你来执行这些命令。你的 Agent 会帮你检查和运行 Workflow，并查看和控制 Run。

### 检查和运行 Workflow

一次性 Workflow 适合使用带引号的 heredoc。
如果源码包含本地 Task/helper 模块，或需要继续修改和复用，请保存为 `workflow.ts`。
临时源码也可以放在项目目录之外。

```sh
# 检查 Workflow，但不创建 Run
acpus workflow check workflow.ts --input '{"topic":"release readiness"}'

# 在终端查看静态工作流树
acpus workflow viz workflow.ts

# 生成自包含的 HTML 工作流图
acpus workflow viz workflow.ts --out workflow.html

# 创建 Run
acpus workflow run workflow.ts --input '{"topic":"release readiness"}'

# 查看 Run
acpus runs inspect <run-id>
```

`workflow check` 会执行类型检查、编译和验证，但不会创建 Run。
`workflow viz` 默认在终端显示工作流树；`--out` 会生成 HTML 文件。
`workflow run` 创建 Run，并输出简短的 inspect/follow 提示。
`runs inspect` 显示 Run 的持久化状态。

### 查看和控制 Run

#### 查看状态

```sh
acpus runs inspect <run-id>
acpus runs inspect <run-id> --forensics
acpus runs inspect <run-id> --target <node-or-attempt> --forensics
acpus runs inspect <run-id> --await-decision
acpus runs inspect <run-id> --follow
```

`--forensics` 显示冻结的定义、实际调用值和调度器接受的结果。
省略 `--target` 时，它默认检查 `root`。

`--await-decision` 会等待下一处需要判断的输入、暂停或终态。
`--follow` 只等待 Run 进入终态。

#### 运行控制

```sh
acpus runs pause <run-id>
acpus runs resume <run-id>
acpus runs retry <run-id> --target <node-or-@ref>
acpus runs signal <run-id> --target <signal-or-@ref> --payload '{"approved":true}'
acpus runs fork <run-id> --workflow workflow.ts
```

`retry` 重试当前 Run 中失败的部分。
`fork` 创建新 Run。
新 Run 只会复用与新 Workflow 兼容、且依赖未变化的已完成工作。

## Hook

通过 Hook 在 Workflow 执行的特定生命周期执行本地命令，例如:
* 运行启动时和完成后，执行特定的环境准备和清理工作
* 运行等待 Signal 输入时，发送通知给你
* 执行到特定类型节点前，记录执行信息到特定日志文件

Hook 命令失败或超时不会改变 Workflow 的状态和输出。

项目级 Hook 写在 `.acpus/hooks.json`，对所有项目生效的 Hook 写在 `~/.acpus/hooks.json`。下面的配置会在 Run 等待输入时执行项目中的通知脚本：

```json
{
  "run.awaiting": [
    {
      "id": "notify-me",
      "command": "./scripts/notify-acpus.sh",
      "timeout": "10s"
    }
  ]
}
```

命令会在 Workflow 的工作目录中运行，并从标准输入收到本次事件的 JSON, Hook 事件的传参包含 Agent Prompt、Task 输入和输出等。

保存后检查配置：

```sh
acpus hooks validate
acpus hooks list
```

Acpus 启动时读取 Hook 配置，修改后的配置会在下次启动时生效。完整的事件列表、筛选方式和输入格式见 [Runtime Hooks 配置](packages/cli/skills/acpus/references/hooks-json.md)。

你也可以让你的 Agent 来配置 Hook。

## 配置 Agent

Acpus 通过 `@acpus/acp` 使用稳定的 ACP v1 会话接口。对于 Workflow 中的
`{ use: "name" }`，每个 Agent Attempt 按以下优先级解析具名的结构化 `argv` 启动项：

1. Host 提供的具名启动项
2. Attempt 有效工作目录中的 `.acpus/agents.json`
3. `~/.acpus/agents.json`
4. Acpus 内置 Agent 目录

在有效工作目录中创建 `.acpus/agents.json` 即可添加或覆盖 Agent：

```json
{
  "agents": {
    "my-agent": { "argv": ["node", "./scripts/agent-acp-bridge.mjs"] }
  }
}
```

`argv` 首项是可执行程序，其余每项都是一个独立参数。项目配置覆盖同名全局配置；
配置无效或所有来源都没有该名称时，Attempt 会以配置错误失败。显式
`{ command: "..." }` 会绕过上述具名解析。

Workflow Agent profile 还可声明 `model` 和字符串到字符串的 `config` 选项，例如
`{ use: "my-agent", model: "model-id", config: { reasoning_effort: "high" } }`。
Acpus 将它们作为 ACP 会话的期望 model 和 options 应用，并在恢复会话时重放。

## Skill 安装的补充说明

你也可以使用 skills CLI 安装内置 Skill：

```sh
npx skills add kelvinschen/acpus/packages/cli/skills/acpus
```

`acpus skill install` 可以在交互式终端中询问安装范围和 Agent 目标。
脚本调用必须提供 `--project` 或 `--global`。
同时还要提供 `--agent universal`、`--agent claude` 或 `--agent universal,claude`。

安装命令会创建所需目录。
它会把 Skill 写入项目目录或操作系统 home 下的 `.agents/skills/acpus` 和/或 `.claude/skills/acpus`。

不安装 Skill 也可以使用 Acpus。
Agent 可以运行 `acpus skill read` 来读取内置指南。
在 Prompt 中写明“使用 acpus”即可。

## 核心概念

### 执行单元

| 元素 | 用途 |
| --- | --- |
| **Agent** | 让 ACP-compatible Agent 执行研究、实现、审查或汇总。 |
| **Task** |  使用 JS 代码执行文件操作、命令和验证、生成 Artifact。 |
| **Signal** | 等待用户或外部控制者提交类型化 Payload。等待状态会持久保存。 |
| **控制流** | `if`、`switch`、`parallel`、`fanout` 和 `loop` 组合节点；`assert` 检查条件。 |

### 持久化对象

Acpus 将 Run 状态保存在当前 Workspace。

| 概念 | 含义 |
| --- | --- |
| Workflow module | 从 stdin 或文件路径提供的 TypeScript 模块。它声明 Agent、节点、值流和输出。 |
| `WorkflowIR` | Acpus 检查并编译 TypeScript 后生成的冻结、可序列化工作流图。 |
| Run | 一次已创建的执行。它包含冻结的 Workflow 数据、输入和 Agent 映射。 |
| Node | Workflow 中稳定的执行单元。每个 Node 在运行时有 Attempt；动态控制流还会生成可寻址实例。 |
| Artifact | Task 或 Agent Attempt 注册的持久化文件。Artifact 与 Run 关联。 |

## 从旧版本迁移

Acpus 0.5 使用 YAML Workflow Spec，并采用不同的节点模型和 CLI。
当前版本使用 TypeScript 模块、`Expr` 值流、Agent、Task、Signal、新的控制面和新的持久化 Runtime。
当前版本不提供兼容层（compatibility shim）。

[迁移指南](docs/migrate-to-next.md) 说明概念对应关系和重写步骤。
旧版文档见
[Acpus 0.5.2 中文 README](https://github.com/kelvinschen/acpus/blob/acpus%400.5.2/README.zh.md)。

## 文档

- [内置 Acpus Skill](packages/cli/skills/acpus/SKILL.md)
- [ACP Session Runtime 架构](docs/acp-session-runtime.md)
- [ACP Session Supervisor 重构 Roadmap](docs/roadmap/acp-session-supervisor-redesign.md)
- [迁移指南](docs/migrate-to-next.md)
- [发布指南](docs/releasing.md)
- [Specs 索引](specs/INDEX.md)
- [Core Spec](specs/core-spec.md)
- [Expression Spec](specs/expression-spec.md)
- [Workflow Compiler Spec](specs/workflow-compiler-spec.md)
- [Runtime Spec](specs/runtime-spec.md)
- [CLI Spec](specs/cli-spec.md)
- [WebUI Spec](specs/webui-spec.md)

当前行为以 `specs/` 为准。
未来工作放在 `docs/roadmap/`。
旧版本保留在 Git Tag 历史中。

## 开发

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## 许可证

MIT
