# Output Schema Authoring Refactor Goal

This roadmap record captures the planned refactor for Acpus output authoring.
It is a living goal document, not current product truth. Current implemented
behavior continues to live in `specs/`.

**Implements with Clean Code and Good Test @AGENTS.md**

## Status Summary

### Decision Status

The product direction is accepted. The implementation will proceed against the
decisions in this document rather than preserve the old task/composite
`outputSchema` behavior.

Confirmed decision areas:

- TypeScript-owned task and composite outputs come from TypeScript inference and
  static checks, not handwritten `outputSchema` fields.
- Schema-less agent and signal nodes expose raw `Expr<string>` text.
- Schema-backed agent and signal nodes keep `outputSchema` as a structured
  parsing boundary.
- Seeded loop output is driven by `initial`, pre-check semantics, and
  non-optional `previous`.
- Fanout all/quorum output is `Array<ItemOutput>` with strategy-specific
  ordering semantics.
- Workflow-admissible output types, opaque JSON escape hatches, IR shape,
  runtime normalization, and schema cleanup are specified below.

### Implementation Status

Implementation is complete for the current refactor scope. Phase status below
tracks delivery state, not decision state:

- Phase 1 public authoring type and schema-surface changes are implemented in
  source, tests, fixtures, specs, and generated core artifacts.
- Phase 2 compiler/check diagnostics for inferred output admissibility are
  implemented for strict graph-binding source-shape producer analysis,
  non-workflow-data rejection, branch convergence, loop consistency, task
  return-type checks, and `JsonValue`/`JsonObject` acceptance.
- Phase 3 IR/lowering and Phase 4 runtime semantics are implemented for the new
  task/composite schema-free IR, schema-less agent/signal raw strings, fanout
  quorum arrays, seeded loop behavior, and generic runtime workflow-data guards.
- Phase 5 specs and verification are complete for the current scope: current
  specs and tests were rewritten for the new behavior, full verification passes,
  and subagent review findings have been applied or documented as expected
  implementation differences below.

### Implemented Gaps And Expected Differences

The implementation intentionally differs from the earlier roadmap in these
places:

- The direct in-memory executor returns fanout quorum output as
  `Array<ItemOutput>` in completion order, but it does not stop or cancel
  remaining item executions as soon as quorum is reached. Durable scheduler
  execution owns quorum cancellation semantics. This is acceptable because the
  direct executor is a lightweight skeleton path and the public output contract
  remains the same array shape.
- Runtime workflow-data guards reject non-finite numbers before persistence.
  TypeScript does not model finite numbers, but SQLite/event persistence would
  otherwise serialize `NaN` or infinities lossy as JSON `null`; rejecting them at
  the runtime boundary is part of the persistence-safety guard, not business
  shape validation.

### Implementation Scope Status

No product-direction open questions remain. Implementation scope decisions are
fixed below so the refactor can proceed without preserving old
task/composite-schema behavior.

### Open Decisions Closed For Implementation

The remaining implementation choices are closed as follows so work can proceed
without further design confirmation:

- Treat task/composite `outputSchema` removal as a typed API deletion, not as a
  parser-diagnostic feature.
- Keep runtime admissible-value guards for persistence safety, but do not add
  generated shape schemas for TypeScript-owned outputs.
- Preserve schema-backed agent/signal parsing only when `outputSchema` is
  declared; schema-less agent/signal output is raw `string`.
- Keep `undefined` in the admissible authoring domain and document JSON
  persistence behavior; prefer `null` in docs when field presence matters.
- Remove `z.artifact()` and `z.secretRef()` completely from schema authoring;
  keep artifact refs only as plain runtime/task data and keep `secret(...)` only
  as an env-binding token.
- Enforce strict source-shape analysis for graph-binding outputs in
  compiler/check. Hidden graph producer shapes are errors rather than runtime
  fallbacks; task `exec` returns rely on TypeScript return types.
- Require seeded loop `initial` and non-optional `previous`; keep the node name
  `loop`.

## Background

The current TypeScript-first workflow authoring API still asks authors to repeat
`outputSchema` in many places where TypeScript already knows the output shape.
That repetition is especially visible in inline tasks and composite nodes.

The old schema-heavy shape improved runtime validation, but it also made the
authoring interface larger than the behavior it described. In practice, Acpus
authoring happens in TypeScript, and the AI authoring loop benefits more from
early static feedback than from runtime failures after a run starts.

The refactor goal is to treat `outputSchema` as a structure/parsing contract for
external intelligent workers, not as a universal node-output declaration.

## Goal

Simplify output authoring so TypeScript-owned outputs are inferred and checked
statically, while external worker boundaries opt into structured parsing with a
schema.

The delivered state must:

- remove handwritten `outputSchema` from task authoring surfaces when the task
  output can be inferred from `exec`;
- remove handwritten `outputSchema` from composite authoring surfaces when the
  output can be inferred from callbacks;
- keep schema declarations for agent and signal nodes only when the author wants
  structured parsing, prompt/response shape guidance, or payload validation;
- expose schema-less agent and signal outputs as raw `Expr<string>`;
- catch non-admissible workflow output types before runtime without trying to
  prevent deliberate TypeScript escape hatches such as `any` or `unknown`;
- avoid runtime surprises in the AI authoring workflow by pushing errors into
  TypeScript typecheck, workflow compiler checks, or authoring diagnostics.

## Fixed Decisions

### Schema Boundary Meaning

`outputSchema` stops meaning "every node's output declaration." It becomes a
structured parsing boundary for external worker outputs.

Agent and signal nodes have two modes:

- schema-less mode returns raw text as `Expr<string>`;
- schema-backed mode parses the worker response or submitted payload according
  to the declared schema and exposes typed structured output.

Task and composite nodes do not expose an author-facing `outputSchema` setting
when TypeScript can infer the output shape.

TypeScript-owned outputs also do not carry generated `outputSchema` in IR.
Runtime shape conformance for those outputs is not schema-normalized; it relies
on typecheck and compiler/check diagnostics before execution.
They also do not carry serialized TypeScript output type metadata for runtime,
UI, or visualization. Issues that can be solved at static authoring time must
not be moved into runtime IR.

This refactor keeps `WorkflowIR.irVersion` at `2`. The TypeScript-first core has
not been published, so the existing v2 shape is rewritten in place and no legacy
v2 compatibility shim is planned.

The `outputSchema` name remains for schema-backed agent and signal nodes. The
refactor narrows where the field appears instead of renaming the remaining
structured-output contract.

### Agent Output

Schema-less agent nodes expose the agent response text directly:

```ts
const review = step("review").agent({
  run: {
    agent: agents.reviewer,
    prompt: template`Review ${input.path}`,
  },
});

return {
  reviewText: review.output,
};
```

There is no wrapper such as `{ text: string }` in the authoring model.
Empty strings are valid schema-less agent outputs. Raw text mode follows the
TypeScript `string` type; authors who need non-empty text should add workflow
logic for that requirement.

Schema-backed agent nodes keep the structured-output behavior: the runtime uses
the schema to guide the prompt, recover JSON, repair non-conforming responses,
and expose the parsed value.
Schema-backed primitive outputs are allowed. For example, `outputSchema:
z.string()` expects the worker to produce a JSON string and still uses structured
parsing and repair; it is not the same runtime contract as schema-less raw text.
Agent `retry` remains available only for schema-backed agents, where it means
response recovery and schema-conformance repair. Schema-less agents have no
output conformance target to repair and must not declare `retry`.

### Signal Output

Signal nodes mirror agent nodes.

Schema-less signal nodes accept and expose raw text as `Expr<string>`.
Schema-backed signal nodes parse submitted payloads according to the declared
schema and expose typed structured output.
Empty strings are valid schema-less signal payloads for the same reason: raw text
mode follows the TypeScript `string` type.

At runtime/admission, schema-less signal payloads are JSON strings. CLI and UI
surfaces may present plain text entry, but the scheduler payload is the string
itself, not an object wrapper.
Signal submission uses one payload interface. If the signal has no
`outputSchema`, the payload is treated as the raw string. If the signal has an
`outputSchema`, the payload must be a JSON string that parses to a value
conforming to that schema. The CLI must not introduce separate text and JSON
submission APIs for these modes.
For example, a schema-less signal payload `approved` becomes the string
`"approved"`. A schema-backed object signal expects text such as
`{"approved":true,"notes":"ok"}`. A schema-backed `z.string()` signal expects a
JSON string literal such as `"approved"` rather than raw `approved`.

This symmetry keeps human and agent workers under the same mental model: both
can produce either raw text or structured data.

### Task Output

Inline task output comes from `Awaited<ReturnType<exec>>`. Reusable task output
comes from the reusable task definition's `Awaited<ReturnType<exec>>`.

The authoring API must not ask for a duplicated task `outputSchema` when the
TypeScript return type is available.

Reusable task definitions keep `inputSchema` because task input crosses from
workflow expressions into task code. They drop `outputSchema`; reusable task
output is inferred from `exec` and checked by the workflow compiler's
output-admissibility rules.
Inline tasks continue to use `run.input` as the expression-to-runtime-value
boundary and do not need a separate `inputSchema`. Runtime evaluates `run.input`
expressions and passes the resulting object to `exec`; TypeScript and compiler
checks own the callsite/input compatibility story.

Task outputs still need to be workflow-admissible. Types such as functions,
classes, `Date`, `Map`, `Set`, `symbol`, `bigint`, broad `object`, and other
non-workflow values are rejected before runtime by type pressure or compiler
checks. `any` and `unknown` are TypeScript escape hatches rather than Acpus
authoring guarantees; authors who want typed opaque JSON should model it
explicitly as `JsonValue` or `JsonObject`.
Because those types become part of the normal authoring surface,
`@acpus/core` must re-export them from its root entrypoint. They must not need
to be imported from `@acpus/expression/ir`, `@acpus/core/ir`, or
`@acpus/core/schema`.

The same workflow-admissible output domain applies to composites. Outputs are
plain JSON-compatible values. `undefined` remains allowed as authoring
optionality because the expression layer already models optional access as
`Expr<T | undefined>` and authors may need to carry optional fields through
workflow logic. Persisted JSON follows normal JSON semantics: object properties
whose runtime value is `undefined` are omitted, array slots become `null`, and
authors should prefer `null` when field presence with an empty value matters.
Functions, class instances, `Date`, `Map`, `Set`, `symbol`, `bigint`, broad
`object`, and other non-workflow values are rejected before runtime. Explicit
opaque JSON types such as `JsonValue` and `JsonObject` remain allowed.

Workflow-admissible type checking uses these boundaries:

- `Expr<T>` is admissible when `T` is admissible; the checker unwraps the
  expression value type rather than treating the authoring-time `Expr` object as
  output data.
- `string`, `number`, `boolean`, `null`, and `undefined` are admissible
  primitives, with `undefined` following the JSON persistence behavior above.
- Arrays and tuples are admissible when every item type is admissible.
- Plain structural object types are admissible when every field type is
  admissible; optional fields remain optional.
- TypeScript-only modifiers such as `readonly` and literal precision are not
  restricted when they have no runtime JSON effect; the authoring surface
  preserves TypeScript's native experience.
- `JsonValue` and `JsonObject` are admissible opaque JSON escape hatches.
- Literal and union types are admissible only when every variant is admissible.
- Functions, constructors, class instances, `Date`, `Map`, `Set`, `WeakMap`,
  `WeakSet`, `Promise`, `symbol`, `bigint`, and known non-workflow values are
  rejected. `any` and `unknown` remain TypeScript escape hatches owned by the
  author. Domain class instances must be converted to plain objects before they
  become workflow output.

Top-level output shape follows the node kind:

- Task `exec` may return any workflow-admissible value: primitive, array, plain
  object, or explicit opaque JSON.
- Task `exec` may return workflow-admissible unions, including discriminated
  object unions. This is a leaf TypeScript return contract. Composite branch
  merges still require stable object shape convergence and do not expose object
  shape unions downstream.
- Task `exec` may return top-level `void` or `undefined` for side-effect/no-op
  tasks. Such tasks have no useful structured output for downstream field
  access; authors should return an object when downstream workflow logic needs
  data.
- Composite scope callbacks still return named output objects because scopes
  expose fields through `ScopeIR.outputs`.
- Task `exec` may be async, but the output contract is the awaited value.
  Composite callbacks are authoring-time scope builders and must remain
  synchronous; they do not return promises.
- This composite object requirement applies to every composite callback: `if`
  branches, `switch` cases/default, `parallel` branches, `fanout` items, and
  `loop` bodies. It is a `ScopeIR` named-output constraint, not an
  `outputSchema` compatibility rule.
- Root workflow returns also remain named output objects and must satisfy the
  same workflow-admissible output domain before durable persistence.
- Root workflow output must keep a stable object shape. Field values may be
  unions, but the root output object itself must not be a conditional object
  shape union.
- Schema-less agent and signal nodes return raw strings.
- Schema-backed agent and signal nodes expose whatever workflow-admissible value
  the declared schema permits, including object, array, or primitive values.

### Schema Extension Cleanup

`z.path()` remains because task inputs and workflow inputs still benefit from a
semantic path string marker.

`z.integer()`, `z.artifact()`, and `z.secretRef()` are removed completely from
the schema authoring surface and from `SchemaIR`. Integer-specific schema
semantics are not preserved; authors should use normal number schemas. Artifact
and secretRef schemas must not be available for task, composite, agent,
signal, input, or output schemas.
Schema lowering, SchemaIR validation, JSON Schema conversion, and runtime
`normalizeValue` must remove the corresponding integer/artifact/secretRef
special cases.

This does not remove runtime artifact or secret primitives:

- Task artifact APIs may continue returning plain JSON artifact reference
  objects, and runtime artifact persistence/fork/rewrite behavior may continue
  to recognize that object convention.
- Output admissibility does not special-case `ArtifactRef`; it is accepted only
  because it is a plain structural JSON object.
- `secret("NAME")` remains an env-only authoring token for agent/task
  environment bindings. It is not a schema type, not workflow output data, and
  not a general signal/input payload shape. No dedicated output checker rule is
  needed beyond the normal workflow-admissible value rules.

`ArtifactRef` moves out of the schema module and lives with runtime/task
context types. The `@acpus/core` root entrypoint may still export `ArtifactRef`
for task authors, but `@acpus/core/schema` must stop exporting it. `SecretRef`
as a workflow data/schema type is removed with `z.secretRef()`; `SecretToken`
remains only for env bindings.

Schema `z.unknown()` remains available for schema-backed input, agent, and signal
boundaries where the contract is "parse any JSON value." This is different from
TypeScript `unknown` in inferred task/composite outputs: Acpus does not add a
runtime shape guarantee for TS `unknown`. Authors should use explicit opaque JSON
types such as `JsonValue` or `JsonObject` when the open shape is intentional and
should remain visible to other authors.

### Composite Output

Composite output comes from callback return types.

For TypeScript-owned composites, returned fields are no longer checked against a
separate declared schema. The callback return type is the output contract. Extra
returned fields become part of the inferred output shape unless rejected by
branch convergence or workflow-admissibility checks.

Branching composites that merge one path into a single output require branch
outputs to converge to the same object shape:

- `if` branches use the same key set;
- `if` always declares `else`;
- `switch` cases and default use the same key set;
- `switch` always declares `default`;
- corresponding fields are mutually assignable to a shared output type;
- missing branch fields do not silently become optional fields.

Control-only branching composites remain valid by returning `{}` from every
branch, including `else` or `default`. This avoids hidden empty fallback scopes
and keeps branch convergence unconditional.

Field types preserve TypeScript's native common-type experience. Literal
differences such as `"ready"` vs `"blocked"` may converge to a literal union (or
the compiler's normal common type), but object shape unions are not exposed to
downstream authoring. The output object shape must be stable even when individual
field values are unions.

`parallel` with the default/all strategy keeps the current branch-keyed output
shape:

```ts
const checks = step("checks").parallel({
  branches: {
    lint: { do: () => ({ ok: true, warnings: 0 }) },
    test: { do: () => ({ ok: true, failed: 0 }) },
  },
});

checks.output.lint.warnings;
checks.output.test.failed;
```

Different branch keys may have different stable output shapes because callers
access them through their branch key.

`parallel` with the race strategy keeps a winner envelope. Branch result shapes
converge to a shared shape, and the output shape is:

```ts
{
  winner: "branchA" | "branchB";
  result: SharedBranchOutput;
}
```

Union result shapes are avoided so downstream authoring stays predictable.
Race runtime behavior otherwise stays unchanged: at least one branch is
required, the first successful branch becomes the winner, and the race fails if
all branches fail. Loser cancellation and failure handling remain runtime
concerns outside the output contract.

### Fanout Output

Fanout item output comes from the `do` callback return type.

The planned authoring shape is:

```ts
const lanes = step("lanes").fanout({
  over: input.lanes,
  key: ({ item }) => template`lane-${item.id}`,
  do: ({ item }) => ({
    lane: item.id,
    ok: true,
  }),
});

lanes.output[0].lane;
```

Fanout output is always `Array<ItemOutput>`.

`strategy: "all"` returns one output per input item, ordered by input item order,
when every item succeeds.
`strategy: "quorum"` returns the accepted item outputs as a shorter array when
the quorum condition completes before every item succeeds. There is no quorum
envelope such as `{ accepted, completed }`.
The existing runtime group behavior remains: quorum completion may cancel
remaining items, impossible quorum still fails, and accepted member tracking may
remain internal. The public node output is only the accepted item outputs in
completion/acceptance order, with length equal to the quorum count.

Consumers that need to distinguish quorum success from all-item success can
compare the input length with the output length in workflow logic. Consumers that
need item identity should include that identity in the item output.

### Seeded Loop

Loop keeps the `loop` name, but its contract changes to a seeded loop.

The planned authoring shape is:

```ts
const repair = step("repair").loop({
  initial: seed.output,
  maxIterations: 3,
  stopWhen: ({ result }) => result.done,
  do: ({ previous, iter }) => ({
    done: false,
    summary: template`repair round ${iter} after ${previous.summary}`,
  }),
});
```

The loop semantics are:

1. `initial` is the first result.
2. `stopWhen` checks the current result before each `do` execution.
3. If the initial result already satisfies `stopWhen`, the loop completes
   without executing `do`.
4. `previous` is always the current result, never `undefined`.
5. `do` returns the next result.
6. `maxIterations` limits only `do` executions and does not count `initial`.
7. If no iteration runs, `loop.output` is `initial`.
8. `maxIterations` may be `0`, in which case only `initial` is checked and
   returned only if `stopWhen(initial)` is true or `onExhausted:
   "returnLast"` is declared.
9. If the loop reaches `maxIterations` and `stopWhen` is still false,
   `onExhausted: "returnLast"` returns the current result; the default
   exhaustion policy is `"fail"`.

`iter` is the next `do` execution index, starting at `0`. The initial
`stopWhen({ result, iter })` check receives `iter = 0`; the first `do` receives
`iter = 0` and `previous = initial`. The final allowed `do` execution is
`iter = maxIterations - 1`.

`stopWhen` remains required. Fixed-count loops can use `stopWhen: () => false`
with `onExhausted: "returnLast"` instead of introducing a second loop mode.

`initial` must be a workflow-admissible object and must converge with the object
returned by `do`. Primitive loop accumulators must be wrapped in a named field,
for example `{ value: "start" }`.
`loop.output` is the converged object accessor for successful completion. The
possibility of exhaustion failure is runtime control flow and is not encoded as
an optional or Result-like output type.

This keeps the API name broad enough while replacing do-while behavior with a
more predictable seeded while/reduce shape.

## Non-Goals For The First Pass

- No helper for parsing external JSON inside tasks is planned initially. Authors
  can use ordinary TypeScript narrowing, and a helper can be reconsidered after
  real usage shows repeated friction.
- No type-only schema replacement such as `outputType: type<T>()` is planned for
  loop. The accepted direction is a real runtime `initial` value instead of a
  type-only DSL field.
- No compatibility shims are planned unless explicitly requested. The codebase
  is greenfield around the TypeScript-first core.

## Static Feedback Direction

Removing author-written schemas from TypeScript-owned outputs does not move
errors to runtime. The replacement bar is stricter:

- TypeScript must reject invalid output access and incompatible callback
  returns.
- The workflow compiler/check layer must reject output types that are known to
  be non-workflow data, without trying to block deliberate `any` or `unknown`
  escape hatches.
- `JsonValue` and `JsonObject` are the explicit escape hatch for opaque JSON
  payloads.
- Runtime receives already-checked workflow outputs and must not be the
  first place common authoring mistakes surface.

The planned IR shape follows that bar: task and composite outputs inferred from
TypeScript do not lower a runtime schema. The compiler/check layer owns proving
that those outputs are admissible workflow values.

This guarantee applies to compiler-produced IR. Raw hand-authored IR validation
continues to protect closed IR object shapes, references, expressions, and
runtime-admissible node definitions, but it no longer proves TypeScript-owned
business output shape without schemas.

Runtime still keeps a generic admissible-value assertion at task and composite
output boundaries before values enter scope, events, or durable store. That
assertion is not schema normalization and does not check business shape; it only
protects the runtime from values that cannot be represented by the workflow
data model.
Type-level authoring allows `number` and does not try to prove values are
finite. The runtime/store guard may still reject actual values that cannot be
stably persisted as JSON, such as `NaN`, `Infinity`, functions, class instances,
cycles, or other non-serializable data. Those failures are system data guards,
not schema-backed output shape validation.

## Compiler/Check Rule Changes

The compiler/check layer must not become a second TypeScript type system. If
the public authoring types plus `tsc` can enforce a rule, Acpus relies on that
and must not add parser-only diagnostics for the same condition.

The implementation does not need a rule whose only purpose is to reject
`outputSchema` on task or composite nodes. Those fields disappear from
the public authoring types, so ordinary TypeScript excess-property checks reject
them at the source.

Existing authoring rules that remain useful:

- TypeScript compiler diagnostics remain the first feedback layer.
- Expr authoring diagnostics such as JavaScript truthiness, logical operators,
  comparison operators, untagged template interpolation, array methods over Expr
  accessors, and Expr-derived node ids remain valid.
- Reusable task reference diagnostics remain valid, but they target the new
  `task.define({ inputSchema, exec })` shape.
- Inline task self-containment diagnostics remain valid.
- Task callsite joinability diagnostics remain valid where source-level task
  metadata must be joined to compiler facts.

Rules or contracts that are removed or rewritten:

- Required task/composite `outputSchema` and `itemOutputSchema` checks are
  removed for TypeScript-owned outputs.
- `G002` and `G003` are rewritten away from "if/switch with `outputSchema` must
  declare else/default" and toward branch convergence where TypeScript cannot
  already enforce it.
- `O001` is removed. Extra returned fields are no longer invalid merely because
  they are outside a separate schema; they become part of the inferred output
  shape unless rejected by branch convergence or workflow-admissibility checks.
- Reusable task output checks are rewritten from "use the task token's
  `outputSchema`" to "infer output from `exec` return type."

Checks implemented in compiler/check because TypeScript alone cannot prove them
reliably:

- Output producer analysis for graph-binding source shapes that must be
  statically located: composite callbacks and loop `initial`; root workflow
  returns may reuse the same admissibility checker. Inline and reusable task
  `exec` returns are checked through their TypeScript return types and do not
  require source-shape visibility.
- If a source shape must be statically located for output/admissibility guarantees
  but cannot be analyzed, the compiler/check result is an error, not a warning.
  There is no fallback mode that defers those mistakes to runtime. This covers
  spec variables, spread-heavy specs, factory-generated composite specs, saved
  step declarations, and similar indirections when they hide the producer being
  checked.
- Output admissibility checks for inferred output types containing functions,
  classes, `Date`, `Map`, `Set`, `symbol`, `bigint`, broad `object`, or other
  non-workflow values.
- Branch convergence diagnostics for `if`, `switch`, and `parallel race` only
  to the extent the public authoring types cannot make `tsc` reject divergent
  shapes directly.
- Seeded loop consistency where `do` return type must converge with `initial`
  and `maxIterations` must be non-negative.
- Schema-less signal admission checks that distinguish raw string payloads from
  schema-backed structured payloads.
- `JsonValue` and `JsonObject` recognition must be based on their real exported
  type identity or structural JSON compatibility, not merely on a user-visible
  type name string.

## Implementation Phases

### Phase 1: Public Authoring Types

- Remove schema extensions that no longer belong in the schema boundary:
  `z.integer()`, `z.artifact()`, `z.secretRef()`, their SchemaIR variants, and
  schema/runtime normalization tests that only preserve those variants.
- Rework task authoring types so inline task output is inferred from `exec` and
  reusable task output is inferred from `task.define(...).exec`.
- Remove reusable task definition `outputSchema`; keep reusable task
  `inputSchema`.
- Rework composite authoring types so `if`, `switch`, `parallel`, `fanout`, and
  `loop` infer output from callbacks and accepted strategy contracts.
- Add seeded loop authoring with real `initial` semantics and non-optional
  `previous`.
- Re-export `JsonValue` and `JsonObject` from the `@acpus/core` root entrypoint.
- Add type tests before runtime or IR changes so the intended authoring surface
  is pinned down first.

### Phase 2: Authoring Checks

- Add a compiler/check module that extracts TypeScript-owned output producer
  types from inline task `exec`, reusable task `exec`, composite callbacks, and
  loop `initial`, while requiring source-shape visibility only for graph
  bindings.
- Add compiler/check diagnostics for inferred output types that contain
  functions, classes, `Date`, `Map`, `Set`, `symbol`, `bigint`, broad `object`,
  or other non-workflow values.
- Allow explicit opaque JSON output types through `JsonValue` and `JsonObject`.
- Add branch convergence diagnostics for `if`, `switch`, and `parallel race`
  when branch result shapes do not converge.
- Keep diagnostics close to the source expression that produced the invalid
  output type so AI authoring can repair workflows before execution.

### Phase 3: IR And Lowering

- Remove `outputSchema` and `itemOutputSchema` from TypeScript-owned task and
  composite IR where output is inferred and checked statically.
- Keep `outputSchema` only on schema-backed agent and signal nodes.
- Lower schema-less agent and signal outputs as raw text producers.
- Lower seeded loop `initial` and pre-check semantics, including the strict
  exhausted behavior described in the loop section.

### Phase 4: Runtime Semantics

- Replace task and composite schema normalization with a generic admissible-value
  assertion before outputs enter scope, events, or durable store.
- Keep schema-backed agent parsing, prompt guidance, response repair, and signal
  payload parsing.
- Make schema-less agent execution and schema-less signal admission produce raw
  string outputs.
- Update fanout quorum aggregation to return `Array<ItemOutput>` instead of a
  quorum envelope.
- Apply seeded loop pre-check semantics in both runtime paths: the durable
  scheduler under `runtime/src/scheduler/*` and the direct executor in
  `runtime/src/execution/scheduler.ts`, while both paths remain supported.

### Phase 5: Specs And Verification

- Update current package specs only when implementation changes land.
- Cover the new authoring API with type tests, focused compiler/check tests,
  runtime scheduler tests, and workflow compiler integration tests.
- Remove tests whose only purpose was to preserve removed `outputSchema`
  authoring behavior.
- Rewrite fixtures that represent current happy-path authoring into the new DSL.
  Delete fixtures/tests whose only purpose is old task/composite schema
  behavior. Do not add compatibility tests that merely assert removed
  `outputSchema` fields are rejected; public authoring types and `tsc` own that.
- Implementation changes that affect package build output must run the relevant
  build so checked-in generated artifacts such as `packages/*/dist` stay current.
  This does not apply to this roadmap-only document update.

## Implementation Scope Decisions

The refactor is a greenfield rewrite of the current TypeScript-first behavior,
not a compatibility migration. Implement only the target model described in this
document.

- Public authoring types are the first enforcement layer. Removed fields such as
  task/composite `outputSchema` and fanout `itemOutputSchema` disappear from the
  typed API; do not add parser-only diagnostics whose sole purpose is to reject
  those old fields.
- Current happy-path fixtures are rewritten into the new authoring DSL. Fixtures
  and tests that exist only to preserve old task/composite output schemas are
  deleted instead of carried forward.
- Source-shape analysis is strict for graph-binding outputs in the first
  implementation. If composite/root/loop graph producers are hidden behind
  factory-generated specs, spreads, saved spec variables, or other indirection
  that prevents static analysis, compiler/check reports an error. Task `exec`
  return expressions remain ordinary TypeScript function bodies and are checked
  through their return types. Do not add fallback runtime validation for graph
  binding shapes.
- Branch convergence is enforced only where public TypeScript types cannot
  already reject the invalid shape. The compiler/check layer fills static gaps;
  it does not duplicate ordinary `tsc` behavior.
- Runtime keeps only a generic workflow-data admissibility guard for
  TypeScript-owned outputs before values enter scope, events, or durable store.
  It does not reintroduce business-shape validation through generated schemas.
- Schema cleanup is part of the same refactor. Remove `z.integer()`,
  `z.artifact()`, `z.secretRef()`, their `SchemaIR` variants, lowering,
  validation, JSON Schema conversion, normalization cases, and tests that exist
  only for those schema extensions.
- Specs are updated in the same implementation change that changes behavior.
  After implementation lands, `specs/` must describe only the new current
  behavior; this roadmap remains historical planning context.

The implementation change must update these current product-truth specs:

- `specs/core-spec.md`: authoring API, IR shape, validator responsibilities,
  `task.define`, loop, fanout, agent and signal output contracts, and removal of
  `z.integer()` / `z.artifact()` / `z.secretRef()` from schema authoring and
  `SchemaIR`.
- `specs/runtime-spec.md`: task/composite admissible-value assertions instead
  of schema normalization, schema-less signal payload strings, schema-less agent
  raw string output, seeded loop pre-check semantics, and fanout quorum array
  output. Runtime artifact persistence and env `secret(...)` handling remain
  runtime concerns, not schema extension contracts.
- `specs/workflow-compiler-spec.md`: output producer analysis, admissible output
  type diagnostics, branch convergence diagnostics, and statically analyzable
  source-shape requirements.
- `specs/tasks-spec.md`: reusable task definitions and package task contracts
  after task output is inferred from `exec`.

## Verification Direction

The implementation must add focused type tests and compiler/check tests that
cover:

- task output inference from inline and reusable `exec`;
- schema-less agent and signal outputs as `Expr<string>`;
- schema-backed agent and signal outputs as structured typed values;
- rejection of missing or incompatible fields in converged `if` and `switch`
  outputs;
- branch-keyed `parallel all` output inference;
- shared-result `parallel race` output inference;
- fanout all/quorum output inference as `Array<ItemOutput>`;
- seeded loop zero-iteration output and typed non-optional `previous`;
- rejection of known non-admissible output values before runtime;
- acceptance of explicit opaque JSON output types such as `JsonValue` and
  `JsonObject`.
