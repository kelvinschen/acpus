# Acpus Codes of Conduct

> Treat current development as greenfield and **NEVER add compatibility shims unless explicitly requested**.

## Specification Maintenance

- Follow the [specification maintenance guide](docs/specification-maintenance.md)
  before adding or reorganizing specs.

- Current behavior belongs in `specs/`; future work belongs in `docs/roadmap/`;
  completed plans and previous product history belong in Git history and
  release tags.

- Read the owning spec before changing behavior. Update the canonical spec and
  verification in the same change; behavior-preserving refactors do not add
  normative requirements.

- Prefer replacing or compressing requirements over appending. Specify stable
  observable behavior and decision boundaries, not implementation detail;
  avoid net growth when existing text can carry the new semantics.

- Specs use the template and RFC 2119 language in `specs/INDEX.md`. Keep each
  behavior canonical in one owner spec and link from delegating specs.

- Treat feature changes as greenfield current behavior. Do not add migration
  warnings, legacy-field diagnostics, compatibility shims, or removed-behavior
  tests unless explicitly requested.

## Development Practice

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.

- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.

- Model recoverable boundary failures with typed Result/ResultAsync and tagged errors. Keep local absence as `undefined`, invariant/system failures as throws, and never serialize Result objects into IR, events, SQLite rows, or CLI JSON.

- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.

- Keep components modular and concerns clearly separated.

- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.

- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.

- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

- LLM-Oriented product design: for every design decision, ask first: Does this enable the consumer's next valid action with the minimum authoritative delta?


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
- **No whole-IR snapshots** — assert stable slices and use partial matchers for dynamic fields such as task source text, digest values, and temp paths.

## Build Maintenance
- After fully completing any feature implementation, MUST run the relevant build/test command so checked-in generated artifacts stay current.
- Prefer the narrow command while developing (`pnpm test:unit`, `pnpm test:contract`, `pnpm test:integration`, `pnpm test:e2e`) and broader checks before handoff (`pnpm test`, `pnpm typecheck`).
- After material test changes, MUST benchmark `pnpm test` against the <10s baseline; investigate regressions over 500ms as test-design overhead or unavoidable cost, and report the conclusion.
