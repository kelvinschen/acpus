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

- **Default:** Use an inline Task; it remains compatible with a self-contained heredoc.
- **Reusable Task:** Use at the second authored call site or when module/third-party imports are required.
- **Not reuse:** Fanout and loop runtime instances do not count as a second authored call site.

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

- **`inputSchema`:** A TypeScript input witness, not runtime parsing or defaulting.
- **Types:** Use `z.infer` to align schema and annotations. Use an explicit `Promise<Result>` and typed locals when reusable Task branches could widen output inference.
- **Output:** Infer it from `exec`; never add `outputSchema`.
- **Imports:** Resolve bare packages from the workflow workspace. Load the Task module fresh for each Attempt.

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

- `artifact.write` accepts `string | Uint8Array` and returns `ArtifactRef`.
- `artifact.path(ref)` synchronously returns an absolute path.
- Accept only refs passed through Task input or written successfully by that Task; arbitrary or cross-run refs fail.
- Serialize JSON explicitly; there are no format-specific or file-copy helpers.

Direct Agent-prompt interpolation of `ArtifactRef` renders its absolute local path. `${ref.uri}` keeps the URI. Nested refs render as compact JSON.

## Task Process Controls

Each Task attempt runs in a fresh Node process. Context contains only `input`, `$`, `artifact`, `env`, and `abortSignal`.

- Resolve a relative Task `cwd` from the workflow workspace and use it as initial `process.cwd()`.
- Resolve Task file access and `$` commands from the current process cwd.
- Honor later `process.chdir()` and `process.env` changes.
- Treat Task `env` as a string-only overlay; it cannot unset inherited variables.

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

- **Task `timeout`:** Abort and terminate the whole Attempt.
- **`defaultCommandTimeout`:** Set only the default for each `$` command.
- **Per-command controls:** Use timeout, `.allowExitCode(...)`, `.nothrow()`, `.json<T>()`, `.text()`, or `.lines()`.
- **Arguments:** Interpolate argument arrays; do not assemble shell strings.
- **Cancellation:** Use `abortSignal` for non-command async work.

## Agent Session Reuse

- Set `sessionKey` only to continue one conversation across loop rounds or steps; omit it otherwise.
- Give each conversation a distinct, stable, non-empty, run-local key.
- Treat each key atomically during Fork: reuse the complete conversation or rerun every occurrence in a fresh child Session.

- Keep the resolved Agent launch, effective cwd, model, and `config` identical across occurrences sharing a key.
- Acpus validates the binding before Provider startup and reports only `launch | cwd | model | options` mismatch categories, never raw values.
- See [ACP Agents](acp-agents.md#acp-agent-config) for configuration.

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
