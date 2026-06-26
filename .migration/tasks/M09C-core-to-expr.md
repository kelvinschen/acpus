# M09C — expression/CEL/template 迁入 `acpus-expr`

Status: Completed on 2026-06-26.

## 目标

把 expression scope、CEL evaluation、template interpolation 从 `acpus-core` 迁入 `acpus-expr`，供 compiler/runtime 共享。

## 允许修改

```text
crates/acpus-expr/**
crates/acpus-core/**
crates/acpus-compiler/**
crates/acpus-runtime/**
Cargo.toml
```

## Codex 指令

```text
执行 M09C。把 eval.rs、expression_scope.rs、template interpolation、CEL wrapper 等 expression 相关逻辑迁入 acpus-expr。
acpus-core 保留 re-export。
不要迁移 compiler lowering 或 runtime engine。
```

## 操作步骤

```bash
rg "eval|Eval|ExpressionScope|template|CEL|cel" crates/acpus-core crates/acpus-runtime crates/acpus-compiler
```

迁移后依赖方向：

```text
acpus-expr 不依赖 acpus-core/runtime/compiler
acpus-compiler 依赖 acpus-expr
acpus-runtime 依赖 acpus-expr
acpus-core re-export 或 adapter 到 acpus-expr
```

## 测试要求

`acpus-expr` 至少覆盖：

```text
renders_scalar_template
unknown_reference_returns_error
non_scalar_template_returns_error
cel_boolean_condition
cel_path_access
invalid_cel_returns_typed_error
```

如果当前 CEL crate API 难以隔离，先封装 compatibility adapter，但 public API 要在 `acpus-expr`。

## 必须通过

```bash
cargo test -p acpus-expr
cargo test -p acpus-compiler
cargo test -p acpus-runtime
cargo test --workspace
cargo fmt --all -- --check
```

## 验收标准

- expression 行为由 `acpus-expr` 测试覆盖。
- compiler/runtime 不再直接依赖 `acpus-core` 的 eval internals。
- 原 CLI/runtime 行为保持。

## 禁止事项

- 不要让 expression evaluation 访问 filesystem/network。
- 不要把 runtime store/state 放入 expr crate。
