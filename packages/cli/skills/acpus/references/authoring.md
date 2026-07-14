# Authoring Workflows

## Start

Write the workflow, then check it:

```sh
acpus workflow check <workflow.ts-or-catalog>
```

Use public facades:

```ts
import { defineWorkflow, z } from "acpus/core";
import { template, md, eq, lte, gte, and, or, lift } from "acpus/expression";
```

Minimal workflow:

```ts
import { defineWorkflow, z } from "acpus/core";
import { template } from "acpus/expression";

export default defineWorkflow({
  name: "my-workflow",
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

`build` declares a static graph; it does not execute the workflow. Graph values such as `input`, `meta`, and node outputs are opaque `Expr<T>` tokens resolved later. Treat `Expr` like a functor: project fields/indexes directly; map or combine with `lift`. Use graph nodes for control flow. Composite callbacks declare static subgraphs instantiated by loop rounds, fanout items, or branches.

## Core Rules

- **Treat `input`, `meta`, and node outputs as `Expr<T>` runtime tokens.**
- **NEVER use JS operators or control flow over `Expr`.** Use graph nodes, predicates, templates, or `lift`.
- **NEVER capture outer vars or functions in `lift`.** Pass every dependency explicitly.
- **NEVER capture outer vars or functions in inline Task `exec`.**  Inline task **MUST** self-contained, bind top-level Task `input`; read Task context.
- **Inline Task first.** Define reusable Task only for reused logic or third-party package imports.
- **Never define a reusable function**. Instead, define reusable task
- **Static step IDs only.** Loop/fanout instance paths create distinct runtime `nodeKey` values.
- **Read node results once through `.output`.** `NodeRef` is a control handle; never return it directly or nested.
- **Keep durable data JSON-compatible.** Use explicit `null`, not raw `undefined`, for authored absence.
- **Always check after editing.** Fix every diagnostic before running.
- **NEVER add `outputSchema` for composite and task.**

Static config includes node IDs, strategies, schemas, Task targets, agent selectors/models/modes, and permission modes.

## Expressions And Data

Project fields and array indexes directly: `review.output.ready`, `items[0]`.
For other work:

- Graph branches/repetition: `if`, `switch`, `loop`, `fanout`.
- Scalar predicates: `eq`/`ne`, `lt`/`lte`/`gt`/`gte`, `not`/`and`/`or`.
- Value transforms, fallbacks, arithmetic, array summaries: `lift`.
- Rendered strings: `template` or `md`.

`eq`/`ne` use strict equality. Boolean helpers evaluate all operands; no short-circuit guarantee. Use unary, positional, or named-object `lift`:

```ts
// lift 1
const title = lift(input.issue, issue => issue.title.trim());
// lift 2
const status = lift(input.kind, input.ready,
  (kind, ready) => `${kind}: ${ready ? "ready" : "blocked"}`);
// lift 3
const overLimit = lift(
  input.count, input.limit, input.urgent,
  (count, limit, urgent) => urgent || count > limit,
);
// More than 3 Expr dependencies MUST use named-object lift.
const summary = lift(
  { kind: input.kind, ready: input.ready, count: input.count, limit: input.limit },
  ({ kind, ready, count, limit }) =>
    `${kind}: ${ready ? "ready" : "blocked"} (${count}/${limit})`,
);
const canRelease = and(eq(input.kind, "release"), gte(input.score, 80));
```

`lift` callbacks must be inline synchronous arrows. Block bodies may use local declarations and control flow. Return `WorkflowData`: finite primitives, arrays, or plain objects.

```ts
// Informal overloads of lift (one dependency):
lift :: Expr<A> -> (A -> B) -> Expr<B>
```

Use unary `lift` for one dependency

Use `template` for compact strings and `md` for multiline text. Interpolation renders scalars as strings and arrays/objects as compact JSON. Compute custom formatting first:

```ts
const lines = lift(items, xs => xs.map(x => `- ${x.id}`).join("\n"));
const prompt = md`Review:\n${lines}`;
```

Use native Zod 4 through `z` from `acpus/core`. Keep workflow input, Agent/Signal output, Task input, workflow output, and composite output durable. Exclude transforms, functions, promises, dates, maps, sets, bigint, symbols, class instances, non-finite numbers, sparse arrays, cycles, and raw `undefined`. A scope's top-level value and array elements must never resolve to `undefined`; an object field typed as `Expr<T | undefined>` is optional and is omitted when missing.

**Never write explicit `any`** in workflow entries;  Use `unknown` and narrow.


## Nodes

### Leaves

Use `{ use: "<agent>" }` for configured agents. Read `acpx-agents.md` before using raw `{ command: "..." }` or choosing models. Omit `outputSchema` when natural-language text is enough. Omit `sessionKey` unless a multi-turn loop must reuse one agent session. Agent and Task `timeout` bound the whole node attempt.

```ts
const review = step("review").agent({
  agent: agents.reviewer,
  prompt: template`Review ${input.topic}`,
});
const facts = step("facts").task({
  input: { repoPath: input.repoPath },
  exec: async ({ input }) => ({ repoPath: input.repoPath, ok: true }),
});
const approval = step("approval").signal({
  outputSchema: z.object({ approved: z.boolean() }),
  prompt: template`Approve ${review.output}?`,
});
step("require_approval").assert({
  condition: approval.output.approved,
  message: "Approval denied.",
});
```

**Do not read `advanced-authoring.md` by default.** Read it only when the requirement needs one of its gated topics.

### Composites And Control

Composite callbacks receive only node-specific values such as fanout `item`/`itemIndex` and loop `state`/`index`/`round`. Use enclosing `step` for nested nodes. Return any durable workflow value; return `{}` explicitly for a control-only scope.

```ts
const gate = step("gate").if({
  condition: input.ready,
  then() { return { status: "ready" }; },
  else() { return { status: "blocked" }; },
});
const route = step("route").switch({
  cases: [{ when: eq(input.kind, "bug"), then() { return { owner: "oncall" }; } }],
  default() { return { owner: "backlog" }; },
});
const checks = step("checks").parallel({
  branches: {
    lint() { return { ok: true }; },
    test() { return { ok: true }; },
  },
});
const items = step("items").fanout({
  over: input.items,
  do({ item, itemIndex }) { return item; },
});

// access loop's output via `retry.output` instead of `retry.state`
const retry = step("retry").loop({
  state: { summary: "" },
  do({ state, round }) {
    return { state: { summary: state.summary }, stop: gte(round, 3) };
  },
});
```

Callbacks declare one static subgraph. Reuse inner static step IDs across loop rounds and fanout items.

Default `parallel` returns the branch record. Race returns `{ winner, result }` for the first successful branch, cancels the rest, and fails if none succeeds. Fanout returns input-order results; quorum returns the first `count` successful completions in completion order, cancels the rest, and fails when quorum becomes impossible.

`parallel` and `fanout` accept `maxConcurrency`; its runtime value must be a positive integer.

Loop is do-while and returns final state (access with `output`). Loop `index` starts at 0; `round` starts at 1. Give empty state arrays an explicit element type.

Heterogeneous if/switch/race outputs remain unions. Project common fields directly; 

use `lift` to narrow before branch-specific access.

## Choose An Example

After understanding the authoring rules above, choose the closest `examples/workflows/` file by node coverage or pattern:

| Example | Nodes | Pattern |
| --- | --- | --- |
| [`adversarial-review`](../examples/workflows/adversarial-review/workflow.ts) | `agent`, `fanout` | Plan adversarial lenses, fan out reviews, cross-critique, and synthesize. |
| [`change-approval`](../examples/workflows/change-approval/workflow.ts) | `agent`, `task`, `signal`, `assert`, `if`, `loop` | Draft, iteratively refine, optionally approve, and enforce a change plan. |
| [`issue-triage`](../examples/workflows/issue-triage/workflow.ts) | `agent`, `task`, `switch`, `parallel`, `fanout` | Fan out issue triage, run branch work in parallel, and route by switch, with reusable task |
| [`multi-aspect-brainstorm`](../examples/workflows/multi-aspect-brainstorm/workflow.ts) | `agent`, `parallel`, `loop` | Run parallel agent perspectives in a bounded synthesis loop. |
| [`worktree-tournament`](../examples/workflows/worktree-tournament/workflow.ts) | `agent`, `task`, `parallel` | Create parallel worktree implementations and have an agent judge them. |

## Check And Lookup

`workflow check` runs TypeScript plus Acpus authoring checks without admitting a run. Output-shape errors, unsafe union access, arithmetic over `Expr`, and array methods on `Expr` may remain native TypeScript diagnostics.

### Declaration Lookup

Inspect declarations only when examples do not answer exact usage:

1. Run `acpus doctor --json | jq ".authoring.imports"` with the current CLI.
2. Read the relevant `typesPath` symbol and nearby signature only.

For retry or run control, read `runtime-recovery.md`.
