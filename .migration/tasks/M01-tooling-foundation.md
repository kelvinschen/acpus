# M01 — 工具链与 CI 基础

Status: Completed on 2026-06-26. The initial M00/M01 Rust test failure was later traced to stale local target artifacts and cleared without source changes.

## 目标

引入可重复的本地/CI 命令，但不要接入还不存在的新 crate/package。这个模块应该低风险、可快速回滚。

## 允许修改

```text
rust-toolchain.toml
nextest.toml
justfile
.github/workflows/ci.yml
package.json
pnpm-workspace.yaml
```

## Codex 指令

```text
执行 M01 工具链基础。只建立现有 workspace 可运行的 just/CI 命令，不要把还不存在的新 crates 加入 Cargo workspace。不要引入 @acpus/bindings。
保留现有包名和现有脚本中仍被使用的命令；新增脚本要尽量兼容旧工作流。
完成后运行 fmt/clippy/test/typecheck。
```

## 实施细节

### 1. `rust-toolchain.toml`

推荐 pin 到明确版本。如果当前项目尚未能使用最新版本，Codex 应根据本地 `cargo check` 结果选择能通过的稳定版本。模板：

```toml
[toolchain]
channel = "1.96.0"
components = ["clippy", "rustfmt", "rust-src"]
profile = "minimal"
```

若当前 stable 版本低于 1.96 或工具链不可用，可先保留当前版本，但要在 `docs/refactor/baseline.md` 说明。

### 2. `nextest.toml`

```toml
[profile.default]
fail-fast = false
retries = 0

[profile.ci]
fail-fast = false
retries = 1
```

### 3. `justfile`

先只覆盖现有项目，不引用 bindings：

```make
set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
    just ci

fmt:
    cargo fmt --all

fmt-check:
    cargo fmt --all -- --check

clippy:
    cargo clippy --workspace --all-targets -- -D warnings

test-rs:
    if command -v cargo-nextest >/dev/null 2>&1; then cargo nextest run --workspace --no-fail-fast; else cargo test --workspace; fi

test-ts:
    pnpm -r test

typecheck:
    pnpm -r typecheck

ci:
    just fmt-check
    just clippy
    just test-rs
    just typecheck
    just test-ts

clean:
    cargo clean
    rm -rf packages/*/dist
```

### 4. `package.json`

只增加或调整根脚本：

```json
{
  "scripts": {
    "ci": "just ci",
    "test": "just test-rs && just test-ts",
    "typecheck": "just typecheck",
    "clean": "just clean"
  }
}
```

不要删除现有脚本，除非确认没有引用。

### 5. CI

新增 `.github/workflows/ci.yml`，使用 Node 22、pnpm、Rust toolchain、nextest，然后执行 `just ci`。

## 必须通过

```bash
just fmt-check
just clippy
just test-rs
pnpm install --frozen-lockfile || pnpm install
just typecheck
just test-ts
```

如果 baseline 已有失败，Codex 只能修 M01 引入的问题；旧失败记录到模块总结。

## 验收标准

- `just ci` 可作为统一入口。
- 没有引用尚未存在的 crate/package。
- CI workflow 与本地 `just ci` 对齐。

## 禁止事项

- 不要新增 Rust crate。
- 不要新增 `packages/bindings`。
- 不要改 TUI facade。
