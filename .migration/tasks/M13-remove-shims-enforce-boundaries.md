# M13 — 移除兼容 shim 与 enforce boundaries

Status: Completed on 2026-06-26.

Execution note: added a CI-enforced `just boundary-check` for the Rust-first crate graph and updated the migration matrix to completed status. `acpus-core` remains as a transitional re-export/helper crate because runtime/store/supervisor still use its public agent override and hook APIs.

## 目标

在所有迁移完成后，移除过渡 re-export/shim，强制 Rust-first 边界，防止回退到 TS-shaped port。

## 允许修改

```text
crates/**
packages/**
Cargo.toml
justfile
docs/refactor/**
```

## Codex 指令

```text
执行 M13。移除已经不需要的 compatibility shim，添加依赖边界检查。
只有在 M09/M10/M11/M12 全部通过后才能执行。
不要删除仍被 public API 依赖的兼容项，除非同步更新调用方和测试。
```

## 边界检查

加入 just target：

```make
boundary-check:
    ! cargo tree -p acpus-spec --edges normal | grep acpus-runtime
    ! cargo tree -p acpus-ir --edges normal | grep -E 'acpus-core|acpus-runtime'
    ! cargo tree -p acpus-compiler --edges normal | grep acpus-runtime
    ! cargo tree -p acpus-runtime --edges normal | grep -E 'axum|reqwest|clap'
```

根据 shell 兼容性可改写为 bash 函数。

## 清理清单

- `acpus-core` 如果已空，改成 deprecated re-export crate 或移出 workspace。
- 删除 TUI 中残留 domain type duplicate。
- 删除 runtime 中残留 HTTP server/client 代码。
- 删除 runtime 中残留 file store implementation。
- 删除 compiler 中对 `acpus-core` 的 dependency。
- 更新 docs/refactor/migration-matrix.md 状态为 completed。

## 必须通过

```bash
just boundary-check
just bindings-check
just ci
```

## 验收标准

- 边界检查进 CI。
- 没有循环依赖。
- TUI/WebUI 未来可复用 `@acpus/bindings`。

## 禁止事项

- 不要提前删除兼容层。
- 不要为了边界检查通过而隐藏依赖或关闭测试。
