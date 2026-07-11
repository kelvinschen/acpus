# Acpus TypeScript Workflow Core

This package is a Core implementation of the Acpus TypeScript Workflow v2 direction:

- TypeScript workflow files generate a typed graph and compile to canonical IR.
- Schema authoring uses the native **Zod 4** `z` interface.
- Expr authoring lives in `@acpus/expression` and uses predicate helpers, overloaded `lift`, `template`, and `md`.
- Program nodes are replaced by trusted local **Task** nodes.
- Task command ergonomics use an Acpus-owned `$` wrapper backed by `zx/core`.
- Task permissions are intentionally removed from Core. Security isolation belongs to the runner/container/profile layer, not to per-node authoring syntax.

## Install

This package is a member of the Acpus pnpm workspace. From the repo root:

```bash
pnpm install
```

It targets:

```txt
zod ^4.4.3
zx  ^8.8.5
```

## Validate

```bash
pnpm --filter @acpus/core typecheck
```

Representative workflow compiler fixtures live under `test/fixtures/workflows/`; this package does not maintain a separate examples tree.

## Minimal workflow

```ts
import {
  defineWorkflow,
  z,
} from "acpus/core";
import { and, lift, lte, template } from "acpus/expression";

const ReviewOut = z.object({
  ready: z.boolean(),
  riskCount: z.number().int(),
  issues: z.array(z.string()),
  summary: z.string(),
});

export default defineWorkflow({
  name: "quick-review",

  inputSchema: z.object({
    repoPath: z.string(),
  }),

  agents: {
    reviewer: { use: "codex", model: "gpt-5.5", permissionMode: "approve-reads" },
  },
}).build(({ input, agents, step }) => {
  const diff = step("diff").task({
    input: {},
    cwd: input.repoPath,
    exec: async ({ $, artifact }) => {
      const result = await $`git diff`;
      return {
        patch: await artifact.writeText("diff.patch", result.stdout, {
          mediaType: "text/x-patch",
        }),
      };
    },
  });

  const review = step("review").agent({
    outputSchema: ReviewOut,
    agent: agents.reviewer,
    prompt: template`Review this diff:\n\n${diff.output.patch}`,
  });

  step("require_ready").assert({
    condition: and(
      review.output.ready,
      lte(review.output.riskCount, 3),
      lift(review.output.issues, issues => issues.length === 0),
    ),
    message: template`Review failed:\n${review.output}`,
  });

  return {
    ready: review.output.ready,
    summary: review.output.summary,
  };
});
```

`model` is optional and validated by acpx; omit it for the agent default.

## Core boundaries

### Zod 4 is the schema authoring layer

Acpus accepts real Zod schemas at workflow boundaries, then canonicalizes them into `SchemaIR` for durable execution. The IR never stores live Zod objects.

Allowed graph-boundary schemas are the serializable Zod subset: primitive scalars, arrays, strict objects, optional/default/nullable fields, records, unions, and literals/enums.

Unsupported at graph boundaries: `transform`, `custom`, `function`, `promise`, `map`, `set`, `date`, `bigint`, `symbol`, `undefined`, `void`, `never`. Use those inside Task implementation code instead.

### Task is trusted local code

Core no longer has per-task `permissions`. A Task is trusted code selected by the workflow author. If you need isolation for third-party workflows, enforce it at the runner layer, for example Docker, VM, CI policy, or OS sandbox.

### `$` is still Acpus-owned

Task code receives `ctx.$`; it should not import raw `zx` directly in normal use. The wrapper is not a permission gate. It provides command timeouts, abort handling, stdout/stderr capture, and output helpers. Explicit artifact writes use `ctx.artifact`.

## Package boundary

This is the Core authoring and IR package, not the workflow module compiler, runtime scheduler, CLI, or agent process executor.

Implemented:

- core syntax layer
- Zod 4 schema bridge and `SchemaIR`
- graph builder
- compile to WorkflowIR
- zx/core-backed `$` wrapper shape

See [`specs/core-spec.md`](../../specs/core-spec.md) and [`docs/roadmap/core-roadmap.md`](../../docs/roadmap/core-roadmap.md).
