# Workflow authoring knowledge

## Mental model

`defineWorkflow(...).build(...)` declares a static durable graph; it does not execute the graph. Runtime workflow `input`, `meta`, composite locals, and node outputs are opaque `Expr<T>` values while declaring the graph; a Task `exec` receives that Task's configured `input` as resolved data. Composite callbacks declare subgraphs that Runtime later instantiates for branches, fanout items, and loop rounds.

Give every workflow a concise semantic name. Use the enclosing `step` dispatcher for every node and stable authored ids for logical duties. Runtime derives unique occurrence Targets. Read a node result through exactly one `.output`; a `NodeRef` is a control handle and must never be returned as output.

Return only durable primitives, `null`, arrays, plain objects, `ArtifactRef` values, or expressions resolving to those shapes. Never return a Promise, class instance, NodeRef, raw top-level `undefined`, or explicit `any`. Optional object fields may be omitted; array elements may not be `undefined`.

## Schemas: use them at deterministic seams

Most workflows DSH authors are one-shot. Embed facts already known before admission as correctly escaped JSON-compatible source literals and omit `inputSchema`; do not parameterize a one-shot workflow merely to mirror the current request. Use `inputSchema` only when values must vary independently of the source across admissions, such as an intentionally reusable workflow. Values that arrive after admission belong in a Signal.

An Agent `outputSchema` is necessary only when deterministic workflow code must read typed fields—for example a Task consumes them programmatically, an `if`/`switch`/`assert` uses them, or a loop transition reads approval and feedback fields.

Do not add `outputSchema` merely because an Agent returns information. Agent-to-Agent handoffs should normally remain prose: interpolate the upstream `.output` into the downstream prompt. Unnecessary schemas increase authoring cost, constrain useful answers, and create validation failures without adding control value. Tasks and composites do not take `outputSchema`.

```ts
// Prose handoff: no schema is needed.
const topic = "<current subject>";
const research = step("research").agent({
  agent: agents.researcher,
  prompt: md`Investigate ${topic}; cite primary sources and dates.`,
});
const synthesis = step("synthesis").agent({
  agent: agents.writer,
  prompt: md`Synthesize this research for the user: ${research.output}`,
});

// Deterministic control reads fields, so a schema is justified.
const review = step("review").agent({
  agent: agents.reviewer,
  outputSchema: z.object({ accepted: z.boolean(), feedback: z.string() }),
  prompt: md`Return a control decision for this draft: ${draft.output}`,
});
```

Use the supported Zod 4 subset. Stabilize evolving state with `z.infer` or an explicit type, especially for empty arrays, nullable fields, literals, and unions:

```ts
const StateSchema = z.object({
  accepted: z.boolean(),
  feedback: z.string(),
  result: z.string(),
});
type State = z.infer<typeof StateSchema>;
const initial: State = { accepted: false, feedback: "Produce a first result.", result: "" };
```

`if`, `switch`, and `parallel({ strategy: "race" })` may produce heterogeneous unions. Narrow the complete union inside `lift` before accessing branch-only fields.

## Expressions

Import only used symbols:

```ts
import { defineWorkflow, z } from "acpus/core";
import { and, eq, gte, lift, md, or, template } from "acpus/expression";
```

Direct property/index projection is valid: `review.output.accepted` and `items[0]`. JavaScript operators, truthiness, template strings, `.length`, array methods, and conditional control flow do not operate on Expr values. Use expression helpers:

```ts
const label = lift(status.output.kind, status.output.ready,
  (kind, ready) => `${kind}: ${ready ? "ready" : "blocked"}`);
const summary = lift(
  { count: status.output.count, limit: status.output.limit },
  ({ count, limit }) => ({ count, overLimit: count > limit }),
);
const releasable = and(eq(status.output.kind, "release"), gte(status.output.score, 80));
```

Every `lift` callback must be an inline synchronous arrow. Pass every runtime dependency explicitly; never capture another Expr or an expression helper inside it. Return plain JSON-compatible data from `lift`, then render outside. Use `template` for compact strings and `md` for multiline prompts.

## Agent nodes and Presets

Declare one logical slot for each distinct duty. Leave the slot unbound in workflow source, select a Preset by `guidance`, and pass the exact slot-to-Preset mapping in `acpus_run.agents`. Use distinct logical slots for distinct duties even when they select the same Preset.

```ts
agents: {
  researcher: {},
  verifier: {},
}
```

Do not put a Preset id in `use`, copy its hidden Agent definition, or infer config, command, environment, credentials, or provider fields. A concrete workflow Agent remains valid only when the user explicitly asks for that direct binding. Catalog presence does not prove executable, authentication, network, or provider readiness; actual startup is authoritative.

Set `cwd: meta.workspaceDir` for workspace work. Leave `timeout` unset unless the user or workflow defines a real hard deadline. Use `sessionKey` only for deliberate continuity across occurrences, commonly a resident worker across loop rounds. Give it a stable run-local key. Fresh independent reviewers should omit it.

## Task nodes

Use inline Tasks for deterministic computation, validation, batching, repository commands, and artifact creation—not for judgment. Pass all runtime values through `input`; an inline `exec` must not capture workflow expressions or module-scope runtime dependencies.

```ts
const batches = step("batch_findings").task({
  input: { findings: findings.output, size: 20 },
  exec: async ({ input }) => Array.from(
    { length: Math.ceil(input.findings.length / input.size) },
    (_, index) => input.findings.slice(index * input.size, (index + 1) * input.size),
  ),
});
```

Use dynamic imports for Node built-ins inside `exec`. Use `$` argument interpolation instead of assembling shell strings. `timeout` bounds the whole Task attempt; `execution.defaultCommandTimeout` bounds individual `$` commands. Check `abortSignal` in non-command asynchronous work.

Use a reusable imported Task only when an existing workspace workflow needs third-party imports or a Task implementation has a second authored caller. Model-authored workflow strings should normally be self-contained.

## Artifacts

Artifacts are run-local durable deliverables or evidence. Create them in a Task and return their refs:

```ts
const report = step("write_report").task({
  input: { content: synthesis.output },
  exec: async ({ input, artifact }) => ({
    report: await artifact.write("report.md", input.content, {
      mediaType: "text/markdown",
    }),
  }),
});
```

`artifact.write` accepts text or bytes and returns an `ArtifactRef`. Direct interpolation into an Agent prompt renders its local path; `${ref.uri}` preserves the URI. Do not guess paths.

## Composite invariants

- `parallel`: fixed named independent branches; default output is branch-keyed. Race is only for the first acceptable success.
- `fanout`: repeat a subgraph over a runtime array; default output preserves input order.
- `if`/`switch`: runtime routing from expression predicates.
- `loop`: do-while; transition replaces the complete state and must have semantic progress plus a hard bound.
- `signal`: external input after admission; use only when the workflow must wait for it.
- `assert`: deterministic invariant enforcement, not subjective review.

Composite callbacks return one durable value; return `{}` for control-only scopes. Declare their child nodes through the enclosing `step`.

## Preparation repair

`acpus_run` authoring failures are recoverable results. Repair the complete workflow according to phase:

| Phase | Repair |
| --- | --- |
| `source` | Fix the generated module or unsupported source shape. |
| `check` | Fix TypeScript, Expr misuse, Task capture, schema, or output-admissibility diagnostics. |
| `compile` | Fix imports, default export, module top-level code, or build callback exceptions. |
| `validate` | Fix malformed workflow/IR fields or package API mismatch. |
| `input` | Match supplied input to an intentional `inputSchema`; otherwise remove needless parameterization and embed one-shot facts. |

Do not weaken types with `any`, remove meaningful validation, or collapse a deliberate topology to hide diagnostics. Apply the smallest complete repair and resubmit changed source.
