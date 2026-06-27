# Agent Instructions — Acpus

Maintenance rules for agents and humans working on this codebase.

> The codebase is being rebuilt around the TypeScript-first core (`@acpus/core` in `packages/core`). The previous YAML Workflow-Spec implementation and its docs, including old `CONTEXT.md` terminology, are archived under `legacy/`. They are read-only history. Because the TypeScript core has not been published yet, do not add compatibility shims unless explicitly requested.

## Specification Maintenance

- If a code change does not require a SPEC update, the final response MUST state why.
- Current product/design truth MUST live in `specs/`, not `docs/`.
- The codebase is under active iteration; treat feature changes as greenfield current behavior. Do not add migration warnings, legacy-field diagnostics, compatibility shims, or backward-compatibility behavior unless explicitly requested.
- After a breaking change, specs and tests MUST describe and validate only the new current behavior. Do not add assertions or wording whose only purpose is to document or reject removed behavior.
- Future plans, backlog, and capability gaps MUST live in `docs/roadmap/`, not `specs/`.
- Historical plans, validation records, roadmap, and handoff notes MUST live under `legacy/` and MUST NOT be treated as current implementation truth.
- SPEC files MUST use the template and RFC 2119 language defined in `specs/INDEX.md`.

## Development Practice

- Read the relevant spec before changing implementation. If code and spec disagree, fix one of them in the same change.
- Use the smallest layer that solves the task. Prefer a pure lowering/helper change over adding a new wrapper or abstraction.
- Preserve the public surface through `packages/core/src/index.ts`; new authoring primitives need public exports and tests.
- Keep IR serializable. Do not put live Zod objects, functions, processes, or runtime-only handles into `WorkflowIR`.
- Treat `legacy/` as archival. Do not edit or import from it unless the task explicitly asks for legacy maintenance.

## The Way of Clean Code

Bias toward subtraction. The best code is the shortest that works. Every line must earn its place.

### Rules

- **Least code for the actual task** — not the anticipated one. Fewer lines is the goal.
- **stdlib before hand-rolling** — never reinvent validation, parsing, dates, collections, strings.
- **platform before dependencies** — a new import must do what the runtime cannot.
- **abstract at the 2nd caller** — no interface/factory/flag/config for one user. Inline first (YAGNI).
- **delete speculative flexibility** — no "might need it later" params, hooks, or single-caller layers.
- **no safety theater** — no retries/caches/guards around idempotent or local calls.
- **shrink** — prefer one-line builtins and the simplest equivalent over verbose plumbing.
- **plain names, sparse comments** — clarity from names and shape first; comments explain non-obvious intent only.

### Self-check, then cut

`delete` dead code · `stdlib` reinvented stdlib · `native` platform dupes · `yagni` single-user abstractions · `shrink` verbose logic.

## The Way of Good Test

Detailed guidance lives in `docs/development-testing.md`.

- **Maps to a concrete risk** — articulate the specific failure mode the test guards against.
- **Targets the lowest stable layer** — test a pure rule directly; never boot the full CLI to verify it.
- **Deterministic & hermetic** — identical input always yields identical output; no network, external services, shared state, or user-local config.
- **Minimal, intent-revealing setup** — the variable under test is visible at a glance in the test body.
- **Strong oracle** — assert exact stable results: return value, lowered IR slice, diagnostic code/path, exit code, or public output key.
- **Refactor-resistant** — survives implementation changes as long as the contract holds.
- **Clear failure signal** — test name + diff reveal which rule was violated.
- **Cost proportional to risk** — reserve expensive E2E tests for high-value cross-layer paths.
- **No whole-IR snapshots** — assert stable slices and use partial matchers for dynamic fields such as `generatedAt`, task source text, digest values, and temp paths.

### Test placement

- `*.unit.test.ts`: pure functions such as schema lowering, expression lowering, template lowering, secret/env lowering.
- `*.contract.test.ts`: public API and stable serialized contracts such as diagnostic codes/paths and IR shape.
- `*.integration.test.ts`: cross-layer authoring/compiler flows such as `defineWorkflow` -> graph -> compiler -> validator.
- `*.e2e.test.ts`: user-facing command/package paths for packages that provide commands.
- `*.regression.test.ts`: one minimal reproduction for a fixed bug that is likely to return.

## Build Maintenance

- After fully completing any feature implementation, MUST run the relevant build/test command so checked-in generated artifacts stay current.
- Prefer the narrow command while developing (`pnpm test:unit`, `pnpm test:contract`, `pnpm test:integration`, `pnpm test:e2e`) and broader checks before handoff (`pnpm test`, `pnpm typecheck`).
- If a command could not be run, the final response MUST state that clearly.
- The package name of acpus is `acpus` instead of `@acpus/cli`.
