# Development and Testing Guide

This guide describes how to change the TypeScript workflow core safely while the project is still in its greenfield phase. Product behavior belongs in `specs/`; this file explains how to work and test.

## Development loop

1. Start from the current spec. If the change modifies current behavior, update the relevant file under `specs/` in the same PR. If it only changes implementation, tests, or docs, say why no spec update is needed.
2. Keep changes at the lowest useful layer. Prefer changing a pure lowering function before adding another wrapper, option, factory, or compatibility shim.
3. Treat `legacy/` as read-only history. Do not copy compatibility rules, YAML workflow behavior, or old terminology into the TypeScript core unless explicitly requested.
4. Preserve the public API through `packages/core/src/index.ts`. New authoring primitives should be exported there and covered by tests at the right layer.
5. Keep IR serializable and deterministic except for explicitly dynamic lock fields such as `generatedAt`. Do not put live Zod objects, functions, process handles, or runtime-only values into IR.

## Test taxonomy

The root Vitest config groups tests by filename. Choose the cheapest project that exercises the risk.

| Project | Filename | Use for | Avoid |
| --- | --- | --- | --- |
| Unit | `*.unit.test.ts` | Pure functions: schema lowering, expression lowering, template lowering, id validation helpers, secret/env lowering. | Dynamic import, filesystem, CLI, subprocesses, real commands. |
| Contract | `*.contract.test.ts` | Public API exports, stable IR shape, diagnostic codes/paths, compatibility between spec and serialized contracts. | Implementation details and incidental ordering except where the contract requires it. |
| Integration | `*.integration.test.ts` | Cross-layer authoring flows such as `defineWorkflow` -> graph builder -> compiler -> validator. Composite node shape and task-bundle wiring belong here. | Real agents, external services, shelling out to package managers. |
| E2E | `*.e2e.test.ts` | The final user-facing path: CLI, checked-in examples, file output, package entrypoint smoke tests. | Fine-grained lowering assertions that would make refactors noisy. |
| Regression | `*.regression.test.ts` | A minimal reproduction for a fixed bug that is likely to return. Include the failure mode in the test name. | Broad feature coverage; move that to unit/integration once generalized. |

## Test design rules

Every test should answer one concrete question: "what breakage would this catch?" Put that answer in the `it(...)` name or the setup shape.

Prefer exact assertions for stable outputs: lowered `ExprIR`, `SchemaIR`, diagnostic `code`/`path`, exit code, node ids, and public output keys. Use partial matchers only for intentionally dynamic values such as `lock.generatedAt`, task bundle digests, source text captured from `Function#toString()`, and temp paths.

Do not snapshot whole `WorkflowIR` objects. Full snapshots make `generatedAt`, function source, and unrelated lock metadata noisy. Instead, assert the stable slices that define the contract.

Keep tests hermetic. No network. No dependence on local Git state, user config, or installed global binaries. For file tests, create a temp directory with `mkdtemp(...)` and clean it up in `finally`.

Use the public entrypoint for public behavior tests: import from `../src/index.js` in core tests. Import internal modules only when the test is intentionally about a private helper.

When a spec says a behavior MUST exist, add or update a test in the same change. If implementation and spec disagree, either fix the implementation or update the spec to the new current behavior.

## Core coverage map

The initial core test foundation should cover these chains:

- Schema: supported Zod boundary subset lowers to `SchemaIR`; unsupported boundary features fail with the offending path; parse issues use Acpus-style paths.
- Expressions: `where(...)` field shorthand, primitive filters, Mongo aliases, logical composition, and collection helpers lower to canonical `ExprIR` calls.
- IR validator: invalid workflow names, schemas, duplicate node ids, empty refs, missing agents, and task-bundle mismatches produce stable diagnostic codes and paths.
- Workflow compiler: a representative workflow compiles leaf nodes, guards, templates, secrets, task bundles, agent definitions, and outputs into validated `WorkflowIR`.
- Composite nodes: `step.if`, `step.parallel`, `step.fanout`, and `step.loop` compile child scopes and projected outputs without invoking any runtime.
- CLI E2E: the checked-in release example emits JSON with `irVersion: 2`, expected node ids, task bundles, outputs, and the trusted-import compiler diagnostic.

## Commands

Run the narrowest command during development, then run the broader checks before handing off.

```bash
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm test:e2e
pnpm test
pnpm typecheck
```

For changes limited to docs or specs, tests may be skipped only when there is no executable behavior to validate; say that explicitly in the handoff.

For checked-in generated artifacts, run the package script that regenerates them instead of editing by hand. For the core example IR:

```bash
pnpm --filter @acpus/core emit:example
```

## PR checklist

Before opening or handing off a PR, verify:

- Specs reflect current behavior or the handoff explains why no spec changed.
- Tests live in the right project and assert stable contracts.
- E2E coverage is limited to high-value user paths.
- Dynamic fields are not asserted with brittle exact values.
- `legacy/` was not changed unless the task explicitly asked for archival updates.
- Relevant test and typecheck commands were run, or the reason they could not be run is stated.
