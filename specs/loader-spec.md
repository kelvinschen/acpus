# Loader Spec

## Purpose

`@acpus/loader` is a private internal package that owns TypeScript authoring module loading for Acpus workflow preparation and reusable task execution. It centralizes official `acpus/*` facade resolution, TypeScript module execution, CJS and ESM resolver hooks, source-first workspace development resolution, and package `development` export fallback. Compiler and runtime packages use this package as their only authoring-module loading boundary.

## Requirements

### Public Surface

- The package MUST expose `officialAuthoringTypeScriptPaths(fromDir)`.
- The package MUST expose `importAuthoringModule(specifier, { parentURL })`.
- The package MUST NOT expose user-facing CLI commands, runtime state, workflow compilation APIs, or task execution APIs.
- The package MUST keep TypeScript loader implementation details private to this package.

### Official Facades

- The loader MUST resolve supported official authoring facade specifiers `acpus/core`, `acpus/expression`, and `acpus/tasks/git` to Acpus-owned implementation packages.
- In workspace development, official facade specifiers SHOULD resolve to live package source when the source file exists.
- In published installs, official facade specifiers MUST resolve through normal package exports.
- Official facade resolution MUST work for ESM imports and for CommonJS-transformed TypeScript module paths.
- Official facade resolution MUST NOT require the workflow workspace to install Acpus packages locally.

### TypeScript Paths

- `officialAuthoringTypeScriptPaths(fromDir)` MUST return `paths` entries that TypeScript scratch configs can use for the supported official facade specifiers.
- Returned path targets MUST be relative to `fromDir`.
- The return value MUST indicate whether any official facade target resolved to workspace source so callers can enable the `development` condition when needed.

### Module Loading

- `importAuthoringModule(...)` MUST lazily register the TypeScript authoring loader, official facade mappings, CommonJS `_resolveFilename` fallback, ESM loader resolution, and feature-detected synchronous `module.registerHooks` resolution at most once per process.
- The synchronous `module.registerHooks` hook MUST be optional and MUST NOT raise on Node versions that do not provide it.
- `importAuthoringModule(specifier, { parentURL })` MUST load file URLs, data URLs, node builtins, relative specifiers, absolute filesystem paths, and bare package specifiers using `parentURL` as the referrer.
- Relative `.js` source-level specifiers MUST continue to load matching TypeScript source files through the authoring loader.
- Bare package specifiers SHOULD use ESM import resolution semantics, including package `import` export conditions.
- When normal package resolution fails for a package export whose normal import/default target is missing, the loader MUST attempt the package `development` export target for that subpath.
- The loader MUST NOT use the `development` export fallback to mask errors thrown while an existing normal import/default target is evaluating.
- The loader MUST rely on normal Node module caching behind the authoring loader and MUST NOT add Acpus-owned cache busting, dependency graph copying, or generated task source artifacts.

## Verification

- Integration tests MUST cover loading a TypeScript task module in a clean temporary project with no user `tsconfig.json`, no workflow-local `node_modules`, and official facade imports.
- Tests MUST cover built-package authoring loading without ambient `tsx`.
- Tests MUST cover direct official facade module imports.
- Tests MUST cover relative `.js` specifiers resolving to TypeScript source.
- Tests MUST cover package `development` export fallback when a default export target is missing.
- Tests MUST cover bare package specifiers using the ESM `import` condition rather than the CommonJS `require` condition.
- Tests MUST cover an existing normal package target with a missing transitive dependency failing without development fallback.
- Tests MUST cover `officialAuthoringTypeScriptPaths(...)` returning usable scratch-config paths.
