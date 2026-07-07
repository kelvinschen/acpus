# Troubleshooting Next Acpus

## Start with the phase

Use `--json` when exact phase and diagnostics matter:

```sh
acpus --json workflows check <workflow.ts> --input '<json>'
acpus --json runs inspect <run-id>
```

Then fix the earliest phase. Do not jump to runtime controls for a `check`, `compile`, or `validate` problem.

## Common authoring failures

### Expr used as JavaScript boolean or comparison

Bad:

```ts
if (input.ready) { ... }
const ok = review.output.riskCount <= 3;
```

Good:

```ts
const ok = and(input.ready, lte(review.output.riskCount, 3));
step("require_ok").assert({ condition: ok });
```

### Untagged template interpolation

Bad:

```ts
prompt: `Review ${diff.output.patch}`
```

Good:

```ts
prompt: template`Review ${diff.output.patch}`
```

### Inline task captures module scope

Bad:

```ts
const PREFIX = "release-";
exec: async () => ({ slug: `${PREFIX}x` });
```

Good:

```ts
run: {
  input: { prefix: "release-" },
  exec: async ({ input }) => ({ slug: `${input.prefix}x` }),
}
```

### Non-admissible outputs

Do not return `Date`, `Map`, `Set`, class instances, functions, symbols, bigint, non-finite numbers, sparse arrays, cycles, or broad `object` outputs. Convert to JSON-compatible values or artifact refs.

### Branch output mismatch

`if`, `switch`, and `parallel` race branches should return compatible object shapes. If one branch returns `{ ok, summary }`, the other should return the same keys with compatible types.

### Loop mismatch

`loop.initial` and loop body output must converge. `previous` is non-optional and starts as `initial`. `maxIterations` counts body executions only.

### Fanout output confusion

`fanout.output` is an array. Use `head`, `get`, `map`, `filter`, `every`, or static graph construction patterns as appropriate. Do not treat fanout output as a key map.

## Common CLI failures

### Invalid input JSON

The CLI rejects invalid JSON before workflow preparation:

```sh
acpus workflows run workflow.ts --input '{"ready":true}'
```

### Workflow outside workspace

Workflow modules are prepared relative to the CLI workspace. If checking `/tmp/workflow.ts` from a repository root fails with `Workflow file ... must be inside workspace`, move the scratch workflow under the workspace, for example `.acpus/tmp/bench/workflow.ts`, and run `acpus workflows check .acpus/tmp/bench/workflow.ts` from the repository root.

### Local dist or module resolution missing

In a source checkout, `pnpm exec acpus` may fail with `ERR_MODULE_NOT_FOUND` for a workspace package `dist` path when local build outputs or workspace links are stale. Restore the package surface before diagnosing the workflow:

```sh
pnpm install --frozen-lockfile
pnpm build
```

When offline packages are already present, `pnpm install --frozen-lockfile --offline` can repair workspace links without resolving new dependencies.

### Agent override rejected

Override JSON must be an object keyed by declared top-level agent names. Do not use unknown names, both `use` and `command`, legacy `policy`, broad `options`, or raw IR `kind`.

### Static target ambiguous

Fanout/loop can create multiple dynamic instances. If a static alias is ambiguous, inspect the run and target a dynamic `nodeKey` or `frameKey`.

### Signal payload rejected

Schema-backed signals validate JSON payloads; schema-less signals receive raw strings. Match the target signal node output schema exactly enough for validation.

For signals nested under `fanout`, `loop`, `parallel`, or `switch`, prefer the dynamic signal `nodeKey` shown by `runs inspect`. If an invalid schema-backed payload is rejected, the wait should remain open; inspect again before sending the corrected payload.

## Hooks failures

- Hooks config must be JSON event map, not YAML.
- Do not use a top-level `hooks` wrapper.
- Regex strings in `match` must be valid JavaScript regex patterns.
- Invalid hook config can fail daemon startup; run `acpus hooks validate` before starting runs.

## Recovery mistakes to avoid

- Do not hand-edit `.acpus/.local/state/runtime.db`.
- Do not hand-edit frozen run files under `.acpus/.local/runs/<run-id>/`.
- Do not use retry after changing workflow source; use fork with `--workflow`.
- Do not use `--unsafe-reuse` unless the user explicitly accepts the risk.
- Do not assume stale means terminal failure; stale is a derived execution state, not a durable status.
