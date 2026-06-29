# Specs Index

Specs define current implementation truth for Acpus. Specs MUST describe current behavior using RFC 2119 language and MUST NOT carry future roadmap items or historical decisions.

## Template

Each spec SHOULD use this structure:

```md
# {Feature} Spec

## Purpose

One short paragraph describing the current feature boundary.

## Requirements

- The implementation MUST ...
- The implementation SHOULD ...
- The implementation MAY ...

## Verification

- Tests MUST cover ...
```

## Specs

- [Core Workflow Spec](core-workflow-spec.md)
- [Core Expression Spec](core-expression-spec.md)
- [CLI Spec](cli-spec.md)
- [Runtime Spec](runtime-spec.md)

## Note on scope

These specs describe the current TypeScript-first core (`@acpus/core`) that
compiles typed workflow modules to a frozen IR. The previous YAML Workflow-Spec
implementation and its specs are archived under `legacy/` and are not current
truth. Future plans and known gaps live in `docs/roadmap/`.
