# Neverthrow Error Boundary Refactor Goal

This roadmap record defines a future full-repo refactor for Acpus error
boundaries. It is an execution guide, not current product truth. Current
implemented behavior continues to live in `specs/`.

**Implements with Clean Code and Good Test @AGENTS.md**

## Status

- [x] Boundary standard accepted: use typed results for recoverable boundary
  failures; keep ordinary local absence as plain TypeScript.
- [ ] Implementation not started.
- [ ] Specs not updated yet. Specs should change only when implementation
  changes land.

## Background

The TypeScript-first implementation has reached a point where broad JavaScript
failure shapes are becoming maintenance risk. Several paths still rely on
thrown errors, open strings, loose casts, or message matching for behavior that
is part of normal domain control flow.

The refactor goal is to make recoverable failures explicit at package,
use-case, scheduler, store, and CLI boundaries. Local optional values stay
simple. The codebase should gain better type pressure where a caller must make
a domain decision, without adding wrappers around every value that might be
absent.

Use the official neverthrow documentation as the API source of truth during
implementation:

- [neverthrow README](https://github.com/supermacro/neverthrow)
- [neverthrow basic usage examples](https://github.com/supermacro/neverthrow/wiki/Basic-Usage-Examples)

## Goal

Migrate Acpus from Core outward so recoverable domain failures are represented
as `Result<T, E>` or `ResultAsync<T, E>` with tagged error unions.

The delivered state should:

- make Core lowering and validation failures composable;
- make runtime command and execution outcomes explicit;
- make scheduler/store control-flow failures typed instead of message-matched;
- keep CLI output and exit behavior stable unless a spec intentionally changes
  it;
- keep serialized IR, scheduler events, SQLite rows, and CLI JSON as plain data.

## Refactoring Standard

### Local Absence

Use plain `undefined` for local absence when it is not a recoverable boundary
failure.

Positive pattern:

```ts
const node = nodes.get(nodeId)
if (!node) {
  continue
}
```

Positive pattern:

```ts
const timeoutMs = task.options?.timeoutMs
```

Counterexample:

```ts
const value = optionalValueToWrapper(input.value)
return wrapperToOptional(value)
```

Wrapping an optional value and immediately converting it back does not improve
the boundary.

### Recoverable Boundary Failures

Use `Result<T, E>` for synchronous recoverable failures that cross a stable
boundary. Use tagged unions for `E`.

Positive pattern:

```ts
import { err, ok, type Result } from "neverthrow"

type LowerWorkflowError =
  | { type: "invalid-task-spec"; path: string; message: string }
  | { type: "unsupported-schema"; path: string; schemaKind: string }

function lowerWorkflow(input: WorkflowInput): Result<WorkflowIR, LowerWorkflowError> {
  const graph = buildGraph(input)
  if (graph.isErr()) {
    return err(graph.error)
  }

  return ok(toWorkflowIR(graph.value))
}
```

Preferred composition when it stays readable:

```ts
return buildGraph(input)
  .andThen(validateGraph)
  .map(toWorkflowIR)
```

Counterexample:

```ts
try {
  return buildGraph(input)
} catch (error) {
  if (String(error).includes("unsupported schema")) {
    return fallbackGraph
  }
  throw error
}
```

Domain control flow should branch on typed error tags, not exception text.

### Async Boundaries

Use `ResultAsync<T, E>` when async recoverable failures need typed composition.
Use neverthrow adapters such as `ResultAsync.fromPromise` or
`ResultAsync.fromThrowable` at narrow unsafe boundaries after checking the
official API signature.

Positive pattern:

```ts
import { ResultAsync } from "neverthrow"

return ResultAsync.fromPromise(
  store.claimLease(runId),
  (cause) => toSchedulerStoreError(cause),
).andThen((lease) => advanceWithLease(lease))
```

Counterexample:

```ts
const lease = await store.claimLease(runId).catch((error) => {
  throw new Error(`lease failed: ${error.message}`)
})
```

This converts typed recoverable control flow back into exceptions.

### Boundary Consumption

Use `.match()` at CLI/API/test boundaries where the program decides output,
exit code, or assertion behavior.

Positive pattern:

```ts
const result = await signalRun(args)

return result.match(
  (value) => renderSignalResult(value),
  (error) => renderCliError(toCliError(error)),
)
```

Counterexample:

```ts
const result = await signalRun(args)
if (result.isErr()) {
  throw toCliError(result.error)
}
return renderSignalResult(result.value)
```

This shape is only acceptable inside a narrow CLI adapter. It should not become
the normal pattern in Core, runtime, scheduler, or store modules.

### Exceptions

Keep `throw` for programmer errors, impossible states, invariant violations,
corrupted persisted state, system failures, and third-party failures before a
narrow adapter converts them.

Positive pattern:

```ts
function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${String(value)}`)
}
```

Counterexample:

```ts
throw new Error("run not found")
```

`run not found` is normal domain control flow at runtime, scheduler, store, and
CLI boundaries. It should become a tagged result error.

## Dependency And Tooling Standard

- Add `neverthrow` only to packages that import it directly.
- Prefer `eslint-plugin-neverthrow` if the repo lint setup can enforce result
  consumption with acceptable signal.
- Use `ok`, `err`, `okAsync`, `errAsync`, `Result`, `ResultAsync`, `map`,
  `mapErr`, `andThen`, `orElse`, `match`, `ResultAsync.fromPromise`,
  `ResultAsync.fromThrowable`, `Result.combine`, and
  `Result.combineWithAllErrors` according to the official docs.
- Avoid `._unsafeUnwrap` in production control flow.
- Use `safeTry` sparingly, only when it is clearer than explicit chaining.
- Do not serialize `Result`, `ResultAsync`, `Ok`, or `Err`.
- Do not introduce optional-value wrappers for ordinary absence.

## Module Migration Plan

### Phase 1: Foundation

- Add the minimal neverthrow dependency surface.
- Add or reuse a small `assertNever` helper for local exhaustive switches.
- Document this error-boundary standard in `AGENTS.md`.
- Keep future-plan content in `docs/roadmap/`; update `specs/` only after
  implementation changes land.

### Phase 2: Core First

- Audit `packages/core` for recoverable failures represented by throws,
  `undefined as unknown as`, broad `any`, open strings, or non-composable
  diagnostics.
- Convert graph, task, expression, and schema lowering boundaries to typed
  `Result` returns where callers must handle recoverable failure.
- Refactor invalid task-node handling so graph construction receives a typed
  success/failure result instead of synthetic invalid task tokens.
- Add a small schema categorizer for Acpus-supported schema kinds. Exhaustively
  match only those known categories and preserve unsupported-schema errors for
  unknown Zod shapes.
- Preserve the public surface through `packages/core/src/index.ts`.

### Phase 3: Authoring And Compiler Boundaries

- Keep author-facing DSL shapes such as `{ use: "..." }` and
  `{ command: "..." }`.
- Normalize validated authoring variants into internal tagged unions before
  lowering.
- Use `Result.combineWithAllErrors` only for validation flows where collecting
  multiple independent diagnostics materially improves feedback.
- Keep optional authoring fields as optional fields.

### Phase 4: Runtime Commands And Execution

- Replace known open command shapes with discriminated unions for `pause`,
  `resume`, `retry`, `fork`, `signal`, and `shutdown`.
- Give each command variant a typed payload and typed result/error shape.
- Represent expected execution outcomes as `Result` or `ResultAsync`, including
  signal awaiting, missing executor, runtime node failure, invalid control
  state, and recoverable command failures.
- Keep actual executor, process, backend, SQLite, and system failures as throws
  until narrow adapters classify them.

### Phase 5: Scheduler And Store

- Add a `SchedulerStoreError` tagged union for recoverable failures:
  `run-not-found`, `lease-lost`, `version-mismatch`, `run-paused`,
  `owner-epoch-stale`, `owner-epoch-inactive`, `terminal-attempt`,
  `idempotency-conflict`, `missing-retry-target`, and
  `invalid-retry-target`.
- Convert store-port operations whose failures drive scheduler control flow to
  `Result` or `ResultAsync`.
- Refactor scheduler advance logic to branch on error tags.
- Keep SQLite corruption, invalid persisted rows, and impossible scheduler
  states as invariant/system failures.

### Phase 6: Event And Command Exhaustiveness

- Use explicit tagged unions for high-cardinality scheduler event families and
  normalized command outcomes.
- Use native `switch` plus `assertNever` for small local unions.
- Use `ts-pattern` `.exhaustive()` only where large or nested unions become
  clearer with pattern matching.
- Remove reducer dispatch based on event type string prefixes.

### Phase 7: CLI Boundaries

- Convert domain result errors into current CLI not-found, validation, and
  execution errors at command boundaries.
- Preserve current text and JSON output shapes unless specs intentionally
  change them.
- Consume result values with `.match()` at the boundary.

### Phase 8: Specs And Tests

- Update relevant `specs/*.md` after the implementation is concrete.
- Update public type contract tests for new `Result` APIs.
- Add focused unit, contract, integration, and E2E coverage at the lowest stable
  layer for each migrated boundary.

## Completion Gates

- `neverthrow` appears only in packages that import it directly.
- Production code has no optional-value wrapper introduced for ordinary local
  absence.
- Recoverable Core lowering failures use tagged `Result` errors.
- Runtime command inputs and outcomes use discriminated unions for known
  variants.
- Scheduler/store recoverable failures use tagged `Result` or `ResultAsync`
  errors.
- Scheduler/runtime control flow does not use `error.message.includes(...)` or
  equivalent message matching.
- Scheduler event reducers no longer dispatch by string prefix.
- CLI commands consume domain results at the boundary and preserve current
  not-found, validation, text, and JSON behavior.
- `buildTaskNode` no longer uses `undefined as unknown as ...`.
- Unsupported schema lowering goes through the typed categorizer.
- `legacy/` remains unchanged.
- Specs describe only delivered current behavior.

## Search Gates

Run these before handoff and explain any remaining matches:

```sh
rg "message\\.includes|String\\(.*\\)\\.includes" packages
rg "startsWith\\(\"instance\\.|startsWith\\(\"attempt\\.|startsWith\\(\"group\\." packages
rg "undefined as unknown as|as unknown as" packages/core packages/runtime
rg "_unsafeUnwrap" packages
rg "type: string" packages/core packages/runtime packages/cli
```

## Test Plan

- `pnpm test:unit`
- `pnpm test:contract`
- `pnpm test:integration`
- `pnpm test:e2e`
- `pnpm test:type`
- `pnpm test`
- `pnpm typecheck`

Add or update focused tests for:

- Core task-node invalid spec handling without unsafe double casts.
- Schema categorizer supported and unsupported paths.
- Authoring normalization from `{ use } | { command }` to internal tagged
  variants.
- Runtime typed control command payloads and command result handling.
- Scheduler `advanceRun` handling of structured store errors without message
  matching.
- Scheduler reducer exhaustiveness, so adding a scheduler event variant fails
  typecheck until handled.
- CLI show, mutate, signal, fork, replay, and shutdown not-found and validation
  paths after result boundary conversion.

## Review Gates

- **Boundary review:** confirm every result represents a recoverable boundary
  failure, not ordinary local absence.
- **Core-first review:** confirm the migration starts in Core and expands
  outward.
- **Neverthrow API review:** confirm every API use matches the official docs,
  especially async adapters, `combine`, `combineWithAllErrors`, and `safeTry`.
- **Persistence review:** confirm no library objects enter IR, scheduler events,
  SQLite rows, or CLI JSON.
- **CLI behavior review:** confirm user-facing behavior is preserved unless a
  spec explicitly changed it.
- **Test review:** confirm each new test maps to a concrete risk and targets the
  lowest stable layer.

## Non-Goals

- No whole-program ban on local `undefined`.
- No whole-program ban on invariant `throw`.
- No compatibility shims, migration warnings, or legacy-field diagnostics.
- No author-facing DSL shape changes solely for style.
- No broad functional runtime migration.
- No edits under `legacy/`.

## Risk Notes

- `Result` can become ceremony if code immediately unwraps or rethrows it. The
  migration should prefer meaningful composition through `map`, `andThen`,
  `mapErr`, `orElse`, and `.match()`.
- `ResultAsync` should appear where async composition benefits from it. Simple
  local async branches can remain ordinary `async`/`await` when no recoverable
  boundary is being modeled.
- Some casts sit at legitimate interop boundaries such as Zod, process IO,
  SQLite rows, and third-party APIs. The migration should isolate and name
  those boundaries rather than chase zero-cast purity.
