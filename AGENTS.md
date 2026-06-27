# Agent Instructions — Acpus

Maintenance rules for whom working on this codebase.

> The codebase is being rebuilt on the TypeScript-first core (`@acpus/core` in `packages/core`). The previous YAML Workflow-Spec implementation and its docs (including the old `CONTEXT.md` terminology) are archived, read-only, under `legacy/`. since it havn't published, no compatibility concern.

## Specification Maintenance
- If a code change does not require a SPEC update, the final response MUST state why.
- Current design truth MUST live in `specs/`, not `docs/`.
- The codebase is under active iteration; treat feature changes as greenfield current behavior, and do not add migration warnings, legacy-field diagnostics, or compatibility shims, or backward-compatibility unless explicitly requested.
- After a breaking change, SPECs and tests MUST describe and validate only the new current behavior; do not add assertions or wording whose only purpose is to document or reject removed behavior.
- Future plans, backlog, and capability gaps MUST live in `docs/roadmap/`, not `specs/`.
- Historical plans, validation records, roadmap, and handoff notes MUST live under `legacy/` and MUST NOT be treated as current implementation truth.
- SPEC files MUST use the template and RFC 2119 language defined in `specs/INDEX.md`.


## The Way of Clean Code 

Bias toward subtraction. The best code is the shortest that works. Every line must earn its place.

### Rules
- **Least code for the actual task** — not the anticipated one. Fewer lines is the goal.
- **stdlib before hand-rolling** — never reinvent validation, parsing, dates, collections, strings.
- **platform before dependencies** — a new import must do what the runtime can't.
- **abstract at the 2nd caller** — no interface/factory/flag/config for one user. Inline first (YAGNI).
- **delete speculative flexibility** — no "might need it later" params, hooks, or single-caller layers.
- **no safety theater** — no retries/caches/guards around idempotent or local calls.
- **shrink** — prefer one-line builtins (`dict(zip())`, comprehensions) over manual loops; collapse to simplest equivalent.
- **plain names, no explanatory comments** — clarity from short code, not prose.
- **keep one smoke/`assert` check** — the minimum, never bloat.

### Self-check, then cut
`delete` dead code · `stdlib` reinvented stdlib · `native` platform dupes · `yagni` single-user abstractions · `shrink` verbose logic.

## The Way of Good Test
- **Maps to a concrete risk** — articulate the specific failure mode the test guards against.
- **Targets the lowest stable layer** — test a pure rule directly; never boot the full CLI to verify it.
- **Deterministic & hermetic** — identical input always yields identical output; no external/shared state.
- **Minimal, intent-revealing setup** — the variable under test is visible at a glance in the test body.
- **Strong oracle** — assert exact results: return value, diagnostic code/path, exit code, or status.
- **Refactor-resistant** — survives implementation changes as long as the contract holds.
- **Clear failure signal** — test name + diff reveal which rule was violated.
- **Cost proportional to risk** — reserve expensive E2E tests for high-value cross-layer risks.


## Build Maintenance
- After fully completing any feature implementation, MUST run the relevant build command so checked-in build artifacts are updated.
- The package name of acpus is `acpus` instead of @acpus/cli