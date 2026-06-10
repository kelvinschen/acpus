# Workflow Spec

## Purpose

Workflow Specs are YAML documents that declare local durable workflows made of Agent Steps, Program Steps, Composite Nodes, Guard Nodes, Approval Gates, inputs, agents, and outputs.

## Requirements

- A Workflow Spec MUST be a YAML object.
- A Workflow Spec MUST declare `version`, `name`, and `workflow.steps`.
- `workflow.steps` MUST be an ordered list of Nodes.
- Every Node MUST declare a stable non-empty `id`.
- Node ids MUST be unique within the Workflow Spec after includes are expanded.
- A Workflow Spec MAY declare top-level `input`.
- A Workflow Spec MAY declare top-level `agents`.
- A Workflow Spec MAY declare top-level `outputs`.
- A Workflow Spec MAY declare `include` steps that are expanded at compile time.
- A started Workflow Run MUST execute a frozen IR snapshot and MUST NOT re-read mutable YAML during replay or resume.

### Agent Steps

- An Agent Step MUST use `run: agent`.
- An Agent Step MUST declare `use`.
- An Agent Step MUST declare `prompt`.
- An Agent Step MUST reference an agent declared under `agents`.
- An Agent Step backed by a `builtin` or `command` agent MUST run against a local ACP-compatible agent through acpx.
- An agent declared under `agents` MAY declare `type` as one of `builtin` or `command`; `type` defaults to `builtin` when omitted.
- A `builtin` agent MUST declare `use` naming an acpx built-in adapter (e.g. `pi`, `claude`, `codex`); the runtime drives it as `acpx <use>`.
- A `command` agent MUST declare `use` as the launch command for a custom ACP server; the runtime drives it through the acpx `--agent "<use>"` escape hatch.
- For testing, use `acpus-mock-agent` as a `command` agent (e.g. `type: command, use: "acpus-mock-agent --script <path>"`), which provides deterministic script responses through the real acpx path.
- An agent MAY declare `model`, `cwd`, and `env`, which the runtime forwards to acpx.
- An Agent Step MAY omit `output` when no structured output parsing is required.
- An Agent Step MAY declare `output` using the Acpus Schema DSL defined in [Schema Spec](schema-spec.md).
- An Agent Step `output` declared with the Acpus Schema DSL MUST compile nested object and array item structure into the Agent Step output schema stored in the IR.
- An Agent Step MUST declare `output` as an object when `output` is present.
- An Agent Step with `output` present MUST produce a JSON object that matches the declared output schema, exposed at `steps.<id>.output`.
- An Agent Step result MUST be exposed as an envelope `{ output }` at `steps.<id>`, so the produced object is read through `steps.<id>.output`.
- Agent response output parse failures and schema failures MUST be handled as continuation retries when retry attempts remain.
- An Agent Step MAY declare `retry` as an object with a non-negative integer `max` and an optional duration `backoff`.
- `retry.max` MUST count extra retry attempts after the initial execution.
- An Agent Step with `output` present and no explicit `retry.max` MUST default to `retry.max: 2` for Agent response output parse and schema failures.
- `retry.max: 0` MUST disable automatic Agent response output retry.
- Agent deterministic configuration or template failures MUST NOT be treated as Agent response output parse failures and MUST NOT trigger automatic output retry.
- When retry attempts remain, Agent response output parse or schema failures MUST trigger automatic re-execution until `max` attempts are exhausted.

### Step Common Fields

- A step MAY declare `timeout` as a duration string or number (in milliseconds).
- A step MAY declare `on_error` as one of `fail`, `retry`, or `skip`.

### Program Steps

- A Program Step MUST use `run: program`.
- A Program Step MUST declare `cmd`.
- A Program Step MUST run as a local subprocess on the same host.
- A Program Step MAY declare `env`.
- A Program Step MAY declare `capture`.
- A Program Step MUST declare `capture` as an object when `capture` is present.
- Program Step `capture.from` MUST be `stdout` or `file`.
- Program Step `capture.parse` MUST be `json` or `text`.
- Program Step `capture.path` MUST be present when `capture.from` is `file`.
- A Program Step with `capture.from: file` MUST read `capture.path` (resolved relative to the workspace) and parse it per `capture.parse`.
- A Program Step result MUST be exposed as an envelope `{ output, exit_code }` at `steps.<id>`.
- A Program Step MUST expose `steps.<id>.exit_code`.
- A Program Step MUST persist its stdout and stderr as artifacts (`stdout.log` and `stderr.log`) on every execution, and expose their references.
- Non-zero Program Step exit codes MUST be treated as step data; the Node completes and carries `exit_code`.
- A Program Step MUST fail the Node only on non-recoverable conditions: process timeout, signal kill, spawn failure, capture parse/read failure, or artifact write failure.
- A Program Step MAY omit `capture` when no structured output parsing is required.
- A Program Step MAY declare `output` using the Acpus Schema DSL defined in [Schema Spec](schema-spec.md).
- A Program Step `output` declared with the Acpus Schema DSL MUST compile nested object and array item structure into the Program Step output schema stored in the IR.
- A Program Step MUST declare `output` as an object when `output` is present.
- A Program Step with `output` present MUST declare `capture.parse: json`; output schema validation requires parsed JSON output.
- A Program Step with `output` present MUST produce a JSON object that matches the declared output schema.
- Program Step output schema validation failures MUST be treated as non-recoverable failures (the Node fails with `failureKind: "schema"`).

### Composite Nodes

- A `parallel` Node MUST contain named child Nodes.
- A `parallel` Node MUST produce a map keyed by branch id.
- A `parallel` Node MAY declare `join` as `all` or `race`.
- A `parallel` Node with `join: race` MUST produce a single-key map containing only the first branch to complete; losing branches are not cancelled.
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
- A `fanout` Node MUST produce an array of the successful lane outputs.
- A `fanout` Node MUST expose `item`, `item_id`, and `item_index` inside its body.
- A `switch` Node MUST select at most one branch.
- A `switch` Node MUST evaluate cases in order.
- A `switch` Node case MAY declare `when` as a boolean or a CEL expression string.
- A `switch` Node MAY declare a default branch.
- A `loop` Node MAY declare `until` as a boolean or a CEL expression string.
- A `loop` Node MUST declare `max_iterations`.
- A `loop` Node MUST expose `loop.iter`.
- A `loop` Node MAY expose prior iteration output as `loop.last`.
- A `subworkflow` Node MUST reference another Workflow Spec path.
- A `subworkflow` Node MUST be compiled and executed at runtime, with its `input` expressions evaluated against the current context.
- A `subworkflow` Node MUST nest child Node keys under its own Node key, and MUST be awaited.

### Guard Nodes

- A Guard Node MUST declare `guard`.
- A Guard Node `guard.when` MUST be a boolean or a CEL expression string.
- A Guard Node MUST declare `guard.then` and `guard.else`.
- `guard.then` and `guard.else` MUST each be one of `continue`, `fail`, or `complete`.
- A Guard Node MAY declare `guard.message` as a template string.
- A Guard Node MUST evaluate `guard.when` deterministically against the current expression context.
- A Guard Node MUST select `guard.then` when `guard.when` evaluates truthy and `guard.else` otherwise.
- A Guard Node action of `continue` MUST complete the Guard Node and continue to the next Node in the current scope.
- A Guard Node action of `fail` MUST fail the Guard Node using the rendered `guard.message` as the error when present, or `Guard '<id>' failed` when absent.
- A Guard Node action of `complete` MUST complete the Guard Node and complete the current scope without executing later sibling Nodes in that scope.
- A Guard Node MUST persist a structured output object containing `matched` and `action`, and MUST include `message` when `guard.message` is declared.
- A Guard Node inside a fanout lane or parallel branch MUST affect only that current lane or branch scope; outer composite success remains governed by that composite's join and success criteria.
- A Guard Node at the Workflow root scope MAY complete or fail the whole Run.

### Approval Gates

- An Approval Gate MUST declare `approval`.
- An Approval Gate MUST declare `prompt`.
- An Approval Gate MAY declare `timeout`. When `timeout` is declared, `on_timeout` MUST also be declared.
- An Approval Gate with no `timeout` MUST wait indefinitely for a human decision (or a cancel).
- An Approval Gate MUST enter the `awaiting` Node state while blocked on a human decision.
- A human decision MUST be delivered through the Run Supervisor approval signal channel (`approve` or `reject`).
- An Approval Gate MUST produce a JSON object that includes `approved`, `decision`, and `at`.
- The `decision` field MUST be one of `approved`, `rejected`, or `timeout`, and `at` MUST be the deterministic workflow clock value.
- A human `reject` MUST complete the Node (not fail it) with `approved: false` and `decision: rejected`, so downstream Nodes can branch on `approved`.
- An Approval Gate with `on_timeout: fail` or `on_timeout: escalate` MUST fail the Node on timeout; full `escalate` semantics are deferred.
- The `awaiting` state MUST be distinct from operator `paused`: a human decision resolves an `awaiting` gate, whereas operator pause/resume governs `paused` Nodes.
- The approval decision channel is in-memory; if the Run Supervisor restarts while a gate is `awaiting`, the gate MUST be re-executed and wait for a fresh decision. Durable decision recovery is deferred (see roadmap).

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
- Expressions MAY read `steps.<id>.output.*`.
- Expressions MAY read `steps.<id>.exit_code`.
- Expressions MAY read fanout and loop scope variables when in scope.
- Expressions MAY read `run_id`.
- `now()` MUST be bound to the deterministic workflow clock.

### Local Runtime Boundary

- Workflow scheduling MUST be owned by Acpus.
- Agent session scheduling MUST be delegated to acpx.
- Program execution MUST be local subprocess execution.
- Workflow Specs MUST NOT require distributed execution semantics.
- Workflow Specs MUST NOT require remote worker routing.

## Verification

- Compiler tests MUST cover required top-level fields.
- Compiler tests MUST cover duplicate id diagnostics.
- Compiler tests MUST cover Agent Step shape validation.
- Compiler tests MUST cover Program Step shape validation.
- Compiler tests MUST cover composite Node compilation.
- Compiler tests MUST cover Guard Node shape validation, compilation, and expression collection.
- Compiler tests MUST cover include expansion and include cycle diagnostics.
- Compiler tests MUST cover expression collection and validation.
- Compiler tests MUST cover output schema validation.
- Compiler tests MUST cover Agent Step output declarations that use the Acpus Schema DSL.
- Runtime tests MUST cover Agent Steps through acpx.
- Runtime tests MUST cover Program Steps as local subprocesses.
- Runtime tests MUST cover deterministic replay.
