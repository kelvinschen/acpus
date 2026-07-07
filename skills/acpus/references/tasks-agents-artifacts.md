# Tasks, Agents, and Artifacts

## Task nodes

Task nodes are trusted local automation boundaries. Use them for deterministic work: reading files, running Git, producing artifacts, normalizing paths, collecting diffs, preparing inputs, or post-processing outputs.

Task `exec` receives a narrow runtime context:

```ts
exec: async ({ input, $, artifact, env, abortSignal }) => {
  const result = await $`pnpm test`.allowExitCode([0, 1]);
  return {
    passed: result.exitCode === 0,
    log: await artifact.writeText("test.log", result.stdout + result.stderr, {
      mediaType: "text/plain",
    }),
  };
}
```

The Acpus `$` wrapper is backed by `zx/core`. Useful forms:

```ts
await $`git status --short`;
await $({ cwd: input.repoPath, env: { CI: "true" } })`pnpm test`;
await $`pnpm test`.allowExitCode([0, 1]);
await $`cat package.json`.json();
await $`printf '%s\n' value`.text();
await $`printf 'a\nb\n'`.lines();
await $`long command`.timeout("10m");
await $`maybe failing`.nothrow();
```

Use zx array interpolation for programmatic arguments instead of building shell strings manually.

## Inline task self-containment

Inline task source is embedded in frozen IR. It must be self-contained. Do not capture module-scope variables:

```ts
// Bad: captures PREFIX from module scope.
const PREFIX = "outer-";
exec: async () => ({ slug: `${PREFIX}value` });

// Good: pass values through run.input.
run: {
  input: { prefix: "outer-" },
  exec: async ({ input }) => ({ slug: `${input.prefix}value` }),
}
```

If reusable behavior needs module-scope helpers, prefer `task.define` and import/call the reusable task token.

## Reusable tasks

Reusable tasks are live module references, not copied code artifacts. The compiler records the source-level specifier, export name, and workflow referrer. Runtime resolves the module through the Acpus loader.

Supported patterns include direct default imports, named imports with aliases, barrel re-exports, same-file exported reusable tasks, and official facades such as `acpus/tasks/git`.

The official Git facade currently exposes `createWorktree` and the lower-level `tryCreateWorktree` domain function. `createWorktree` should be used as a reusable task token through `run.task`.

## Artifacts

Use artifacts for large or durable data instead of stuffing prompts or root outputs:

```ts
const diffRef = await artifact.writeText("diff.patch", diff.stdout, {
  mediaType: "text/x-patch",
});
```

Task artifact APIs write run-local files and register metadata in SQLite. Artifact writes after a task timeout must be rejected. Return artifact refs in node outputs and use those refs in downstream prompts.

## Agent nodes

Agent nodes are for judgment, synthesis, planning, review, and other open-ended work.

Named agents:

```ts
agents: {
  reviewer: { use: "codex", permissionMode: "approve-reads" },
}
```

Custom ACP server:

```ts
agents: {
  worker: { command: "my-acp-server --stdio", permissionMode: "deny-all" },
}
```

Runtime maps named definitions to acpx positional agent tokens and command definitions to `acpx --agent <command>`. Real runtime execution should go through acpx-backed agent execution, not provider-command environment maps.

Absent effective `permissionMode` defaults to `approve-all`; set it explicitly when reads/writes should be constrained.

## Schema-backed agent outputs

With `outputSchema`, Acpus asks for exactly one JSON value matching the schema. Runtime can recover JSON from whole-response JSON, prose/Markdown-wrapped balanced JSON, and conservative repair. Extra object keys may be accepted for conformance, but workflow-visible output is projected to the declared schema shape.

`retry.max` controls response repair turns for schema-backed agent output. It does not create extra scheduler attempts.

Schema-less agent nodes return raw response text and do not run schema conformance repair.

## Sessions and retries

Explicit `sessionKey` values render to non-empty strings and become run-local logical session keys. Without an explicit key, runtime derives deterministic session identity from run id and dynamic node key.

Manual control-plane retry of a failed agent node reuses the same acpx session identity for that dynamic node key and sends a fixed continuation prompt.
