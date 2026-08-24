# Loader SPEC

## 目的

`@acpus/loader` 负责在包之间统一解析与加载 TypeScript Workflow 及可复用 Task 模块。无论是在源码开发模式还是在已发布的 npm 包安装环境中，它都为 Workflow Compiler 与执行方提供一致的官方包导入入口与依赖解析规则。

## 要求

- 无论在源码开发模式还是已发布的安装环境中，官方编写入口 MUST 准确解析到匹配的 Acpus 实现。具体支持的入口由各包的 `exports` 定义。
- 通过官方编写入口加载模块时，MUST NOT 强制要求用户的 Workflow 项目工作区额外安装底层的 Acpus 内部实现包。
- 加载编写模块时，调用方 MUST 明确提供 referrer（发起导入的源文件）；相对导入 MUST 以此为基准。对于从调用方指定源码范围内发起的 bare package import（通过包名导入模块），如果常规解析失败且调用方提供了 dependency authority（依赖解析来源），Loader MUST 仅从该来源继续查找。
- Loader 在解析过程中 MUST NOT 擅自修改进程当前工作目录（cwd），也 MUST NOT 自行猜测或推导 Workflow Compiler 与 Runtime 未显式提供的依赖来源。
- 在源码模式与发布安装模式下，针对 Workflow Compiler 准备阶段与可复用 Task 运行阶段的模块解析行为 MUST 保持完全一致。
- 只有首选目标确实不存在时，Loader MUST 尝试该包在 `development` 条件下选中的 export target；一旦首选目标存在，解析、访问或执行它时发生的失败 MUST 原样返回，MUST NOT 被回退机制掩盖。
- 当加载失败时，Loader MUST 保留完整的模块解析或执行上下文信息，以便上层的 Workflow Compiler 或 Runtime 能够准确报告具体是哪项导入失败。
- Loader 仅负责模块定位与加载，MUST NOT 负责源码快照捕获、数据持久化、生成唯一标识、磁盘清理、维护 Runtime 状态或执行面向用户的命令；这些生命周期行为由各自的调用方负责。

## 验证

- `pnpm --filter @acpus/loader typecheck` 与 `pnpm test:contract packages/loader`：验证 Workflow Compiler 与 Runtime 共用的显式模块加载接口契约。
- `pnpm test:integration packages/loader`：验证源码模式与发布模式的一致性、显式依赖解析来源以及保留底层失败的回退查找行为。
