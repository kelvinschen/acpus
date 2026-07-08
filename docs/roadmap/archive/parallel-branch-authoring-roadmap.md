# Parallel Branch Authoring Roadmap

This archived record describes the completed cleanup for static parallel branch
authoring in `@acpus/core`. It is background context only; current implemented
behavior lives in `specs/`.

## Goal

Simplify `parallel.branches` so each named branch is the branch callback
directly, instead of an object that only wraps the callback in a `do` field.

Current shape before this cleanup:

```ts
step("checks").parallel({
  branches: {
    fast: {
      do: ({ step }) => ({ ok: true }),
    },
  },
});
```

Delivered authoring shape:

```ts
step("checks").parallel({
  branches: {
    fast({ step }) {
      return { ok: true };
    },
  },
});
```

## Delivered Shape

The authoring API keeps the useful `branches` namespace so branch names do not
collide with `strategy` or `maxConcurrency`.

Retained behavior:

- `parallel({ branches, strategy?, maxConcurrency? })`
- `strategy: "all" | "race"`
- `parallel.output.<branch>.*` for all-branch parallel nodes
- `parallel.output.winner` and `parallel.output.result` for race parallel nodes
- `ParallelNodeIR.branches: Record<string, ParallelBranchIR>`

The cleanup removes only the authoring-only branch wrapper.

## Implementation Record

### Phase 1: Core Authoring Types

- Replace the branch spec object with a branch callback type.
- Type `ParallelStepSpec.branches` as `Record<string, ScopeCallback>`.
- Infer branch output directly from callback return type.
- Lower each branch with `buildScope(branchCallback)` while preserving the
  current IR branch object.

### Phase 2: Tests And Examples

- Update core type tests for all-branch output, nested composite callback
  contexts, and race winner inference.
- Update integration tests that assert lowered IR still contains
  `branches.<name>.scope`.
- Update Acpus example workflows to the direct branch callback form.
- Search current authoring call sites and remove the old `{ do: ... }` branch
  shape outside archived roadmap records.

### Phase 3: Specs And Authoring Docs

- Update `specs/core-spec.md` when implementation lands so current behavior
  describes direct branch callbacks.
- Update `packages/cli/skills/acpus/references/authoring.md` with copyable
  direct branch examples.
- Keep runtime, validator, CLI status, and WebUI behavior unchanged because the
  serialized IR shape is not changing.

## Verification

Narrow checks run during implementation:

```sh
pnpm --filter @acpus/core typecheck
pnpm test:type -- packages/core
pnpm test:unit -- packages/core
pnpm test:contract -- packages/core
```

Compiler coverage run after updating example and fixture workflows:

```sh
pnpm test:integration -- packages/workflow-compiler
```

## Assumptions

- This is a breaking TypeScript-first API cleanup with no compatibility overload
  for `{ do }`.
- No IR version bump, runtime migration, validator change, CLI runtime change,
  or WebUI graph change is planned.
- Other composites stay unchanged because `if`, `switch`, `fanout`, and `loop`
  do not have the same empty per-branch wrapper.
