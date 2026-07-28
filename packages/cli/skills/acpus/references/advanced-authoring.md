# Advanced Authoring

Use it only for Agent session reuse, reusable/prebuilt Tasks, third-party imports, artifacts, custom Task process controls, cooperative Task cancellation, or Agent tracing configuration. Ordinary Task logic belongs in inline `exec`.

Contents:

- Choose Task form
- Define reusable Tasks
- Write and consume artifacts
- Configure Task processes
- Reuse Agent sessions
- Configure Agent tracing

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

Task context exposes only `artifact.write` and `artifact.path`:

```ts
const report = step("write_report").task({
  input: { data: input.data },
  exec: async ({ input, artifact }) => ({
    report: await artifact.write(
      "report.json",
      JSON.stringify(input.data),
      { mediaType: "application/json" },
    ),
  }),
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

Set `sessionKey` only when Agent occurrences must continue the same conversation, such as across loop rounds or intentionally across different steps. Omit it for one-shot or independent work. Keys are run-local and must be stable, non-empty, and distinct for each independent conversation.

An Agent definition's `config` is a reusable, frozen string-to-string ACP option profile, not an ACP `configOptions` snapshot or shared mutable session state. For example: `agents: { planner: { use: "codex", config: { mode: "plan" } } }`. `config.model` overrides top-level `model`; do not place secrets in it. Every consumer of one shared `sessionKey` must resolve to the same backend, effective model, and config; Acpus does not detect conflicts.

When a specific Agent needs acpx-side configuration, rather than a workflow profile, eg: configure a named agent using exsiting acp adapter, consult the [acpx configuration guide](https://github.com/openclaw/acpx/blob/main/docs/config.md).

In a fix/review loop, reuse the fixer session across rounds but omit `sessionKey` for the reviewer so each review starts fresh. Do not use an empty string; it is invalid.

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

## Agent Tracing

Enable benchmark/replay capture only on a top-level Agent definition:

```ts
agents: {
  reviewer: { use: "codex", trace: true },
}
```

`trace` defaults to false, is not valid on `step(...).agent(...)`, and cannot be set by CLI `--agents` overrides. An override that changes `use` or `command` inherits the authored tracing policy. Treat tracing as sensitive-data capture.

For artifact roles, event semantics, inspection, and consumption, read [Agent Tracing](agent-tracing.md).
