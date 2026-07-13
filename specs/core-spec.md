# Core Spec

## Purpose

`@acpus/core` is the TypeScript-first workflow authoring and IR construction package for Acpus. It provides the workflow DSL, schema bridge, node authoring shapes, serializable `WorkflowIR` types, and structural IR validation. Expression and template authoring belongs to `@acpus/expression`. Core compiles in-memory workflow definitions with `compileWorkflowDefinition`; TypeScript module loading, workflow static checks, task callsite analysis, and reusable task reference preparation belong to `@acpus/workflow-compiler`.

## Requirements

### Public API

- The root `@acpus/core` entrypoint MUST expose the minimal workflow authoring surface: `defineWorkflow`, `z`, and `task`.
- The root and workflow entrypoints MUST NOT expose standalone `OutputValue` or `OutputValues` authoring types; output constraints MUST remain behind workflow and node interfaces.
- `@acpus/core/workflow` MUST expose `defineWorkflow`, `compileWorkflowDefinition`, and `isWorkflowDefinition`.
- `@acpus/core/schema` MUST expose the native `z` authoring object, `toSchemaIR`, `tryToSchemaIR`, and `schemaToJsonSchema`.
- `@acpus/core/runtime` MUST expose the task command wrapper factory `createDollar` and related task runtime types.
- `@acpus/core/ir` MUST expose `validateWorkflowIR`, `tryParseDurationMs`, `childScopes`, `walkNodes`, `DurationParseError`, and public IR and traversal types.
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
- Named and custom command agent definitions MAY declare `trace?: boolean`.
  `trace` MUST be accepted only on the top-level Agent definition, MUST default
  to disabled when absent or false, and MUST NOT be accepted on Agent nodes.
- The `build` context `agents` member MUST expose one typed token for each key declared in workflow top-level `agents`.
- Agent node authoring field `agent` MUST use an agent token from the `build` context `agents` member.
- When authors extract an `agents` object before passing it to `defineWorkflow(...)`, they SHOULD preserve literal keys, for example with `satisfies AgentMap`.

### Schema Layer

- The core MUST directly re-export Zod 4's native `z` object without Acpus extensions, preserving standard type members such as `z.infer` and `z.output`.
- Graph-boundary schemas MUST be canonicalized to serializable `SchemaIR` via `toSchemaIR(schema)`.
- `tryToSchemaIR(schema)` MUST return a neverthrow `Result<SchemaIR, SchemaLoweringError>` for recoverable schema lowering failures.
- `SchemaLoweringError` MUST be a serializable tagged union that includes unsupported schema, invalid literal, and invalid default failures with stable path fields.
- `toSchemaIR(schema)` MUST return the lowered `SchemaIR` from
  `tryToSchemaIR(schema)` or throw an `Error` carrying the lowering failure
  message.
- The graph-boundary schema subset MUST include string, number, boolean, null, unknown, literal, enum, array, object, record, union, optional, nullable, and default schemas.
- The core MUST expose the native Zod schema constructor surface without Acpus-specific constructors.
- Graph-boundary schema lowering MUST reject runtime-only or non-serializable schema constructs such as transform, custom, function, promise, map, set, date, bigint, symbol, undefined, void, and never.
- `SchemaIR` MUST be a core-owned recursive schema union rather than duplicating or overloading the expression value model.
- `validateWorkflowIR(ir)` MUST validate `SchemaIR` as a closed recursive union, reject unknown schema kinds and fields, and reject hand-authored `kind: "integer"` in favor of `kind: "number"`.

### Resolvable Values, Templates, And Helpers

- Plain `T` in an authoring type MUST mean declaration-time structure. `Resolvable<T>` MUST mean a value evaluated from durable workflow scope at run time.
- Core MUST use `Resolvable<T>` from `@acpus/expression` as the sole public runtime-value seam and MUST NOT define duplicate value-or-expression or template-input types.
- Every `Resolvable` field, including literal input, MUST lower through `valueToExprIR` to `ExprIR`. Template tokens MUST be stored only as `ExprIR.kind: "template"`; node fields MUST NOT store `TemplateIR` directly.
- Workflow, composite-scope, and Task-input authored bindings MUST reject raw `undefined` at every nesting level instead of omitting it during lowering. Runtime Task outputs remain governed by runtime output normalization.
- Template interpolation MUST preserve expressions inside the template `ExprIR`; rendering policy belongs to runtime consumers.

### Nodes

- Schema-valued authoring fields MUST use the `Schema` suffix. Workflow `inputSchema` and Agent/Signal `outputSchema` are runtime schema boundaries; reusable Task `inputSchema` is a config-time TypeScript type witness.
- Runtime bindings and accessors MUST continue to use `input` and `output`; scopes MUST declare their single `output` by returning a durable workflow value, not by calling an output helper.
- Agent, Task, and Signal authoring specs MUST use flat kind-specific objects. Lowering MUST group their execution fields under the frozen node's `run` field. TypeScript-owned task outputs MUST be inferred from `exec`; they MUST NOT declare author-facing `outputSchema`.
- Node ids MUST be bound through `step("id")`; node kind methods MUST receive only the kind-specific spec.
- Agent nodes MUST use `step("id").agent({ agent: agents.<key>, prompt, permissionMode?, sessionKey?, cwd?, env?, outputSchema?, timeout? })`.
- Agent definitions MAY declare `permissionMode?: "approve-reads" | "approve-all" | "deny-all"`, `agentMode?: string`, and `trace?: boolean`.
- Signal nodes MUST use `step("id").signal({ prompt, outputSchema?, timeout?, onTimeout? })`. Schema-less signals expose raw `Expr<string>` output; schema-backed signals expose parsed structured output.
- Signal `onTimeout`, when present, MUST use `{ message? }`.
- Signal `onTimeout` MUST NOT be present unless `timeout` is present.
- Task nodes MUST use the top-level authoring field `input` as the explicit expression-to-runtime-value boundary.
- Inline Task nodes MUST use `step("id").task({ input, exec, cwd?, env?, execution?, timeout? })`; output is inferred from `Awaited<ReturnType<exec>>`.
- Reusable Task nodes MUST use `step("id").task({ task, input, cwd?, env?, execution?, timeout? })`; output is inferred from the reusable Task token's `exec`.
- Agent node graph dependencies MUST be expressed by refs inside the authored `prompt`, `cwd`, `env`, and `sessionKey` fields.
- Signal node graph dependencies MUST be expressed by refs inside the authored `prompt` field.
- Agent and Task node authoring field `cwd` MUST be `Resolvable<string>`.
- Agent and Task node authoring field `env` values MUST be `Resolvable<string>`.
- Top-level Agent definition `cwd` and `env` MUST remain declaration-time plain strings and MUST remain plain values in `WorkflowIR`.
- Assert nodes MUST use `step("id").assert({ condition, message? })`.
- Assert nodes MUST serialize only `condition` and optional `message`, and MUST produce no output.
- Composite nodes MUST include `step("id").if`, `switch`, `parallel`, `fanout`, and `loop`, each producing child-scope IR.
- Composite callbacks MUST receive only node-specific local values: fanout callbacks receive `item` and `itemIndex`; loop body callbacks receive `index`, `round`, and `state`.
- `step` MUST be a single per-compilation active-scope dispatcher provided by the workflow `build` callback: `step("id")` declares into whichever workflow or composite declaration callback is currently executing.
- Workflow and composite graph declaration callbacks MUST be synchronous. Calling `step()` after graph declaration has closed MUST fail with a clear authoring invariant error.
- Node ids MUST remain unique across the entire workflow IR, including nested composite scopes.
- Parent scopes MUST access a composite node only through that node's projected `output`.
- Workflow and composite callbacks MUST declare one durable output value. They MUST accept primitives, `null`, arrays, plain objects, `ArtifactRef`, and `Expr` values whose resolved type is durable workflow data.
- A node's result MUST be read through exactly one `.output`; `NodeRef` itself is a control handle and MUST be rejected both as a direct scope return and when nested at any depth. A direct `Expr` such as `task.output` MUST remain valid.
- TypeScript-owned composite outputs MUST be inferred from callback returns and MUST NOT declare author-facing `outputSchema`.
- Workflow root and composite callback return types MUST use a position-sensitive recursive TypeScript constraint that accepts durable primitives, arrays, plain object shapes, `JsonValue`, `ArtifactRef`, graph `Expr` values, and unions while rejecting raw `undefined`, `unknown`, functions, promises, dates, maps, sets, symbols, bigint, and array-element `undefined`. Task outputs MAY contain object-property `undefined` and MAY return top-level `undefined`.
- A scope output MUST NOT be raw `undefined` or an `Expr<T | undefined>` at the top level. An object field MAY be an `Expr<T | undefined>` and MUST remain optional to downstream projection; an array element MUST NOT be raw `undefined` or an `Expr<T | undefined>`.
- Workflow, composite, loop-state, and Task output seams MUST reduce `any`, including `any` inherited from imported helpers, to `never`; they MUST NOT provide a usable author-facing `any` escape hatch.
- The recursive output constraint MUST preserve exact inferred output types and MUST remain an internal type implementation detail rather than a required author import.
- Ordinary authored literals MUST follow TypeScript widening. Authors MUST use `as const` or an explicit literal union when a narrow literal result is required.
- Array output accessors MAY be combined through the `@acpus/expression` `lift` callback helper; no array-specific expression helper is required.
- If nodes MUST use `step("id").if({ condition, then, else })` and MUST infer the union of `then` and `else` outputs.
- Switch nodes MUST use `default` for fallback authoring, and default MUST be declared.
- Switch and parallel race outputs MUST preserve heterogeneous branch unions. Accessors over a union MUST expose only fields TypeScript can prove are present.
- If and switch results MUST permit direct projection only of fields common to every possible branch. Authors MUST use `lift` to narrow a branch union before reading branch-specific fields.
- Parallel nodes MUST express static named branches and support declaration-time `strategy?: "all" | "race"`, defaulting to `"all"`, plus runtime `maxConcurrency?: Resolvable<number | undefined>`.
- Parallel `all` output MUST remain a record keyed by branch name; parallel `race` output MUST remain `{ winner, result }`; fanout output MUST remain the accepted item-output array; loop output MUST remain the final state.
- Fanout nodes MUST express runtime array expansion through `over: Resolvable<readonly Item[]>`, support declaration-time `strategy?: "all" | "quorum"`, and accept runtime `count: Resolvable<number>` for quorum and `maxConcurrency?: Resolvable<number | undefined>`.
- Fanout item output MUST be inferred from the `do` callback and serialize no `itemOutputSchema`.
- Loop nodes MUST declare `state`; loop bodies MUST receive `index`, `round`, and non-optional `state`.
- Loop bodies MUST return a transition object `{ state, stop }`; transition `state` MUST converge with the declared initial `state`.
- Loop `stop` MUST accept a boolean workflow value and lower under the `stop` field of `LoopNodeIR.do.output`; `loop.output` MUST expose the final transition `state`.
- Loop transition shape, stop type, and state convergence MUST be enforced by the public TypeScript interface rather than compiler AST rules.
- Control-only scopes MUST return `{}` explicitly. `null` MUST mean an explicit null output and MUST NOT represent an implicit no-output state.

### Task Authoring And Runtime Context Types

- A reusable Task MUST be authored via `task.define({ inputSchema, exec })`.
- A reusable Task node MUST infer output from the reusable Task's `exec` return type and MUST NOT repeat `outputSchema` at the call site.
- A reusable Task definition's `inputSchema` MUST infer the TypeScript input type of its `exec` function and call sites. It MUST NOT be retained on the executable Task token or promise runtime parsing, defaults, or transforms.
- A reusable Task node call site's top-level `input` MUST be the graph expression binding checked against that inferred input type.
- Inline and reusable Task return types MUST use the recursive durable output constraint. A Task MAY return top-level `undefined` to represent no output, but arrays MUST NOT contain `undefined` entries.
- Task node lifecycle options MAY support top-level `timeout`.
- Task invocation options MAY support top-level `cwd`, `env`, and `execution.defaultCommandTimeout`.
- Task code MUST receive a context containing only `input`, `$`, `artifact`, `env`, and `abortSignal`.
- Task context `artifact` MUST expose only `write(name, content, options?)` and synchronous `path(ref)` operations. It MUST NOT expose format-specific write helpers or file-read helpers.
- `artifact.write(...)` MUST accept `string | Uint8Array`, return `Promise<ArtifactRef>`, encode strings as UTF-8 with default media type `text/plain`, and write byte arrays verbatim without inferring a media type.
- `artifact.path(ref)` MUST return an absolute filesystem path synchronously.
- Task context `env` MUST use `Record<string, string | undefined>` and MUST expose the Task process's live `process.env` object.
- Task code MUST receive an Acpus-owned `$` wrapper backed by `zx/core`.
- Without an explicit per-call cwd or env override, the `$` wrapper MUST read the live process cwd and environment when each command starts rather than capturing them when the wrapper is created.
- The wrapper MUST support `` $`cmd` ``, `$({ cwd, env, timeout, nothrow, allowExitCode })`, `.allowExitCode([...])`, `.nothrow()`, `.timeout("10m")`, `.json<T>()`, `.text()`, and `.lines()`.
- Programmatic arguments MUST use zx array interpolation.

### IR And Validation

- `compileWorkflowDefinition(definition)` MUST lower an in-memory workflow definition to serializable `WorkflowIR` with `irVersion: 5`.
- If an internal caller bypasses the public TypeScript interface, workflow and composite outputs containing a `NodeRef` or a non-durable value MUST fail as lowering invariants rather than being interpreted as empty or positional bindings.
- Repeated compilation of the same in-memory workflow definition MUST produce identical `WorkflowIR` values.
- `WorkflowIR` MUST contain only `irVersion`, `name`, optional `description`, optional `inputSchema`, `agents`, `root`, and `diagnostics`.
- Every executable `ScopeIR`, including `WorkflowIR.root`, MUST contain exactly `nodes: NodeIR[]` and one required `output: ExprIR`. Scope outputs MUST lower as one expression and MUST NOT use a named-output map or a top-level workflow `outputs` field.
- `LoopNodeIR.do.output` MUST be an object expression containing exactly the authored `state` and `stop` fields.
- `WorkflowIR`, node IR, scope IR, schema IR, template IR, expression IR, agent definitions, task runs, and task execution targets MUST use closed serialized object shapes.
- `AgentDefinitionIR` MUST retain optional boolean `trace` in IR version 5.
  Agent node and Agent run IR MUST remain closed shapes without a `trace` field.
- `childScopes(node)` MUST return every direct child scope of a composite node and no child scopes for leaf nodes. If branches MUST be ordered `then` before `else`; switch cases MUST retain their authored index order before `default`; parallel branches MUST retain their authored key order; fanout and loop bodies MUST each expose their body scope.
- `walkNodes(scope)` MUST traverse nodes in depth-first pre-order, preserve authored node and branch order, and report child-scope ancestry from outermost to innermost.
- Structural traversal MUST exhaust the closed `NodeIR` union so adding a node kind requires traversal handling at compile time.
- `WorkflowIR.description`, when present, MUST be a string.
- `validateWorkflowIR(ir)` MUST require IR version 5 and diagnose unknown fields, malformed agent definitions, malformed node runs, missing or invalid scope output expressions, invalid expressions/templates/schemas, missing required composite branches/defaults, invalid loop transition output, and malformed task execution targets. It MUST NOT enforce TypeScript-owned task/composite business output shape through generated schemas.
- `validateWorkflowIR(ir)` MUST be the sole owner of `ID001` node-id diagnostics. Each invalid id MUST produce one error containing the accepted `/^[A-Za-z_][A-Za-z0-9_-]*$/` pattern, the node IR path, and a hint to use a compile-time literal id.
- Node builders MUST NOT emit `ID001`. `compileWorkflowDefinition(definition, { validate: false })` MUST intentionally skip node-id validation; the default compilation path MUST append validator diagnostics once.
- `validateWorkflowIR(ir)` MUST diagnose scope-illegal refs with stable code `IR003`.
- Node pre-execution fields MUST reference only workflow input/meta, visible local refs such as the current fanout or loop context, ancestor scope nodes, and previous sibling nodes in the same scope. They MUST NOT reference the current node output or later sibling node outputs.
- Scope outputs MAY reference ancestor scope nodes and any node declared in that scope, but parent scopes and sibling branches/cases MUST NOT reference child-scope internal nodes.
- `fanout.<id>.item` and `fanout.<id>.itemIndex` refs MUST be valid only in that fanout body and nested descendants.
- `loop.<id>.index`, `loop.<id>.round`, and `loop.<id>.state` refs MUST be valid only in that loop body and nested descendants.
- Agent, Task, and Signal `timeout`, Task `execution.defaultCommandTimeout`, Parallel/Fanout `maxConcurrency`, Fanout quorum `count`, prompts, session keys, assert/signal messages, conditions, fanout `over`, loop state, task input/cwd/env, and other runtime values MUST be stored as `ExprIR`.
- Literal duration expressions MUST contain strings matching `^\d+(ms|s|m|h)?$`; omitted units MUST mean milliseconds and zero MUST be accepted.
- `DurationParseError` MUST be `{ type: "invalid-duration-syntax"; value: string } | { type: "duration-out-of-range"; value: string }`; both variants MUST preserve the original input in `value`.
- `tryParseDurationMs(value)` MUST return the resolved integer milliseconds in a `Result`; invalid syntax MUST return `invalid-duration-syntax`, and any non-finite or non-safe-integer resolved value MUST return `duration-out-of-range`.
- Literal quorum counts MUST be positive integers. Literal concurrency limits MUST be positive integers or zero, where zero means no authored local concurrency cap.
- `@acpus/core/ir` MUST expose the shared positive-integer predicate used by frozen-IR validation and runtime resource resolution.
- Agent, Task, and Signal runs MUST serialize only their meaningful execution fields and MUST NOT contain singleton run-kind tags.
- Task runs MUST contain a closed `target` descriptor that is either an inline source target or a reusable module target.
- Inline task targets MUST contain `{ kind: "inline", source }`, where `source` is the self-contained `exec` function source.
- Reusable task targets MUST contain `{ kind: "module", specifier, exportName, referrer }`, where `specifier` is the source-level module specifier, `exportName` selects the exported task token, and `referrer` identifies the workflow source file used as the resolution parent.
- Runtime-admissible reusable task targets MUST be completed by `@acpus/workflow-compiler`; incomplete in-memory core reusable descriptors MUST fail `validateWorkflowIR(...)`.
- Reusable task `exportName` MUST be `"default"` for default imports, the original exported binding name for named imports even when locally aliased, and the exported workflow-module binding name for same-file task exports.
- Reusable task target referrers MUST use the closed shape `{ path: string }`.
- Reusable task target referrer paths MUST be workspace-relative workflow paths, not absolute filesystem paths or paths that escape the workspace.
- Serialized Task invocation fields such as `input`, `cwd`, `env`, and `execution` MUST belong to `TaskRunIR`, not the serialized task node top level.
- Parallel node branch values MUST be child `ScopeIR` objects directly, without a single-field branch wrapper.

## Verification

- Tests MUST cover root and subpath public exports.
- Tests MUST prove root and schema entrypoints expose the native Zod `z` object and support `z.infer` type authoring.
- Tests MUST cover schema lowering acceptance and rejection for graph-boundary schemas.
- Tests MUST cover authoring type contracts for workflow input, agents, outputs, composites, fanout, loop, and boolean conditions.
- Tests MUST cover `compileWorkflowDefinition(...)` lowering authoring graphs to valid `WorkflowIR`.
- Tests MUST cover `validateWorkflowIR(...)` diagnostics for closed IR shapes, malformed agents, malformed nodes, malformed task execution targets, composite output requirements, and the exact single `ID001` contract with default validation and `validate: false`.
- Tests MUST cover duration parsing units, omitted units, zero, invalid syntax, out-of-range millisecond results, and validator rejection of out-of-range duration literals.
- Tests MUST cover traversal across all nine node kinds and every composite child scope, including exact depth-first pre-order, switch case-before-default order, parallel authored order, and outermost-first ancestry.
- Public API type tests MUST cover the complete `NodeChildScope` union and the `NodeVisit`, `childScopes`, and `walkNodes` signatures.
