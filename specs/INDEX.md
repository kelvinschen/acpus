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

## Maintenance Rules

- A requirement MUST state current observable behavior, a public interface, a persistence or safety invariant, or a cross-component boundary owned by this spec.
- Each behavior MUST have one canonical spec owner. Consumer specs MUST link to that owner and describe only their adapter or presentation behavior.
- Requirements MUST be atomic and use RFC 2119/BCP 14 terms deliberately. Prefer one normative term per bullet; split independent obligations.
- Public wire shapes and closed enums SHOULD use compact tables or type-like notation instead of prose that duplicates every field across consumers. Prose MAY remain only when the contract cannot be expressed clearly by the canonical type or table.
- Replace or delete superseded requirements in the same change. A refactor with no contract change SHOULD add no requirements; it MAY update stale ownership, links, or verification routing.
- Implementation algorithms, test-case inventories, validation records, historical decisions, and handoff notes MUST NOT be preserved as current requirements.
- Negative requirements SHOULD remain only for a current closed shape, safety boundary, or unsupported input. They MUST NOT serve only as tombstones for removed behavior.
- Verification SHOULD name the narrow commands and high-value risks, not repeat the Requirements section as an exhaustive test matrix. Manual inspection MAY replace an automated command only when the risk has no practical deterministic oracle.
- Cross-spec dependencies MUST use Markdown links so maintainers and agents can find the canonical contract directly.

## Specs

| Spec | Contract owner | Canonical interface | Read with | Verification |
| --- | --- | --- | --- | --- |
| [Build Toolchain](build-toolchain-spec.md) | workspace | TypeScript build graph and repository commands | [Loader](loader-spec.md) | `pnpm build:clean`, `pnpm test:dist` |
| [Loader](loader-spec.md) | `@acpus/loader` | Official facade resolution and authoring-module loading | [Compiler](workflow-compiler-spec.md), [Runtime](runtime-spec.md) | `pnpm --filter @acpus/loader typecheck`, `pnpm test:integration -- packages/loader` |
| [Core](core-spec.md) | `@acpus/core` | Workflow authoring, schema IR, workflow IR | [Expression](expression-spec.md), [Compiler](workflow-compiler-spec.md) | `pnpm --filter @acpus/core typecheck`, `pnpm test:unit -- packages/core`, `pnpm test:contract -- packages/core`, `pnpm test:type -- packages/core` |
| [Expression](expression-spec.md) | `@acpus/expression` | Expression authoring, IR, validation, evaluation | [Core](core-spec.md), [Compiler](workflow-compiler-spec.md) | `pnpm --filter @acpus/expression typecheck`, `pnpm test:unit -- packages/expression`, `pnpm test:contract -- packages/expression`, `pnpm test:type -- packages/expression` |
| [Workflow Compiler](workflow-compiler-spec.md) | `@acpus/workflow-compiler` | Static checks and prepared workflow data | [Core](core-spec.md), [Loader](loader-spec.md) | `pnpm --filter @acpus/workflow-compiler typecheck`, `pnpm test:contract -- packages/workflow-compiler`, `pnpm test:integration -- packages/workflow-compiler` |
| [Tasks](tasks-spec.md) | `@acpus/tasks` | Reusable task-domain contracts | [Core](core-spec.md), [Loader](loader-spec.md) | `pnpm --filter @acpus/tasks typecheck`, `pnpm test:integration -- packages/tasks`, `pnpm test:type -- packages/tasks` |
| [Runtime](runtime-spec.md) | `@acpus/runtime` | Durable execution, controls, and read APIs | [Core](core-spec.md), [Expression](expression-spec.md), [Agent Executor](agent-executor-spec.md), [Loader](loader-spec.md), [Hooks](hooks-spec.md) | `pnpm --filter @acpus/runtime typecheck`, `pnpm test:unit -- packages/runtime`, `pnpm test:integration -- packages/runtime`, `pnpm test:contract -- packages/runtime` |
| [Runtime Hooks](hooks-spec.md) | `@acpus/runtime` | Hook configuration, dispatch, and journal | [Runtime](runtime-spec.md), [CLI](cli-spec.md) | `pnpm --filter @acpus/runtime typecheck`, `pnpm --filter acpus typecheck`, `pnpm test:unit -- packages/runtime`, `pnpm test:integration -- packages/runtime`, `pnpm test:contract -- packages/cli`, `pnpm test:e2e -- packages/cli` |
| [Agent Executor](agent-executor-spec.md) | `@acpus/agent-executor` | One normalized acpx-backed Agent turn | [Runtime](runtime-spec.md) | `pnpm --filter @acpus/agent-executor typecheck`, `pnpm test:unit -- packages/agent-executor`, `pnpm test:integration -- packages/agent-executor`, `pnpm test:contract -- packages/agent-executor`, `pnpm test:type -- packages/agent-executor` |
| [CLI](cli-spec.md) | `acpus` | Leaf command grammar and text/JSON/NDJSON presentation | [Compiler](workflow-compiler-spec.md), [Runtime](runtime-spec.md), [Hooks](hooks-spec.md) | `pnpm --filter acpus typecheck`, `pnpm test:type -- packages/cli`, `pnpm test:e2e -- packages/cli`, `pnpm test:contract -- packages/cli` |
| [WebUI](webui-spec.md) | `@acpus/web` | Browser APIs and operator interactions | [Runtime](runtime-spec.md), [WebUI Design](webui-design-spec.md) | `pnpm --filter @acpus/web typecheck`, `pnpm test:unit -- packages/web`, `pnpm test:contract -- packages/web` |
| [WebUI Design](webui-design-spec.md) | `@acpus/web` | Visual and interaction language | [WebUI](webui-spec.md) | `pnpm --filter @acpus/web typecheck`, `pnpm test:unit -- packages/web`, `pnpm test:contract -- packages/web` |

## Scope Rules

- Current product and design truth MUST live in `specs/`.
- Planned work, backlog, and capability gaps MUST live in `docs/roadmap/`.
- A spec SHOULD describe the package or feature that owns the behavior. Cross-package workflows MAY appear only as linked delegation boundaries.
