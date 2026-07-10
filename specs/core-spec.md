# Core Spec

## Purpose

`@acpus/core` is the TypeScript-first workflow authoring and IR construction package for Acpus. It provides the workflow DSL, schema bridge, node authoring shapes, serializable `WorkflowIR` types, and structural IR validation. Expression and template authoring belongs to `@acpus/expression`. Core compiles in-memory workflow definitions with `compileWorkflowDefinition`; TypeScript module loading, workflow static checks, task callsite analysis, and reusable task reference preparation belong to `@acpus/workflow-compiler`.

## Requirements

### Public API

- The root `@acpus/core` entrypoint MUST expose the minimal workflow authoring surface: `defineWorkflow`, `z`, `task`, and `secret`.
- `@acpus/core/workflow` MUST expose `defineWorkflow`, `compileWorkflowDefinition`, and `isWorkflowDefinition`.
- `@acpus/core/schema` MUST expose schema authoring, parsing, validation, and lowering helpers, including `z`, `isSchema`, `parseSchema`, `safeParseSchema`, `validateValue`, `toSchemaIR`, `tryToSchemaIR`, `toJSONSchema`, `schemaToJsonSchema`, and `assertBoundarySchema`.
- `@acpus/core/runtime` MUST expose the task command wrapper factory `createDollar`, secret tokens, and related task runtime types.
- `@acpus/core/ir` MUST expose `validateWorkflowIR` and public IR types.
- The core package MUST NOT expose a binary; command behavior belongs to the `acpus` CLI package.

### Workflow Authoring

- The core MUST expose `defineWorkflow(...).build(...)` as the workflow entry point, where `build` receives `{ input, agents, meta, step }`.
- Workflow authoring config MAY declare `description?: string`, and compilation MUST preserve it as top-level `WorkflowIR.description` metadata when present.
- During graph construction, `input.*` fields MUST be exposed as `Expr<T>` tokens.
- During graph construction, `meta.runId`, `meta.workflowPath`, `meta.workflowName`, and `meta.workspaceDir` MUST be exposed as run-level `Expr<string>` tokens.
- Agent definitions MUST be declared at workflow top level under `agents` as plain object definitions.
- `{ use, model?, ... }` MUST define a named acpx agent token and
  `{ command, ... }` MUST define a custom acpx `--agent <command>` ACP server.
- Agent definition `use` and `command` MUST be mutually exclusive.
- Top-level agent definitions MUST be authoring specs without an IR `kind` field.
- Named and custom command agent definitions MAY declare `model`.
- The `build` context `agents` member MUST expose one typed token for each key declared in workflow top-level `agents`.
- Agent node `run.agent` MUST use an agent token from the `build` context `agents` member.
- When authors extract an `agents` object before passing it to `defineWorkflow(...)`, they SHOULD preserve literal keys, for example with `satisfies AgentMap`.

### Schema Layer

- The core MUST directly re-export Zod 4's native `z` object without Acpus extensions, preserving standard type members such as `z.infer` and `z.output`.
- Graph-boundary schemas MUST be canonicalized to serializable `SchemaIR` via `toSchemaIR(schema)`.
- `tryToSchemaIR(schema)` MUST return a neverthrow `Result<SchemaIR, SchemaLoweringError>` for recoverable schema lowering failures.
- `SchemaLoweringError` MUST be a serializable tagged union that includes unsupported schema, invalid literal, and invalid default failures with stable path fields.
- `toSchemaIR(schema)` MAY remain a throwing compatibility adapter over `tryToSchemaIR(schema)` for authoring APIs that still expect exceptions.
- The graph-boundary schema subset MUST include string, number, boolean, null, unknown, literal, enum, array, object, record, union, optional, nullable, and default schemas.
- The core MUST expose the native Zod schema constructor surface without Acpus-specific constructors.
- Graph-boundary schema lowering MUST reject runtime-only or non-serializable schema constructs such as transform, custom, function, promise, map, set, date, bigint, symbol, undefined, void, and never.
- `SchemaIR` MUST be a core-owned recursive schema union. It MUST NOT reuse expression `TypeIR` for core-only variants such as `literal`, `enum`, or schema metadata.
- `validateWorkflowIR(ir)` MUST validate `SchemaIR` as a closed recursive union, reject unknown schema kinds and fields, and reject hand-authored `kind: "integer"` in favor of `kind: "number"`.

### Resolvable Values, Templates, And Helpers

- Plain `T` in an authoring type MUST mean declaration-time structure. `Resolvable<T>` MUST mean a value evaluated from durable workflow scope at run time.
- Core MUST use `Resolvable<T>` from `@acpus/expression` as the sole public runtime-value seam and MUST NOT define duplicate value-or-expression or template-input types.
- Every `Resolvable` field, including literal input, MUST lower through `valueToExprIR` to `ExprIR`. Template tokens MUST be stored only as `ExprIR.kind: "template"`; node fields MUST NOT store `TemplateIR` directly.
- Workflow, composite-scope, and Task-input authored bindings MUST reject raw `undefined` at every nesting level instead of omitting it during lowering. Runtime Task outputs remain governed by runtime output normalization.
- Template interpolation MUST preserve expressions inside the template `ExprIR`; rendering policy belongs to runtime consumers.

### Nodes

- Schema contract fields MUST use the `Schema` suffix only at actual schema boundaries: `inputSchema` and schema-backed agent/signal `outputSchema`.
- Runtime bindings and accessors MUST continue to use `input` and `output`; scopes MUST declare their `output` by returning a plain object, not by calling an output helper.
- Executable nodes MUST use `run` as the execution boundary. TypeScript-owned task outputs MUST be inferred from `exec`; they MUST NOT declare author-facing `outputSchema`.
- Node ids MUST be bound through `step("id")`; node kind methods MUST receive only the kind-specific spec.
- Agent nodes MUST use `step("id").agent({ outputSchema?, run: { agent: agents.<key>, prompt, permissionMode?, sessionKey?, cwd?, env? }, timeout?, retry? })`.
- Agent definitions MAY declare `permissionMode?: "approve-reads" | "approve-all" | "deny-all"` and `agentMode?: string`.
- Agent definitions MUST NOT accept broad `options` fields.
- Signal nodes MUST use `step("id").signal({ outputSchema?, run: { prompt }, timeout?, onTimeout? })`. Schema-less signals expose raw `Expr<string>` output; schema-backed signals expose parsed structured output.
- Signal `onTimeout`, when present, MUST use `{ action: "fail", message? }`.
- Signal `onTimeout` MUST NOT be present unless `timeout` is present.
- Task nodes MUST use `run.input` as the explicit expression-to-runtime-value boundary.
- Inline Task nodes MUST use `step("id").task({ run: { input, exec, cwd?, env?, execution? }, timeout? })`; output is inferred from `Awaited<ReturnType<exec>>`.
- Reusable Task nodes MUST use `step("id").task({ run: { task, input, cwd?, env?, execution? }, timeout? })`; output is inferred from the reusable Task token's `exec`.
- Agent node graph dependencies MUST be expressed by refs inside `run.prompt`, `run.cwd`, `run.env`, and `run.sessionKey`.
- Signal node graph dependencies MUST be expressed by refs inside `run.prompt`.
- Agent and Task node `run.cwd` MUST be `Resolvable<string>`.
- Agent and Task node `run.env` values MUST be `Resolvable<string>` or `secret(...)` tokens.
- Top-level Agent definition `cwd` and `env` MUST remain declaration-time plain strings or secret refs and MUST remain plain values in `WorkflowIR`.
- Assert nodes MUST use `step("id").assert({ condition, message? })`.
- Assert nodes MUST serialize only `condition` and optional `message`, and MUST produce no output.
- Composite nodes MUST include `step("id").if`, `switch`, `parallel`, `fanout`, and `loop`, each producing child-scope IR.
- Composite callbacks MUST receive only node-specific local values: fanout callbacks receive `item` and `itemIndex`; loop body callbacks receive `index`, `round`, and `state`.
- `step` MUST be a single per-compilation active-scope dispatcher provided by the workflow `build` callback: `step("id")` declares into whichever workflow or composite declaration callback is currently executing.
- Workflow and composite graph declaration callbacks MUST be synchronous. Calling `step()` after graph declaration has closed MUST fail with a clear authoring invariant error.
- Node ids MUST remain unique across the entire workflow IR, including nested composite scopes.
- Parent scopes MUST access a composite node only through that node's projected `output`.
- Composite callbacks MUST declare their scope output by returning a plain object. TypeScript-owned composite outputs MUST be inferred from callback returns and MUST NOT declare author-facing `outputSchema`.
- Workflow root and composite callback return types MUST use a recursive TypeScript constraint that accepts durable primitives, arrays, plain object shapes, `JsonValue`, `ArtifactRef`, graph `Expr` values, object-property `undefined`, and unions while rejecting `unknown`, functions, promises, dates, maps, sets, symbols, bigint, and array-element `undefined`.
- The recursive output constraint MUST preserve exact inferred output types and MUST allow `any` as the explicit TypeScript escape hatch. It MUST remain an internal type implementation detail rather than a required author import.
- Array output accessors MAY be combined through `@acpus/expression` callback helpers such as `fmap` and `lift`; no array-specific expression helper is required.
- If nodes MUST use `step("id").if({ condition, then, else })` and MUST infer the union of `then` and `else` outputs.
- Switch nodes MUST use `default` for fallback authoring, and default MUST be declared.
- Switch and parallel race outputs MUST preserve heterogeneous branch unions. Accessors over a union MUST expose only fields TypeScript can prove are present.
- Parallel nodes MUST express static named branches and support declaration-time `strategy?: "all" | "race"`, defaulting to `"all"`, plus runtime `maxConcurrency?: Resolvable<number>`.
- Fanout nodes MUST express runtime array expansion through `over: Resolvable<readonly Item[]>`, support declaration-time `strategy?: "all" | "quorum"`, and accept runtime `count: Resolvable<number>` for quorum and `maxConcurrency?: Resolvable<number>`.
- Fanout item output MUST be inferred from the `do` callback and serialize no `itemOutputSchema`.
- Loop nodes MUST declare `state`; loop bodies MUST receive `index`, `round`, and non-optional `state`.
- Loop bodies MUST return a transition object `{ state, stop }`; transition `state` MUST converge with the declared initial `state`.
- Loop `stop` MUST accept a boolean workflow value and lower under `LoopNodeIR.do.outputs.stop`; `loop.output` MUST expose the final transition `state`.
- Loop transition shape, stop type, and state convergence MUST be enforced by the public TypeScript interface rather than compiler AST rules.
- Required output fields MUST NOT accept nullable or optional refs unless the author explicitly removes the nullish case, for example with `fmap(value, value => value ?? fallback)`.

### Task Authoring And Runtime Context Types

- A reusable Task MUST be authored via `task.define({ inputSchema, exec })`.
- A reusable Task node MUST infer output from the reusable Task's `exec` return type and MUST NOT repeat `outputSchema` at the call site.
- A reusable Task definition's `inputSchema` MUST be the runtime input schema for its `exec` function; a reusable Task node call site's `run.input` MUST be the graph expression binding for that schema.
- Inline and reusable Task return types MUST use the recursive durable output constraint. A Task MAY return top-level `undefined` to represent no output, but arrays MUST NOT contain `undefined` entries.
- Task node lifecycle options MAY support top-level `timeout`.
- Task node lifecycle options MUST NOT support workflow-level automatic `retry`.
- Agent node `retry`, when present, MUST contain only `max?: Resolvable<number>` and MUST
  require `outputSchema`.
- Task invocation options MAY support `run.cwd`, `run.env`, and `run.execution`.
- Task code MUST receive a context containing only `input`, `$`, `artifact`, `env`, and `abortSignal`.
- Task context `env` MUST use `Record<string, string | undefined>` and MUST expose the Task process's live `process.env` object.
- Task code MUST receive an Acpus-owned `$` wrapper backed by `zx/core`.
- Without an explicit per-call cwd or env override, the `$` wrapper MUST read the live process cwd and environment when each command starts rather than capturing them when the wrapper is created.
- The wrapper MUST support `` $`cmd` ``, `$({ cwd, env, timeout, nothrow, allowExitCode })`, `.allowExitCode([...])`, `.nothrow()`, `.timeout("10m")`, `.json<T>()`, `.text()`, and `.lines()`.
- Programmatic arguments MUST use zx array interpolation.

### IR And Validation

- `compileWorkflowDefinition(definition)` MUST lower an in-memory workflow definition to serializable `WorkflowIR` with `irVersion: 3`.
- `WorkflowIR`, node IR, scope IR, schema IR, template IR, expression IR, agent definitions, task runs, and task execution targets MUST use closed serialized object shapes.
- `WorkflowIR.description`, when present, MUST be a string.
- `validateWorkflowIR(ir)` MUST diagnose unknown fields, malformed agent definitions, malformed node runs, invalid expressions/templates/schemas, missing required composite branches/defaults, and malformed task execution targets. It MUST NOT enforce TypeScript-owned task/composite business output shape through generated schemas.
- `validateWorkflowIR(ir)` MUST diagnose scope-illegal refs with stable code `IR003`.
- Node pre-execution fields MUST reference only workflow input/meta, visible local refs such as the current fanout or loop context, ancestor scope nodes, and previous sibling nodes in the same scope. They MUST NOT reference the current node output or later sibling node outputs.
- Scope outputs MAY reference ancestor scope nodes and any node declared in that scope, but parent scopes and sibling branches/cases MUST NOT reference child-scope internal nodes.
- `fanout.<id>.item` and `fanout.<id>.itemIndex` refs MUST be valid only in that fanout body and nested descendants.
- `loop.<id>.index`, `loop.<id>.round`, and `loop.<id>.state` refs MUST be valid only in that loop body and nested descendants.
- Agent, Task, and Signal `timeout`, Task `execution.defaultCommandTimeout`, Agent `retry.max`, Parallel/Fanout `maxConcurrency`, Fanout quorum `count`, prompts, session keys, assert/signal messages, conditions, fanout `over`, loop state, task input/cwd/env, and other runtime values MUST be stored as `ExprIR`.
- Literal duration expressions MUST contain strings matching `^\d+(ms|s|m|h)?$`; omitted units MUST mean milliseconds. Literal quorum/concurrency values MUST be positive integers, and literal retry max values MUST be non-negative integers.
- `WorkflowIR` MUST NOT expose a `DurationIR` alias that hides the common `ExprIR` representation.
- Workflow authoring config MUST NOT expose an unconsumed `defaults.timeout` field.
- Task runs MUST contain a closed `target` descriptor that is either an inline source target or a reusable module target.
- Inline task targets MUST contain `{ kind: "inline", runtime: "node", source }`, where `source` is the self-contained `exec` function source.
- Reusable task targets MUST contain `{ kind: "module", runtime: "node", specifier, exportName, referrer }`, where `specifier` is the source-level module specifier, `exportName` selects the exported task token, and `referrer` identifies the workflow source file used as the resolution parent.
- Runtime-admissible reusable task targets MUST be completed by `@acpus/workflow-compiler`; incomplete in-memory core reusable descriptors MUST fail `validateWorkflowIR(...)`.
- Reusable task `exportName` MUST be `"default"` for default imports, the original exported binding name for named imports even when locally aliased, and the exported workflow-module binding name for same-file task exports.
- Reusable task target referrers MUST use the closed shape `{ kind: "workflow", path: string }`.
- Reusable task target referrer paths MUST be workspace-relative workflow paths, not absolute filesystem paths or paths that escape the workspace.
- Task invocation fields such as `input`, `cwd`, `env`, and `execution` MUST belong to `TaskRunIR`, not the task node top level.

## Verification

- Tests MUST cover root and subpath public exports.
- Tests MUST prove root and schema entrypoints expose the native Zod `z` object and support `z.infer` type authoring.
- Tests MUST cover schema lowering acceptance and rejection for graph-boundary schemas.
- Tests MUST cover authoring type contracts for workflow input, agents, outputs, composites, fanout, loop, and boolean conditions.
- Tests MUST cover `compileWorkflowDefinition(...)` lowering authoring graphs to valid `WorkflowIR`.
- Tests MUST cover `validateWorkflowIR(...)` diagnostics for closed IR shapes, malformed agents, malformed nodes, malformed task execution targets, and composite output requirements.
