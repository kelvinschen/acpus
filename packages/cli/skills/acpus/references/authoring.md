# Authoring Workflows

## Quick Start

### Imports

Use TypeScript workflow modules and user-facing facades only:

```ts
import { defineWorkflow, task, secret, z } from "acpus/core";
import { template, md, and, lte, add, join, map, transform } from "acpus/expression";
import { createWorktree } from "acpus/tasks/git";
```

Import only the helpers the workflow uses. For the complete surface, inspect the declarations listed under Declaration Lookup.

Do not import `@acpus/*` from user workflows; those are implementation packages behind the `acpus/*` facades.

### Minimal Workflow Skeleton

```ts
import { defineWorkflow, z } from "acpus/core";
import { template } from "acpus/expression";

export default defineWorkflow({
  name: "my-workflow",
  description: "Analyze a topic in a repository.",
  inputSchema: z.object({ repoPath: z.path(), topic: z.string() }),
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

Acpus workflows are a TypeScript-authored DSL, not ordinary runtime TypeScript. `build` declares a durable graph before a run executes, so workflow input, metadata, and prior node outputs are graph values wrapped as `Expr<T>` tokens. Treat every run-dependent value (typically from `input` and `output`) as an expression token and use graph constructs plus `acpus/expression` helpers to combine, compare, select, and render those values. Use plain JavaScript only for authoring-time constants and task `exec` bodies.

### Expressions And Templates

Expression helpers:

| Do not write | Write |
| --- | --- |
| `input.ready && output.ok` | `and(input.ready, output.ok)` |
| `!input.ready` | `not(input.ready)` |
| `input.kind === "release"` | `eq(input.kind, "release")` |
| `risk <= 3` | `lte(risk, 3)` |
| `iter + 1` | `add(iter, 1)` |
| `input.maybe ?? "fallback"` | `coalesce(input.maybe, "fallback")` |
| `` `topic ${input.topic}` `` | `template\`topic ${input.topic}\`` |
| `input.items.length` | `len(input.items)` |
| `input.items.map(item => item.id)` | `map(input.items, item => item.id)` |
| `items[0]` | `head(items)` or `get(items, 0)` |

For collections: `filter(input.items, item => where(item, { tags: { contains: "ready" } }))`, `map(ready, item => item.id)`, `len(ready)`, `coalesce(head(readyIds), "(none)")`.

Use `transform(value, fn)` for small runtime JSON transforms that are awkward as named expression helpers but too small for a Task:

```ts
const title = transform(input.issue, issue => issue.title.trim());
const view = transform(input.issue, issue => ({
  title: issue.title.trim(),
  urgent: issue.labels.includes("urgent"),
}));
```
`acpus workflow check` rejects block bodies, captures, imported helpers, `async`, mutation, `new`, `Math.random`, and non-allowlisted calls:

```ts
transform(input.issue, issue => issue.title.trim()); // ok
transform(input.issue, issue => { return issue.title.trim(); }); // rejected
transform(input.issue, issue => helper(issue)); // rejected
```

Use `template` for compact strings and `md` for multiline prompts/messages; `md` trims surrounding blank lines and common indentation while preserving expression interpolation.

Template interpolation renders strings directly, scalar non-strings with `String(value)`, and arrays/objects as compact JSON. Do not rely on array interpolation for Markdown line breaks. Build explicit lines with:

```ts
join(map(items, item => template`- ${item.id}`), "\n")
```

Common helper choices:

| Need | Use |
| --- | --- |
| Boolean conditions | `not`, `and`, `or`, `ifElse` |
| Equality and ordering | `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `where` |
| Counting and arithmetic | `add`, `subtract`, `multiply`, `divide`, `mod` |
| Nullish fallback | `coalesce(value, fallback)` |
| Array/string size and access | `len`, `isEmpty`, `head`, `get`, `pick` |
| Runtime array transforms | `map`, `filter`, `every`, `some` |
| Small runtime value transforms | `transform(value, value => expression)` |
| Markdown lines from arrays | Use `join(map(...), "\n")`; see the example above. |

`map`, `filter`, `every`, and `some` callbacks receive `(item, index)`. Both are expression accessors; `index` is not a JavaScript number. Use `add(index, 1)` for human-facing numbering.

### Boundary Schemas

Boundary schemas use `z` from `acpus/core`. Use `z.path()` for filesystem paths crossing workflow boundaries.

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

Top-level agents use either `{ use: "codex" }` for native acpx agents or `{ command: "npx pi-acp" }` for custom ACP commands.

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

Composite callbacks receive `{ step }` plus node-specific values such as `item`, `iter`, `previous`, and `result`. Return a plain object to declare output; do not add `outputSchema` to composites.

`if` branches on one expression. Both branches should return compatible object shapes:

```ts
const gate = step("gate").if({
  condition: input.ready,
  then: () => ({ status: "ready" }),
  else: () => ({ status: "blocked" }),
});
```

`switch` chooses the first matching case and requires `default`:

```ts
const route = step("route").switch({
  cases: [
    { when: eq(input.kind, "bug"), then: () => ({ owner: "oncall" }) },
  ],
  default: () => ({ owner: "backlog" }),
});
```

`parallel` runs static named branches:

```ts
const checks = step("checks").parallel({
  branches: {
    lint: () => ({ ok: true }),
    test: () => ({ ok: true }),
  },
});
```

`fanout` expands a runtime array. Its output is an array:

```ts
const items = step("items").fanout({
  over: input.items,
  key: ({ item }) => template`item-${item.id}`,
  do: ({ item }) => ({ id: item.id }),
});
```

`loop` starts from `initial`, checks `stopWhen` before each next iteration, and counts only body executions:

```ts
const refined = step("refine").loop({
  initial: { ready: false, summary: "" },
  maxIterations: 3,
  do: ({ previous }) => ({
    ready: previous.ready,
    summary: previous.summary,
  }),
  stopWhen: ({ result }) => result.ready,
});
```

For `parallel({ strategy: "race" })`, output is `{ winner, result }`. For `fanout({ strategy: "quorum", count })`, output is the accepted item array. Loop `iter` is a 0-based `Expr<number>`; use `add(iter, 1)` for display. Empty arrays in `initial` need an explicit element type:

```ts
type Round = { summary: string };
const initial = {
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
- Check local availability with `command -v <binary>` before recommending a local agent.
- Use `acpus runs retry` for control-plane retry after a failed run.
- Omit `sessionKey` by default; set it only when a multi-turn loop explicitly needs the agent to reuse one session.
- Omit `permissionMode` for normal authoring; use `permissionMode: "approve-reads"` only for agents that are explicitly not allowed to write, such as audit-only inspection.

### Task Boundaries

- Put reusable tasks in separate task modules when they need shared code or third-party packages installed with the workflow package.
- Keep inline tasks self-contained: no third-party imports, module-scope environment reads, or module-scope captures.

### Expression And Schema Hygiene

- Start from the examples; inspect declarations only when the examples do not answer the API question.
- Use graph-level composites instead of JavaScript control flow over expression values.
- Use expression helpers instead of native operators/properties over expression values.
- Use `transform` only for small one-expression JSON transforms. 
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
