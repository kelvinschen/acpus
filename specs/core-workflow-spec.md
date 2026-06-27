# Core Workflow Spec

## Purpose

`@acpus/core` is the TypeScript-first authoring and compile layer for Acpus. Workflow authors write typed TypeScript modules that build a graph and compile to a frozen, serializable `WorkflowIR` (`irVersion: 2`) that a runtime consumes. The core provides workflow authoring, a Zod 4 schema bridge, an Acpus-owned expression IR, prompt templates, Agent / Task / Signal executable nodes, composite nodes, and compilation to IR with structural validation. It is an authoring layer only; it does not provide a CLI, execute, persist, replay, or fork runs.

## Requirements

### Authoring surface

- The core MUST expose `defineWorkflow(...).build(...)` as the workflow entry point, where `build` receives `{ input, step, output }`.
- During graph construction, `input.*` fields MUST be exposed as `Expr<T>` tokens, not concrete values.
- Agent definitions MUST be declared at workflow top-level under `agents` via `agent.define(...)`.
- The public API MUST include at least: `defineWorkflow`, `z`, `agent`, `task`, `signal`, `template`, `where`, `and`, `not`, `lte`, `all`, `max`, `runtime`, `secret`.

```ts
import {
  defineWorkflow, z, agent, task, signal,
  template, where, and, not, lte, all, max, runtime, secret,
} from "@acpus/core";

export default defineWorkflow({
  name: "release-readiness",
  input: z.object({ repoPath: z.path(), version: z.string() }),
  agents: { reviewer: agent.define({ provider: "codex", policy: "read" }) },
}).build(({ input, step, output }) => {
  // construct graph
  return output({ /* ... */ });
});
```

### Schema layer (Zod 4)

- The core MUST re-export Zod 4 as `z` and MUST add the Acpus extensions `z.path()`, `z.artifact(mediaType?)`, `z.secretRef()`, and `z.integer()` (alias for `z.number().int()`).
- The core MUST NOT store live Zod objects in IR; it MUST canonicalize graph-boundary schemas to `SchemaIR` via `toSchemaIR(schema)`.
- The graph-boundary schema subset that MUST be accepted is: `string`, `number`, `number().int()`, `boolean`, `null`, `unknown`, `literal`, `enum`, `array`, `object`, `record`, `union`, `optional`, `nullable`, `default`, plus the Acpus extensions `path`, `artifact`, `secretRef`.
- The core MUST reject the following at graph boundaries: `transform`, `custom`, `function`, `promise`, `map`, `set`, `date`, `bigint`, `symbol`, `undefined`, `void`, `never`. These MAY be used inside Task implementation code, but MUST NOT be node input/output contracts.

### Expressions

- The core MUST own the canonical expression IR (`ExprIR`); it MUST NOT use CEL or JSON Logic as the canonical layer.
- The core MUST support Prisma/Mongo-style `where(...)` filters and MUST lower them to primitive `ExprIR` calls.
- `where(...)` MUST accept Mongo aliases (e.g. `$lte`, `$regex`).
- The core MUST support named operators: `literal`, `not`, `and`, `or`, `all`, `any`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `len`, `contains`, `startsWith`, `endsWith`, `matches`, `coalesce`, `max`, `min`, `where`.
- Collection helpers (`all`, `max`, ...) MUST operate on compile-time arrays via selector callbacks; runtime arrays MUST use `step.fanout(...)`.

```ts
where(review.output, { ready: true, riskCount: { lte: 3 }, issues: { length: 0 } });
and(where(review.output, { ready: true }), lte(review.output.riskCount, 3));
all(reviews, review => review.output.ready);
```

### Templates

- The core MUST provide a single tagged template helper named `template`, producing `TemplateIR` with text and expression parts.
- Plain string prompts/messages MUST compile to `TemplateIR` with one text part.
- Template interpolation MUST preserve expressions in `TemplateIR`; object, array, and artifact rendering policy belongs to the runtime template renderer.

### Nodes

- Executable nodes (Agent, Task, Signal) MUST share the shape `step.kind("id", { input, output, run, ...options })`.
- Executable node `run` typing MUST be derived from that node's `input` object.
- Agent and Signal `run` callbacks MUST receive graph-time typed input values for prompt construction.
- Inline Task `run` functions MUST receive runtime typed input values unwrapped from the node's graph-time input expressions.
- The core MUST provide `step.guard(...)` with `when`, `otherwise`, and `message`.
- The core MUST provide composite nodes `step.if`, `step.switch`, `step.parallel`, `step.fanout`, `step.loop`, each producing composite node IR containing child scopes.
- Composite callbacks MUST receive a `ScopeContext` containing `{ step, output }`.
- Each composite callback MUST define an implicit pipeline scope: child steps execute sequentially and can reference earlier sibling outputs in that scope.
- Parent scopes MUST access a composite node only through that node's projected `output`; internal child steps are not part of the parent scope's public contract.

#### Task

- An inline Task MUST be authored as trusted local code directly on `step.task(...).run`.
- A reusable Task MUST be authored via `task.define({ input, output }).run(...)`.
- A reusable Task node MUST use the Task's declared output schema and MUST NOT repeat `output` at the `step.task(...)` call site.
- The core MUST NOT expose a per-task `permissions` field; security isolation is delegated to the runner/container/profile layer.
- Inline Task options MUST support `input`, `output`, and `run`; reusable Task node options MUST support `input` and `run`.
- Task node options MAY support `params`, `cwd`, `env`, `timeout`, `retry`, and `execution` (`shell`, `defaultCommandTimeout`).

```ts
const tests = step.task("run_tests", {
  input: { repoPath: input.repoPath },
  output: z.object({ passed: z.boolean(), log: z.artifact("text/plain") }),
  cwd: input.repoPath,
  env: { CI: "true" },
  timeout: "15m",
  run: async ({ $, artifact }) => {
    const result = await $`pnpm test`.allowExitCode([0, 1]);
    return {
      passed: result.exitCode === 0,
      log: await artifact.writeText("test.log", result.stdout + result.stderr),
    };
  },
});
```

#### Signal

- A Signal node MUST enter an awaiting state pending an external/human decision and MUST validate its payload against the declared output schema.

### Task command wrapper

- Task code MUST receive `ctx.$`, an Acpus-owned wrapper backed by `zx/core`.
- The wrapper MUST NOT be treated as a permission gate. It exists for command spans, stdout/stderr capture, timeout/abort integration, redaction, result normalization, and future artifact integration.
- The wrapper MUST mirror the core `zx/core` surface so task authors use familiar `$` syntax: shared method signatures (`nothrow`, `timeout`, `text`, `json`, `lines`) MUST be derived from zx `ProcessPromise` and stay assignable to it.
- The wrapper MUST support at least: `` $`cmd` ``, the zx-style configurator `` $({ cwd, env, timeout, nothrow, allowExitCode })`cmd` ``, `.allowExitCode([...])`, `.nothrow()`, `.timeout("10m")`, `.json<T>()`, `.text()`, and `.lines()`.
- The wrapper MUST NOT expose non-zx helpers (`$.cmd`, `$.shell`, `$.raw`); programmatic arguments use zx array interpolation (`` $`${exe} ${args}` ``).

### IR contract

- The compiler MUST produce `WorkflowIR` with the shape below, and the IR MUST be frozen (no live Zod objects, no live functions).

```ts
type WorkflowIR = {
  irVersion: 2;
  name: string;
  inputSchema?: SchemaIR;
  agents: Record<string, AgentDefinitionIR>;
  root: ScopeIR;
  outputs: Record<string, ExprIR>;
  assets: { taskBundles: Record<string, TaskBundleIR> };
  lock: WorkflowLockIR;
  diagnostics: DiagnosticIR[];
};
```

- `TaskNodeIR` MUST NOT carry a `permissions` field.

### Compile behavior

- `compileWorkflowModule(entry)` MUST read the source, import the module, run `build(...)`, lower to IR, attach a `workflowSourceDigest`, and append `validateWorkflowIR(...)` diagnostics.
- While the compiler uses trusted dynamic `import()` (not a production sandbox) and records inline Task source via `Function#toString()`, it MUST emit a diagnostic flagging that this is not a production-grade deterministic compile. (See `docs/roadmap/core-roadmap.md` for the planned replacement.)

## Verification

- Tests MUST cover `toSchemaIR` acceptance of the boundary subset and rejection of unsupported Zod features (`transform`, `custom`, `date`, `map`, `set`, etc.).
- Tests MUST cover `where(...)` lowering to primitive `ExprIR` calls, including Mongo aliases and AND/OR/NOT composition.
- Tests MUST cover that compiling a workflow module through `compileWorkflowModule(...)` produces a valid `WorkflowIR` (`irVersion: 2`) with no live Zod/function references and with the trusted-import diagnostic present.
- The core package MUST NOT expose a binary or command-line entry point; CLI behavior belongs in a separate package.
