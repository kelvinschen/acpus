# M14 — 最终 CI hardening 与迁移完成检查

Status: Completed on 2026-06-26.

Execution note: finalized `just ci` as the single full validation entrypoint, updated GitHub Actions setup/fetch steps, added package script aliases, and recorded final verification in `docs/refactor/final-verification.md`.

## 目标

把所有质量门禁串成最终 `just ci`，确认重构已经从脚手架变成最终状态。

## 允许修改

```text
justfile
.github/workflows/ci.yml
package.json
pnpm-workspace.yaml
Cargo.toml
docs/refactor/**
```

## Codex 指令

```text
执行 M14。整理最终 CI/just/package scripts，确保 just ci 包含 fmt、clippy、bindings-check、Rust tests、TS typecheck/tests、boundary-check、E2E。
不要修改业务逻辑，除非是修复 CI 暴露的问题。
```

## 最终 justfile 应包含

```make
fmt
fmt-check
clippy
bindings
bindings-check
test-rs
test-ts
typecheck
e2e
boundary-check
ci
clean
```

`ci` 推荐顺序：

```make
ci:
    just fmt-check
    just clippy
    just bindings-check
    just boundary-check
    just test-rs
    just typecheck
    just test-ts
    just e2e
```

## 最终 CI workflow

- checkout
- setup pnpm/node
- setup pinned Rust
- install nextest
- pnpm install frozen lockfile
- cargo fetch locked
- just ci

## 最终完成报告

更新：

```text
docs/refactor/migration-matrix.md
docs/refactor/final-verification.md
```

`final-verification.md` 写入：

```text
commit hash
工具版本
just ci 输出摘要
boundary-check 输出摘要
已知遗留项
```

## 必须通过

```bash
just ci
git diff --exit-code packages/bindings/src/generated
```

## 验收标准

- 一条 `just ci` 能完整验证项目。
- generated bindings 无 drift。
- docs 标记迁移完成。

## 禁止事项

- 不要把失败测试从 CI 移除。
- 不要降低 clippy 严格度。
