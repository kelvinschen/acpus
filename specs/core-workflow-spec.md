# Core Workflow Spec

## Purpose

`@acpus/core` is the TypeScript-first authoring and compile layer for Acpus. Workflow authors write typed TypeScript modules that build a graph and compile to a frozen, serializable `WorkflowIR` (`irVersion: 2`) that a runtime consumes. The core provides workflow authoring, a Zod 4 schema bridge, an Acpus-owned expression IR, prompt templates, Agent / Task / Signal executable nodes, composite nodes, and compilation to IR with structural validation. It is an authoring layer only; it does not provide a CLI, execute, persist, replay, or fork runs.

## Requirements

### Authoring surface

- The core MUST expose `defineWorkflow(...).build(...)` as the workflow entry point, where `build` receives `{ input, step, output }`.
- During graph construction, `input.*` fields MUST be exposed as `Expr<T>` tokens, not concrete values.
- Agent definitions MUST be declared at workflow top-level under `agents` as plain object definitions. `{ use, model?, ... }` MUST define an agent that uses a runner/tool id; `{ command, ... }` MUST define a command-backed agent. `use` and `command` MUST be mutually exclusive.
- Top-level agent definitions MUST be authoring specs, not IR objects, and MUST NOT include an IR `kind` field.
- Command-backed agent definitions MUST NOT declare `model`; model selection belongs to tool-backed `{ use, model?, ... }` definitions.
- The compiler and IR validator MUST diagnose malformed top-level agent definitions and MUST NOT emit malformed agent definitions into `WorkflowIR.agents`.
- Agent node `run.agent` MUST reference a key declared in workflow top-level `agents`; TypeScript authoring MUST type-check `run.agent` against those declared keys, and IR MUST serialize it as `AgentRunIR.agent`, the stable string key consumed by runners.
- When authors extract the `agents` object before passing it to `defineWorkflow(...)`, they SHOULD preserve literal keys, for example with `satisfies AgentMap`; annotating it as a broad `AgentMap` widens keys to `string` and gives up authoring-time key checking.
- Top-level `agents.*.use` MUST mean the tool/worker id for that agent definition; agent node `run.agent` MUST mean the declared top-level agent key.
- The public API MUST include at least: `defineWorkflow`, `z`, `task`, `template`, `pick`, `fallback`, `head`, `nth`, `where`, `includes`, `isEmpty`, `and`, `not`, `lte`, `all`, `max`, `runtime`, `secret`.

```ts
import {
  defineWorkflow,
  z,
  task,
  template,
  pick,
  fallback,
  head,
  nth,
  where,
  includes,
  isEmpty,
  and,
  not,
  lte,
  all,
  max,
  runtime,
  secret,
} from "@acpus/core";

export default defineWorkflow({
  name: "release-readiness",
  inputSchema: z.object({ repoPath: z.path(), version: z.string() }),
  agents: { reviewer: { use: "codex", policy: "read" } },
}).build(({ input, step, output }) => {
  // construct graph
  return output({
    /* ... */
  });
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
- The core MUST support named operators: `literal`, `not`, `and`, `or`, `all`, `any`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `len`, `includes`, `isEmpty`, `startsWith`, `endsWith`, `matches`, `coalesce`, `fallback`, `head`, `nth`, `max`, `min`, `where`.
- Collection helpers (`all`, `max`, ...) MUST operate on compile-time arrays via selector callbacks; runtime arrays MUST use `step("id").fanout(...)`.

```ts
where(review.output, {
  ready: true,
  riskCount: { lte: 3 },
  issues: { length: 0 },
});
and(where(review.output, { ready: true }), lte(review.output.riskCount, 3));
all(reviews, (review) => review.output.ready);
```

### Templates

- The core MUST provide a single tagged template helper named `template`, producing `TemplateIR` with text and expression parts.
- Plain string prompts/messages MUST compile to `TemplateIR` with one text part.
- Template interpolation MUST preserve expressions in `TemplateIR`; object, array, and artifact rendering policy belongs to the runtime template renderer.
- Runtime template renderers SHOULD render object and array expression values as stable pretty JSON, SHOULD render string/number/boolean/null values with stable stringification, and SHOULD define runtime-specific policy for artifact and secret values.
- The core MUST provide `pick(source, keys)` for graph-time object projection. `pick` MUST accept an object-like `OutputAccessor<T>` and a literal list of top-level keys, MUST return a plain object fragment containing same-name `OutputAccessor<T[K]>` fields, and MUST NOT create nodes, output tokens, or a distinct IR shape.
- The core MUST provide `fallback(value, defaultValue)` as the authoring helper for nullish fallback. `fallback` MUST lower to the same expression semantics as `coalesce(value, defaultValue)` and MUST NOT create nodes, output tokens, or a distinct IR shape.

### Nodes

- Schema contract fields MUST use the `Schema` suffix: `inputSchema`, `outputSchema`, and `itemOutputSchema`. Runtime bindings, accessors, and output token helpers MUST continue to use `input` and `output`.
- Executable nodes (Agent, Task, Signal) MUST use `run` as the execution boundary and top-level `outputSchema` as the downstream contract boundary.
- Node ids MUST be bound through `step("id")`; node kind methods MUST receive only the kind-specific spec and MUST NOT include an `id` field.
- Agent nodes MUST use the shape `step("id").agent({ outputSchema?, run: { agent, prompt, policy?, session?, cwd?, env? }, timeout?, retry? })`.
- Signal nodes MUST use the shape `step("id").signal({ outputSchema, run: { prompt }, timeout?, onTimeout? })`.
- Signal `onTimeout`, when present, MUST use `{ action: "fail", message? }`; signal timeout MUST NOT support successful completion without a payload. If `timeout` is set and `onTimeout` is omitted, timeout MUST fail without a custom message.
- Task nodes MUST use `run.input` as their explicit Expr-to-runtime-value boundary for both inline and reusable task invocations.
- Task input binding values MUST be graph-lowerable workflow values: refs, primitive literals, arrays, and plain objects composed of those values.
- Inline Task nodes MUST use the shape `step("id").task({ outputSchema, run: { input, exec, params?, cwd?, env?, execution? }, timeout?, retry? })`.
- Reusable Task nodes MUST use the shape `step("id").task({ run: { task, input, params?, cwd?, env?, execution? }, timeout?, retry? })` and MUST take their output schema from the reusable Task token.
- Agent and Signal nodes MUST NOT require node-level `input`; their graph dependencies are expressed by refs inside `run.prompt`, `run.cwd`, `run.env`, and `run.session`. Serialized Agent and Signal node IR MUST NOT include an `inputs` field.
- Agent and Task `cwd` MUST be a string workflow value. Agent and Task `env` values MUST be string workflow values or `secret(...)` tokens.
- Inline Task `run.exec` functions MUST receive runtime typed input values unwrapped from `run.input` graph-time expressions.
- The core MUST provide `step("id").assert(...)` for runtime boolean invariants.
- Assert nodes MUST use the shape `step("id").assert({ condition, message? })`, where `condition` MUST be a boolean expression or boolean literal.
- Assert nodes MUST continue when `condition` evaluates true and fail when `condition` evaluates false.
- Assert nodes MUST NOT produce outputs and MUST NOT support branch or complete actions.
- The core MUST provide composite nodes `step("id").if`, `step("id").switch`, `step("id").parallel`, `step("id").fanout`, `step("id").loop`, each producing composite node IR containing child scopes.
- Composite callbacks MUST receive a `ScopeContext` containing `{ step, output }`.
- Each composite callback MUST define an implicit pipeline scope: child steps execute sequentially and can reference earlier sibling outputs in that scope.
- Parent scopes MUST access a composite node only through that node's projected `output`; internal child steps are not part of the parent scope's public contract.
- Composite nodes that declare an `outputSchema` SHOULD expose downstream `output` accessors typed from that schema.
- Composite callbacks for nodes that declare an `outputSchema` MUST type-check `output({...})` values against that schema at authoring time. This type check MUST NOT add fields to IR or change the serialized `ScopeIR.outputs` shape.
- Composite callbacks MUST return the `output({...})` token produced by the callback's own `ScopeContext`; an outer-scope output helper MUST NOT satisfy a typed composite callback return.
- Array output accessors MUST support numeric index refs, lowering `node.output[0].field` to a serializable ref path.
- The core MUST provide `head(array)` and `nth(array, index)` for ref-backed workflow arrays. These helpers MUST return accessors typed as possibly `undefined` and MUST lower to the same index ref path as direct numeric access. `nth` MUST use zero-based non-negative integer indexes.
- If nodes MUST use the authoring shape `step("id").if({ condition, outputSchema?, then, else? })`. `condition` MUST be a boolean workflow value and MUST lower to `IfNodeIR.condition`; `else` MUST lower to `IfNodeIR.else`. If `outputSchema` is present, `else` MUST be present. If `outputSchema` is absent, `else` MAY be omitted.
- Switch case `when` values MUST be boolean workflow values.
- Switch nodes MUST use `default` for fallback authoring. `default` MUST lower to `SwitchNodeIR.default`. If a Switch node declares `outputSchema`, it MUST declare `default`. If `outputSchema` is absent, `default` MAY be omitted.
- Parallel nodes MUST express static named branch concurrency. `step("id").parallel(...)` MUST accept `strategy?: "all" | "race"` and MUST default to `"all"`.
- Parallel branches MUST use `{ outputSchema, do }`; each branch `outputSchema` MUST type-check that branch `do` scope output.
- Parallel nodes MUST NOT accept a top-level aggregate `output` schema. For `strategy: "all"`, the final output type MUST be inferred as `{ [branchKey]: BranchOutput }`. For `strategy: "race"`, the final output type MUST be inferred as `{ winner: BranchKeyUnion; result: BranchOutputUnion }`.
- Fanout nodes MUST express runtime array expansion. `step("id").fanout(...)` MUST accept `strategy?: "all" | "quorum"` and MUST default to `"all"`.
- Fanout `over` MUST be typed as an array workflow value. String and unknown workflow values MUST NOT be accepted as `over`.
- Fanout `itemOutputSchema` MUST represent the per-item output contract and MUST serialize as `FanoutNodeIR.itemOutputSchema`. Fanout nodes MUST NOT accept a top-level aggregate output schema.
- Fanout `strategy: "all"` final output MUST be inferred as `ItemOutput[]`. Fanout `strategy: "quorum"` final output MUST be inferred as `{ accepted: ItemOutput[]; completed: ItemOutput[] }`, and MUST require a positive integer `count`.
- Fanout `key` MAY be a callback over `{ item, itemIndex }`, and callback-produced templates MUST lower those refs into the fanout node key template. `itemIndex` refs MUST serialize as `["fanout", id, "itemIndex"]`.
- Fanout bodies MUST expose `item` as an output accessor so object items can be referenced as `item.field`.
- Loop bodies MUST receive `iter` and `previous`. `previous` MUST be the previous body output accessor and MUST be typed as possibly `undefined` because the first iteration has no previous output.
- Loop nodes MUST use `stopWhen({ iter, result })` as their public stop condition. A loop MUST run its body at least once; `stopWhen` MUST evaluate after a body iteration completes, and `result` MUST be the just-completed body output accessor. The serialized `LoopNodeIR.stopWhen` field MUST represent this post-body stop condition.
- Loop body `previous` refs MUST serialize under `["loop", id, "previous", ...]`; loop `stopWhen` `result` refs MUST serialize under `["loop", id, "result", ...]`.
- Loop `stopWhen(...)` MUST return a boolean workflow value.
- Loop `onExhausted`, when present, MUST be `"fail"` or `"returnLast"`. If omitted, exhaustion MUST mean failure. `"returnLast"` MUST use the last completed body output as the loop output and MUST NOT change the loop output contract.
- Required output fields MUST NOT accept nullable or optional refs unless the author explicitly removes the nullish case, for example with `fallback(...)`.

#### Task

- An inline Task MUST be authored as trusted local code directly in `step("id").task({ run: { input, exec } })`.
- A reusable Task MUST be authored via `task.define({ inputSchema, outputSchema, exec })`.
- A reusable Task MUST live in its own task module and MUST be referenced at the call site by an identifier imported directly from that module. A reusable Task MUST NOT be a workflow-local value, and its import MUST NOT be routed through a barrel or re-export module.
- An inline Task `exec` MUST be self-contained: it MUST reference only its own parameters, its own local declarations, and runtime globals. It MUST NOT capture workflow-module scope (helpers, imports, or graph builder values). Shared logic or dependency-backed logic MUST be moved into a reusable Task module.
- A reusable Task node MUST use the Task's declared `outputSchema` and MUST NOT repeat `outputSchema` at the `step("id").task(...)` call site.
- A reusable Task definition's `inputSchema` MUST be the runtime input schema for its `exec` function; a reusable Task node call site's `run.input` MUST be the graph expression binding for that schema.
- The core MUST NOT expose a per-task `permissions` field; security isolation is delegated to the runner/container/profile layer.
- Inline Task options MUST support `outputSchema` and `run: { input, exec, params?, cwd?, env?, execution? }`; reusable Task node options MUST support `run: { task, input, params?, cwd?, env?, execution? }`.
- Task node lifecycle options MAY support top-level `timeout` and `retry`. Task invocation options MAY support `run.params`, `run.cwd`, `run.env`, and `run.execution` (`shell`, `defaultCommandTimeout`, `commandRunner`).

```ts
const tests = step("run_tests").task({
  outputSchema: z.object({ passed: z.boolean(), log: z.artifact("text/plain") }),
  timeout: "15m",
  run: {
    input: { repoPath: input.repoPath },
    cwd: input.repoPath,
    env: { CI: "true" },
    exec: async ({ input, $, artifact }) => {
      const result = await $({ cwd: input.repoPath })`pnpm test`.allowExitCode([
        0, 1,
      ]);
      return {
        passed: result.exitCode === 0,
        log: await artifact.writeText(
          "test.log",
          result.stdout + result.stderr,
        ),
      };
    },
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
- Serialized IR object shapes MUST be closed. `WorkflowIR`, `NodeIR`, run objects, scope objects, branch envelopes, templates, expression objects, agent definitions, and task execution options MUST NOT include fields outside the current IR contract. The validator MUST diagnose unspecified fields as invalid IR.

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
- `TaskNodeIR` MUST NOT carry task invocation fields such as `input`, `params`, `cwd`, `env`, or `execution` at node top-level. Those fields belong to `TaskRunIR`.

### Compile behavior

- `compileWorkflowModule(entry)` MUST read the source, import the module, run `build(...)`, lower to IR, attach a `workflowSourceDigest`, statically analyze task provenance, bundle Task assets, synchronize task run digests, and append `validateWorkflowIR(...)` diagnostics.
- Task provenance MUST be resolved by static analysis of the workflow source (TypeScript parser only; no type checker), not by runtime stack inspection. For each `step("id").task(...)` call site, the analyzer MUST determine whether the task is inline or reusable, MUST resolve a reusable task to the task module file it is directly imported from, and MUST emit an error diagnostic when an authoring boundary is violated.
- Task bundles MUST contain bundled ESM source and a `sha256:` digest of that bundled source. The task run digest in each node MUST match its bundle digest.
- Reusable Task definitions MAY import local modules and JavaScript npm dependencies; the compiler MUST bundle that dependency graph into the Task bundle from the statically resolved source file. Node built-ins remain runtime externals.
- Inline Task source MUST be bundled as a self-contained function. The compiler MUST emit an error diagnostic when an inline Task is not self-contained, when a reusable Task is a workflow-local value or routed through a re-export, or when a referenced module export is not a `task.define(...)` task.

## Verification

- Tests MUST cover `toSchemaIR` acceptance of the boundary subset and rejection of unsupported Zod features (`transform`, `custom`, `date`, `map`, `set`, etc.).
- Tests MUST cover `where(...)` lowering to primitive `ExprIR` calls, including workflow-value filters, Mongo aliases, and AND/OR/NOT composition.
- Tests MUST cover that compiling a workflow module through `compileWorkflowModule(...)` produces a valid `WorkflowIR` (`irVersion: 2`) with no live Zod/function references and bundled Task assets, including a reusable task whose third-party dependency graph is inlined into the bundle source.
- Tests MUST cover the static provenance gate: rejecting workflow-local reusable tasks, re-exported reusable tasks, module exports that are not `task.define(...)`, and inline tasks that capture workflow-module scope.
- The core package MUST NOT expose a binary or command-line entry point; CLI behavior belongs in a separate package.
