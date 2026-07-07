# Authoring TypeScript Workflows

## Canonical imports

Use the CLI package authoring facades from workflow modules:

```ts
import { defineWorkflow, task, secret, z } from "acpus/core";
import { and, coalesce, eq, head, lte, md, template, where } from "acpus/expression";
import { createWorktree } from "acpus/tasks/git";
```

Avoid importing `@acpus/core` directly in user workflow modules unless you are editing Acpus internals.

## Workflow skeleton

```ts
import { defineWorkflow, z } from "acpus/core";
import { template } from "acpus/expression";

const Result = z.object({ ok: z.boolean(), summary: z.string() });

export default defineWorkflow({
  name: "my-workflow",
  inputSchema: z.object({ repoPath: z.path(), topic: z.string() }),
  agents: {
    worker: { use: "codex", permissionMode: "approve-reads" },
  },
}).build(({ input, agents, meta, step }) => {
  const result = step("work").agent({
    outputSchema: Result,
    run: {
      agent: agents.worker,
      prompt: template`Analyze ${input.topic} in ${input.repoPath}.`,
    },
  });

  return { runId: meta.runId, ok: result.output.ok, summary: result.output.summary };
});
```

`build` receives `{ input, agents, meta, step }`. `input.*` and `meta.*` fields are expression tokens, not runtime JavaScript values.

## Agent definitions

Top-level `agents` entries are plain authoring specs:

```ts
agents: {
  reviewer: { use: "codex", model: "opus", permissionMode: "approve-reads" },
  localServer: { command: "my-acp-server --stdio", model: "custom" },
}
```

Rules:

- Use either `use` or `command`, never both.
- `use` maps to an acpx positional agent token.
- `command` maps to `acpx --agent <command>` for a custom ACP server.
- Valid override/definition fields are narrow: `use`, `command`, `model`, `permissionMode`, `agentMode`, `cwd`, `env` where supported. Do not use legacy `policy`, raw IR `kind`, broad `options`, or provider-command environment maps.

## Node patterns

### Task node

Use Task nodes for deterministic local glue and durable artifacts.

```ts
const prepared = step("prepare").task({
  run: {
    input: { repoPath: input.repoPath },
    cwd: input.repoPath,
    env: { CI: "true" },
    exec: async ({ input, $, artifact, abortSignal }) => {
      const status = await $`git status --short`;
      return {
        dirty: status.stdout.trim().length > 0,
        statusFile: await artifact.writeText("status.txt", status.stdout, {
          mediaType: "text/plain",
        }),
      };
    },
  },
  timeout: "2m",
});
```

Task outputs are inferred from `exec`; do not add author-facing `outputSchema` to task nodes.

### Reusable task

```ts
import { defineWorkflow, task, z } from "acpus/core";

export const normalizeName = task.define({
  inputSchema: z.object({ name: z.string() }),
  exec: async ({ input }) => ({ slug: input.name.toLowerCase().replaceAll(" ", "-") }),
});

export default defineWorkflow({
  name: "reuse-task",
  inputSchema: z.object({ name: z.string() }),
}).build(({ input, step }) => {
  const normalized = step("normalize").task({
    run: { task: normalizeName, input: { name: input.name } },
  });
  return { slug: normalized.output.slug };
});
```

Reusable task calls also infer output from the task token. The call site supplies `run.input`; the task definition owns `inputSchema` and `exec`.

### Agent node

```ts
const review = step("review").agent({
  outputSchema: z.object({ ready: z.boolean(), summary: z.string() }),
  run: {
    agent: agents.reviewer,
    prompt: template`Review artifact ${prepared.output.statusFile}.`,
    sessionKey: template`review-${input.repoPath}`,
    cwd: input.repoPath,
  },
  retry: { max: 2 },
  timeout: "30m",
});
```

Agent `retry.max` is schema-backed response repair inside one scheduler-visible attempt. It is not workflow-level automatic retry. Use manual `acpus runs retry` for control-plane retry after a failed run.

When live Agent execution budget matters, place a single Agent node outside `fanout` or `loop` unless repeated Agent calls are intentional. Agent nodes inside runtime-expanded composites may execute once per item or iteration.

### Signal node

```ts
const approval = step("approval").signal({
  outputSchema: z.object({ approved: z.boolean(), notes: z.string().default("") }),
  run: { prompt: template`Approve the result: ${review.output.summary}` },
  timeout: "24h",
  onTimeout: { action: "fail", message: "Approval timed out" },
});
```

`onTimeout` is allowed only when `timeout` is present. Schema-less signals accept raw string payloads; schema-backed signals validate JSON payloads against `outputSchema`.

### Assert node

```ts
step("require_approval").assert({
  condition: approval.output.approved,
  message: template`Approval denied: ${approval.output.notes}`,
});
```

Assert nodes produce no output.

## Composite nodes

- `if`: conditional branch; both branches should return compatible object shapes.
- `switch`: case list plus required `default` branch.
- `parallel`: static named branches; `strategy` defaults to `"all"`, with `"race"` available.
- `fanout`: runtime array expansion; output is an array, not a key map. `strategy` defaults to `"all"`, with `"quorum"` available.
- `loop`: seeded pre-check loop. `initial` is the first result; body receives non-optional `previous`; `maxIterations` counts body executions only; `stopWhen` checks before each body execution.

Composite callbacks receive `{ step }` plus composite-specific values such as `item`, `iter`, and `previous`. Return a plain object to declare composite output. Do not add `outputSchema` to composites.

`fanout({ strategy: "quorum", count })` also outputs the accepted item array. It does not return an envelope with `.accepted`, `.result`, or `.winner`. Use the full pattern in `assets/examples/quorum-agentless.workflow.ts` to prove quorum output shape at runtime.

Copy the full pattern in `assets/examples/composite-review.workflow.ts` when combining `fanout`, `parallel`, `loop`, `if`, Agent, Task, and Signal nodes. The most common shapes are:

```ts
import { len, template } from "acpus/expression";

const reviews = step("reviews").fanout({
  over: input.items,
  key: ({ item }) => template`item-${item.id}`,
  do: ({ item, step }) => {
    const review = step("review_item").agent({
      outputSchema: z.object({ ready: z.boolean(), summary: z.string() }),
      run: {
        agent: agents.reviewer,
        prompt: template`Review ${item.id}: ${item.summary}`,
      },
    });
    return { id: item.id, ready: review.output.ready, summary: review.output.summary };
  },
});

const retry = step("retry_until_done").loop({
  initial: { done: false, round: 0, summary: "" },
  maxIterations: 3,
  do: ({ iter, previous, step }) => {
    const round = step("round").task({
      run: {
        input: { iter, previous: previous.summary },
        exec: async ({ input }) => ({
          done: input.iter >= 1,
          round: input.iter,
          summary: input.previous,
        }),
      },
    });
    return { done: round.output.done, round: round.output.round, summary: round.output.summary };
  },
  stopWhen: ({ result }) => result.done,
  onExhausted: "returnLast",
});
```

Use `onExhausted: "fail"` when exhausting the loop should fail the run instead of returning the last body output:

```ts
step("must_converge").loop({
  initial: { done: false, summary: "seed" },
  maxIterations: 2,
  do: ({ previous }) => ({ done: false, summary: previous.summary }),
  stopWhen: ({ result }) => result.done,
  onExhausted: "fail",
});
```

When a loop fails on exhaustion, downstream nodes such as Signal gates are not reached; inspect reports the failed loop node and an exhaustion message.

Do not use native properties such as `input.items.length` on expression arrays. Use expression helpers such as `len(input.items)` in graph expressions, or pass the array through `run.input` to a Task and use normal JavaScript inside `exec`.

Use `switch` when one of several graph branches should run. `default` is required, and every branch should return a compatible object shape:

```ts
const route = step("route").switch({
  cases: [
    {
      when: where(item, { kind: "ship" }),
      then: ({ step }) => {
        const shipped = step("ship").task({
          run: { input: { id: item.id }, exec: async ({ input }) => ({ route: "ship", summary: input.id }) },
        });
        return { route: shipped.output.route, summary: shipped.output.summary };
      },
    },
  ],
  default: ({ step }) => {
    const held = step("hold").task({
      run: { input: { id: item.id }, exec: async ({ input }) => ({ route: "hold", summary: input.id }) },
    });
    return { route: held.output.route, summary: held.output.summary };
  },
});
```

For collection expressions, prefer helpers over JavaScript methods:

```ts
const ready = filter(input.items, item => where(item, { tags: { contains: "ready" } }));
const readyIds = map(ready, item => item.id);
const allScored = every(input.items, item => where(item.score, { gte: 0, lte: 100 }));
const anyBlocked = some(input.items, item => where(item.tags, { contains: "blocked" }));
const firstReadyId = coalesce(get(readyIds, 0), "(none)");
```

For `parallel({ strategy: "race" })`, the output is an envelope with `winner` and `result`, not a branch-keyed object:

```ts
const winner = step("winner").parallel({
  strategy: "race",
  branches: {
    fast: { do: () => ({ summary: "fast" }) },
    slow: { do: () => ({ summary: "slow" }) },
  },
});

return {
  winner: winner.output.winner,
  summary: winner.output.result.summary,
};
```

## Output and schema contracts

Schema fields belong only at graph/runtime boundaries:

- Workflow input: `inputSchema`.
- Agent output: optional `outputSchema`; required if using `retry`.
- Signal output: optional `outputSchema`.
- Reusable task definition input: `task.define({ inputSchema, exec })`.

Task and composite outputs are TypeScript-owned and inferred. Keep workflow root output small: paths, booleans, counts, summaries, artifact refs, run ids. Store large data in artifacts.

Workflows that use only Task, Signal, Assert, and composite nodes may omit the top-level `agents` map entirely.

## Static authoring checks to expect

`acpus workflows check` runs TypeScript diagnostics plus Acpus authoring diagnostics before import/compile. It rejects common hidden runtime traps such as:

- `Expr` values in JavaScript truthiness (`if (input.flag)`) or native `&&`, `||`, `<`, `===` positions.
- Untagged template interpolation involving `Expr` tokens.
- JavaScript array methods over runtime expression arrays.
- Expr-derived node ids.
- Task callsites that cannot be joined to task metadata.
- Inline tasks that capture workflow-module scope instead of using `run.input`.
- Non-workflow-data outputs such as functions, `Date`, `Map`, `Set`, `symbol`, `bigint`, class instances, broad `object`, non-finite numbers, sparse arrays, or cycles.
