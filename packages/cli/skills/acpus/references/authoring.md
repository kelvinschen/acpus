# Authoring Workflows

## Quick Start

For a new workflow, prefer generating a checkable scaffold first:

```sh
acpus workflow init file workflow.ts
acpus workflow check workflow.ts
```

### Imports

Use TypeScript workflow modules and user-facing facades only:

```ts
import { defineWorkflow, task, secret, z } from "acpus/core";
import { template, md, fmap, lift2, lift3, lift } from "acpus/expression";
import { createWorktree } from "acpus/tasks/git";
```

The generated starter deliberately keeps broad public imports as local authoring context. After the workflow takes shape, unused imports may be removed. Hand-authored examples import only the helpers they use. For the complete surface, inspect the declarations listed under Declaration Lookup.

Do not import `@acpus/*` from user workflows; those are implementation packages behind the `acpus/*` facades.

Inside `build`, every run-dependent value from `input`, `meta`, and node `output` is an `Expr<T>` token. Field projection such as `review.output.ready` and array index projection such as `items[0]` are supported. Do not compute over expression values with authoring-time JavaScript; use workflow control nodes, `template`/`md`, and `fmap`/`lift2`/`lift3`/`lift` for computed operations.

### Minimal Workflow Skeleton

```ts
import { defineWorkflow, z } from "acpus/core";
import { template } from "acpus/expression";

export default defineWorkflow({
  name: "my-workflow",
  description: "Analyze a topic in a repository.",
  inputSchema: z.object({ repoPath: z.string(), topic: z.string() }),
  agents: { worker: { use: "codex" } },
}).build(({ input, agents, meta, step }) => {
  const result = step("work").agent({
    outputSchema: z.object({ ok: z.boolean(), summary: z.string() }),
    run: { agent: agents.worker, prompt: template`Analyze ${input.topic} in ${input.repoPath}.` },
  });
  return { runId: meta.runId, ok: result.output.ok, summary: result.output.summary };
});
```

## Mental Model

### Why Expressions Exist

Acpus workflows are TypeScript-authored durable graph definitions, not ordinary runtime TypeScript programs. `build` runs before any workflow run executes. Values from `input`, `meta`, and node `output` are therefore graph tokens: `Expr<T>`.

An `Expr<T>` means "a value of type `T` that will exist at run time." You can project through it with field and index syntax, such as `review.output.ready` and `items[0]`, because those are still graph projections. You cannot use JavaScript control flow or operators over it at authoring time, because JavaScript would need the value immediately.

Use graph nodes for control flow, `template`/`md` for rendered strings, and `fmap`/`lift*` for small computed values. Inside an `fmap`/`lift*` callback, write normal JavaScript over plain runtime values.

### Expression Functions

Think of `Expr` as a functor. `fmap` maps one expression value. `lift2`, `lift3`, and `lift` lift a normal JavaScript function over multiple expression dependencies.

```ts
// Informal signatures:
fmap  :: Expr<A> -> (A -> WorkflowData B) -> Expr<B>
lift2 :: Expr<A> -> Expr<B> -> ((A, B) -> WorkflowData C) -> Expr<C>
lift3 :: Expr<A> -> Expr<B> -> Expr<C> -> ((A, B, C) -> WorkflowData D) -> Expr<D>
lift  :: { name: Expr<A>, ... } -> ({ name: A, ... } -> WorkflowData B) -> Expr<B>
```

Use `fmap` for one dependency:

```ts
const title = fmap(input.issue, issue => issue.title.trim());
const firstId = fmap(input.items[0], item => item?.id ?? "none");
```

Use `lift2`/`lift3` for concise positional dependencies:

```ts
const shouldRelease = lift2(
  input.ready,
  input.kind,
  (ready, kind) => ready && kind === "release",
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
- A block callback may contain at most eight executable statements across itself and nested arrows. Move larger multi-step logic into a Task and pass dependencies through `run.input`.
- They must not capture workflow/module-scope runtime values; pass every dependency explicitly through `fmap`/`lift*`.
- They must return `WorkflowData`: JSON primitives.

### Templates

Use `template` for compact strings and `md` for multiline prompts/messages. `md` trims surrounding blank lines and common indentation while preserving expression interpolation.

Template interpolation renders strings directly, scalar non-strings with `String(value)`, and arrays/objects as compact JSON. For Markdown list rendering, compute explicit lines first:

```ts
const lines = fmap(items, items => items.map(item => `- ${item.id}`).join("\n"));
const prompt = md`
  Review these items:
  ${lines}
`;
```

### Boundary Schemas

Boundary schemas use the native Zod 4 `z` re-exported from `acpus/core`. Filesystem paths are ordinary `z.string()` fields; use field names and descriptions to explain their meaning. Infer schema values with `z.infer<typeof Schema>`.

Keep workflow input, Agent output, Signal output, and reusable task input JSON-compatible and durable. Avoid schema transforms, functions, promises, maps, sets, dates, bigint, symbol, `undefined`, `void`, `never`, non-finite numbers, sparse arrays, cycles, and class instances in graph-boundary values or runtime outputs.

## Workflow Building Blocks

### Leaf Nodes

Leaf nodes do work or wait for external input. Keep options sparse; add schemas, timeouts, cwd, env, retry, and artifacts only when the workflow needs them.

Agent nodes run an ACP agent. Without `outputSchema`, `output` is text:

```ts
const review = step("review").agent({
  run: { agent: agents.reviewer, prompt: template`Review ${input.topic}` },
});
```

Top-level agents use either `{ use: "codex" }` for named acpx agents or `{ command: "my-acp-server --stdio" }` for raw ACP commands. Common built-ins include `codex`, `claude`, `gemini`, `cursor`, `copilot`, `qwen`, `trae`, and `opencode`; see `references/acpx-agents.md` for the full built-in list and local discovery rules.

Task nodes run local TypeScript glue. Pass workflow values through `run.input`; inside `exec`, use only task context:

```ts
const status = step("status").task({
  run: {
    input: { repoPath: input.repoPath },
    exec: async ({ input }) => ({ repoPath: input.repoPath, ok: true }),
  },
});
```

Reusable tasks own their input schema and executable body:

```ts
// tasks/normalize-name.ts
import { task, z } from "acpus/core";

export const normalizeName = task.define({
  inputSchema: z.object({ name: z.string() }),
  exec: async ({ input }) => ({ slug: input.name.toLowerCase() }),
});
```

```ts
const normalized = step("normalize").task({
  run: { task: normalizeName, input: { name: input.name } },
});
```

Signal nodes wait for operator input:

```ts
const approval = step("approval").signal({
  outputSchema: z.object({ approved: z.boolean() }),
  run: { prompt: template`Approve ${review.output}?` },
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
    { when: fmap(input.kind, kind => kind === "bug"), then() { return { owner: "oncall" }; } },
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
  key({ item }) { return template`item-${item.id}`; },
  do({ item }) {
    const normalized = step("normalize_item").task({
      run: {
        input: { id: item.id },
        exec: async ({ input }) => ({ id: input.id }),
      },
    });
    return { id: normalized.output.id };
  },
});
```

`loop` is a do-while primitive: it always runs one body round, carries `state`, and each body returns `{ state, stop }`. `loop.output` is the final `state`.

```ts
const refined = step("refine").loop({
  state: { ready: false, summary: "" },
  do({ state, round }) {
    return {
      state: {
        ready: state.ready,
        summary: state.summary,
      },
      stop: fmap(round, round => round >= 3),
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

### Expression And Schema Hygiene

- Start from the closest example by its file-header `Pattern` and `Nodes` labels; inspect declarations only when the examples do not answer the API question.
- Use graph-level composites instead of JavaScript control flow over expression values.
- Use field/index projection directly (`review.output.ready`, `items[0]`).
- Use `fmap`/`lift` for small synchronous JSON transforms; prefer expression bodies, and use a short block when named intermediate values improve clarity.
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
