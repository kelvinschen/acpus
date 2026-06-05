# acpus

`acpus` is a CLI-first TypeScript orchestrator for durable ACP agent workflows. The project is currently in M1: YAML authoring, static linting, frozen IR generation, and dry-run schedule projection.

Runtime execution through Temporal is intentionally not implemented in M1.

## Packages

| Package | Goal |
| --- | --- |
| `@acpus/core` | Own the YAML DSL compiler boundary: parse specs, validate JSON Schema fragments, parse CEL expressions, lint references, emit frozen IR, and project a schedule summary. |
| `acpus` | Own the user-facing CLI: read files and input payloads, resolve includes, expose `lint`, and expose `run --dry-run` for IR inspection. |

Future packages should be split only when the runtime surface exists: likely `@acpus/runtime` for Temporal workflows/activities, `@acpus/mock-agent` for ACP-compatible fixtures, and `@acpus/artifacts` for artifact-store implementations.

## Commands

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

CLI examples:

```sh
pnpm acpus lint packages/core/test/fixtures/all-primitives.yaml
pnpm acpus run packages/core/test/fixtures/all-primitives.yaml --dry-run --json
```

`acpus run <spec>` without `--dry-run` exits with a clear M1 runtime-not-implemented error.

## Design Targets

- Keep `@acpus/core` free of process, filesystem, Temporal, and agent runtime side effects.
- Keep CLI output stable enough for tests and CI: `run --dry-run --json` emits `{ ok, diagnostics, ir, schedule }`.
- Keep workflow specs YAML-first and use standard JSON Schema objects under `expect.schema`.
- Build packages with `tsc` only for M1; bundling is a future publishing optimization, not a compiler/runtime requirement.

## References

- [PRD](docs/PRD-acpus.md)
- [CLI contract](docs/spec-cli.md)
- [DSL reference](docs/spec-dsl.md)
