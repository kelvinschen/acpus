# Expression SPEC

## 目的

`@acpus/expression` 负责在 Workflow Run 期间对动态值进行类型化计算与模板渲染。它为 [Core](core-spec.md) 与 Runtime 等使用方提供统一的持久化表达式契约，无需将轻量计算拆分为独立的 Workflow 节点。

## 要求

### 编写语义

- 在构建图期间，表达式 MUST 保持为未求值的运行时占位值。编写者 MUST NOT 对表达式直接使用 JavaScript 的真值判断（truthiness）、原生运算符、条件控制流、模板字符串插值或集合遍历方法。
- 直接读取对象的属性或数组下标 MAY 生成新的子表达式。所有其他数据转换或比较操作 MUST 通过表达式辅助函数显式声明其运行时依赖。
- 通过 `lift(...)` 声明的计算 MUST 同步执行，仅依赖显式声明的参数和标准运行时全局对象计算结果，并返回可持久化的 Workflow 数据；MUST NOT 创建 Workflow 节点、执行异步操作，或通过闭包引用 Workflow 作用域或模块作用域中的外部变量。
- 表达式计算过程 MUST NOT 被视为安全沙箱。不可信的代码或包含副作用的操作 MUST 放在 Task 执行边界内运行。
- 精确字符串模板 MUST 完整保留声明中的所有空白字符。Markdown 模板 MUST 自动剥离首尾空行并去除各行共有的缩进，同时保持其中的插值表达式内容不变。

### 持久化求值

- 字面量输入以及表达式计算成功的结果 MUST 保持为兼容 JSON 的可持久化数据。遇到不支持的类型、循环引用、稀疏数组或非有限数值时，求值 MUST 直接失败，MUST NOT 隐式转换或修复。
- 读取不存在的属性或索引时 MUST 返回临时的 `undefined`。该临时值 MAY 作为 `lift(...)` 的输入传给计算回调，或在外层对象中直接省略；但若将其作为数组元素、模板插值内容或最终的持久化结果输出时，求值 MUST 直接失败。
- 模板插值 MUST 原样渲染字符串，将标量值转为文本格式，并将结构化数据渲染为 JSON 字符串；若插值遇到未定义的值或不可持久化的数据，模板渲染 MUST 直接失败。
- 求值过程 MUST 保护调用方传入的持久化输入数据，防止被计算回调函数意外修改；若回调返回 Promise、抛出异常、无法加载依赖或返回不可持久化的数据，表达式求值 MUST 直接失败。
- 表达式 IR MUST 保持自包含且完全可序列化。校验与求值逻辑 MUST 拒绝格式错误或未知操作，MUST NOT 猜测或推断执行意图。
- Core、Workflow Compiler 与 Runtime 等所有使用方 MUST 采用相同的表达式与模板求值语义。

## 验证

- `pnpm --filter @acpus/expression typecheck` 与 `pnpm test:type packages/expression`：验证类型化表达式编写边界。
- `pnpm test:contract packages/expression`：验证公共持久化 IR、校验与求值边界。
- `pnpm test:unit packages/expression`：验证属性读取、计算、模板与失败语义。
