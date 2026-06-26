# M16 — CLI UX Help and Diagnostics

Status: Completed on 2026-06-26.

## 目标

让 Rust `acpus` CLI 的用户体验成为 TS 版的超集：命令行为和 JSON contract 保持兼容，但 help、examples、参数说明、错误提示和可测试性明显增强。

## 允许修改

```text
.migration/README.md
.migration/tasks/**
crates/acpus-cli/**
docs/refactor/**
```

## 完成记录

- 为 public CLI 命令、参数和选项补充 `help`、`value_name`、`long_about` 和 examples。
- `workflows` alias `wf` 改为 visible alias，public help 中可见；hidden `supervisor` 仍不出现在 public help。
- `workflows run`、`runs fork`、`runs signal`、`runs visualize`、`hooks validate` 增加 examples。
- `--input`、`--agents`、`--payload`、`--poll`、`--serve` 等关键选项补充输入格式和行为说明。
- human diagnostics 增加 `Hint:`，覆盖冲突 submission flags、无效 `--poll`、无效 `--serve`、payload/input 非 object、workflow lookup 等场景。
- 新增 help contract tests，用 substring assertions 锁定核心 help 页面和关键参数说明。
- 保持 exit codes 和 JSON error envelope 结构不变；未新增 interactive wizard、未新增命令 alias、未改变 REST/supervisor 行为。

## 必须通过

```bash
cargo test -p acpus-cli
just ci
```

## 验收标准

- `acpus --help` 显示 `wf` alias 且不显示 hidden `supervisor`。
- 核心 public help 页面不再出现空说明的 `<TARGET>` / `<RUN_ID>` 风格参数。
- 高复杂命令显示 `Examples:`。
- `cargo test -p acpus-cli` 包含 help UX contract tests。
- `just ci` 通过。
