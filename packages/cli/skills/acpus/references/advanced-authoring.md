# Advanced Authoring

Use it only for Agent session reuse, reusable/prebuilt Tasks, third-party imports, artifacts, custom Task process controls, or cooperative Task cancellation.
Ordinary Task logic belongs in inline `exec`.

Contents:

- Choose Task form
- Define reusable Tasks
- Write and consume artifacts
- Configure Task processes
- Reuse Agent sessions

## Choose Task Form

**Inline Task first.** It stays compatible with a self-contained heredoc. Use a file-backed reusable Task at the second authored call site or when the implementation requires module/third-party imports. Fanout/loop runtime instances do not count as authoring reuse.

Inline Tasks may dynamically import Node built-ins inside `exec`:

```ts
const read = step("read").task({
  input: { path: input.path },
  exec: async ({ input }) => {
    const { readFile } = await import("node:fs/promises");
    return { text: await readFile(input.path, "utf8") };
  },
});
```

Never capture module-scope imports or workflow values in inline `exec`.

## Reusable Tasks

Export `task.define` from a loadable module, then bind graph values at the call site:

```ts
// tasks/normalize-name.ts
import { task, z } from "acpus/core";

const NormalizeInput = z.object({ name: z.string() });
type NormalizeInput = z.infer<typeof NormalizeInput>;
type NormalizeResult = { slug: string };

export const normalizeName = task.define({
  inputSchema: NormalizeInput,
  exec: async ({ input }): Promise<NormalizeResult> => {
    const value: NormalizeInput = input;
    return { slug: value.name.toLowerCase() };
  },
});

// workflow.ts
import { normalizeName } from "./tasks/normalize-name.js";

const normalized = step("normalize").task({
  task: normalizeName,
  input: { name: input.name },
});
```

`inputSchema` is a TypeScript input witness, not runtime parsing/defaulting. `z.infer` keeps schema and input annotations aligned. For reusable Tasks, an explicit `Promise<Result>` return and typed local values prevent output inference from drifting across branches; output remains inferred from `exec`, so never add `outputSchema`. Bare-package dependencies resolve from the workflow workspace, and each attempt loads the resolved Task module in a fresh Node process.

Use an existing reusable Task when the requirement needs its capability:

```ts
import { createWorktree } from "acpus/tasks/git";

const worktree = step("create_worktree").task({
  task: createWorktree,
  input: { repo: input.repoPath, path: input.worktreePath },
});
```

For a checked reusable Task with a stable result type and artifact output, use [`reusable-task-artifact`](../workflows/examples/reusable-task-artifact/workflow.ts).

## Artifacts

The Task artifact API exposes only `artifact.write` and `artifact.path`:

```ts
const report = step("write_report").task({
  input: { data: input.data },
  exec: async ({ input, $, artifact }) => {
    const content = JSON.stringify(input.data);
    await $`printf '%s' ${content} > report.json`; // Ordinary cwd file; not an artifact.
    return {
      // Run-local artifact; returns an ArtifactRef.
      report: await artifact.write(
        "report.json",
        content,
        { mediaType: "application/json" },
      ),
    };
  },
});
```

`artifact.write` accepts `string | Uint8Array` and returns `ArtifactRef`. `artifact.path(ref)` synchronously returns an absolute path. The ref must arrive through Task input or that Task's successful write; arbitrary/cross-run refs fail. Serialize JSON yourself; no format-specific or file-copy helpers.

Direct Agent-prompt interpolation of `ArtifactRef` renders its absolute local path. `${ref.uri}` keeps the URI. Nested refs render as compact JSON.

## Task Process Controls

Each Task attempt runs in a fresh Node process. Context contains only `input`, `$`, `artifact`, `env`, and `abortSignal`.

An authored relative Task `cwd` resolves from the workflow workspace and becomes initial `process.cwd()`; Task file access and `$` commands then resolve from that process cwd. Later commands follow `process.chdir()` and `process.env` changes. Task `env` is a string-only host-environment overlay and cannot unset inherited variables.

```ts
const inspect = step("inspect").task({
  input: { repo: input.repoPath },
  cwd: input.repoPath,
  env: { MODE: "audit" },
  timeout: "5m",
  execution: { defaultCommandTimeout: "2m" },
  exec: async ({ input, $, abortSignal }) => {
    abortSignal.throwIfAborted();
    const status = await $`git -C ${input.repo} status --porcelain`.text();
    const probe = await $({ timeout: "10s", allowExitCode: [0, 1] })`git diff --quiet`;
    return { status, clean: probe.exitCode === 0 };
  },
});
```

Task `timeout` aborts and terminates the whole attempt; `execution.defaultCommandTimeout` is only the default for individual `$` commands. `$` also supports per-command timeout, `.allowExitCode(...)`, `.nothrow()`, `.json<T>()`, `.text()`, and `.lines()`. Interpolate argument arrays instead of assembling shell strings. Use `abortSignal` for cooperative cancellation in non-command async work.

## Agent Session Reuse

Use `sessionKey` only to continue a conversation across loop rounds or steps; omit it otherwise. Give each conversation a distinct, stable, non-empty, run-local key. Fork treats each key atomically: it reuses the complete source conversation or reruns every occurrence in a fresh child session.

Occurrences sharing a key must use the same Agent backend, effective model, and `config`; Acpus does not detect conflicts. See [ACP Agents](acp-agents.md#acp-agent-config) for configuration.

In a fix/review loop, give only the fixer a key so each review starts fresh:

```ts
const cycle = step("fix_review").loop({
  state: { approved: false, feedback: input.request },
  do({ state }) {
    const fix = step("fix").agent({
      agent: agents.fixer,
      sessionKey: "fix-review:fixer",
      prompt: md`Apply this feedback: ${state.feedback}`,
    });
    const review = step("review").agent({
      agent: agents.reviewer,
      prompt: md`Review this fix: ${fix.output}`,
      outputSchema: z.object({ approved: z.boolean(), feedback: z.string() }),
    });
    return { state: review.output, stop: review.output.approved };
  },
});
```
