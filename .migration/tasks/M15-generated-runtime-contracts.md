# M15 — Generated Runtime Bindings and Supervisor Client

Status: Completed on 2026-06-26.

## 目标

用成熟 codegen 替代手写 runtime TypeScript contract：

- 用 `ts-rs` 从 Rust DTO 生成 `packages/bindings/src/generated/types.ts`。
- 用 `utoipa` / `utoipa-axum` 生成 supervisor OpenAPI。
- 用 `openapi-typescript` / `openapi-fetch` 生成并封装共享 TS supervisor client。

## 允许修改

```text
.migration/tasks/**
crates/acpus-ir/**
crates/acpus-runtime-api/**
crates/acpus-supervisor/**
packages/bindings/**
packages/tui/**
Cargo.toml
Cargo.lock
package.json
pnpm-lock.yaml
justfile
docs/refactor/**
```

## 必须通过

```bash
cargo test -p acpus-runtime-api
cargo test -p acpus-ir
cargo test -p acpus-supervisor
pnpm --filter @acpus/bindings typecheck
pnpm --filter @acpus/tui test
just bindings-check
just boundary-check
just ci
git diff --exit-code packages/bindings/src/generated
```

## 验收标准

- `crates/acpus-runtime-api/src/typescript.rs` 不再手写 struct/enum/interface body。
- generated bindings 覆盖 runtime API 和 IR DTO。
- `packages/bindings` 导出共享 `RunSupervisorClient`。
- TUI 不再拥有 supervisor HTTP fetch client，只 re-export 共享 client/errors 并保留展示辅助函数。
- `packages/bindings/src/generated/openapi.json` 和 `openapi.ts` 可由 `just bindings` 重建且无 drift。

## 完成记录

- `acpus-runtime-api` 和 `acpus-ir` 的公开 DTO 已增加 `ts-rs` / `utoipa` derives。
- `TYPESCRIPT_BINDINGS` 已替换为 `typescript_bindings()`，生成器只保留固定 header 和 primitive aliases。
- `acpus-supervisor` 已导出 `supervisor_openapi()` 和 `export-openapi` binary。
- `packages/bindings` 已生成 `types.ts`、`openapi.json`、`openapi.ts`，并封装 `openapi-fetch` 版 `RunSupervisorClient`。
- `packages/tui/src/acpus.ts` 已删除本地 supervisor fetch client，改为 re-export `@acpus/bindings` 的 client/errors。
- `just bindings` / `bindings-check` 已覆盖 ts-rs、OpenAPI、OpenAPI TS client 生成链路。

## 禁止事项

- 不改变现有 REST/JSON endpoint 行为。
- 不引入 RPC/gRPC/protobuf。
- 不删除 `acpus-core` 兼容层。
