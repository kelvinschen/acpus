# M03 — docs、fixtures 与 compiler golden 测试

Status: Completed on 2026-06-26.

## 目标

先把“兼容原行为”的测试护栏钉住，后续移动 compiler 内部实现时可以靠 snapshots 发现语义漂移。

## 允许修改

```text
docs/refactor/**
fixtures/workflows/**
crates/acpus-compiler/**
crates/acpus-testkit/**
Cargo.toml
```

## Codex 指令

```text
执行 M03。新增 refactor docs、workflow fixtures、compiler golden/snapshot tests。
不要迁移 compiler 实现，只通过 acpus-compiler facade 调用当前 acpus-core 编译器。
先让测试能跑，再根据实际输出生成 snapshots。
```

## 文档文件

新增：

```text
docs/refactor/rfc-000-rust-first-boundaries.md
docs/refactor/migration-matrix.md
docs/refactor/testing-strategy.md
```

内容要明确：

```text
workflow YAML -> acpus-spec -> acpus-compiler -> acpus-ir -> acpus-runtime
-> acpus-store -> acpus-supervisor -> acpus-runtime-api -> TS bindings -> TUI/WebUI
```

## Fixtures

新增最小集合：

```text
fixtures/workflows/valid/basic-agent.yaml
fixtures/workflows/valid/program-json-output.yaml
fixtures/workflows/valid/include-basic.yaml
fixtures/workflows/valid/retry-policy.yaml
fixtures/workflows/invalid/missing-version.yaml
fixtures/workflows/invalid/duplicate-step-id.yaml
fixtures/workflows/invalid/invalid-cel.yaml
fixtures/workflows/invalid/bad-include.yaml
```

如果当前 compiler 不支持某个 fixture，用 `todo/` 子目录隔离，不要让测试误红。

## Golden tests

在 `crates/acpus-compiler/tests/compiler_golden.rs`：

- valid fixtures：断言 compile ok，并 snapshot `ir`、`schedule`、`diagnostics`。
- invalid fixtures：断言有 diagnostic，并 snapshot diagnostics。

推荐使用 `insta`。

## Snapshot 更新流程

首次生成：

```bash
INSTA_UPDATE=always cargo test -p acpus-compiler --test compiler_golden
cargo insta review || true
```

之后正常验证：

```bash
cargo test -p acpus-compiler --test compiler_golden
```

## 必须通过

```bash
cargo fmt --all -- --check
cargo test -p acpus-compiler
cargo test --workspace
```

## 验收标准

- fixtures 能代表核心 spec 行为。
- snapshots 被提交。
- `acpus-compiler` 仍是 facade，没有大规模移动 `acpus-core`。

## 禁止事项

- 不要为了通过 snapshot 删除核心 fixture。
- 不要把 snapshot failure 直接忽略。
- 不要在这个模块拆 runtime。
