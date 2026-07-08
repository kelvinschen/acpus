# Expression Transform Roadmap

This document records the planned direction for lightweight runtime transforms
inside `@acpus/expression`. It is a roadmap note, not current product truth.
Current implemented behavior lives in `specs/`.

## Goal

Add an expression-level `transform(expr, fn)` helper that applies a small,
self-contained, synchronous runtime callback to an evaluated expression value and
returns a new `Expr<U>`.

The feature is intentionally a tiny, non-node task: it does not enter the
workflow DAG, does not create task attempts, and does not receive task context,
artifacts, cwd, env, timeout, retry, or async execution support.

## Planned Shape

Authoring API:

```ts
const title = transform(input.issue, issue => issue.title.trim());

const view = transform(input.issue, issue => ({
  title: issue.title.trim(),
  urgent: issue.labels.includes("urgent"),
}));
```

Type shape:

```ts
function transform<T, U>(
  value: WorkflowValue<T>,
  fn: (value: T) => U,
): Expr<U>;
```

Lowering target:

```ts
{
  kind: "call",
  fn: "transform",
  args: [
    { kind: "ref", path: ["input", "issue"] },
    { kind: "literal", value: "(issue) => issue.title.trim()" }
  ]
}
```

The callback source is stored as expression data, following the existing inline
task source-string model. The plan does not introduce a transform registry,
compiled transform manifest, secondary compiler, or user-authored transform
name.

## Boundaries

- Use existing expression helpers such as `add`, `len`, `get`, `where`, `map`,
  and `filter` for small declarative expression composition.
- Use `transform(expr, fn)` for pure, synchronous, local JSON value transforms
  that are too awkward to express with existing helpers and too small to justify
  a task node.
- Use Task nodes for IO, imports, reusable modules, artifacts, environment,
  workspace cwd, timeouts, async work, command execution, or any side effect.
- Treat `transform` as Acpus' practical fmap over `Expr<T>`, without adding
  graph-shaping monad semantics such as runtime-dependent step creation.

## Implementation Phases

### Phase 1: Expression Surface

- Add `transform` to the `@acpus/expression` root export.
- Lower `transform(value, fn)` to a `call` expression with operator id
  `transform`.
- Store callback source with `fn.toString()` as the second call argument.
- Add operator registry metadata for `transform` with arity 2.
- Keep `inputSchema` and `outputSchema` out of the first API; rely on TypeScript
  inference plus runtime JSON admissibility checks.

### Phase 2: Runtime Evaluation

- Extend the expression evaluator to execute `transform`.
- Evaluate the first argument normally.
- Load the second argument as a function source string using the same lightweight
  `data:text/javascript` import approach used by inline task execution.
- Call the function with the evaluated JSON value.
- Reject async results and non-JSON-compatible outputs before returning the
  transformed value.
- Surface callback failures as expression evaluation failures with the operator
  and source context in the error message.

### Phase 3: Authoring Checks

- Extend workflow-compiler authoring checks with parser-only static analysis for
  `transform(...)` callbacks.
- Accept only inline one-expression arrow callbacks in v1, such as
  `value => value.title.trim()`.
- Reject block-body callbacks, even when they are otherwise self-contained, so
  authors do not grow `transform` into a hidden task body.
- Reject async functions, generators, `this`, `arguments`, free identifier
  capture, dynamic import, and obvious non-deterministic or side-effectful APIs
  such as `process`, `Date`, `Math.random`, and `fetch`.
- Reuse the inline task free-identifier analysis approach instead of adding a new
  compiler pipeline.

### Phase 4: Specs And Tests

- Update `specs/expression-spec.md` only when implementation begins, describing
  `transform` as current behavior with RFC 2119 language.
- Add expression type tests for `Expr<T> -> Expr<U>` inference.
- Add lowering tests for callback source storage.
- Add evaluator tests for object/scalar transforms, callback throws, async
  rejection, and non-JSON output rejection.
- Add validator tests for `transform` arity and source argument shape.
- Add workflow-compiler authoring tests for accepted self-contained callbacks
  and rejected captures/side effects.
- Run the narrow expression and compiler checks during development, then broader
  typecheck/test before handoff.

## Open Questions

- Whether static side-effect detection should be a short denylist or a stricter
  allowlist of syntax and globals.
- Whether a future optional output schema is useful enough to justify expanding
  the API:

```ts
transform(input.issue, issue => ..., { output: IssueViewSchema });
```

The default remains schema-free until a concrete runtime-shape validation need
appears.
