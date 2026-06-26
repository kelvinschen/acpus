# Acpus Rust-first 完整迁移任务包

这份任务包用于把原先的一键迁移包拆成一组可控、可提交、可验证、可回滚的 Codex 执行任务。

适用分支：`kelvinschen/acpus` 的 `next/rust-port`。

## 使用方式

建议每个模块单独开分支、单独提交、单独跑验证：

```bash
git checkout next/rust-port
git pull --ff-only

# 对每个模块：
git checkout -b refactor/rust-first-mXX-<name>
# 把对应 tasks/MXX-*.md 的指令交给 Codex 执行
# Codex 完成后跑该模块验证命令
git status --short
git diff --stat
git commit -am "refactor: <module summary>"
```

不要一次性交给 Codex 执行全部模块。每个模块的失败面应该被限制在它自己的文件范围内。

## 执行原则

1. **绿色后再进入下一模块**：当前模块的 `必须通过` 命令不通过时，不继续后续模块。
2. **小步提交**：每个模块最多 1 个 Commit；复杂模块按文档里的子模块拆 Commits。
3. **不扩大范围**：Codex 不应在一个模块里顺手重构其它层。
4. **保留兼容层直到最后**：`acpus-core`、`acpus-runtime` 的旧 public API 不要在中前期删除。
5. **测试先行**：每移动一个语义边界，都要先有 fixture、snapshot 或 integration test。
6. **生成物可审查**：TS bindings 和 snapshot 更新必须通过 `git diff` 审查。

## 模块总览

| 模块 | 目的 | 主要风险 | 验证重点 |
|---|---|---:|---|
| M00 | 预检、基线、Codex 工作约束 | 低 | baseline commands |
| M01 | 工具链与 CI 基础，不引入新 crate | 低 | fmt/clippy/test/typecheck |
| M02 | 新 Rust crate 空壳与 workspace 接入 | 中 | cargo metadata/check |
| M03 | docs、fixtures、compiler golden 测试 | 中 | compiler snapshots |
| M04 | `acpus-runtime-api` 与 TS bindings | 中 | bindings build/check |
| M05 | TUI 改为消费 generated bindings | 中 | TUI typecheck/contract tests |
| M06 | `acpus-store` journal/snapshot trait | 中 | store unit tests |
| M07 | `acpus-supervisor` typed client/API boundary | 中 | supervisor client tests/check |
| M08 | `acpus-testkit` 与 integration harness | 中 | testkit compile |
| M09A | core diagnostics/source resolver 迁入 `acpus-spec` | 高 | core + spec tests |
| M09B | IR/hash/schedule 迁入 `acpus-ir` | 高 | compiler snapshots |
| M09C | expression/CEL/template 迁入 `acpus-expr` | 高 | expression tests + runtime tests |
| M09D | compiler lowering/validation 迁入 `acpus-compiler` | 高 | golden + lint |
| M10A | runtime public contract 改用 `acpus-runtime-api` | 高 | Rust/TS contract |
| M10B | runtime store 实现迁入 `acpus-store` | 高 | runtime resume/replay tests |
| M10C | Axum routes 迁入 `acpus-supervisor` | 高 | supervisor API tests |
| M10D | interpreter 拆成 engine/state_machine/effects | 最高 | runtime integration/e2e |
| M11 | CLI thin layer 与 JSON contract tests | 中 | CLI black-box tests |
| M12 | E2E 主链路补齐 | 中 | YAML -> terminal run |
| M13 | 移除兼容 shim、边界 enforcement | 高 | full CI |
| M14 | 最终 CI hardening 与迁移完成检查 | 中 | `just ci` |
| M15 | 生成 runtime bindings 与 supervisor TS client | 中 | bindings drift + OpenAPI client |
| M16 | CLI UX help 与 diagnostics 增强 | 低 | CLI help contract + `just ci` |

## Codex 通用执行模板

每个模块都建议用下面的开头约束 Codex：

```text
你正在 kelvinschen/acpus 的 next/rust-port 分支工作。
只执行当前模块，不要提前做后续模块。
先运行文档中的预检命令，记录失败项。
只修改“允许修改的文件”。若必须修改其它文件，先说明原因。
完成后运行“必须通过”的命令。
若失败，优先修当前模块引入的问题；不要绕过测试，不要降低 lint，不要删除测试。
输出：变更摘要、验证命令结果、仍需后续模块处理的问题。
```

## 完整完成标准

最终状态必须满足：

```text
acpus-spec          不依赖 runtime/supervisor/cli
acpus-ir            不依赖 compiler/runtime
acpus-expr          不依赖 runtime/supervisor/cli
acpus-compiler      不依赖 runtime/supervisor/cli
acpus-runtime-api   是 Rust/TS JSON contract 唯一事实来源
acpus-store         拥有 durable journal/snapshot
acpus-runtime       不依赖 axum/reqwest/clap/node/tui
acpus-supervisor    拥有 HTTP/SSE/client transport
acpus-cli           变成薄入口
packages/tui        只拥有展示逻辑，domain types 来自 @acpus/bindings
```

最终命令：

```bash
just ci
cargo tree -p acpus-runtime --edges normal | grep -E 'axum|reqwest|clap' && exit 1 || true
cargo tree -p acpus-compiler --edges normal | grep acpus-runtime && exit 1 || true
git diff --exit-code packages/bindings/src/generated
```
