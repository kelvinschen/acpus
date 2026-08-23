# SPEC 索引

SPEC 定义了 Acpus 当前稳定的产品契约：即在底层实现变更后，调用方、运维人员或协作模块仍可依赖的行为。生产代码是当前运行机制的可信来源；导出类型、Schema、命令帮助与配置定义了精确的数据结构，自动化测试提供可执行证据。SPEC 不用文字重复这些已有信息。

草案与能力规划属于 `docs/roadmap/`。已完成的规划、已移除的行为与过往实现属于 Git 历史与发布标签。

## 模板

每个 SPEC MUST 使用如下结构：

```md
# {能力或模块} SPEC

## 目的

用一小段话说明负责包、主要使用者和长期稳定的模块边界。

## 要求

- {产品、调用方或模块} MUST 保持 {稳定结果或不变式}。

## 验证

- `{针对性命令}`：验证 {契约风险}。
```

在添加要求之前，请先对照 [SPEC 维护指南](../docs/specification-maintenance.md) 中的四项准入检查。

## 编写与准备

| SPEC | 负责包 | 长期契约 |
| --- | --- | --- |
| [Core](core-spec.md) | `@acpus/core` | 静态 Workflow 编写、可持久化数据与冻结图结构的语义 |
| [Expression](expression-spec.md) | `@acpus/expression` | 类型化运行时计算与可持久化表达式的求值语义 |
| [Workflow Compiler](workflow-compiler-spec.md) | `@acpus/workflow-compiler` | 静态检查、源码冻结与可供 Runtime 准入的 Workflow 数据 |
| [Loader](loader-spec.md) | `@acpus/loader` | 源码模式与发布模式下的官方编写入口，以及调用方明确指定的依赖解析来源 |
| [Tasks](tasks-spec.md) | `@acpus/tasks` | 内置可复用 Task 的安全行为与防误删边界 |

## 持久化运行

| SPEC | 负责包 | 长期契约 |
| --- | --- | --- |
| [Configuration](configuration-spec.md) | `@acpus/runtime` | 项目与全局作用域、优先级、私密配置与生命周期可见性 |
| [Runtime](runtime-spec.md) | `@acpus/runtime` | 绑定工作区的持久化准入与执行、恢复、控制、修剪（Prune）及一致性检查 |
| [Runtime Hooks](hooks-spec.md) | `@acpus/runtime` | 按提交顺序观察事件，且不干扰 Workflow 执行 |
| [ACP](acp-spec.md) | `@acpus/acp` | ACP Session、Turn、权限控制、恢复与私有恢复数据 |
| [Agent Executor](agent-executor-spec.md) | `@acpus/agent-executor` | 独占 Agent Session 租约、Turn 收尾、取消与所有权恢复 |
| [Owned Process](owned-process-spec.md) | `@acpus/owned-process` | 子进程归属、存活性检测、身份隔离与孤儿进程防护 |

## 产品适配器

| SPEC | 负责包 | 长期契约 |
| --- | --- | --- |
| [DeepSeek Harness 集成](dsh-spec.md) | `@acpus/dsh` | 隔离的嵌入式准入、持久化监管与控制，以及分别向人和模型提供经过信息裁剪的视图 |
| [CLI](cli-spec.md) | `acpus` | Workflow 准备、持久 Run、控制、恢复与内置 Skill 的安全管理 |
| [WebUI](webui-spec.md) | `@acpus/web` | 工作区安全的浏览器检查、图语义、控制、Artifact 安全与交互语言 |
