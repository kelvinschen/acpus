# Build Toolchain Spec

## Purpose

The repository build toolchain owns deterministic TypeScript project ordering, package-local incremental state, Web client and server output boundaries, and the root build, typecheck, clean, and verification commands.

## Requirements

### TypeScript Configurations

- Every package development `tsconfig.json` MUST resolve package `development` exports so package-local typechecks consume workspace source.
- Every package MUST provide a `tsconfig.build.json` that extends its development configuration, enables `composite`, disables custom export conditions, and stores incremental state at `./tsconfig.build.tsbuildinfo`.
- Build configurations MUST resolve workspace dependencies through their published `types` exports and MUST NOT consume another package's source tree.
- The Web build configuration MUST compile only `src/index.ts` and `src/server/**/*.ts`.
- The repository MUST use exactly `typescript@7.0.2`; `@typescript/native-preview`, `@typescript/typescript6`, and TypeScript fallback implementations MUST NOT be declared.
- Every workspace and publishable package MUST require Node.js 22.12 or newer.

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
- Each package `clean` command MUST remove both package output and its package-root build cache. The Web clean command MUST also remove its temporary static visualization output.
- Build cache files MUST be ignored by Git and MUST NOT be included in published packages.
- The repository MUST NOT use Turbo, Nx, or another cross-command task cache.

## Verification

- `pnpm check:build-toolchain` MUST verify tool versions, project references, configuration boundaries, build and clean scripts, cache placement, and the absence of Turbo and Nx configuration.
- CI and publish workflows MUST run `pnpm check:build-toolchain`.
- `pnpm test:dist` MUST reject packages containing `.tsbuildinfo` files.
- Build verification MUST cover a clean build and repeated no-change builds without imposing wall-clock thresholds in CI.
