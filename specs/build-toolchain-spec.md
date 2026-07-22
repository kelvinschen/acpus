# Build Toolchain Spec

## Purpose

The repository build toolchain owns deterministic TypeScript project ordering, package-local incremental state, Web client and server output boundaries, and the root build, typecheck, clean, and verification commands.

## Requirements

### Package Manager

- The workspace MUST pin `pnpm@11.15.1`, and GitHub Actions MUST derive that version from the root `packageManager` field rather than duplicate it in workflow inputs.
- Pull request, main-branch, and manually dispatched CI MUST run on Node.js `22.18.0` and the latest Node.js 24 release.
- Dependency lifecycle scripts MUST fail installation unless explicitly approved; `esbuild` MUST be the sole approved dependency build.
- Dependency resolution MUST block exotic subdependencies and versions published less than 1,440 minutes ago.
- Frozen installs MUST revalidate the committed lockfile against the active supply-chain policies rather than trust it without verification.
- The stable publish job MUST enable npm provenance through `PNPM_CONFIG_PROVENANCE` and MUST reject a mismatched pnpm version before publishing.

### TypeScript Configurations

- Every package development `tsconfig.json` MUST resolve package `development` exports so package-local typechecks consume workspace source.
- Every package MUST provide a `tsconfig.build.json` that extends its development configuration, enables `composite`, disables custom export conditions, and stores incremental state at `./tsconfig.build.tsbuildinfo`.
- Build configurations MUST resolve workspace dependencies through their published `types` exports and MUST NOT consume another package's source tree.
- The Web TypeScript build MUST exclude client implementation sources while including shared modules required by its server declarations.
- The repository MUST use `typescript@7.0.2` as its sole TypeScript implementation.
- Every workspace and publishable package MUST declare Node.js `^22.18.0 || >=24.0.0` support.
- Every package that declares Node.js types MUST use `@types/node@^22.20.1`.

### Project Graph

- `@acpus/core` MUST reference `@acpus/expression`.
- `@acpus/tasks` MUST reference `@acpus/core`.
- `@acpus/workflow-compiler` MUST reference `@acpus/core`, `@acpus/expression`, and `@acpus/loader`.
- `@acpus/runtime` MUST reference `@acpus/agent-executor`, `@acpus/core`, `@acpus/expression`, and `@acpus/loader`.
- `@acpus/web` MUST reference `@acpus/core`, `@acpus/expression`, `@acpus/runtime`, and `@acpus/workflow-compiler`.
- `acpus` MUST reference `@acpus/core`, `@acpus/expression`, `@acpus/runtime`, `@acpus/tasks`, `@acpus/web`, and `@acpus/workflow-compiler`.
- The foundation solution MUST contain every project except `@acpus/web` and `acpus`; the full solution MUST contain all package projects.

### Commands and Outputs

- `pnpm build` MUST first build the foundation solution.
- The root build MUST start the main Web client bundle and static visualization generation in parallel after foundation output exists.
- The root build MUST start the full TypeScript solution after static visualization generation succeeds, while the main client bundle remains eligible to run concurrently.
- A failed child build MUST fail the root build, and the root build MUST await every child process that it started.
- Vite MUST own `packages/web/dist/client`; TypeScript MUST own the remaining Web distribution files. Neither builder MAY delete the other's output.
- `pnpm typecheck` MUST run source-first package typechecks without a prerequisite emit.
- `pnpm check:docs` MUST reject missing local targets in current public Markdown documentation and the static Pages entry point.
- `pnpm check:release` MUST reject prerelease package versions, active or pending Changesets, an inconsistent Node.js engine, and a bundled Skill version that differs from the CLI version.
- `pnpm check:security` MUST reject high- or critical-severity advisories in the complete locked dependency graph.
- Each package `clean` command MUST remove both package output and its package-root build cache. The Web clean command MUST also remove its temporary static visualization output.
- Build cache files MUST be ignored by Git and MUST NOT be included in published packages.
- The repository MUST NOT use Turbo, Nx, or another cross-command task cache.

## Verification

- `pnpm check:build-toolchain`: verifies the pnpm pin and supply-chain policy, CI Node.js coverage and version authority, publish provenance configuration, tool versions, project references, shared build settings, build and clean scripts, cache placement, and the absence of cross-command caches.
- `pnpm check:docs`, `pnpm check:release`, and `pnpm check:security`: verify public documentation links, the stable package-release state, and the locked dependency graph.
- `pnpm build:clean`, repeated `pnpm build`, and `pnpm test:dist`: verify deterministic output ownership and publishable artifacts without build caches.
