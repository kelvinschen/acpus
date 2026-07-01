# Specs Index

Specs define current implementation truth for Acpus. Specs MUST describe current behavior using RFC 2119 language and MUST NOT carry planned roadmap items or historical decisions.

## Template

Each spec SHOULD use this structure:

```md
# {Package Or Feature} Spec

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

| Spec | Owner | Verification |
| --- | --- | --- |
| [Core Spec](core-spec.md) | `@acpus/core` | `pnpm --filter @acpus/core typecheck`, `pnpm test:unit -- packages/core`, `pnpm test:contract -- packages/core`, `pnpm test:type -- packages/core` |
| [Expression Spec](expression-spec.md) | `@acpus/expression` | `pnpm --filter @acpus/expression typecheck`, `pnpm test:unit -- packages/expression`, `pnpm test:contract -- packages/expression`, `pnpm test:type -- packages/expression` |
| [Workflow Compiler Spec](workflow-compiler-spec.md) | `@acpus/workflow-compiler` | `pnpm --filter @acpus/workflow-compiler typecheck`, `pnpm test:contract -- packages/workflow-compiler`, `pnpm test:integration -- packages/workflow-compiler` |
| [Runtime Spec](runtime-spec.md) | `@acpus/runtime` | `pnpm --filter @acpus/runtime typecheck`, `pnpm test:unit -- packages/runtime`, `pnpm test:integration -- packages/runtime`, `pnpm test:contract -- packages/runtime` |
| [Agent Executor Spec](agent-executor-spec.md) | `@acpus/agent-executor` | `pnpm --filter @acpus/agent-executor typecheck`, `pnpm test:unit -- packages/agent-executor`, `pnpm test:integration -- packages/agent-executor`, `pnpm test:contract -- packages/agent-executor`, `pnpm test:type -- packages/agent-executor` |
| [CLI Spec](cli-spec.md) | `acpus` | `pnpm --filter acpus typecheck`, `pnpm test:e2e -- packages/cli`, `pnpm test:contract -- packages/cli` |

## Scope Rules

- Current product/design truth MUST live in `specs/`.
- Planned work, backlog, and capability gaps MUST live in `docs/roadmap/`.
- Historical plans, validation records, and handoff notes MUST live under `legacy/`.
- A spec SHOULD describe the package that owns the behavior. Cross-package workflows MAY be mentioned only as delegation boundaries.
- Negative requirements SHOULD be kept only when they define a current boundary, closed shape, safety rule, or unsupported input.
