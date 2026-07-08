# Expression Transform Roadmap

This archived record captures the design decisions and review follow-up for
expression-level `transform`. Current behavior lives in `specs/`.

## Historical Summary

The implemented design treats `transform(expr, fn)` as a lightweight Task-like
runtime callback, not as a workflow node and not as a second compiler. It stores
the callback as source text in expression IR, following the inline Task source
model, and evaluates it synchronously inside expression evaluation.

The public API keeps TypeScript inference natural:

```ts
const view = transform(input.issue, issue => ({
  title: issue.title.trim(),
  urgent: issue.labels.includes("urgent"),
}));
```

`transform` returns `OutputAccessor<U>` for callback return type `U`, so normal
expression accessors remain available on transformed objects and arrays. It does
not take input schema, output schema, user-authored names, or callback registry
options.

Authoring restrictions live in workflow-compiler checks. The accepted callback
form is an inline one-expression arrow. Block bodies, async callbacks, captures,
imports, side-effect syntax, non-allowlisted globals, and unsupported syntax are
reported before runtime. Callback return types use the same workflow-data
admissibility policy as Task outputs; `any` and `unknown` are not rejected solely
as safety measures.

Runtime keeps the final boundary guard and rejects non-JSON-compatible outputs,
async results, invalid source, missing values, and callback failures with
expression evaluation errors.

## Deferred

- Optional output schema support.
- Module-level or reusable transform declarations.
- Block-body callbacks.
- Imported helper dependencies.
- Async transforms.
- Task-like context, artifacts, cwd, env, timeout, retry, logging, or node-level
  observability.
- `flatMap`/`bind` semantics that let runtime values shape workflow graph
  topology.

## Review Log

- Expression implementation review covered API surface, lowering, operator
  registration, validation, evaluation, and expression tests. It found that
  callback throws escaped the expression error boundary and that evaluator tests
  under-covered array and nested outputs. The implementation was updated to wrap
  callback throws as `ExpressionEvaluationError` and to broaden evaluator
  coverage.
- Workflow-compiler authoring review covered import matching, callback syntax
  rules, capture handling, mutation checks, allowlisted globals, and diagnostics.
  It found shadowed facade bindings, prefix updates, comma expressions,
  shadowed `Math`/`Object`, callback source diagnostics, and coarse tests. The
  implementation was updated to bind transform calls to the Acpus expression
  facade, reject those syntax forms, and test the diagnostics directly.
- Four-dimension follow-up review covered goal completion, clean code, test
  quality, and TypeScript type design. True positives were the need for
  `OutputAccessor<U>` return typing, check-time callback output admissibility,
  removal of fake checker fallbacks, tighter global detection, less brittle
  source-string tests, nested callback negatives, stronger error assertions, and
  roadmap/spec separation. Those fixes were folded into the final implementation.
