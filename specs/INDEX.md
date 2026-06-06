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

- [CLI Spec](cli-spec.md)
- [Local Runtime Target Spec](local-runtime-target-spec.md)
- [Mock Agent Spec](mock-agent-spec.md)
- [Schema Spec](schema-spec.md)
- [Workflow Spec](workflow-spec.md)
