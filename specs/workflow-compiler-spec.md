# Workflow Compiler SPEC

## 目的

`@acpus/workflow-compiler` 将 TypeScript Workflow 源码转换为经过校验、可直接用于准入运行的 Workflow 数据。它负责在不执行源码的前提下检查编写规则，并完成源码冻结、Task 引用关联和准备结果输出；[Loader](loader-spec.md) 负责模块导入解析，[Core](core-spec.md) 负责图结构转换与校验，[Expression](expression-spec.md) 负责表达式计算语义。

## 要求

### 静态编写分析

- 提取 Workflow 静态元数据或执行静态代码检查时，Workflow Compiler MUST 只分析源码，MUST NOT 导入或执行 Workflow 模块代码，也 MUST NOT 运行任何 Workflow 节点。
- 仅当静态分析能够无歧义确定默认 Workflow 声明及其最终名称时，元数据提取 MUST 返回该 Workflow 名称；若存在歧义，MUST 返回类型化的元数据错误，MUST NOT 通过实际执行源码来试探名称。
- 静态检查 MUST 拒绝任何违反 [Core](core-spec.md) 和 [Expression](expression-spec.md) 中回调函数与 Task 编写规则的源码，并且对同一输入 MUST 给出与这些规范一致的判断。
- 静态检查过程 MUST NOT 加载用户的外部 Lint 配置文件或第三方规则 Preset。
- 检查失败的诊断结果 MUST 保持可序列化、附带可定位的源码位置信息，并在相同源码下产生确定性的输出；报错信息 MUST 具备明确的操作指引，同时 MUST NOT 泄露编译器内部实现细节。

### 准备边界

- 完整的 Workflow 准备流程 MUST 在正式导入源码前先完成静态检查。准备阶段 MAY 执行模块初始化代码和同步的 Workflow 构建回调以冻结图结构，但 MUST NOT 触发 Agent、Task、Signal 或 Composite 的运行实例（occurrence）实际执行。
- 如果在冻结图结构完成前，已检查的 Workflow 源码或依赖的本地源码文件发生了变更，准备过程 MUST 失败并报告错误；MUST NOT 返回拼凑了不同源码版本的构建结果。
- 引用的可复用 Task MUST 解析为模块中可加载且可识别的 Task 导出值。若 Task 引用无法完整关联或解析，准备过程 MUST 失败，MUST NOT 生成未绑定的占位执行目标。
- 仅当静态检查、模块加载、图结构转换与完整性校验均成功时，准备流程 MUST 返回最终结果。对于无法纳入静态源码依赖图的模块加载，相关警告 MUST NOT 阻塞准备，且 MUST 随结果一并返回。
- 对于可恢复的失败，Workflow Compiler MUST 输出具有稳定错误类型与说明的信息，明确指出失败发生在源码捕获、静态检查、编译、图校验还是依赖锁文件读取阶段。上层调用方 MUST 原样传递底层错误，MUST NOT 自行臆测或篡改其含义。
- 准备流程 MUST NOT 创建或修改任何 Runtime 存储分片。

### 已准备的 Workflow 数据

- 如果入口文件位于当前工作区目录下，MUST 直接以实时工作区源码的形式引用。通过显式文件列表传入或位于工作区外的文件，MUST 打包捕获为只读快照源码。
- 无论是实时源码还是快照源码，调用方传入的工作区目录 MUST 始终作为 Workflow 的执行工作目录以及 bare package dependency（通过包名引用的依赖）的解析来源；Workflow Compiler MUST NOT 从临时创建的目录中自行推导其他依赖来源。
- 源码快照 MUST 完整包含检查和编译 Workflow 所需的全部本地 TypeScript 文件，外部 bare package 则作为环境依赖项保留。显式传入的文件即使未被入口直接 import，也 MUST 保留在该快照中。
- 快照的内容及其唯一标识 MUST 具备环境无关的可移植性，MUST NOT 受到文件原本所在的绝对路径、编译器临时目录、文件修改时间戳或目录遍历顺序的影响。
- 针对实时源码准备的 Workflow MUST 直接以工作区目录作为可信源，MUST NOT 冗余复制一份源码快照。针对快照准备的 Workflow MUST 自带重现冻结图所需的完整本地源码，且完全脱离对原始磁盘根目录的依赖。
- 准备生成的标识与 Lock 数据 MUST 确定性地将冻结后的 Workflow IR 与其逻辑源码内容绑定。附带的 package-lock 标识 MAY 用于记录依赖环境信息，但 MUST NOT 影响源码本身的唯一标识。
- 编译器内部的私有路径与临时目录等实现细节，MUST NOT 泄露到最终生成的 IR、诊断日志、源码引用、Bundle、Lock 数据或类型化错误信息中。

## 验证

- `pnpm --filter @acpus/workflow-compiler typecheck` 与 `pnpm test:type packages/workflow-compiler`：验证调用方无需编译器内部实现即可区分准备成功与失败。
- `pnpm test:contract packages/workflow-compiler`：验证已准备的 Workflow 数据可由 Runtime 跨环境可靠消费。
- `pnpm test:integration packages/workflow-compiler`：验证非执行检查、源码版本一致性、源码来源与 Task 链接。
