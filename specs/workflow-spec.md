# Workflow Spec

## Purpose

Workflow Specs are YAML documents that declare local durable workflows made of Agent Steps, Program Steps, Composite Nodes, If Nodes, Guard Nodes, Signal Nodes, inputs, agents, and outputs.

## Requirements

- A Workflow Spec MUST be a YAML object.
- A Workflow Spec MUST declare `version`, `name`, and `workflow.steps`.
- `workflow.steps` MUST be an ordered list of Nodes.
- Every user-authored Node MUST declare a stable non-empty `id`.
- User-authored Node ids MUST match `^[A-Za-z_][A-Za-z0-9_-]*$`.
- User-authored Node ids MUST be unique within the Workflow Spec after includes are expanded.
- User-authored Node ids and `parallel` branch ids MUST NOT start with `$`; `$` is reserved for generated internal pipeline ids.
- User-authored Node ids and `parallel` branch ids MUST be rejected during lint/schema validation when they contain path separators, whitespace, `:`, shell/path-danger characters, or any other character outside the safe id pattern.
- A Workflow Spec MAY declare top-level `input`.
- A Workflow Spec MAY declare top-level `agents`.
- A Workflow Spec MAY declare top-level `outputs`.
- Top-level `outputs` MUST be evaluated as the Workflow Run's public output projection after the root Workflow scope completes successfully.
- A Workflow Run MUST fail when top-level `outputs` evaluation fails after Node execution completes.
- A Workflow Spec MAY declare `include` steps that are expanded at compile time.
- A started Workflow Run MUST execute a frozen IR snapshot and MUST NOT re-read mutable YAML during replay or resume.
- Agent Overrides MAY produce an effective Workflow Spec at Run or Forked Run creation by overriding top-level agent definitions before compilation.
- Agent Overrides MUST apply only to the submitted top-level Workflow Spec's top-level `agents` map and MUST NOT mutate the Workflow Spec YAML.
- Agent Overrides MUST affect a Run only through the frozen IR created from the effective Workflow Spec; they MUST NOT control an already-started Run.
- Included Agent Steps MUST continue to resolve agents from the effective top-level agent definitions. Subworkflow-scoped Agent Overrides are not supported in v1.

### Authoring Boundaries

- Workflow Specs SHOULD use Program Steps only for deterministic local glue such as preparing directories, computing stable paths, running verification commands, collecting git diffs, applying patches, or evaluating simple guard data.
- Workflow Specs SHOULD keep open-ended planning, judgment, synthesis, failure interpretation, cross-round memory, and role-specific ownership decisions in Agent Steps.
- Workflow Specs SHOULD share rich intermediate material through durable files and SHOULD expose only control values, compact counts, decisions, and durable file paths through step `output` and top-level `outputs`.
- Distributable single-file Workflow Specs MAY embed inline Program scripts when a separate helper script would make the template harder to copy or run, but embedded scripts SHOULD stay short, deterministic, and mechanically verifiable.
- Inline Program scripts SHOULD avoid login shell execution such as `bash -lc`; they SHOULD prefer inherited execution environments such as `bash -c` when shell semantics are required.

### Agent Steps

- An Agent Step MUST use `run: agent`.
- An Agent Step MUST declare `use`.
- An Agent Step MUST declare `prompt`.
- An Agent Step MUST reference an agent declared under `agents`.
- An Agent Step backed by a `builtin` or `command` agent MUST run against a local ACP-compatible agent through acpx.
- An Agent Step MAY declare `session_key` as a template string.
- When `session_key` is absent, an Agent Step MUST use a session identity derived from the Run id and resolved Node key.
- When `session_key` is present, an Agent Step MUST use a session identity derived from the Run id and rendered `session_key`, allowing explicit session sharing between materialized Agent Steps in the same Run.
- A rendered `session_key` MUST NOT be empty or blank, and distinct rendered `session_key` values MUST NOT silently alias through session-name normalization.
- `session_key` MUST NOT create cross-Run persistent memory.
- Acpus MUST NOT automatically namespace `session_key` by agent definition; Workflow authors are responsible for avoiding unwanted sharing across different agents, models, or working directories.
- When multiple concurrent Agent Steps render the same `session_key`, Acpus MUST NOT add runtime serialization in v1; ordering and conflict behavior are delegated to acpx.
- Agent Steps that share a rendered `session_key` MUST still send their own rendered `prompt`; fixed runtime continuation prompts are reserved for Agent Step pause/resume, manual retry, and parse/schema retry behavior.
- An agent declared under `agents` MAY declare `type` as one of `builtin` or `command`; `type` defaults to `builtin` when omitted.
- A `builtin` agent MUST declare `use` naming an acpx built-in adapter (e.g. `pi`, `claude`, `codex`); the runtime drives it as `acpx <use>`.
- A `command` agent MUST declare `use` as the launch command for a custom ACP server; the runtime drives it through the acpx `--agent "<use>"` escape hatch.
- For testing, use `acpus-mock-agent` as a `command` agent (e.g. `type: command, use: "acpus-mock-agent --script <path>"`), which provides deterministic script responses through the real acpx path.
- An agent MAY declare `model`, `cwd`, and `env`, which the runtime forwards to acpx.
- An agent MAY declare `policy` as one of `read` or `full`; `policy` defaults to `full` when omitted.
- An Agent Step MAY declare `policy` as one of `read` or `full`; a step-level `policy` overrides the referenced agent definition's `policy`.
- `policy: read` MUST constrain the agent to only read and search operations; individual write tool calls MUST be rejected and MAY cause the Agent Step to fail.
- `policy: full` MUST allow all operations.
- Agent Policy is orthogonal to terminal capability (whether the agent can create sub-processes via ACP `terminal/create`).
- An Agent Override `cwd` value MUST be a non-empty string.
- An Agent Step MAY declare `cwd` as a template string, which overrides the referenced agent definition's `cwd` for that step's execution.
- A step-level `cwd` MUST be evaluated against the current expression context (so it MAY reference `input.*` and prior `steps.*`) and resolved to an absolute path before being forwarded to acpx.
- When an Agent Step omits `cwd`, the runtime MUST fall back to the referenced agent definition's `cwd`, and then to the executor process working directory.
- An Agent Step `cwd` that is declared but renders empty (including the literal `cwd: ""`) MUST resolve to the executor process working directory, bypassing the agent definition's `cwd`; this is the canonical way to opt a single step out of an agent's default `cwd`.
- Agent `env` values MUST add to or override the executor process environment, and MUST be template-evaluated and stringified before being passed to acpx.
- Agent `env` MUST NOT delete inherited environment variables.
- For a `builtin` agent with `use: claude`, the runtime MUST default `ACPX_CLAUDE_INCLUDE_USER_SETTINGS` to `1`; this default MUST be overridable by the inherited process environment and by the agent's declared `env`.
- Agent Override `env` values MUST merge into the selected top-level agent's `env` by key and MUST NOT delete existing agent environment keys.
- An Agent Override MAY declare `policy` as one of `read` or `full`; policy is a whole-value replacement and MUST NOT be cleared by an Agent Override. When an Agent Override changes `type`/`use` (identity change), the agent's `policy` MUST be preserved (policy is orthogonal to agent identity, unlike `model` which is cleared).
- An Agent Step MAY omit `output` when no structured output parsing is required.
- An Agent Step MAY declare `output` using the Acpus Schema DSL defined in [Schema Spec](schema-spec.md).
- An Agent Step `output` declared with the Acpus Schema DSL MUST compile nested object and array item structure into the Agent Step output schema stored in the IR.
- An Agent Step MUST declare `output` as an object when `output` is present.
- An Agent Step with `output` present MUST produce a JSON object whose declared fields match the output schema; additional fields MUST be accepted and preserved in persisted Node output.
- An Agent Step result MUST be exposed as an envelope `{ output }` at `steps.<id>`, so the produced object is read through `steps.<id>.output`; workflow expressions MUST see only the fields declared in `output`.
- Agent response output parse failures and schema failures MUST be handled as continuation retries when retry attempts remain.
- `retry.max` MUST count extra retry attempts after the initial execution.
- An Agent Step with `output` present and no explicit `retry.max` MUST default to `retry.max: 2` for Agent response output parse and schema failures.
- `retry.max: 0` MUST disable automatic Agent response output retry.
- Agent deterministic configuration or template failures MUST NOT be treated as Agent response output parse failures and MUST NOT trigger automatic output retry.
- When retry attempts remain, Agent response output parse or schema failures MUST trigger automatic re-execution until `max` attempts are exhausted.

### Step Common Fields

- A step MAY declare `timeout` as a duration string or number (in milliseconds). Signal Nodes use `timeout` only with a paired `on_timeout`.
- Agent and Program Steps MAY declare `on_error` as one of `fail`, `retry`, or `skip`; the default is `fail`. Signal Nodes do not support `on_error`.
- Agent and Program Steps MAY declare `retry` as an object with a non-negative integer `max` (extra attempts after the initial one) and an optional `backoff` duration.

### Program Steps

- A Program Step MUST use `run: program`.
- A Program Step MUST declare `cmd`.
- A Program Step MUST run as a local subprocess on the same host.
- A Program Step `cmd` declared as a string MUST execute with shell semantics.
- A Program Step `cmd` declared as an array MUST execute without shell expansion, using the first array element as the executable and remaining elements as arguments.
- A Program Step MAY declare `env`.
- Program Step `env` values MUST add to or override the executor process environment, and MUST be template-evaluated and stringified before subprocess execution.
- Program Step `env` MUST NOT delete inherited environment variables.
- A Program Step MAY declare `cwd` as a template string, evaluated against the current expression context and resolved to an absolute path; the subprocess MUST run in that directory.
- When a Program Step omits `cwd`, the subprocess MUST run in the executor process working directory.
- A Program Step with `capture.from: file` MUST resolve a relative `capture.path` against the resolved `cwd`.
- A Program Step MAY declare `capture`.
- A Program Step MUST declare `capture` as an object when `capture` is present.
- Program Step `capture.from` MUST be `stdout` or `file`.
- Program Step `capture.parse` MUST be `json` or `text`.
- Program Step `capture.path` MUST be present when `capture.from` is `file`.
- A Program Step with `capture.from: file` MUST read `capture.path` (resolved relative to the resolved `cwd`) and parse it per `capture.parse`.
- A Program Step result MUST be exposed as an envelope `{ output, exit_code }` at `steps.<id>`.
- A Program Step MUST expose `steps.<id>.exit_code`.
- Program Step `exit_code` fields on step envelopes MUST be exposed to CEL as integers.
- A Program Step MUST persist its stdout and stderr as artifacts (`stdout.log` and `stderr.log`) on every execution, and expose their references.
- A Program Step MAY declare `expect.exit_code` as a non-empty array of non-negative integers.
- The default `expect.exit_code` MUST be treated as `[0]` when `expect` is omitted.
- A Program Step exit code allow-listed by `expect.exit_code` MUST be exposed as step data: the Node completes and `steps.<id>.exit_code` carries the code.
- A Program Step exit code NOT allow-listed by `expect.exit_code` MUST fail the Node with `failureKind: "exit"`; the failure message MUST include the exit code and a tail of stderr to localize the broken script.
- A Program Step MUST evaluate `expect.exit_code` before capture and output schema validation; a non-allow-listed exit code MUST NOT be reported as a capture or schema failure.
- A Program Step MUST fail the Node only on non-recoverable conditions: process timeout, signal kill, spawn failure, capture parse/read failure, output schema validation failure, artifact write failure, or non-allow-listed exit code.
- A Program Step MAY omit `capture` when no structured output parsing is required.
- A Program Step MAY declare `output` using the Acpus Schema DSL defined in [Schema Spec](schema-spec.md).
- A Program Step `output` declared with the Acpus Schema DSL MUST compile nested object and array item structure into the Program Step output schema stored in the IR.
- A Program Step MUST declare `output` as an object when `output` is present.
- A Program Step with `output` present MUST declare `capture.parse: json`; output schema validation requires parsed JSON output.
- A Program Step with `output` present MUST produce a JSON object whose declared fields match the output schema; additional fields MUST be accepted and preserved in persisted Node output.
- A Program Step result MUST expose only declared output fields to workflow expressions while preserving the full captured output in persisted Node output.
- Program Step output schema validation failures MUST be treated as non-recoverable failures (the Node fails with `failureKind: "schema"`).
- Program Step output schema validation failure diagnostics MUST include schema validation details and SHOULD include a bounded captured-output preview.

### Composite Nodes

- A `pipeline` Node MUST contain a non-empty ordered `pipeline` list of child Nodes.
- A `pipeline` Node MAY declare `outputs` as a projection object evaluated after its child Nodes complete.
- A `pipeline` Node without `outputs` MUST produce `steps.<id>.output` as its final child Node's primary output.
- A `pipeline` Node with `outputs` MUST produce `steps.<id>.output` as the evaluated projection.
- `fanout.do`, `loop.do`, `if.then`, `if.else`, `switch.cases[].do`, and `switch.default.do` MUST compile as generated internal pipeline Nodes.
- Generated internal pipeline ids MUST use parent-local `$` segments: `fanout.do` and `loop.do` compile to `$do`, `if.then` compiles to `$then`, `if.else` compiles to `$else`, `switch.cases[n].do` compiles to `$case_<1-based-index>`, `switch.default.do` compiles to `$default`, and each `parallel` branch body compiles to `$<branch_id>`.
- Generated internal pipeline ids are parent-local and MAY repeat in one compiled Workflow Spec; the durable Node identity MUST be the resolved Node Key derived from the full `nodePath`.
- Generated internal pipeline ids MUST NOT be visible expression targets. Expressions such as `steps.$do.output` MUST be rejected as unknown step references.
- `do` lists MUST be non-empty and MUST NOT declare an `outputs` projection; authors who need a custom public contract MUST use an explicit `pipeline` Node.
- A `parallel` Node MUST contain branch descriptors shaped as `{ id, do }`, where `id` is the public branch key and `do` is a non-empty ordered list of child Nodes.
- A `parallel` branch id MUST match `^[A-Za-z_][A-Za-z0-9_-]*$` and MUST NOT start with `$`.
- The generated `$<branch_id>` pipeline segment is internal; the public branch output key remains the branch id, so branch output is read as `steps.<parallel_id>.output.<branch_id>`.
- Composite child Nodes (`pipeline` children, `parallel` branch `do` lists, and `fanout`, `if`, `switch` case, `switch` default, and `loop` body lists) MUST be validated as full Nodes, so unknown or misplaced fields on a nested Node MUST be rejected with the same structural diagnostics as a top-level Node.
- Every Node result MUST be a step value envelope that exposes its primary produced value at `steps.<id>.output`.
- Composite outputs MUST expose child primary outputs, not child step envelopes: parallel branch values, fanout lane values, switch selected values, and loop last values use the selected body's primary output directly.
- The root pipeline Node MUST persist an output envelope whose `output` field is a map keyed by direct child step id, where each value is that child step's full step value.
- A `parallel` Node MUST produce `steps.<id>.output` as a map keyed by branch id.
- A `parallel` Node MAY declare `join` as `all` or `race`.
- A `parallel` Node MAY declare `max_concurrency` as an integer greater than or equal to 1 to cap concurrent branch execution.
- A `parallel` Node with `join: race` MUST produce `steps.<id>.output` as a single-key map containing only the first branch to complete; losing branches are not cancelled.
- A `parallel` Node with `join: all` MUST fail fast on the first branch failure; when it does, its still-running or pending sibling branches in the same invocation MUST be cancelled (transition to `cancelled`) rather than left in `running`.
- A `fanout` Node MUST declare `over` as an array or a CEL expression string.
- A `fanout` Node MAY declare `key` as a template string (supports `${{ }}` interpolation); when absent, item index is used as identity.
- A `fanout` Node MAY declare `max_concurrency`.
- A `fanout` Node MAY declare `join` as `all`, `race`, or `quorum`.
- A `fanout` Node MUST declare `quorum` when `join: quorum` is used.
- A `fanout` Node MAY declare `success_criteria.min_success` as a positive integer.
- Node `join` MUST define the wait strategy, not the overall success criteria.
- A `fanout` Node with `join: race` or `join: quorum` MUST capture a failed lane as a lane result rather than aborting the Node, so the wait strategy can still reach its target on the surviving lanes; operator pause/cancel MUST still propagate.
- A `fanout` Node with `join: all` MUST fail fast on the first lane failure; when it does, its still-running or pending lanes (and their descendant Nodes) MUST be cancelled (transition to `cancelled`, except Nodes already `failed`) rather than left in `running`.
- `success_criteria.min_success` MUST define how many successful fanout lanes are required for overall fanout success after the wait strategy completes.
- When `success_criteria.min_success` is absent, the default MUST follow the wait strategy: `all` requires all lanes, `race` requires 1, and `quorum` requires `quorum`.
- A `fanout` Node MUST produce `steps.<id>.output` as an array of the successful lane outputs.
- A `fanout` Node MUST expose `item`, `item_id`, and `item_index` inside its body.
- `item_index` MUST be exposed to CEL as an integer.
- An `if` Node MUST declare `if.condition` as a boolean or a CEL expression string.
- An `if` Node MUST declare `if.then` as a non-empty ordered list of child Nodes.
- An `if` Node MAY declare `if.else` as a non-empty ordered list of child Nodes.
- `if.then` and `if.else` MUST have the same body semantics as `do` lists and MUST NOT declare an `outputs` projection.
- An `if` Node MUST execute `if.then` when `if.condition` evaluates truthy.
- An `if` Node MUST execute `if.else` when `if.condition` evaluates falsey and `if.else` is declared.
- An `if` Node with falsey `if.condition` and no `if.else` MUST complete without executing child Nodes and MUST produce `{}` at `steps.<id>.output`.
- An `if` Node MUST produce `steps.<id>.output` as the selected branch pipeline's primary output when a branch executes.
- A `switch` Node MUST select at most one branch.
- A `switch` Node MUST evaluate cases in order.
- A `switch` Node case MAY declare `when` as a boolean or a CEL expression string.
- A `switch` Node MUST declare a default branch.
- A `switch` Node MUST produce `steps.<id>.output` as the selected branch pipeline's primary output.
- A `loop` Node MAY declare `until` as a boolean or a CEL expression string.
- A `loop` Node MUST declare `max_iterations`.
- A `loop` Node MUST expose `loop.iter`.
- `loop.iter` MUST be exposed to CEL as an integer.
- A `loop` Node MAY expose prior iteration output as `loop.last`; `loop.last` MUST be the previous iteration body pipeline primary output.
- A `loop` Node MUST produce `steps.<id>.output` as the final executed iteration body pipeline primary output.
- A `subworkflow` Node MUST reference another Workflow Spec path.
- A `subworkflow` Node MUST be compiled and executed at runtime, with its `input` expressions evaluated against the current context.
- A `subworkflow` Node MUST nest child Node keys under its own Node key, and MUST be awaited.
- A `subworkflow` Node MUST produce `steps.<id>.output` as the referenced Workflow Spec's evaluated top-level `outputs`.
- A `subworkflow` Node referencing a Workflow Spec with no top-level `outputs` MUST produce `{}` at `steps.<id>.output`.

### Guard Nodes

- A Guard Node MUST declare `guard`.
- A Guard Node `guard.when` MUST be a boolean or a CEL expression string.
- A Guard Node MUST declare `guard.then` and `guard.else`.
- `guard.then` and `guard.else` MUST each be one of `continue`, `fail`, or `complete`.
- A Guard Node MAY declare `guard.message` as a failure message template string.
- A Guard Node MUST evaluate `guard.when` deterministically against the current expression context.
- A Guard Node MUST select `guard.then` when `guard.when` evaluates truthy and `guard.else` otherwise.
- A Guard Node action of `continue` MUST complete the Guard Node and continue to the next Node in the current scope.
- A Guard Node action of `fail` MUST fail the Guard Node using the rendered `guard.message` as the error when present, or `Guard '<id>' failed` when absent.
- A Guard Node action of `complete` MUST complete the Guard Node and complete the current scope without executing later sibling Nodes in that scope.
- A Guard Node MUST persist an output envelope whose `output` field contains `matched` and `action`, and MUST include `message` only when the selected action is `fail` and `guard.message` is declared.
- A Guard Node inside a fanout lane or parallel branch MUST affect only that current lane or branch scope; outer composite success remains governed by that composite's join and success criteria.
- A Guard Node at the Workflow root scope MAY complete or fail the whole Run.

### Signal Nodes

- A Signal Node MUST use `run: signal`.
- A Signal Node MUST declare `prompt` as an operator-facing description template string.
- A Signal Node MAY declare `output` using the Acpus Schema DSL defined in [Schema Spec](schema-spec.md); when omitted or declared as an empty map (`output: {}`), any injected payload object is accepted without validation.
- A Signal Node MUST enter the `awaiting` Node state while blocked on an external decision.
- An external decision MUST be delivered through the Run Supervisor signal channel as a JSON payload object.
- When `output` is declared, the injected payload MUST validate strictly against it, including rejecting undeclared extra fields; a non-conforming payload MUST be rejected without resolving the Node, and the Node MUST remain `awaiting`.
- A Signal Node MUST produce an output envelope whose `output` field is exactly the injected payload object, with no added envelope metadata.
- A Signal Node MAY declare `timeout` as a duration string or number (in milliseconds). When `timeout` is declared, `on_timeout` MUST also be declared.
- A Signal Node with no `timeout` MUST wait indefinitely for an external decision (or a cancel).
- `on_timeout` MUST be one of `fail` or `default`.
- A Signal Node with `on_timeout: default` MUST declare `default` as a literal payload object; when `output` is declared, `default` MUST validate against it at compile time.
- A Signal Node with `on_timeout: default` MUST, on timeout, complete the Node with the declared `default` payload as its primary output at `steps.<id>.output`.
- A Signal Node with `on_timeout: fail` MUST fail the Node on timeout.
- The `awaiting` state MUST be distinct from operator `paused`: an external decision resolves an `awaiting` Signal Node, whereas operator pause/resume governs `paused` Nodes.
- The decision channel is in-memory; if the Run Supervisor restarts while a Signal Node is `awaiting`, the Node MUST be re-executed and wait for a fresh decision. Durable decision recovery is deferred (see roadmap).

### Expressions

- Expressions MUST use the `${{ ... }}` syntax.
- `over`, `until`, and `when` MUST be raw CEL expression strings (no `${{ }}` wrappers).
- When `over`, `until`, or `when` are provided as YAML arrays or booleans, the compiler coerces them to CEL expression strings before evaluation.
- `key`, `prompt`, and `cmd` MUST be template strings (`${{ }}` interpolation is supported).
- Expressions MUST be deterministic.
- Expressions MUST NOT perform external I/O.
- Expressions MUST NOT read wall-clock system time directly.
- Expressions MUST NOT use randomness.
- Expressions MAY read `input.*`.
- Expressions MAY read a Node's primary produced value through `steps.<id>.output.*`.
- Expressions MAY read `steps.<id>.exit_code`.
- Expressions MAY read fanout and loop scope variables when in scope.
- Expressions MAY read `run_id`.
- Expressions MAY read Workflow metadata through `workflow.name`, `workflow.description`, `workflow.source_path`, and `workflow.source_dir`.
- `workflow.name` MUST be the compiled Workflow Spec `name`.
- `workflow.description` MUST be the compiled Workflow Spec `description`, or an empty string when absent.
- `workflow.source_path` MUST be the absolute real filesystem path of the Workflow Spec source used to compile the Run, or an empty string when the Run has no source path.
- `workflow.source_dir` MUST be the absolute real filesystem directory containing `workflow.source_path`, or an empty string when the Run has no source path.
- `workflow.source_dir` SHOULD be used for explicit spec-local helper scripts, for example `cmd: ["node", "${{ workflow.source_dir }}/scripts/helper.mjs"]`.
- Included steps MUST inherit the parent compiled Workflow's `workflow.*` context because includes are expanded into the parent Workflow at compile time.
- Subworkflow execution MUST expose the child Workflow Spec's own `workflow.*` context while evaluating child steps and child top-level `outputs`.
- `now()` MUST be bound to the deterministic workflow clock.
- `json(value)` MUST serialize its argument to a JSON string with deterministic (sorted) object key order, so an object or array can be embedded into a template string instead of stringifying to `[object Object]`.
- The compiler and runtime MUST use the same Acpus CEL environment registration for context roots and custom functions.

#### Static Validation

The compiler MUST statically validate expressions against the compiled IR so that classes of runtime failure are surfaced at lint / dry-run time. Validation MUST be fail-quiet for workflow shape that cannot be determined statically (prefer false negatives over false positives), and static validation MUST NOT throw.

- CEL syntax, built-ins, macros, function overloads, unknown roots, and unknown functions MUST be validated through `cel-js` with Acpus context roots and custom functions registered. Acpus MUST NOT maintain a separate whitelist for standard `cel-js` built-ins or macros.
- Expression references MUST be extracted from the parsed CEL AST, not by text matching.
- A `steps.<id>.output.<path>` reference whose `<id>` declares an output schema (an Agent, Program, or Signal Node) MUST be rejected when `<path>` names a field absent from the schema's declared properties; the diagnostic MUST list the available fields. Static string indexes such as `steps.<id>.output["field"]` MUST be treated as field references. Dynamic indexes MUST be accepted only when they index an array with declared `items`; path validation MUST stop, accepting the reference, at the first scalar, unknown, or composite (pipeline/loop/fanout/parallel/if/switch/guard) output projection.
- An `input.<path>` reference MUST be validated against the compiled input schema where declared properties make the path statically knowable, and MUST fail quietly at open or dynamic input shapes.
- A `workflow.<path>` reference MUST be validated against the workflow metadata context fields.
- Inside a `fanout` body whose `over` resolves to a typed array element schema, an `item.<path>` reference MUST be validated against that element schema under the same declared-property rule.
- A scope-local root (`loop`, `item`, `item_id`, `item_index`) used outside the composite body that introduces it MUST be rejected.
- A `steps.<id>` reference to a step that is not visible at the referencing position (a later sibling, or a step in a sibling branch) MUST be rejected; the diagnostic MUST list the visible steps.
- A `${{ }}` expression spliced into a Program Step `cmd` element that statically evaluates to a non-scalar value (an object, an array, or a `json(...)` call) MUST produce a warning advising the author to route the value through `env:`. Values placed in `env:` MUST NOT be flagged.
- A `${{ }}` expression spliced into any non-`cmd` template string that statically evaluates to a structured value (an object or array) MUST produce an `EXPR_STRUCTURED_TEMPLATE` warning. Wrapping the value with `json(value)` MUST suppress this warning and indicate intentional JSON text rendering. Unknown or dynamic shapes MUST NOT be flagged.
- The static-validation rules MUST source every Node kind's output projection and body-local scope from a single shared composite contract that the compiler also uses to build the IR, so a new composite kind is described in exactly one place.

### Local Runtime Boundary

- Workflow scheduling MUST be owned by Acpus.
- Agent session scheduling MUST be delegated to acpx.
- Program execution MUST be local subprocess execution.
- Workflow Specs MUST NOT require distributed execution semantics.
- Workflow Specs MUST NOT require remote worker routing.

## Verification

- Compiler tests MUST cover required top-level fields.
- Compiler tests MUST cover duplicate id diagnostics.
- Compiler tests MUST cover safe-id validation for user-authored Node ids and `parallel` branch ids.
- Compiler tests MUST cover repeated parent-local generated internal ids with unique full node paths.
- Compiler tests MUST cover Agent Step shape validation.
- Compiler tests MUST cover Agent Step `session_key` validation, expression collection, and IR preservation.
- Compiler tests MUST cover Program Step shape validation.
- Compiler tests MUST cover `expect.exit_code` shape validation.
- Compiler tests MUST cover composite Node compilation.
- Compiler tests MUST cover If Node shape validation, generated branch pipelines, output projection, and expression scope.
- Compiler tests MUST cover rejection of `switch` Nodes without a default branch.
- Compiler tests MUST cover unknown-field rejection on Nodes nested inside composite `do`, `then`, `else`, and `parallel` lists.
- Compiler tests MUST cover Guard Node shape validation, compilation, and expression collection.
- Compiler tests MUST cover Signal Node shape validation, optional `output` schema compilation, and `default` payload validation against a declared `output` schema.
- Compiler tests MUST cover include expansion and include cycle diagnostics.
- Compiler tests MUST cover expression collection and validation.
- Compiler tests MUST cover scope-aware expression validation: declared-property field-path rejection with available-field reporting, fail-quiet acceptance of dyn / composite shapes, out-of-scope local roots, step visibility, fanout `item` element-schema validation, and the non-scalar-in-`cmd` warning.
- Compiler tests MUST cover declared-property field-path rejection for open Agent and Program output schemas, including static string indexes and dynamic indexes on schema object outputs.
- Compiler tests MUST cover workflow metadata context references and rejection of unknown `workflow.*` fields.
- Compiler tests MUST assert that every IR Node kind has an entry in the shared composite contract.
- Compiler tests MUST cover output schema validation.
- Compiler tests MUST cover Agent Step output declarations that use the Acpus Schema DSL.
- Runtime tests MUST cover Agent Steps through acpx.
- Runtime tests MUST cover Program Steps as local subprocesses.
- Runtime tests MUST cover spec-local helper script execution through `workflow.source_dir`.
- Runtime tests MUST cover Program Step default fail-fast on non-allow-listed exit codes and `expect.exit_code` opt-out.
- Runtime tests MUST cover deterministic replay.
- Runtime tests MUST cover Signal Nodes: entering `awaiting`, schema-validated payload injection, rejection of a non-conforming payload while staying `awaiting`, and `on_timeout` `fail` and `default` behavior.
- Runtime tests MUST cover Agent and Program output extras being preserved in persisted Node state while workflow expressions and composite parent outputs see only declared fields.
- Runtime tests MUST cover Signal Node rejection of undeclared extra payload fields when an output schema is declared.
- Runtime tests MUST cover top-level `outputs` projection and failure when declared `outputs` cannot be evaluated.
- Runtime tests MUST cover workflow metadata context in top-level `outputs`, empty source path fallback, retry/resume context reconstruction, and subworkflow child metadata context.
