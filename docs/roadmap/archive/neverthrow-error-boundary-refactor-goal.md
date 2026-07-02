# Neverthrow Error Boundary Refactor Goal

This roadmap record defines a future full-repo refactor for Acpus error
boundaries. It is an execution guide, not current product truth. Current
implemented behavior continues to live in `specs/`.

**Implements with Clean Code and Good Test @AGENTS.md**

## Status

- [x] Boundary standard accepted: use typed results for recoverable boundary
  failures; keep ordinary local absence as plain TypeScript.
- [x] Implementation complete.
  - [x] Phase 1-2 Core/expression typed lowering helpers, task-node unsafe cast
    removal, focused tests, and subagent review.
  - [x] Phase 3 workflow-compiler preflight/module typed ResultAsync helpers,
    task package typed git worktree domain errors, focused tests, and subagent
    review.
  - [x] Phase 4-6 runtime/scheduler/store Result boundary migration:
    scheduler store-port `try*` Result methods, typed scheduler advance
    adapter, tagged idempotency/retry/store errors, typed durable command
    variants, stable failed command payloads, reducer exhaustiveness, focused
    tests, and subagent review.
  - [x] Phase 7 CLI workflow-preparation adapter consumes typed compiler
    results while preserving CLI output behavior.
  - [x] Final full-repo verification and final review.
- [x] Specs updated for delivered Core/expression/compiler/tasks/runtime/CLI
  behavior. Specs should change only when implementation
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
- Prefer a neverthrow lint rule if the repo lint setup can enforce result
  consumption with acceptable signal. Validate compatibility with the current
  ESLint setup before adding a package or CI gate.
- Use `ok`, `err`, `okAsync`, `errAsync`, `Result`, `ResultAsync`, `map`,
  `mapErr`, `andThen`, `asyncAndThen`, `orElse`, `match`,
  `Result.fromThrowable`, `ResultAsync.fromPromise`,
  `ResultAsync.fromThrowable`, `Result.combine`, and
  `Result.combineWithAllErrors` according to the official docs.
- Avoid `._unsafeUnwrap` and `._unsafeUnwrapErr` in production control flow.
- Use `safeTry` sparingly, only when it is clearer than explicit chaining.
- Do not serialize `Result`, `ResultAsync`, `Ok`, or `Err`.
- Do not introduce optional-value wrappers for ordinary absence.

## Neverthrow Usage Standard

Use this table during implementation reviews. The intent is to make Result
composition predictable, not to make every function functional.

| API | Use For | Avoid |
| --- | --- | --- |
| `ok` / `err` | Constructing a sync boundary result with a typed success or error. | Returning stringly `{ ok: false, message }` objects where a typed error union is expected. |
| `okAsync` / `errAsync` | Constructing an async boundary result when no promise adapter is needed. | Wrapping already available sync results just to make callers `await`. |
| `map` | Transforming a successful value without changing the error type. | Returning another `Result` from the callback; use `andThen` instead. |
| `mapErr` | Translating lower-level error tags into package-level errors while preserving context. | Formatting human messages too early and losing machine-readable fields. |
| `andThen` | Chaining a dependent fallible sync step and flattening nested results. | Using it for pure value decoration that belongs in `map`. |
| `asyncAndThen` | Moving from a sync result into an async fallible step. | Starting all async chains with `await` and then manually branching when composition is clearer. |
| `orElse` | Explicit recoverable fallback, such as stale compile cache recovery or retrying a benign miss. | Hiding domain failures by converting every error into a default success. |
| `match` | Terminal boundary consumption: CLI rendering, process exit behavior, test assertion helpers, worker JSON adapters. | Deep internal unwrapping just to continue normal domain logic. |
| `Result.fromThrowable` | Wrapping synchronous third-party or platform APIs that throw, such as `JSON.parse`. | Wrapping functions whose failures are already typed. |
| `ResultAsync.fromPromise` | Mapping promise rejection into a typed error. | Assuming it catches synchronous throws that happen before a promise exists. |
| `ResultAsync.fromThrowable` | Wrapping promise-returning functions that may throw synchronously or reject asynchronously. | Broadly wrapping internal code to avoid designing a real error union. |
| `andTee` / `orTee` | Non-critical side effects such as logging or metrics where side-effect failure must not affect the main result. | Meaningful mutations such as store writes, command completion, event appends, or state transitions. |
| `Result.combine` | Combining dependent-or-all-required results where fail-fast semantics are acceptable. | Validation flows that should report all independent diagnostics. |
| `Result.combineWithAllErrors` | Independent validation/lowering where complete diagnostics are more useful than fail-fast behavior. | Runtime control flow where the first failure should stop mutation. |

Production code should not call `_unsafeUnwrap`, `_unsafeUnwrapErr`, or
`safeUnwrap`. Tests should usually compare `Result` values directly with
`ok(...)` and `err(...)`; unsafe unwraps are only acceptable in narrow test
helpers when direct equality makes the assertion less clear.

`ResultAsync` is useful where async failures continue composing. Simple local
`async`/`await` remains fine when no recoverable boundary is being modeled.

## Error Union Standard

Error unions should be tagged, serializable, and specific enough to drive
control flow without reading messages.

Positive pattern:

```ts
type SchedulerStoreError =
  | { type: "run-not-found"; runId: string }
  | { type: "version-mismatch"; runId: string; expected: number; actual: number }
  | { type: "owner-epoch-inactive"; runId: string; ownerEpoch: number };
```

Use `message` only as display text or debugging context. Do not require callers
to parse it. Prefer stable identifiers such as `runId`, `nodeKey`,
`attemptId`, `commandId`, `expectedVersion`, and `actualVersion` over rendered
sentences.

When crossing package boundaries, use `mapErr` to add context rather than
discarding the original tag:

```ts
return lowerSchema(schema).mapErr(error => ({
  type: "node-schema-lower-failed",
  nodeId,
  cause: error,
}))
```

## Module Migration Plan

### Phase 1: Foundation

- Add the minimal neverthrow dependency surface.
- Add or reuse a small `assertNever` helper for local exhaustive switches.
- Document this error-boundary standard in `AGENTS.md`.
- Add a root lint path only after validating compatibility with the current
  ESLint version and flat config shape. Scope the first lint gate to migrated
  packages instead of the whole repo.
- Keep future-plan content in `docs/roadmap/`; update `specs/` only after
  implementation changes land.

### Phase 2: Core First

- Audit `packages/core` for recoverable failures represented by throws,
  `undefined as unknown as`, broad `any`, open strings, or non-composable
  diagnostics.
- Convert graph, task, expression, and schema lowering boundaries to typed
  `Result` returns where callers must handle recoverable failure.
- Target these concrete seams first:
  `packages/core/src/schema/lower.ts`,
  `packages/expression/src/internal/expr.ts`,
  `packages/expression/src/index.ts`,
  `packages/core/src/graph/builder.ts`, and
  `packages/core/src/nodes/leaf/task.ts`.
- Refactor invalid task-node handling so graph construction receives a typed
  success/failure result instead of synthetic invalid task tokens.
- Add a small schema categorizer for Acpus-supported schema kinds. Exhaustively
  match only those known categories and preserve unsupported-schema errors for
  unknown Zod shapes.
- Keep public authoring helpers ergonomic. If public helpers continue throwing
  for programmer misuse, add internal `Result`-returning lowering helpers for
  Core/compiler use instead of forcing every author-facing helper to expose
  neverthrow directly.
- Preserve the public surface through `packages/core/src/index.ts`.

### Phase 3: Authoring And Compiler Boundaries

- Keep author-facing DSL shapes such as `{ use: "..." }` and
  `{ command: "..." }`.
- Normalize validated authoring variants into internal tagged unions before
  lowering.
- Use `Result.combineWithAllErrors` only for validation flows where collecting
  multiple independent diagnostics materially improves feedback.
- Keep optional authoring fields as optional fields.
- Target compiler boundaries:
  `packages/workflow-compiler/src/compiler/module.ts`,
  compile worker output paths, and
  `packages/workflow-compiler/src/preflight/index.ts`.
- Convert dynamic import, default-export validation, workspace containment, and
  preflight failures into tagged compile/preflight errors. Use
  `ResultAsync.fromThrowable` for promise-returning operations that may throw
  synchronously before returning a promise.
- Convert task package domain refusals such as dirty repository, unsafe
  worktree path, or unregistered worktree removal into typed task errors at
  `packages/tasks/src/git.ts`. Keep process/system failures separate.

### Phase 4: Runtime Commands And Execution

- Replace known open command shapes with discriminated unions for `pause`,
  `resume`, `retry`, `fork`, `signal`, and `shutdown`.
- Give each command variant a typed payload and typed result/error shape.
- Represent expected execution outcomes as `Result` or `ResultAsync`, including
  signal awaiting, missing executor, runtime node failure, invalid control
  state, and recoverable command failures.
- Target runtime control seams:
  `packages/runtime/src/control/apply-command.ts`,
  `packages/runtime/src/scheduler/control.ts`,
  `packages/runtime/src/execution/advance.ts`,
  `packages/runtime/src/execution/scheduler.ts`,
  `packages/runtime/src/scheduler/runtime-runner.ts`, and
  `packages/runtime/src/runs/use-cases.ts`.
- Migrate expected execution exception classes into tagged errors such as
  `signal-awaiting`, `executor-required`, and `node-failed`, preserving `nodeId`
  and executed-node context.
- Keep existing discriminated success values such as scheduler advance summaries
  and runtime advance results as plain serializable success values.
- Keep actual executor, process, backend, SQLite, and system failures as throws
  until narrow adapters classify them.

### Phase 5: Scheduler And Store

- Add a `SchedulerStoreError` tagged union for recoverable failures:
  `run-not-found`, `lease-lost`, `version-mismatch`, `run-paused`,
  `owner-epoch-stale`, `owner-epoch-inactive`, `terminal-attempt`,
  `idempotency-conflict`, `missing-retry-target`, and
  `invalid-retry-target`.
- Make `packages/runtime/src/scheduler/store-port.ts` the first runtime
  boundary. Convert store-port operations whose failures drive scheduler
  control flow to `Result` or `ResultAsync`, including `loadRunSnapshot`,
  `appendSchedulerEvents`, `startAttempt`, `commitAttemptResult`,
  `consumeSignal`, `pauseRun`, `resumeRun`, `retryRun`, `retry`, and
  `markExpiredOwnerAttemptsSuperseded`.
- Map concrete store failures in `packages/runtime/src/store/store.ts` into
  tags such as `run-not-found`, `version-mismatch`, `lease-not-active`,
  `run-paused`, `attempt-not-found`, `attempt-terminal`,
  `idempotency-conflict`, `invalid-event-stream`, and `sqlite-error`.
- Refactor scheduler advance logic to branch on error tags.
- Refactor command application so failed commands persist a stable typed result
  payload rather than only `{ message }`.
- Keep SQLite corruption, invalid persisted rows, and impossible scheduler
  states as invariant/system failures.

### Phase 6: Event And Command Exhaustiveness

- Use explicit tagged unions for high-cardinality scheduler event families and
  normalized command outcomes.
- Use native `switch` plus `assertNever` for small local unions.
- Use `ts-pattern` `.exhaustive()` only where large or nested unions become
  clearer with pattern matching.
- Remove reducer dispatch based on event type string prefixes.
- Keep pure projection functions in `scheduler/transitions.ts` mostly pure.
  Throws in projection code can remain invariant failures for corrupted event
  streams or impossible replay states; expected scheduler/store contention
  belongs in tagged results at the store-port and advance boundaries.

### Phase 7: CLI Boundaries

- Convert domain result errors into current CLI not-found, validation, and
  execution errors at command boundaries.
- Preserve current text and JSON output shapes unless specs intentionally
  change them.
- Consume result values with `.match()` at the boundary.
- Target `packages/cli/src/commands/runs.ts`,
  `packages/cli/src/commands/run.ts`, and
  `packages/cli/src/workflow-preparation.ts` as result consumption adapters.
- Keep `packages/cli/src/program.ts` as the top-level Commander/CliError
  fallback boundary, not the place for package-specific domain branching.
- Keep `packages/cli/src/output.ts` as plain serializable output formatting.
  Do not introduce `Result` into static metadata or rendering helpers just
  because a field is optional.

### Phase 8: Specs And Tests

- Update relevant `specs/*.md` after the implementation is concrete.
- Update public type contract tests for new `Result` APIs.
- Add focused unit, contract, integration, and E2E coverage at the lowest stable
  layer for each migrated boundary.

## Completion Gates

- `neverthrow` appears only in packages that import it directly.
- Production code has no optional-value wrapper introduced for ordinary local
  absence.
- Production code has no `_unsafeUnwrap`, `_unsafeUnwrapErr`, or `safeUnwrap`
  usage.
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
- Any introduced lint gate is scoped, documented, and compatible with the repo's
  ESLint setup.
- Search gates are split into hard failures and advisory audits, with remaining
  advisory matches explained.

## Search Gates

Run hard gates before handoff. Remaining matches should block completion unless
there is a documented false positive.

```sh
rg "message\\.includes|message\\.match|String\\([^\\n]*\\)\\.includes" packages/runtime/src packages/cli/src
rg "startsWith\\(\"instance\\.|startsWith\\(\"attempt\\.|startsWith\\(\"group\\." packages
rg "undefined as unknown as" packages/core packages/runtime
rg "_unsafeUnwrap|_unsafeUnwrapErr|safeUnwrap" packages --glob "!**/test/**"
rg "catch \\(error\\).*finishCommand|payload: \\{ message:" packages/runtime/src
```

Run advisory audits and explain remaining matches:

```sh
rg "as unknown as" packages/core packages/runtime
rg "type: string" packages/core packages/runtime packages/cli
rg "\\| undefined|return undefined" packages/cli/src packages/runtime/src/runs
rg "throw new Error|throw new [A-Za-z]" packages/core/src packages/expression/src packages/workflow-compiler/src packages/tasks/src packages/runtime/src
rg "fromSafePromise|\\.unwrap\\(" packages
rg "ResultAsync|Result<|ok\\(|err\\(" packages/*/src
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
- Core schema lowering: supported schema categories, unsupported Zod shapes,
  and non-JSON literal values return exact tagged errors.
- Expression lowering: unsupported authoring values return exact tagged errors
  without throwing through Core/compiler seams.
- Authoring normalization from `{ use } | { command }` to internal tagged
  variants.
- Compiler/preflight contract tests: missing file, invalid default export,
  outside-workspace workflow, check failure, validate failure, and compile
  worker failure resolve to typed `Err` values.
- Task package tests: dirty repository, unsafe worktree path, and unregistered
  worktree removal are typed task-domain failures, while process/system failures
  remain separate.
- Runtime typed control command payloads and command result handling.
- Runtime execution tests: signal awaiting, executor required, node failure,
  cancellation, and timeout are expected tagged outcomes where applicable.
- Scheduler store-port contract tests: version mismatch, lease lost or inactive
  owner epoch, paused run, terminal attempt, missing or consumed signal wait,
  and idempotency conflict.
- Scheduler `advanceRun` handling of structured store errors without message
  matching. Fake stores should return tagged errors with arbitrary messages to
  prove behavior does not depend on text.
- Scheduler reducer exhaustiveness, so adding a scheduler event variant fails
  typecheck until handled.
- Scheduler command tests: failed commands persist stable typed result payloads,
  not only message text.
- CLI adapter contract tests for domain-error-to-CLI conversion, asserting exit
  code, phase, message, and JSON/text shape at the lowest stable layer.
- CLI E2E tests only for paths requiring workspace/process behavior: missing
  run, invalid signal node, invalid fork input, and shutdown without supervisor.

## Review Gates

- **Boundary review:** confirm every result represents a recoverable boundary
  failure, not ordinary local absence.
- **Core-first review:** confirm the migration starts in Core and expands
  outward.
- **Neverthrow API review:** confirm every API use matches the official docs,
  especially async adapters, `combine`, `combineWithAllErrors`, and `safeTry`.
- **Composition review:** confirm internal code composes with `map`,
  `andThen`, `mapErr`, `orElse`, and `asyncAndThen`; `.match()` appears only at
  real consumption boundaries.
- **Async adapter review:** confirm `ResultAsync.fromPromise` is not expected to
  catch synchronous throws, and `ResultAsync.fromThrowable` is used only at
  narrow unsafe promise-returning adapters.
- **Side-effect review:** confirm `andTee` and `orTee` are used only for
  non-critical logging or metrics, not for required state mutations.
- **Persistence review:** confirm no library objects enter IR, scheduler events,
  SQLite rows, or CLI JSON.
- **CLI behavior review:** confirm user-facing behavior is preserved unless a
  spec explicitly changed it.
- **Lint review:** confirm any neverthrow lint rule is compatible with the repo
  tooling and paired with a production unsafe-unwrap ban.
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
- `.match()` is a terminal operation. If a function matches only to keep going,
  the implementation probably needs `map`, `andThen`, `mapErr`, or `orElse`
  instead.
- Lint can force result consumption, but allowing `._unsafeUnwrap` as an
  official escape hatch would weaken the migration. Pair lint with a production
  search gate.
- Some casts sit at legitimate interop boundaries such as Zod, process IO,
  SQLite rows, and third-party APIs. The migration should isolate and name
  those boundaries rather than chase zero-cast purity.
