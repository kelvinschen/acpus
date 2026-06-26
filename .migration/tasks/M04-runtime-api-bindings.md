# M04 — `acpus-runtime-api` 与 TypeScript bindings

Status: Completed on 2026-06-26.

## 目标

建立 Rust-owned JSON contract，并生成 `@acpus/bindings`，为 TUI/WebUI 消费同一套类型做准备。

## 允许修改

```text
crates/acpus-runtime-api/**
packages/bindings/**
package.json
pnpm-workspace.yaml
justfile
Cargo.toml
```

## Codex 指令

```text
执行 M04。把 runtime/TUI 共享的 JSON contract 定义到 acpus-runtime-api，并新增 @acpus/bindings 包。
此模块不要改 packages/tui/src/acpus.ts，只准备 bindings。
如果无法一次接入 ts-rs，可先用 Rust exporter 写出 types.ts，但必须保持 Rust 是事实来源，并在后续模块继续收敛到 derive/codegen。
```

## Rust contract 最小集合

`acpus-runtime-api` 应包含：

```text
JsonObject
Timestamp
RunId
NodeKey
NodeId
ArtifactRef
RunStatus
NodeState
RunState
RunSummary
NodeExecutionState
SupervisorHealth
SignalRequest
RetryRequest
ReplayRequest
ForkRequest
ReplayResult
RunCleanResult
ApiErrorCode
ApiErrorBody
RunEvent
AcpusIr / IrNode / IrNodeKind / IrBranch / NodeKeyTemplate
```

字段命名要匹配当前 HTTP/TUI JSON shape，优先保持兼容。

## TS bindings 包

新增：

```text
packages/bindings/package.json
packages/bindings/tsconfig.json
packages/bindings/src/index.ts
packages/bindings/src/generated/types.ts
```

包名：

```json
"name": "@acpus/bindings"
```

`src/index.ts`：

```ts
export * from "./generated/types.js";
```

## 生成命令

`crates/acpus-runtime-api/src/bin/export-ts-bindings.rs`：

```rust
fn main() -> anyhow::Result<()> {
    // 输出 packages/bindings/src/generated/types.ts
    Ok(())
}
```

理想状态使用 `ts-rs` derive；过渡阶段允许 `include_str!("typescript.ts")` 输出，但必须在文档中标注这是 transitional。

## justfile 更新

新增但暂不强制进 `ci`，除非本模块已经稳定：

```make
bindings:
    cargo run -p acpus-runtime-api --bin export-ts-bindings
    pnpm --filter @acpus/bindings build

bindings-check:
    just bindings
    git diff --exit-code packages/bindings/src/generated
```

## 必须通过

```bash
cargo run -p acpus-runtime-api --bin export-ts-bindings
pnpm install
pnpm --filter @acpus/bindings build
pnpm --filter @acpus/bindings typecheck
cargo test -p acpus-runtime-api
```

## 验收标准

- `packages/bindings/src/generated/types.ts` 存在且可编译。
- Rust/TS 字段名与当前 TUI/supervisor JSON 兼容。
- 本模块没有修改 TUI 业务代码。

## 禁止事项

- 不要让 `@acpus/bindings` 包含业务逻辑。
- 不要让 TS 手写类型成为事实来源。
- 不要把 runtime engine 迁入 runtime-api。
