# Acpus Codes of Conduct

> Treat current development as greenfield. **NEVER add compatibility shims unless explicitly requested.**

## Required Guides

- Before changing any spec, MUST read
  [Specification Maintenance](docs/specification-maintenance.md) completely.
- Before changing tests, test configuration, or test scripts, MUST read
  [Testing Maintenance](docs/testing-maintenance.md) completely.
- Before changing `packages/cli/skills/**` or Skill-facing guidance, MUST read
  [Skill Maintenance](docs/skill-maintenance.md) completely.
- Before changing Effect-based runtime/application code, service Layers,
  concurrency, cancellation, time, or scoped resources, MUST read
  [Effect Maintenance](docs/effect-maintenance.md) completely.
- During the repository-wide Effect migration, any migration task MUST also
  read the [Effect Migration Guide Index](docs/effect-migration/INDEX.md) and
  its required documents completely.
- Once A01 vendors Effect v4 under `repos/effect`, any substantial Effect coding
  task MUST read `repos/effect/LLMS.md` and use the matching vendored source,
  tests, and `ai-docs` as read-only reference material. Prefer those sources
  over generated guesses, unrelated web snippets, or remembered Effect v3
  idioms. See
  [Upstream Effect Source Workflow](docs/effect-migration/upstream-source-workflow.md).
- A change spanning multiple domains MUST follow every applicable guide.

## Vendored Repositories

External source under `repos/` exists for agent reference, not as application
source.

- Treat `repos/effect/**` as read-only unless explicitly assigned a coordinated
  upstream-source refresh.
- Never import from `repos/effect`; production/test code imports normal package
  dependencies.
- Do not add vendored source to TypeScript project references, package exports,
  build outputs, coverage, or normal test discovery.
- When the vendored Effect source and installed pinned types disagree, stop the
  affected API decision and report a baseline-coherence defect instead of
  choosing silently.

## Development Practice

- Remove obsolete behavior instead of adding migrations, fallbacks, warnings,
  legacy diagnostics, or removed-behavior tests.
- Choose the simplest complete implementation. Avoid speculative abstractions,
  configuration, and indirection.
- Model effectful recoverable boundary failures with Effect's typed error
  channel. Keep pure domain branching as direct values, discriminated unions,
  `Either`, or `Option` where useful; keep invariant/system failures as defects.
  Never serialize Effect/Either/Option wrapper objects into IR, events, SQLite
  rows, or CLI JSON unless the wrapper is itself an explicit product contract.
- Grow the system in layers: keep the smallest version working end to end
  before adding capability.
- Keep components modular and concerns clearly separated.
- Prefer established libraries when they reduce total complexity or improve
  reliability.
- Use the standard library, platform, and existing dependencies before adding
  code or packages; verify dependency documentation and types first.
- Make durable architectural decisions, not stopgaps intended for replacement.
- Ask whether each design enables the consumer's next valid action with the
  minimum authoritative delta.

## Clean Code

Bias toward subtraction. The shortest complete implementation wins; every line
must earn its place.

- **Least code:** implement the actual task, not anticipated needs.
- **stdlib first:** do not reinvent validation, parsing, dates, collections, or strings.
- **platform before dependencies:** import only capability the runtime lacks.
- **abstract at the second caller:** no single-use interface, factory, flag, or configuration.
- **delete speculative flexibility:** no future-facing parameters or hooks.
- **no safety theater:** no retries, caches, or guards around idempotent or local calls.
- **shrink:** prefer direct built-ins over verbose plumbing.
- **plain names, sparse comments:** explain only non-obvious intent.

**Self-check:** delete dead code, replace hand-rolled utilities, remove YAGNI
abstractions, and shrink verbose logic.

## Delivery

- After a production feature, MUST run relevant build/tests and keep checked-in
  generated artifacts current.
- Use narrow checks while iterating, then run `pnpm test` and `pnpm typecheck`
  before handoff.
- Report verification performed and any intentional omissions.
