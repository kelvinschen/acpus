# Authoring Workflows

## Quick Start

Choose the closest file under `examples/workflows/` by its `Pattern` and
`Nodes` header, then write the target workflow module directly. Validate it
before running:

```sh
acpus workflow check <workflow.ts-or-catalog>
```

### Imports

Use TypeScript workflow modules and user-facing facades only:

```ts
import { defineWorkflow, task, z } from "acpus/core";
import { template, md, eq, lte, gte, and, or, lift } from "acpus/expression";
import { createWorktree } from "acpus/tasks/git";
```

Import only the helpers the workflow uses. Official examples name the remaining
public runtime helpers in import comments so each example exposes the complete
authoring surface. For exact signatures, inspect the declarations listed under
Declaration Lookup.

Do not import `@acpus/*` from user workflows; those are implementation packages behind the `acpus/*` facades.

Inside `build`, every run-dependent value from `input`, `meta`, and node `output` is an `Expr<T>` token. Field projection such as `review.output.ready` and array index projection such as `items[0]` are supported. Do not compute over expression values with authoring-time JavaScript; use workflow control nodes, predicate helpers, `template`/`md`, and `lift` for computed operations.

Use this boundary rule consistently: a plain `T` field is declaration-time structure, while `Resolvable<T>` is evaluated from workflow scope at run time. Authors normally do not need to import `Resolvable`; the public node signatures reveal which fields support both literals and expressions. For example:

```ts
timeout: "5m",
timeout: input.timeout,
maxConcurrency: input.parallelism,
count: input.quorum,
onTimeout: {
  message: template`Request ${input.requestId} timed out`,
},
```

Node ids, strategies, schemas, task targets, agent selectors/model/modes, and permission modes stay static. Workflow-level Agent definition `cwd`/`env` fields are also static; Agent/Task step `cwd`/`env` fields are runtime-resolvable.

### Minimal Workflow Skeleton

```ts
import { defineWorkflow, z } from "acpus/core";
import { template } from "acpus/expression";

export default defineWorkflow({
  name: "my-workflow",
  description: "Analyze a topic in a repository.",
  inputSchema: z.object({ repoPath: z.string(), topic: z.string() }),
  agents: { worker: { use: "codex", model: "gpt-5.5" } },
}).build(({ input, agents, meta, step }) => {
  const result = step("work").agent({
    outputSchema: z.object({ ok: z.boolean(), summary: z.string() }),
    agent: agents.worker,
    prompt: template`Analyze ${input.topic} in ${input.repoPath}.`,
  });
  return { runId: meta.runId, ok: result.output.ok, summary: result.output.summary };
});
```

## Mental Model

### Why Expressions Exist

Acpus workflows are TypeScript-authored durable graph definitions, not ordinary runtime TypeScript programs. `build` runs before any workflow run executes. Values from `input`, `meta`, and node `output` are therefore graph tokens: `Expr<T>`.

An `Expr<T>` means "a value of type `T` that will exist at run time." You can project through it with field and index syntax, such as `review.output.ready` and `items[0]`, because those are still graph projections. You cannot use JavaScript control flow or operators over it at authoring time, because JavaScript would need the value immediately.

Use graph nodes for control flow, predicate helpers for standard boolean conditions, `template`/`md` for rendered strings, and `lift` for custom computed values. Inside a `lift` callback, write normal JavaScript over plain runtime values.

### Expression Functions

Prefer the standard predicate helpers when they express the whole condition:

```ts
const isRelease = eq(input.kind, "release");
const withinLimit = lte(selectedCount, input.maxItems);
const shouldStop = or(input.ready, gte(round, 3));
const canRelease = and(isRelease, withinLimit);
```

`eq`/`ne` use JavaScript strict equality over scalar values. `lt`/`lte`/`gt`/`gte` compare numbers. `not` negates one boolean, while `and`/`or` combine two or more booleans. Boolean operands are evaluated eagerly; `and` and `or` do not promise JavaScript short-circuit behavior.

Think of `Expr` as a functor. The overloaded `lift` helper lifts a normal JavaScript function over one to three positional dependencies. A named object is one structured dependency, so use it when names matter or more values must be combined.

```ts
// Informal overloads:
lift :: Expr<A> -> (A -> B) -> Expr<B>
lift :: Expr<A> -> Expr<B> -> ((A, B) -> C) -> Expr<C>
lift :: Expr<A> -> Expr<B> -> Expr<C> -> ((A, B, C) -> D) -> Expr<D>
```

Use unary `lift` for one dependency:

```ts
const title = lift(input.issue, issue => issue.title.trim());
const firstId = lift(input.items[0], item => item?.id ?? "none");
```

Use the binary or ternary overload for concise positional dependencies:

```ts
const statusLine = lift(
  input.kind,
  input.ready,
  (kind, ready) => `${kind}: ${ready ? "ready" : "blocked"}`,
);
```

Use named-object `lift` when names matter or there are many dependencies:

```ts
const overLimit = lift(
  { priority: input.priority, selectedCount, maxItems: input.maxItems },
  ({ priority, selectedCount, maxItems }) => priority === "high" || selectedCount > maxItems,
);
```

Callbacks are intentionally a simplified task-like surface:

- They must be inline synchronous arrows. Prefer an expression body for simple transforms; a block body may use local declarations and control flow.
- They must not capture workflow/module-scope runtime values; pass every dependency explicitly through `lift`.
- They must return `WorkflowData`: JSON-compatible primitives, arrays, or plain objects.

### Templates

Use `template` for compact strings and `md` for multiline prompts/messages. `md` trims surrounding blank lines and common indentation while preserving expression interpolation.

Template interpolation renders strings directly, scalar non-strings with `String(value)`, and arrays/objects as compact JSON. For Markdown list rendering, compute explicit lines first:

```ts
const lines = lift(items, items => items.map(item => `- ${item.id}`).join("\n"));
const prompt = md`
  Review these items:
  ${lines}
`;
```

Agent prompts give a directly interpolated `ArtifactRef` to the Agent as its absolute local path. Explicit `${ref.uri}` interpolation keeps the logical URI, while a ref nested inside an interpolated object or array remains ordinary compact JSON.

### Boundary Schemas

Boundary schemas use the native Zod 4 `z` re-exported from `acpus/core`. Filesystem paths are ordinary `z.string()` fields; use field names and descriptions to explain their meaning. Infer schema values with `z.infer<typeof Schema>`.

Keep workflow input, Agent output, Signal output, and values passed to reusable tasks JSON-compatible and durable. Avoid schema transforms, functions, promises, maps, sets, dates, bigint, symbol, `undefined`, `void`, `never`, non-finite numbers, sparse arrays, cycles, and class instances in graph-boundary values or runtime outputs.

## Workflow Building Blocks

### Leaf Nodes

Leaf nodes do work or wait for external input. Keep options sparse; add schemas, timeouts, cwd, env, Agent response repair, and artifacts only when the workflow needs them.

Agent nodes run an ACP agent. Without `outputSchema`, `output` is text:

```ts
const review = step("review").agent({
  agent: agents.reviewer,
  prompt: template`Review ${input.topic}`,
});
```

Top-level agents use `use` for named acpx agents or `command` for raw ACP
commands. Both accept a static optional `model`, validated by acpx; omit it for
the agent default, and define separate Agent keys for different models. See
`references/acpx-agents.md` for built-in agents and local discovery rules.

Task nodes run local TypeScript glue. Bind workflow values through the step's top-level `input`; inside `exec`, use only task context:

```ts
const status = step("status").task({
  input: { repoPath: input.repoPath },
  exec: async ({ input }) => ({ repoPath: input.repoPath, ok: true }),
});
```

Reusable tasks declare a config-time input type witness and an executable body:

```ts
// tasks/normalize-name.ts
import { task, z } from "acpus/core";

export const normalizeName = task.define({
  inputSchema: z.object({ name: z.string() }),
  exec: async ({ input }) => ({ slug: input.name.toLowerCase() }),
});
```

The `inputSchema` types `exec` and the call-site `input`; the runtime does not
retain or parse it.

```ts
const normalized = step("normalize").task({
  task: normalizeName,
  input: { name: input.name },
});
```

Signal nodes wait for operator input:

```ts
const approval = step("approval").signal({
  outputSchema: z.object({ approved: z.boolean() }),
  prompt: template`Approve ${review.output}?`,
});
```

Assert nodes fail the run when an expression condition is false:

```ts
step("require_approval").assert({
  condition: approval.output.approved,
  message: "Approval denied.",
});
```

Inline task source is embedded in frozen IR. Reusable tasks can import package dependencies; inline tasks should stay self-contained.

### Composite And Control Nodes

Composite node callbacks accept only node-specific values such as fanout `item`/`itemIndex` and loop `state`/`index`/`round`. Declare nested nodes with the unified `step` provided by the enclosing `build` callback. Return a plain object to declare output; do not add `outputSchema` to composites.

`if` branches on one expression. Both branches should return compatible object shapes:

```ts
const gate = step("gate").if({
  condition: input.ready,
  then() { return { status: "ready" }; },
  else() { return { status: "blocked" }; },
});
```

`switch` chooses the first matching case and requires `default`:

```ts
const route = step("route").switch({
  cases: [
    { when: eq(input.kind, "bug"), then() { return { owner: "oncall" }; } },
  ],
  default() { return { owner: "backlog" }; },
});
```

`parallel` runs static named branches:

```ts
const checks = step("checks").parallel({
  branches: {
    lint() { return { ok: true }; },
    test() { return { ok: true }; },
  },
});
```

`fanout` expands a runtime array. Its output is an array:

```ts
const items = step("items").fanout({
  over: input.items,
  do({ item }) {
    const normalized = step("normalize_item").task({
      input: { id: item.id },
      exec: async ({ input }) => ({ id: input.id }),
    });
    return { id: normalized.output.id };
  },
});
```


`loop` is a do-while primitive: it always runs one body round, carries `state`, and each body returns `{ state, stop }`. `loop.output` is the final `state`. Do not mirror runtime `index` or `round` into `state` unless downstream nodes need the final iteration number through `loop.output`.

```ts
const refined = step("refine").loop({
  state: { ready: false, summary: "" },
  do({ state, index, round }) {
    return {
      state: {
        ready: state.ready,
        summary: state.summary,
      },
      stop: gte(round, 3),
    };
  },
});
```

For `parallel({ strategy: "race" })`, output is `{ winner, result }`. For `fanout({ strategy: "quorum", count })`, output is the accepted item array. Loop `index` is 0-based and `round` is 1-based. Empty arrays in `state` need an explicit element type:

```ts
type Round = { summary: string };
const state = {
  rounds: [] as Round[],
};
```

## Best Practices

### Structured Boundaries

- Use the smallest structured boundary that the workflow actually needs.
- Omit `outputSchema` when natural-language text is enough.
- Add schemas only for values the workflow must branch on, fan out over, assert, or expose as machine-readable final output.
- Let agents exchange Markdown when later agents can read the result directly.

### Agent Sessions And Permissions

- When the user has no agent preference, ask which agent to use.
- Prefer `{ use: "<agent>" }` for built-in or locally configured acpx agents. Read `references/acpx-agents.md` before using `{ command: "..." }`.
- Common built-ins visible at a glance: `codex`, `claude`, `gemini`, `cursor`, `copilot`, `qwen`, `trae`, `opencode`.
- Check local availability with `command -v <binary>` before recommending a local agent.
- Use `acpus runs retry` for control-plane retry after a failed run.
- Omit `sessionKey` by default; set it only when a multi-turn loop explicitly needs the agent to reuse one session.
- Omit `permissionMode` for normal authoring; use `permissionMode: "approve-reads"` only for agents that are explicitly not allowed to write, such as audit-only inspection.

### Task Boundaries

- Put reusable tasks in separate task modules when they need shared code or third-party packages installed with the workflow package.
- Keep inline tasks self-contained: no third-party imports, module-scope environment reads, or module-scope captures.
- Each Task attempt runs in a fresh Node process. Task module globals and module caches do not carry across tasks or retries.
- Task artifacts use `artifact.write(name, string | Uint8Array, options?)`. Read files with Node `readFile` and serialize JSON with `JSON.stringify` before writing; there are no format-specific or file-copy helpers.
- Use synchronous `artifact.path(ref)` for an absolute local path. The ref must arrive through Task input or come from that Task's own successful `artifact.write(...)`; arbitrary and cross-run refs are rejected.
- The Task step's `cwd` is the Task process cwd: `process.cwd()`, relative Node filesystem calls, and default `$` commands all use it. Relative cwd values resolve from the workflow workspace, and the directory must exist before the attempt starts.
- The Task step's `env` overlays the host environment. `process.env`, task context `env`, module top-level code, and default `$` commands see the same effective values.
- A Task may call `process.chdir(...)` or update `process.env`; later relative Node operations and default `$` commands follow the changed process state.

### Expression And Schema Hygiene

- Start from the closest example by its file-header `Pattern` and `Nodes` labels; inspect declarations only when the examples do not answer the API question.
- Use graph-level composites instead of JavaScript control flow over expression values.
- Use field/index projection directly (`review.output.ready`, `items[0]`).
- Prefer `eq`/`ne`, numeric comparisons, and `not`/`and`/`or` for standard predicates.
- Use `lift` for small synchronous JSON transforms; prefer expression bodies, and use a short block when named intermediate values improve clarity.
- Use `template` for compact strings and `md` for multiline prompts/messages.
- Use signal nodes only when the workflow needs external control.
- Keep graph-boundary schema values JSON-compatible and durable.

## Validation And API Lookup

### Workflow Check

`acpus workflow check <workflow.ts-or-catalog>` prepares the workflow in memory and catches TypeScript diagnostics plus Acpus authoring diagnostics such as Expr truthiness, native operators over Expr values, dynamic node ids, task callsites that cannot be joined to task metadata, inline task captures, and non-admissible outputs.

Run `acpus workflow check <workflow.ts-or-catalog>` before admitting a run.

### Declaration Lookup
Only when exact API usage is unclear, inspect installed declarations:

1. Start from the global install: `$(npm root -g)/acpus/dist/authoring/`.
2. Read facade declarations there: `core.d.ts`, `expression.d.ts`, and `tasks/git.d.ts`.
3. Follow re-exports into sibling global packages: `$(npm root -g)/@acpus/core/dist/*.d.ts`, `@acpus/expression/dist/*.d.ts`, and `@acpus/tasks/dist/*.d.ts`.
4. Retrieve only the relevant symbol plus nearby doc comment/signature; do not dump full declaration files.
