# Tasks SPEC

## 目的

`@acpus/tasks` 提供与 Acpus 一同发布的常用内置 Task。目前包含的 Git Task 能够在保护调用方主代码仓及无关文件系统路径的前提下，创建独立的 git worktree。

## 要求

- 内置 Git Worktree Task MUST 遵守 [Core Task 边界](core-spec.md#持久化边界) 定义的可复用 Task 契约。
- 执行内置 Git Worktree Task 时，该 Task MUST 在指定的 revision 处创建一个处于 detached HEAD 状态的 worktree（未指定时默认使用源代码仓当前的 `HEAD`），并返回下游 Workflow 所需的源仓库路径、目标路径及基准 commit 标识。
- 当源代码仓存在未提交的修改时，该 Task MUST 直接拒绝执行；且 MUST 拒绝将源代码仓自身所在路径作为目标路径。
- 在收到强制替换（force）请求时，仅当 Git 明确确认目标路径确实是当前源代码仓已注册的 worktree 时，该 Task MUST 删除既有目标路径；对于任何无关路径（包括悬空的符号链接），MUST NOT 进行删除。
- 若无法明确确认目标路径的状态，该 Task MUST 采取安全拒绝策略并报告错误，MUST NOT 擅自删除已有文件或继续创建 worktree。
- 遇到 Git 底层错误或因领域规则拒绝执行时，该 Task MUST 输出包含具体原因的操作提示并终止 Task；Runtime 对该 Task 的调度与重试策略 MUST 由上层定义，不属于本包契约。

## 验证

- `pnpm test:contract packages/tasks` 与 `pnpm test:type packages/tasks`：验证官方可复用 Task 模块导出接口及 TypeScript 类型推导。
- `pnpm test:integration packages/tasks`：验证独立 worktree 的创建流程与防误删的安全拒绝边界。
