# Loader Spec

## Purpose

`@acpus/loader` is a private internal package that owns TypeScript authoring module loading for Acpus workflow preparation and reusable task execution. It centralizes official `acpus/*` facade resolution, TypeScript module execution, CJS and ESM resolver hooks, source-first workspace development resolution, and package `development` export fallback. Compiler and runtime packages use this package as their only authoring-module loading boundary.

## Requirements

### Public Surface

- The package MUST expose `officialAuthoringTypeScriptPaths(fromDir)`.
- The package MUST expose `officialAuthoringEnvironment()` as the single resolved authority for official facade implementation package names, versions, package roots, and TypeScript authority paths.
- The package MUST expose `importAuthoringModule(specifier, { parentURL, sourceRoot?, dependencyRoot? })`.
- The package MUST NOT expose user-facing CLI commands, runtime state, workflow compilation APIs, or task execution APIs.
- The package MUST keep TypeScript loader implementation details private to this package.

### Official Facades

- The loader MUST resolve supported official authoring facade specifiers `acpus/core`, `acpus/expression`, and `acpus/tasks/git` to Acpus-owned implementation packages.
- In workspace development, official facade specifiers SHOULD resolve to a usable live package source. Normal published exports MAY be used when no usable live source target exists.
- In published installs, official facade specifiers MUST resolve through normal package exports.
- Official facade resolution MUST work for ESM imports and for CommonJS-transformed TypeScript module paths.
- Official facade resolution MUST NOT require the workflow workspace to install Acpus packages locally.

### TypeScript Paths

- `officialAuthoringTypeScriptPaths(fromDir)` MUST return `paths` entries that TypeScript scratch configs can use for the supported official facade specifiers.
- Returned path targets MUST be relative to `fromDir`.
- The return value MUST indicate whether any official facade target resolved to workspace source so callers can enable the `development` condition when needed.
- `officialAuthoringEnvironment()` paths MUST be canonical absolute paths and MUST describe the same targets returned by `officialAuthoringTypeScriptPaths(...)`.

### Module Loading

- `importAuthoringModule(...)` MUST lazily register the TypeScript authoring loader, official facade mappings, CommonJS `_resolveFilename` fallback, ESM loader resolution, and feature-detected synchronous `module.registerHooks` resolution at most once per process.
- The synchronous `module.registerHooks` hook MUST be optional and MUST NOT raise on Node versions that do not provide it.
- `importAuthoringModule(specifier, options)` MUST load file URLs, data URLs, node builtins, relative specifiers, absolute filesystem paths, and bare package specifiers using `parentURL` as the source referrer.
- When `sourceRoot` and `dependencyRoot` are present, failed bare-package resolution originating beneath that source root MUST fall back to the dependency root; relative and absolute source resolution MUST remain anchored to `parentURL`.
- When registered source roots overlap, dependency fallback MUST use the most specific containing source root independent of registration order. Re-registering the same source root MUST replace its dependency authority.
- The loader MUST NOT substitute process cwd or infer a workspace dependency root.
- Source-root and referrer construction are owned by the [Workflow Compiler](workflow-compiler-spec.md#prepared-workflow-data) and [Runtime](runtime-spec.md#workspace-shards-admission-and-store).
- The loader MUST NOT persist, copy, identify, or clean source roots.
- Relative `.js` source-level specifiers MUST continue to load matching TypeScript source files through the authoring loader.
- TypeScript authoring modules MUST load when their workspace has no nearest `package.json` or its package type is CommonJS.
- Bare package specifiers SHOULD use ESM import resolution semantics, including nested `node`, `node-addons`, `import`, `module-sync`, and `default` export conditions in declaration order. CommonJS-transformed paths MAY use the registered CommonJS fallback.
- When normal package resolution fails for a package export whose selected normal import target is missing, the loader MUST attempt the selected, possibly nested, package `development` export target for that subpath.
- Filesystem discovery MUST treat only `ENOENT` and `ENOTDIR` as an absent candidate.
- Filesystem permission, I/O, symlink-loop, and directory-import failures MUST propagate and MUST NOT select another source or package export target.
- The loader MUST NOT use the `development` export fallback to mask errors thrown while an existing selected normal import target is evaluating, including transitive `ERR_MODULE_NOT_FOUND` failures.
- The loader MUST rely on normal Node module caching behind the authoring loader and MUST NOT add Acpus-owned cache busting, dependency graph copying, or generated task source artifacts.

## Verification

- Integration tests cover official facade and TypeScript module loading in clean source and built-package environments without ambient workspace dependencies.
- Resolver tests cover explicit source and dependency authorities, ESM/CJS hooks, relative `.js` to TypeScript, `development` fallback boundaries, normal import conditions, and usable scratch-config paths.
