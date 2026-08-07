# Acpus Codes of Conduct

> Treat current development as greenfield. **NEVER add compatibility shims unless explicitly requested.**

## Required Guides

- Before changing any spec, MUST read
  [Specification Maintenance](docs/specification-maintenance.md) completely.
- Before changing tests, test configuration, or test scripts, MUST read
  [Testing Maintenance](docs/testing-maintenance.md) completely.
- Before changing `packages/cli/skills/**` or Skill-facing guidance, MUST read
  [Skill Maintenance](docs/skill-maintenance.md) completely.
- A change spanning multiple domains MUST follow every applicable guide.

## Development Practice

- Remove obsolete behavior instead of adding migrations, fallbacks, warnings,
  legacy diagnostics, or removed-behavior tests.
- Choose the simplest complete implementation. Avoid speculative abstractions,
  configuration, and indirection.
- Model recoverable boundary failures with typed Result/ResultAsync and tagged
  errors. Keep local absence as `undefined`, invariant/system failures as
  throws, and never serialize Result objects into IR, events, SQLite rows, or
  CLI JSON.
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
