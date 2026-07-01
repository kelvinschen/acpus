# Spec Gap Audit

This audit records gaps found while aligning specs to package ownership. Specs describe current behavior; items here are follow-up work unless a later change explicitly moves them into a package spec.

## Implementation gaps

- `WorkflowIR` immutability: specs now require serializable IR shape, but `compileWorkflowDefinition(...)` does not deep-freeze the returned object. Add deep-freeze behavior and focused contract tests only if runtime immutability becomes a package contract.
- Runtime admission input validation: current runtime APIs expect caller-normalized input. If runtime should defend direct API callers, add admission-time validation and update `specs/runtime-spec.md`.

## Contract coverage gaps

- `@acpus/workflow-compiler` has indirect coverage for `sourceGraphDigest`, but lacks an explicit contract test for the digest formula.
- Package-lock digest inclusion is covered through preflight shape checks, but not with a focused digest-change contract.
- Task bundling relies on esbuild's Node built-ins external behavior; add a package-owned contract if that policy must remain stable.
- Workspace `development` condition behavior is implemented for check/compile, but deserves an explicit package-boundary test before being treated as a public guarantee.

## Roadmap hygiene

- Keep runtime durability planning in `docs/roadmap/durable-runtime-roadmap.md`.
- Keep package specs free of backlog wording; move future behavior and known gaps into roadmap files.
