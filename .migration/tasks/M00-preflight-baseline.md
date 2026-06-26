# M00 — 预检、基线与工作约束

Status: Completed on 2026-06-26.

## 目标

确认本地 checkout 与 `next/rust-port` 基线一致，记录当前测试状态，为后续模块提供可比较的 baseline。

## 允许修改

本模块默认不修改源码。允许新增：

```text
docs/refactor/baseline.md
```

## Codex 指令

```text
你正在 kelvinschen/acpus 的 next/rust-port 分支工作。
执行 M00 预检。不要修改业务代码。
运行预检命令，记录当前通过/失败状态到 docs/refactor/baseline.md。
如果某些命令因为本地缺少工具失败，只记录原因，不改源码绕过。
```

## 执行步骤

```bash
git status --short
git branch --show-current
git rev-parse --short HEAD
rustc --version || true
cargo --version || true
node --version || true
pnpm --version || true
```

如果工作区不干净，先停下，让操作者决定是否 stash/commit。

记录 baseline：

```bash
cargo fmt --all -- --check || true
cargo clippy --workspace --all-targets -- -D warnings || true
cargo test --workspace || true
pnpm install --frozen-lockfile || pnpm install || true
pnpm typecheck || true
pnpm test || true
```

把命令结果摘要写入：

```text
docs/refactor/baseline.md
```

## 必须通过

本模块没有硬性测试通过要求，但必须生成 baseline 记录。

## 验收标准

- `docs/refactor/baseline.md` 存在。
- 记录了 git commit、工具版本、每个 baseline 命令的状态。
- 没有修改 Rust/TS 业务代码。

## 禁止事项

- 不要改 `Cargo.toml`。
- 不要改 `package.json`。
- 不要删测试。
