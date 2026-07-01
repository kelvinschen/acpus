# Core Spec

## Purpose

`@acpus/core` is the TypeScript-first workflow authoring and IR construction package for Acpus. It provides the workflow DSL, schema bridge, node authoring shapes, serializable `WorkflowIR` types, and structural IR validation. Expression and template authoring belongs to `@acpus/expression`. Core compiles in-memory workflow definitions with `compileWorkflowDefinition`; TypeScript module loading, workflow static checks, task analysis, and task bundling belong to `@acpus/workflow-compiler`.

## Requirements

### Public API

- The root `@acpus/core` entrypoint MUST expose the minimal workflow authoring surface: `defineWorkflow`, `z`, `s`, `task`, and `secret`.
- `@acpus/core/workflow` MUST expose `defineWorkflow`, `compileWorkflowDefinition`, and `isWorkflowDefinition`.
- `@acpus/core/schema` MUST expose schema authoring, parsing, validation, and lowering helpers, including `z`, `s`, `isSchema`, `parseSchema`, `safeParseSchema`, `validateValue`, `toSchemaIR`, `toJSONSchema`, `schemaToJsonSchema`, and `assertBoundarySchema`.
- `@acpus/core/runtime` MUST expose the task command wrapper factory `createDollar`, secret tokens, and related task runtime types.
- `@acpus/core/ir` MUST expose `validateWorkflowIR` and public IR types.
- The core package MUST NOT expose a binary; command behavior belongs to the `acpus` CLI package.

### Workflow Authoring

- The core MUST expose `defineWorkflow(...).build(...)` as the workflow entry point, where `build` receives `{ input, agents, meta, step }`.
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

- The core MUST re-export Zod 4 as `z` and MUST add Acpus extensions `z.path()`, `z.artifact(mediaType?)`, `z.secretRef()`, and `z.integer()`.
- Graph-boundary schemas MUST be canonicalized to serializable `SchemaIR` via `toSchemaIR(schema)`.
- The graph-boundary schema subset MUST include string, number, integer, boolean, null, unknown, literal, enum, array, object, record, union, optional, nullable, default, path, artifact, and secretRef schemas.
- Integer schema extensions MUST lower to expression-compatible `SchemaIR` with `kind: "number"`.
- Graph-boundary schema lowering MUST reject runtime-only or non-serializable schema constructs such as transform, custom, function, promise, map, set, date, bigint, symbol, undefined, void, and never.
- `SchemaIR` MUST be a core-owned recursive schema union. It MUST NOT reuse expression `TypeIR` for core-only variants such as `path`, `artifact`, `secretRef`, `literal`, `enum`, or schema metadata.
- `validateWorkflowIR(ir)` MUST validate `SchemaIR` as a closed recursive union, reject unknown schema kinds and fields, and reject hand-authored `kind: "integer"` in favor of `kind: "number"`.

### Expression, Templates, And Helpers

- Core authoring APIs MUST accept workflow values and expression/template tokens produced by `@acpus/expression`.
- Plain string prompts/messages MUST lower to `TemplateIR` with one text part.
- Template interpolation MUST preserve expressions in `TemplateIR`; rendering policy belongs to runtime consumers.

### Nodes

- Schema contract fields MUST use the `Schema` suffix: `inputSchema`, `outputSchema`, and `itemOutputSchema`.
- Runtime bindings and accessors MUST continue to use `input` and `output`; scopes MUST declare their `output` by returning a plain object, not by calling an output helper.
- Executable nodes MUST use `run` as the execution boundary and top-level `outputSchema` as the downstream contract boundary.
- Node ids MUST be bound through `step("id")`; node kind methods MUST receive only the kind-specific spec.
- Agent nodes MUST use `step("id").agent({ outputSchema?, run: { agent: agents.<key>, prompt, permissionMode?, session?, cwd?, env? }, timeout?, retry? })`.
- Agent definitions MAY declare `permissionMode?: "approve-reads" | "approve-all" | "deny-all"` and `agentMode?: string`.
- Agent definitions MUST NOT accept broad `options` fields.
- Signal nodes MUST use `step("id").signal({ outputSchema, run: { prompt }, timeout?, onTimeout? })`.
- Signal `onTimeout`, when present, MUST use `{ action: "fail", message? }`.
- Task nodes MUST use `run.input` as the explicit expression-to-runtime-value boundary.
- Inline Task nodes MUST use `step("id").task({ outputSchema, run: { input, exec, cwd?, env?, execution? }, timeout? })`.
- Reusable Task nodes MUST use `step("id").task({ run: { task, input, cwd?, env?, execution? }, timeout? })` and MUST take their output schema from the reusable Task token.
- Agent and Signal node graph dependencies MUST be expressed by refs inside `run.prompt`, `run.cwd`, `run.env`, and `run.session`.
- Agent and Task `cwd` MUST be a string workflow value.
- Agent and Task `env` values MUST be string workflow values or `secret(...)` tokens.
- Assert nodes MUST use `step("id").assert({ condition, message? })`.
- Assert nodes MUST serialize only `condition` and optional `message`, and MUST produce no output.
- Composite nodes MUST include `step("id").if`, `switch`, `parallel`, `fanout`, and `loop`, each producing child-scope IR.
- Composite callbacks MUST receive a `ScopeContext` containing `{ step }`.
- Parent scopes MUST access a composite node only through that node's projected `output`.
- Composite callbacks for nodes that declare an `outputSchema` MUST type-check the returned output object's field types and required fields against that schema; output fields outside the schema MUST be rejected at IR build time (see IR And Validation), because callback return values do not receive compile-time excess-property checks.
- Composite callbacks MUST declare their scope output by returning a plain object whose fields satisfy the scope's `outputSchema`.
- Array output accessors MUST support numeric index access through `@acpus/expression` accessors and helpers.
- If nodes MUST use `step("id").if({ condition, outputSchema?, then, else? })`.
- Switch nodes MUST use `default` for fallback authoring.
- Parallel nodes MUST express static named branch concurrency and support `strategy?: "all" | "race"`, defaulting to `"all"`.
- Fanout nodes MUST express runtime array expansion and support `strategy?: "all" | "quorum"`, defaulting to `"all"`.
- Fanout `itemOutputSchema` MUST represent the per-item output contract and serialize as `FanoutNodeIR.itemOutputSchema`.
- Loop bodies MUST receive `iter` and `previous`; `previous` MUST be typed as possibly `undefined`.
- Loop `stopWhen({ iter, result })` MUST return a boolean workflow value and lower to `LoopNodeIR.stopWhen`.
- Required output fields MUST NOT accept nullable or optional refs unless the author explicitly removes the nullish case, for example with `coalesce(...)`.

### Task Authoring And Runtime Context Types

- A reusable Task MUST be authored via `task.define({ inputSchema, outputSchema, exec })`.
- A reusable Task node MUST use the Task's declared `outputSchema` and MUST NOT repeat `outputSchema` at the call site.
- A reusable Task definition's `inputSchema` MUST be the runtime input schema for its `exec` function; a reusable Task node call site's `run.input` MUST be the graph expression binding for that schema.
- Task node lifecycle options MAY support top-level `timeout`.
- Task node lifecycle options MUST NOT support workflow-level automatic `retry`.
- Agent node `retry`, when present, MUST contain only `max?: number` and MUST
  require `outputSchema`.
- Task invocation options MAY support `run.cwd`, `run.env`, and `run.execution`.
- Task code MUST receive a context containing only `input`, `$`, `artifact`, `env`, and `abortSignal`.
- Task code MUST receive an Acpus-owned `$` wrapper backed by `zx/core`.
- The wrapper MUST support `` $`cmd` ``, `$({ cwd, env, timeout, nothrow, allowExitCode })`, `.allowExitCode([...])`, `.nothrow()`, `.timeout("10m")`, `.json<T>()`, `.text()`, and `.lines()`.
- Programmatic arguments MUST use zx array interpolation.

### IR And Validation

- `compileWorkflowDefinition(definition)` MUST lower an in-memory workflow definition to serializable `WorkflowIR` with `irVersion: 2`.
- `WorkflowIR`, node IR, scope IR, schema IR, template IR, expression IR, agent definitions, task runs, and task bundles MUST use closed serialized object shapes.
- `validateWorkflowIR(ir)` MUST diagnose unknown fields, malformed agent definitions, malformed node runs, invalid expressions/templates/schemas, missing composite outputs, scope output fields outside a node's declared `outputSchema`, missing task bundles, and task run digest mismatches.
- `WorkflowIR.assets.taskBundles` MUST contain task bundle metadata emitted by core authoring; production bundling belongs to `@acpus/workflow-compiler`.
- Task invocation fields such as `input`, `cwd`, `env`, and `execution` MUST belong to `TaskRunIR`, not the task node top level.

## Verification

- Tests MUST cover root and subpath public exports.
- Tests MUST cover schema lowering acceptance and rejection for graph-boundary schemas.
- Tests MUST cover authoring type contracts for workflow input, agents, outputs, composites, fanout, loop, and boolean conditions.
- Tests MUST cover `compileWorkflowDefinition(...)` lowering authoring graphs to valid `WorkflowIR`.
- Tests MUST cover `validateWorkflowIR(...)` diagnostics for closed IR shapes, malformed agents, malformed nodes, missing task bundles, digest mismatches, and composite output requirements.
