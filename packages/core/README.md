# Acpus TypeScript Workflow Core

This package is a Core implementation of the Acpus TypeScript Workflow v2 direction:

- TypeScript workflow files generate a typed graph and compile to canonical IR.
- Schema authoring uses **Zod 4** plus Acpus boundary extensions: `z.path()`, `z.artifact()`, `z.secretRef()`.
- Expr authoring supports Prisma/Mongo-style `where(...)` plus named operators like `and`, `lte`, `all`, and `max`.
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

The checked-in example workflow and compiled IR live under `examples/`.

## Minimal workflow

```ts
import {
  defineWorkflow,
  z,
  agent,
  template,
  where,
  runtime,
} from "@acpus/core";

const ReviewOut = z.object({
  ready: z.boolean(),
  riskCount: z.number().int(),
  issues: z.array(z.string()),
  summary: z.string(),
});

export default defineWorkflow({
  name: "quick-review",

  input: z.object({
    repoPath: z.path(),
  }),

  agents: {
    reviewer: agent.define({ provider: "codex", policy: "read" }),
  },
}).build(({ input, step, output }) => {
  const diff = step.task("diff", {
    input: { repoPath: input.repoPath },
    output: z.object({ patch: z.artifact("text/x-patch") }),
    cwd: input.repoPath,
    run: async ({ $, artifact }) => {
      const result = await $`git diff`;
      return {
        patch: await artifact.writeText("diff.patch", result.stdout, {
          mediaType: "text/x-patch",
        }),
      };
    },
  });

  const review = step.agent("review", {
    input: { patch: diff.output.patch },
    output: ReviewOut,
    run: ({ input }) => ({
      use: "reviewer",
      prompt: template`Review this diff:\n\n${input.patch}`,
    }),
  });

  step.guard("require_ready", {
    when: where(review.output, {
      ready: true,
      riskCount: { lte: 3 },
      issues: { length: 0 },
    }),
    otherwise: "fail",
    message: template`Review failed:\n${review.output}`,
  });

  return output({
    ready: review.output.ready,
    summary: review.output.summary,
  });
});
```

## Core boundaries

### Zod 4 is the schema authoring layer

Acpus accepts real Zod schemas at workflow boundaries, then canonicalizes them into `SchemaIR` for durable execution. The IR never stores live Zod objects.

Allowed graph-boundary schemas are the serializable Zod subset: primitive scalars, arrays, strict objects, optional/default/nullable fields, records, unions, literals/enums, and Acpus extensions.

Unsupported at graph boundaries: `transform`, `custom`, `function`, `promise`, `map`, `set`, `date`, `bigint`, `symbol`, `undefined`, `void`, `never`. Use those inside Task implementation code instead.

### Task is trusted local code

Core no longer has per-task `permissions`. A Task is trusted code selected by the workflow author. If you need isolation for third-party workflows, enforce it at the runner layer, for example Docker, VM, CI policy, or OS sandbox.

### `$` is still Acpus-owned

Task code receives `ctx.$`; it should not import raw `zx` directly in normal use. The wrapper is not a permission gate. It exists so Acpus can attach command spans, timeouts, abort handling, stdout/stderr capture, redaction, and future artifact integration.

## Important current limitations

This is a Core package, not a complete runtime.

Implemented:

- core syntax layer
- Zod 4 schema bridge and `SchemaIR`
- Acpus Expr IR
- `where(...)` lowering and named operators
- graph builder
- compile to WorkflowIR
- zx/core-backed `$` wrapper shape

Still roadmap:

- real Task executor
- AST-based Task extraction/bundling
- deterministic compile sandbox
- ESLint rules
- Agent executor
- Signal executor
- runtime persistence/replay/fork

See [`specs/core-workflow-spec.md`](../../specs/core-workflow-spec.md) and [`docs/roadmap/core-roadmap.md`](../../docs/roadmap/core-roadmap.md).
