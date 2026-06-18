# Build Toolchain Spec

## Purpose

This spec defines the current TypeScript compiler toolchain used to build and type-check Acpus packages.

## Requirements

- The workspace MUST use `@typescript/native-preview` as the TypeScript compiler dependency.
- Package build scripts MUST invoke `tsgo -p tsconfig.json` for TypeScript compilation.
- Package typecheck scripts MUST invoke `tsgo -p tsconfig.json --noEmit`.
- Packages that produce executable entrypoints MUST preserve executable file permissions after compilation.
- Packages that use Node.js runtime globals or `node:*` modules MUST include Node ambient types in their package `tsconfig.json`.

## Verification

- `pnpm build` MUST compile all workspace packages with `tsgo`.
- `pnpm typecheck` MUST type-check all workspace packages with `tsgo --noEmit`.
