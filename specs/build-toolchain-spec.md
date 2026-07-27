# Build Toolchain Spec

## Purpose

The repository build toolchain owns deterministic TypeScript project ordering, package-local incremental state, Web client and server output boundaries, and the root build, typecheck, clean, and verification commands.

## Requirements

### Package Manager

- The workspace MUST pin `pnpm@11.15.1`, and GitHub Actions MUST derive that version from the root `packageManager` field rather than duplicate it in workflow inputs.
- Pull request, main-branch, and manually dispatched CI MUST run on Node.js `22.18.0` and the latest Node.js 24 release.
- Dependency lifecycle scripts MUST fail installation unless explicitly approved; `esbuild` MUST be the sole approved dependency build.
- Dependency resolution MUST block exotic subdependencies.
- Dependency resolution MUST NOT enforce a minimum package release age.
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
- Libraries used only to build bundled Web browser assets MUST be development dependencies and MUST NOT expand the published Node runtime dependency surface.
- The Web package MUST classify packages solely through `dependencies` and `devDependencies`; optional, peer, peer-metadata, and bundled dependency declarations MUST be absent.
- The full dependency graph MUST include Web browser sources and development dependencies. The strict production graph MUST exclude browser sources while retaining published Web server/shared sources, so misplaced browser/runtime dependencies fail through the repository dependency checker rather than a source-text import parser.
- Static workflow visualization generation MUST produce exactly one non-empty JavaScript asset, one non-empty CSS asset, and no other assets from the same Vite build.
- Static workflow visualization generation MUST reject asset content that could close its owning inline HTML element.
- Generated static workflow visualization declarations MUST expose asset payloads as opaque strings and MUST NOT duplicate the browser bundle bytes.
- `pnpm typecheck` MUST run source-first package typechecks and a repository-wide test-source typecheck without a prerequisite emit.
- A layer-specific test command MUST fail when its project and file filters select no tests.
- Distribution verification MUST pack each publishable package exactly once per run, derive its packed-file inventory from that operation, and reuse the resulting archive for every consumer that depends on that package.
- The workflow-compiler and CLI distribution smokes MUST install their local publishable dependency closures from that shared archive set in separate temporary consumers.
- The packed CLI distribution smoke MUST render a workflow HTML visualization through its packed `@acpus/web` dependency and verify the embedded static graph bundle.
- Repository checks MUST expose one executable interface through `pnpm check`.
- With no task argument, `pnpm check` MUST run the named `toolchain`, `graph:source`, `graph:strict`, `docs`, and `security` tasks in that order and MUST stop after the first failed task.
- `pnpm check <task>` MUST run only that named task and MUST reject unknown task names.
- CI MUST execute the toolchain task on the minimum supported Node.js version and MUST execute the complete default task set only once on the primary Node.js version, avoiding duplicate repository-graph and security-policy work across the runtime matrix.
- The `graph:source` task MUST check the complete source/development graph for dead files and symbols as well as dependency issues, including browser build inputs.
- The `graph:strict` task MUST separately check the published production graph and reject runtime dependencies that are unused once browser sources are excluded.
- The `docs` task MUST reject missing local targets in current public Markdown documentation and the static Pages entry point.
- The `release` task MUST reject prerelease package versions, active or pending Changesets, an inconsistent Node.js engine, and a bundled Skill version that differs from the CLI version. It MUST remain available as a targeted task and MUST NOT run in the default task set.
- The `security` task MUST reject high- or critical-severity advisories in the complete locked dependency graph.
- Each package `clean` command MUST remove both package output and its package-root build cache. The Web clean command MUST also remove its temporary static visualization output.
- Build cache files MUST be ignored by Git and MUST NOT be included in published packages.
- The repository MUST NOT use Turbo, Nx, or another cross-command task cache.

## Verification

- `pnpm check`: verifies the toolchain, complete source/development graph, strict published production graph, public documentation links, and locked dependency graph through the canonical fail-fast task sequence.
- `pnpm check toolchain`: verifies the pnpm pin and supply-chain policy, CI Node.js coverage and version authority, publish provenance configuration, tool versions, project references, shared source/test settings, build entrypoint configuration and isolated build-plan scheduling/failure semantics, check entrypoint and task definitions, Web manifest declaration boundaries, typecheck/clean scripts, cache placement, and the absence of cross-command caches.
- `pnpm check graph:source` and `pnpm check graph:strict`: verify the complete source/development issue set and the distinct strict production dependency graph.
- `pnpm check docs`, `pnpm check release`, and `pnpm check security`: verify public documentation links, the stable package-release state, and the locked dependency graph independently.
- `pnpm build:clean`, repeated `pnpm build`, and `pnpm test:dist`: verify deterministic output ownership, opaque generated asset declarations, and publishable artifacts without build caches.
- `pnpm test:unit definitely-not-a-real-test-path` (expected failure): verifies that an empty filtered test selection cannot report success.
