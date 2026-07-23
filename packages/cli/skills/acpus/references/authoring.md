# Authoring Workflows

## Start

Write the workflow and import only the symbols it uses:

```ts
import { defineWorkflow, z } from "acpus/core";
import { template } from "acpus/expression";

export default defineWorkflow({
  name: "my-workflow",
  description: "demo",
  inputSchema: z.object({ topic: z.string() }),
  agents: { worker: { use: "codex" } },
}).build(({ input, agents, step }) => {
  const result = step("work").agent({
    agent: agents.worker,
    prompt: template`Analyze ${input.topic}.`,
  });
  return { result: result.output };
});
```

## Mental Model

`build` declares a static graph; it does not execute it. `input`, `meta`, composite locals, and node outputs are opaque `Expr<T>` values resolved during a run. Composite callbacks declare static subgraphs that runtime loop rounds, fanout items, or branches instantiate.

Choose the operation by intent:

| Intent | Use |
| --- | --- |
| Render text | `template` for compact strings; `md` for dedented multiline Markdown. |
| Transform or combine values | `lift`; pass every runtime dependency explicitly. |
| Predicate or graph control | `eq`/`lte`/`and`-style helpers, or `if`/`switch`/`loop`/`fanout`. |
| Read a node result | Exactly one `.output`; `NodeRef` itself is only a control handle. |
| Stabilize a shape or state | `z.infer`, an explicit type, complete loop transitions, and `lift` narrowing for unions. |

## Core Rules

- Project fields and indexes directly; **MUST use `lift` or predicate helpers for JavaScript operators, `.length`, array methods, and control flow over `Expr` values**.
- `lift` callbacks must be inline synchronous arrows. Pass runtime data as dependencies; never capture workflow values or helpers such as `md`. Return plain data, then render outside `lift`.
- Inline Task `exec` must be self-contained. Bind data through Task `input` and use only its context.
- Use an inline Task first. Upgrade at the second authored call site or when module/third-party imports are required; loop/fanout runtime instances do not count.
- Use static step IDs. Runtime derives distinct `nodeKey` values for loop/fanout instances.
- Set a stable, non-empty `sessionKey` for agent step only when reusing context across occurrences, such as loop rounds or different steps; otherwise omit it.
- Return durable primitives, `null`, arrays, plain objects, `ArtifactRef`, or expressions. Never return a `NodeRef`, promise, class instance, or raw `undefined`.
- Never add `outputSchema` to Task or composite nodes; their outputs are TypeScript-inferred.

## Expressions And Shapes

Project fields and indexes directly, such as `review.output.ready` or `items[0]`. Use helpers for everything else:

```ts
import { and, eq, gte, lift, md } from "acpus/expression";

const label = lift(input.kind, input.ready,
  (kind, ready) => `${kind}: ${ready ? "ready" : "blocked"}`);
const summary = lift(
  { kind: input.kind, count: input.count, limit: input.limit },
  ({ kind, count, limit }) => ({ kind, overLimit: count > limit }),
);
const canRelease = and(eq(input.kind, "release"), gte(input.score, 80));
const prompt = md`Review ${label}: ${summary}`;
```

Unary, two-value, and three-value positional `lift` forms are supported; use the named-object form for more dependencies. Return only durable data.

Graph boundaries support the documented Zod 4 subset; Use `z.infer` when a TypeScript annotation must stabilize the same shape:

```ts
const StateSchema = z.object({
  items: z.array(z.string()),
  note: z.string().nullable(),
});
type State = z.infer<typeof StateSchema>;
const initialState: State = { items: [], note: null };
```

Keep authored data JSON-compatible. A top-level scope value or array element must not be `undefined`; an optional object field is omitted when missing. Never write explicit `any`; use `unknown` and narrow it.

## Nodes And Composites

Leaf nodes use the enclosing `step` dispatcher:

```ts
const review = step("review").agent({
  agent: agents.worker,
  prompt: template`Review ${input.topic}.`,
});
const facts = step("facts").task({
  input: { topic: input.topic },
  exec: async ({ input }) => ({ normalized: input.topic.trim() }),
});
const approval = step("approval").signal({
  outputSchema: z.object({ approved: z.boolean() }),
  prompt: template`Approve ${review.output}?`,
});
step("require_approval").assert({ condition: approval.output.approved });
```

Read `acpx-agents.md` before choosing agent backends/models or using raw `{ command: "..." }`. Read `advanced-authoring.md` only for Agent session reuse, reusable/prebuilt Tasks, imports, artifacts, Task process controls, cancellation, or Agent tracing. Read `signal-authoring.md` for parallel waits, payload, or timeout semantics.

Composite callbacks return one durable value; return `{}` for control-only scopes:

```ts
const gate = step("gate").if({
  condition: input.ready,
  then() { return { status: "ready" as const, detail: "go" }; },
  else() { return { status: "blocked" as const, reason: "not ready" }; },
});
const status = gate.output.status;
const detail = lift(gate.output, result =>
  result.status === "ready" ? result.detail : result.reason);
```

`if`, `switch`, and parallel race preserve heterogeneous unions. Project common fields directly; narrow inside `lift` before branch-specific access.

`parallel` runs a fixed set of branches; `fanout` repeats one subgraph over a runtime array:

```ts
const checks = step("checks").parallel({
  branches: {
    security: () => step("security_review").agent({
      agent: agents.worker, prompt: template`Review security for ${input.topic}.`,
    }).output,
    quality: () => step("quality_review").agent({
      agent: agents.worker, prompt: template`Review quality for ${input.topic}.`,
    }).output,
  },
});

const reviews = step("reviews").fanout({
  over: input.items,
  maxConcurrency: 4,
  do: ({ item, itemIndex }) => step("review_item").agent({
    agent: agents.worker, prompt: template`Review item ${itemIndex}: ${item}.`,
  }).output,
});
```

Default parallel returns a branch-keyed record such as `checks.output.security`; `strategy: "race"` returns the first success as `{ winner, result }` and cancels the rest. Default fanout returns input-order results through `reviews.output`; `strategy: "quorum"` plus `count` returns accepted successes in completion order.

**Loop is do-while and returns its final state through `.output`. Its `do` callback receives `{ state, round }`;** declare child nodes through the enclosing `step`. A transition replaces the complete state, never merges partial objects. Widen empty arrays, `null`, and literal fields with an explicit state type:

```ts
const initial: State = { items: [], note: null };
const rounds = step("rounds").loop({
  state: initial,
  do({ state, round }) {
    return {
      state: lift(state, current => ({ ...current, items: [...current.items, "done"] })),
      stop: gte(round, 3),
    };
  },
});
return rounds.output;
```

`parallel` and `fanout` accept runtime `maxConcurrency`: use a positive integer to cap work, or `0`/`undefined` for no authored local cap.

## Choose An Example

Only after applying the rules above, choose the closest compact teaching example by pattern and node coverage:

| Example | Nodes | Pattern |
| --- | --- | --- |
| [`typed-loop-state`](../workflows/examples/typed-loop-state/workflow.ts) | `loop` | Widen evolving loop state and replace it completely each round. |
| [`adversarial-review`](../workflows/examples/adversarial-review/workflow.ts) | `agent`, `fanout` | Plan adversarial lenses, fan out reviews, cross-critique, and synthesize. |
| [`change-approval`](../workflows/examples/change-approval/workflow.ts) | `agent`, `task`, `signal`, `assert`, `if`, `loop` | Draft, refine, optionally approve, and enforce a plan. |
| [`issue-triage`](../workflows/examples/issue-triage/workflow.ts) | `agent`, `task`, `switch`, `parallel`, `fanout` | Triage items in parallel and route them by switch. |
| [`multi-aspect-brainstorm`](../workflows/examples/multi-aspect-brainstorm/workflow.ts) | `agent`, `parallel`, `loop` | Run parallel perspectives in a bounded synthesis loop. |
| [`worktree-tournament`](../workflows/examples/worktree-tournament/workflow.ts) | `agent`, `task`, `parallel` | Build parallel worktree candidates and judge them. |

## Declaration Lookup

Only look up declaration when the above rules and examples don't already answer the exact usage, since lookups consume context.

1. Run `acpus doctor --json | jq ".authoring.imports"` with the active CLI.
2. Read only the relevant symbol and nearby signature from its reported `typesPath`.

For operation commands read `cli-operations.md`; for retry/fork read `runtime-recovery.md`.
