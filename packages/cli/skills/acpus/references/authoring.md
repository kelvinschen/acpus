# Authoring Workflows

Use TypeScript workflow modules and user-facing facades only:

```ts
import { defineWorkflow, task, secret, z } from "acpus/core";
import { template, md, and, eq, lte, coalesce, len, head, get, filter, map, where, not, or, gte, includes, ifElse, ne, lt, gt, isEmpty, startsWith, endsWith, matches, every, some, max, min, pick } from "acpus/expression";
import { createWorktree } from "acpus/tasks/git";
```

Do not import `@acpus/*` from user workflows; those are implementation packages behind the `acpus/*` facades.

## API Lookup

Start from the examples. Only when API usage is still unclear, inspect installed declarations instead of copied reference prose:

1. Start from the global install: `$(npm root -g)/acpus/dist/authoring/`.
2. Read facade declarations there: `core.d.ts`, `expression.d.ts`, and `tasks/git.d.ts`.
3. Follow re-exports into sibling global packages: `$(npm root -g)/@acpus/core/dist/*.d.ts`, `@acpus/expression/dist/*.d.ts`, and `@acpus/tasks/dist/*.d.ts`.
4. Retrieve only the relevant symbol plus nearby doc comment/signature; do not dump full declaration files.

## Skeleton

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

## Agent Selection
When the user has no agent preference, ask which agent to use. Check local availability with `command -v <binary>` before recommending a local agent.
Native acpx `use` names include `pi`, `codex`, `claude`, `gemini`, `cursor`, `copilot`, `droid`, `fast-agent`, `grok-build`, `iflow`, `kilocode`, `kimi`, `kiro`, `mux`, `opencode`, `qoder`, `qwen`, and `trae`; for the current list, see https://github.com/openclaw/acpx/tree/main/agents.
For agents not natively supported by acpx, use `command: "<acp command>"`, for example `{ command: "npx pi-acp" }`.

## Why Expressions Exist

Acpus workflows are a TypeScript-authored DSL, not ordinary runtime TypeScript. `build` declares a durable graph before a run executes, so workflow input, metadata, and prior node outputs are graph values wrapped as `Expr<T>` tokens. Treat every run-dependent value as an expression token and use graph constructs plus `acpus/expression` helpers to combine, compare, select, and render those values. Use plain JavaScript only for authoring-time constants and task `exec` bodies.

## Tasks

Task nodes run deterministic local glue, write artifacts, and infer output from `exec`:
```ts
const prepared = step("prepare").task({
  run: {
    input: { repoPath: input.repoPath },
    cwd: input.repoPath,
    exec: async ({ input, $, artifact, abortSignal }) => {
      const status = await $`git status --short`;
      return { dirty: status.stdout.trim().length > 0, statusFile: await artifact.writeText("status.txt", status.stdout, { mediaType: "text/plain" }) };
    },
  },
  timeout: "2m",
});
```

Reusable tasks own their input schema and executable body. Put them in separate task modules when they need shared code or third-party packages installed with the workflow package:
```ts
// tasks/normalize-name.ts
import { task, z } from "acpus/core";
import slugify from "slugify";

export const normalizeName = task.define({
  inputSchema: z.object({ name: z.string() }),
  exec: async ({ input }) => ({ slug: slugify(input.name, { lower: true }) }),
});
```

```ts
import { normalizeName } from "./tasks/normalize-name.js";
const normalized = step("normalize").task({ run: { task: normalizeName, input: { name: input.name } } });
```

Inline task source is embedded in frozen IR. Inline tasks must be self-contained: do not import third-party packages, read module-scope environment, or capture module-scope variables. Pass workflow values through `run.input` and use only task context (`input`, `$`, `artifact`, `env`, `abortSignal`) inside `exec`.

## Agents, Signals, Asserts

Agent nodes handle judgment, synthesis, planning, and review:
```ts
const review = step("review").agent({
  outputSchema: z.object({ ready: z.boolean(), summary: z.string() }),
  run: { agent: agents.reviewer, prompt: template`Review artifact ${prepared.output.statusFile}.`, cwd: input.repoPath },
  retry: { max: 2 },
  timeout: "30m",
});
```

Top-level agent definitions use either `use` or `command`, never both. use `acpus runs retry` for control-plane retry after a failed run. Omit `sessionKey` by default; set it only when a multi-turn loop explicitly needs the agent to reuse one session. Omit `permissionMode` for normal authoring; the default is write-capable and usually gives coding agents better tool performance. Use `permissionMode: "approve-reads"` only for agents that are explicitly not allowed to write, such as audit-only inspection.

Signal nodes wait for operator input; use them only when the workflow needs external control:
```ts
const approval = step("approval").signal({
  outputSchema: z.object({ approved: z.boolean(), notes: z.string().default("") }),
  run: { prompt: template`Approve the result: ${review.output.summary}` },
  timeout: "24h",
  onTimeout: { action: "fail", message: "Approval timed out" },
});
```

Assert nodes fail the run when an expression condition is false:
```ts
step("require_approval").assert({ condition: approval.output.approved, message: template`Approval denied: ${approval.output.notes}` });
```

## Composites

Use graph-level composites instead of JavaScript control flow over expression values:

- `if`: conditional branch; both branches should return compatible object shapes.
- `switch`: case list plus required `default` branch.
- `parallel`: static named branches; `strategy` defaults to `"all"`, with `"race"` available.
- `fanout`: runtime array expansion; output is an array. `strategy` defaults to `"all"`, with `"quorum"` available.
- `loop`: seeded pre-check loop. `maxIterations` counts body executions only; `stopWhen` checks before each body execution.

Composite callbacks receive `{ step }` plus composite-specific values such as `item`, `iter`, and `previous`. Return a plain object to declare composite output; do not add `outputSchema` to composites. For `parallel({ strategy: "race" })`, output is `{ winner, result }`, not a branch-keyed object. For `fanout({ strategy: "quorum", count })`, output is the accepted item array, not an envelope.

## Expressions And Schemas

Use helpers instead of native operators/properties over expression values:

| Do not write | Write |
| --- | --- |
| `input.ready && output.ok` | `and(input.ready, output.ok)` |
| `input.kind === "release"` | `eq(input.kind, "release")` |
| `risk <= 3` | `lte(risk, 3)` |
| `input.maybe ?? "fallback"` | `coalesce(input.maybe, "fallback")` |
| `` `topic ${input.topic}` `` | `template\`topic ${input.topic}\`` |
| `input.items.length` | `len(input.items)` |
| `items[0]` | `head(items)` or `get(items, 0)` |

For collections: `filter(input.items, item => where(item, { tags: { contains: "ready" } }))`, `map(ready, item => item.id)`, `len(ready)`, `coalesce(head(readyIds), "(none)")`.

Use `template` for compact strings and `md` for multiline prompts/messages; `md` trims surrounding blank lines and common indentation while preserving expression interpolation.

Boundary schemas use `z` from `acpus/core`. Keep workflow input, Agent output, Signal output, and reusable task input JSON-compatible and durable. Use `z.path()` for filesystem paths crossing workflow boundaries. Avoid transforms, functions, promises, maps, sets, dates, bigint, symbol, `undefined`, `void`, `never`, non-finite numbers, sparse arrays, cycles, and class instances in graph-boundary values or runtime outputs.

## Checks

Run `acpus workflow check <workflow.ts-or-catalog>` before admitting a run. It prepares the workflow in memory and catches TypeScript diagnostics plus Acpus authoring diagnostics such as Expr truthiness, native operators over Expr values, dynamic node ids, task callsites that cannot be joined to task metadata, inline task captures, and non-admissible outputs.
