# Specs Index

Specs define current implementation truth for Acpus. A file in this directory
is current; drafts, backlog, and capability gaps belong in `docs/roadmap/`, and
completed plans and previous implementations belong in Git history and release
tags.

## Template

Each spec MUST use this structure:

```md
# {Package Or Feature} Spec

## Purpose

One short paragraph describing the current feature boundary.

## Requirements

- The implementation MUST ...
- The implementation SHOULD ...
- The implementation MAY ...

## Verification

- `{narrow verification command}`: verifies {contract risk}.
```

## Maintenance

Before changing a spec, read the authoritative
[Specification Maintenance Guide](../docs/specification-maintenance.md)
completely.

## Specs

| Spec | Contract owner | Canonical interface | Read with | Verification |
| --- | --- | --- | --- | --- |
| [Build Toolchain](build-toolchain-spec.md) | workspace | TypeScript build graph and repository commands | [Loader](loader-spec.md) | `pnpm build:clean`, `pnpm test:dist` |
| [Loader](loader-spec.md) | `@acpus/loader` | Official facade resolution and authoring-module loading | [Compiler](workflow-compiler-spec.md), [Runtime](runtime-spec.md) | `pnpm --filter @acpus/loader typecheck`, `pnpm test:contract packages/loader`, `pnpm test:integration packages/loader` |
| [Core](core-spec.md) | `@acpus/core` | Workflow authoring, schema IR, workflow IR | [Expression](expression-spec.md), [Compiler](workflow-compiler-spec.md) | `pnpm --filter @acpus/core typecheck`, `pnpm test:unit packages/core`, `pnpm test:contract packages/core`, `pnpm test:type packages/core` |
| [Expression](expression-spec.md) | `@acpus/expression` | Expression authoring, IR, validation, evaluation | [Core](core-spec.md), [Compiler](workflow-compiler-spec.md) | `pnpm --filter @acpus/expression typecheck`, `pnpm test:unit packages/expression`, `pnpm test:contract packages/expression`, `pnpm test:type packages/expression` |
| [Workflow Compiler](workflow-compiler-spec.md) | `@acpus/workflow-compiler` | Static checks and prepared workflow data | [Core](core-spec.md), [Loader](loader-spec.md) | `pnpm --filter @acpus/workflow-compiler typecheck`, `pnpm test:type packages/workflow-compiler`, `pnpm test:contract packages/workflow-compiler`, `pnpm test:integration packages/workflow-compiler` |
| [Tasks](tasks-spec.md) | `@acpus/tasks` | Reusable task-domain contracts | [Core](core-spec.md), [Loader](loader-spec.md) | `pnpm --filter @acpus/tasks typecheck`, `pnpm test:contract packages/tasks`, `pnpm test:type packages/tasks`, `pnpm test:integration packages/tasks` |
| [Runtime](runtime-spec.md) | `@acpus/runtime` | Durable execution, controls, and coherent observation APIs | [Core](core-spec.md), [Expression](expression-spec.md), [Agent Executor](agent-executor-spec.md), [Loader](loader-spec.md), [Hooks](hooks-spec.md) | `pnpm --filter @acpus/runtime typecheck`, `pnpm test:type packages/runtime`, `pnpm test:unit packages/runtime`, `pnpm test:integration packages/runtime`, `pnpm test:contract packages/runtime` |
| [Runtime Hooks](hooks-spec.md) | `@acpus/runtime` | Hook configuration, dispatch, and journal | [Runtime](runtime-spec.md), [CLI](cli-spec.md) | `pnpm --filter @acpus/runtime typecheck`, `pnpm --filter acpus typecheck`, `pnpm test:unit packages/runtime`, `pnpm test:integration packages/runtime`, `pnpm test:contract packages/cli`, `pnpm test:e2e packages/cli` |
| [Agent Executor](agent-executor-spec.md) | `@acpus/agent-executor` | Attempt-scoped managed ACP workers and normalized turns | [Runtime](runtime-spec.md) | `pnpm --filter @acpus/agent-executor typecheck`, `pnpm test:unit packages/agent-executor`, `pnpm test:integration packages/agent-executor`, `pnpm test:contract packages/agent-executor`, `pnpm test:type packages/agent-executor` |
| [CLI](cli-spec.md) | `acpus` | Leaf command grammar and text/structured presentation | [Compiler](workflow-compiler-spec.md), [Runtime](runtime-spec.md), [Hooks](hooks-spec.md) | `pnpm --filter acpus typecheck`, `pnpm test:type packages/cli`, `pnpm test:e2e packages/cli`, `pnpm test:contract packages/cli` |
| [WebUI](webui-spec.md) | `@acpus/web` | Browser APIs and operator interactions | [Core](core-spec.md), [Workflow Compiler](workflow-compiler-spec.md), [Runtime](runtime-spec.md), [WebUI Design](webui-design-spec.md) | `pnpm --filter @acpus/web typecheck`, `pnpm test:type packages/web`, `pnpm test:unit packages/web`, `pnpm test:contract packages/web`, `pnpm test:integration packages/web` |
| [WebUI Design](webui-design-spec.md) | `@acpus/web` | Visual and interaction language | [WebUI](webui-spec.md) | `pnpm --filter @acpus/web typecheck`, `pnpm test:unit packages/web`, `pnpm test:contract packages/web` |
