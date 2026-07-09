# Core Spec

## Purpose

`@acpus/core` is the TypeScript-first workflow authoring and IR construction package for Acpus. It provides the workflow DSL, schema bridge, node authoring shapes, serializable `WorkflowIR` types, and structural IR validation. Expression and template authoring belongs to `@acpus/expression`. Core compiles in-memory workflow definitions with `compileWorkflowDefinition`; TypeScript module loading, workflow static checks, task callsite analysis, and reusable task reference preparation belong to `@acpus/workflow-compiler`.

## Requirements

### Public API

- The root `@acpus/core` entrypoint MUST expose the minimal workflow authoring surface: `defineWorkflow`, `z`, `s`, `task`, and `secret`.
- `@acpus/core/workflow` MUST expose `defineWorkflow`, `compileWorkflowDefinition`, and `isWorkflowDefinition`.
- `@acpus/core/schema` MUST expose schema authoring, parsing, validation, and lowering helpers, including `z`, `s`, `isSchema`, `parseSchema`, `safeParseSchema`, `validateValue`, `toSchemaIR`, `tryToSchemaIR`, `toJSONSchema`, `schemaToJsonSchema`, and `assertBoundarySchema`.
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

- The core MUST re-export Zod 4 as `z` and MUST add the Acpus boundary extension `z.path()`.
- Graph-boundary schemas MUST be canonicalized to serializable `SchemaIR` via `toSchemaIR(schema)`.
- `tryToSchemaIR(schema)` MUST return a neverthrow `Result<SchemaIR, SchemaLoweringError>` for recoverable schema lowering failures.
- `SchemaLoweringError` MUST be a serializable tagged union that includes unsupported schema, invalid literal, and invalid default failures with stable path fields.
- `toSchemaIR(schema)` MAY remain a throwing compatibility adapter over `tryToSchemaIR(schema)` for authoring APIs that still expect exceptions.
- The graph-boundary schema subset MUST include string, number, boolean, null, unknown, literal, enum, array, object, record, union, optional, nullable, default, and path schemas.
- The core schema authoring surface MUST NOT provide `z.integer()`, `z.artifact()`, or `z.secretRef()`.
- Graph-boundary schema lowering MUST reject runtime-only or non-serializable schema constructs such as transform, custom, function, promise, map, set, date, bigint, symbol, undefined, void, and never.
- `SchemaIR` MUST be a core-owned recursive schema union. It MUST NOT reuse expression `TypeIR` for core-only variants such as `path`, `literal`, `enum`, or schema metadata.
- `validateWorkflowIR(ir)` MUST validate `SchemaIR` as a closed recursive union, reject unknown schema kinds and fields, and reject hand-authored `kind: "integer"` in favor of `kind: "number"`.

### Expression, Templates, And Helpers

- Core authoring APIs MUST accept workflow values and expression/template tokens produced by `@acpus/expression`.
- Plain string prompts/messages MUST lower to `TemplateIR` with one text part.
- Template interpolation MUST preserve expressions in `TemplateIR`; rendering policy belongs to runtime consumers.

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
- Agent and Task `cwd` MUST be a string workflow value.
- Agent and Task `env` values MUST be string workflow values or `secret(...)` tokens.
- Assert nodes MUST use `step("id").assert({ condition, message? })`.
- Assert nodes MUST serialize only `condition` and optional `message`, and MUST produce no output.
- Composite nodes MUST include `step("id").if`, `switch`, `parallel`, `fanout`, and `loop`, each producing child-scope IR.
- Composite callbacks MUST receive only node-specific local values: fanout callbacks receive `item` and `itemIndex`; loop body callbacks receive `iter` and `previous`; loop stop callbacks receive `iter` and `result`.
- `step` MUST be a single per-compilation active-scope dispatcher provided by the workflow `build` callback: `step("id")` declares into whichever workflow or composite declaration callback is currently executing.
- Workflow and composite graph declaration callbacks MUST be synchronous. Calling `step()` after graph declaration has closed MUST fail with a clear authoring invariant error.
- Node ids MUST remain unique across the entire workflow IR, including nested composite scopes.
- Parent scopes MUST access a composite node only through that node's projected `output`.
- Composite callbacks MUST declare their scope output by returning a plain object. TypeScript-owned composite outputs MUST be inferred from callback returns and MUST NOT declare author-facing `outputSchema`.
- Array output accessors MUST support numeric index access through `@acpus/expression` accessors and helpers.
- If nodes MUST use `step("id").if({ condition, then, else })`.
- Switch nodes MUST use `default` for fallback authoring, and default MUST be declared.
- Parallel nodes MUST express static named branch concurrency with named branch declaration methods and support `strategy?: "all" | "race"`, defaulting to `"all"`.
- Fanout nodes MUST express runtime array expansion and support `strategy?: "all" | "quorum"`, defaulting to `"all"`.
- Fanout item output MUST be inferred from the `do` callback and serialize no `itemOutputSchema`.
- Loop nodes MUST declare `initial`; loop bodies MUST receive `iter` and non-optional `previous`.
- Loop `maxIterations` MUST accept a workflow number value and lower to `LoopNodeIR.maxIterations`.
- Loop `stopWhen({ iter, result })`, when present, MUST return a boolean workflow value and lower to `LoopNodeIR.stopWhen`; omitted `stopWhen` MUST lower to a literal false expression.
- Required output fields MUST NOT accept nullable or optional refs unless the author explicitly removes the nullish case, for example with `coalesce(...)`.

### Task Authoring And Runtime Context Types

- A reusable Task MUST be authored via `task.define({ inputSchema, exec })`.
- A reusable Task node MUST infer output from the reusable Task's `exec` return type and MUST NOT repeat `outputSchema` at the call site.
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
- `WorkflowIR`, node IR, scope IR, schema IR, template IR, expression IR, agent definitions, task runs, and task execution targets MUST use closed serialized object shapes.
- `WorkflowIR.description`, when present, MUST be a string.
- `validateWorkflowIR(ir)` MUST diagnose unknown fields, malformed agent definitions, malformed node runs, invalid expressions/templates/schemas, missing required composite branches/defaults, and malformed task execution targets. It MUST NOT enforce TypeScript-owned task/composite business output shape through generated schemas.
- `validateWorkflowIR(ir)` MUST diagnose scope-illegal refs with stable code `IR003`.
- Node pre-execution fields MUST reference only workflow input/meta, visible local refs such as the current fanout or loop context, ancestor scope nodes, and previous sibling nodes in the same scope. They MUST NOT reference the current node output or later sibling node outputs.
- Scope outputs MAY reference ancestor scope nodes and any node declared in that scope, but parent scopes and sibling branches/cases MUST NOT reference child-scope internal nodes.
- `fanout.<id>.item` and `fanout.<id>.itemIndex` refs MUST be valid only in that fanout key/body and nested descendants.
- `loop.<id>.iter`, `loop.<id>.previous`, and `loop.<id>.result` refs MUST be valid only in that loop body/stop condition and nested descendants.
- `DurationIR` fields MUST be duration strings matching `^\d+(ms|s|m|h)?$`; omitted units MUST mean milliseconds.
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
- Tests MUST cover schema lowering acceptance and rejection for graph-boundary schemas.
- Tests MUST cover authoring type contracts for workflow input, agents, outputs, composites, fanout, loop, and boolean conditions.
- Tests MUST cover `compileWorkflowDefinition(...)` lowering authoring graphs to valid `WorkflowIR`.
- Tests MUST cover `validateWorkflowIR(...)` diagnostics for closed IR shapes, malformed agents, malformed nodes, malformed task execution targets, and composite output requirements.
