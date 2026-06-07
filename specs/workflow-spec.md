# Workflow Spec

## Purpose

Workflow Specs are YAML documents that declare local durable workflows made of Agent Steps, Program Steps, Composite Nodes, Approval Gates, inputs, agents, and outputs.

## Requirements

- A Workflow Spec MUST be a YAML object.
- A Workflow Spec MUST declare `version`, `name`, and `workflow.steps`.
- `workflow.steps` MUST be an ordered list of Nodes.
- Every Node MUST declare a stable non-empty `id`.
- Node ids MUST be unique within the Workflow Spec after includes are expanded.
- A Workflow Spec MAY declare top-level `input`.
- A Workflow Spec MAY declare top-level `defaults`.
- A Workflow Spec MAY declare top-level `agents`.
- A Workflow Spec MAY declare top-level `outputs`.
- A Workflow Spec MAY declare `include` steps that are expanded at compile time.
- A started Workflow Run MUST execute a frozen IR snapshot and MUST NOT re-read mutable YAML during replay or resume.

### Agent Steps

- An Agent Step MUST use `run: agent`.
- An Agent Step MUST declare `use`.
- An Agent Step MUST declare `prompt`.
- An Agent Step MUST reference an agent declared under `agents`.
- An Agent Step backed by a `builtin` or `command` agent MUST run against a local ACP-compatible agent through acpx; a `mock` agent is a test-only in-memory executor that does not use acpx.
- An agent declared under `agents` MAY declare `type` as one of `builtin`, `command`, or `mock`; `type` defaults to `builtin` when omitted.
- A `builtin` agent MUST declare `use` naming an acpx built-in adapter (e.g. `pi`, `claude`, `codex`); the runtime drives it as `acpx <use>`.
- A `command` agent MUST declare `use` as the launch command for a custom ACP server; the runtime drives it through the acpx `--agent "<use>"` escape hatch.
- A `mock` agent MAY omit `use`; it is served by the in-memory mock executor and does not require acpx.
- An agent MAY declare `model`, `cwd`, and `env`, which the runtime forwards to acpx.
- An Agent Step MAY omit `output` when no structured output parsing is required.
- An Agent Step MAY declare `output` using the Acpus Schema DSL defined in [Schema Spec](schema-spec.md).
- An Agent Step `output` declared with the Acpus Schema DSL MUST compile nested object and array item structure into the Agent Step output schema stored in the IR.
- An Agent Step MAY declare `output.schema` as a JSON Schema escape hatch.
- An Agent Step MUST declare `output` as an object when `output` is present.
- An Agent Step with `output` present MUST produce a JSON object that matches the declared output schema, exposed at `steps.<id>.output`.
- An Agent Step result MUST be exposed as an envelope `{ output }` at `steps.<id>`, so the produced object is read through `steps.<id>.output`.
- Agent output parse failures and schema failures MUST be handled as continuation retries when retry attempts remain.
- An Agent Step MAY declare `retry` as an object with a positive integer `max` and an optional duration `backoff`.
- When `retry` is present, Agent output parse or schema failures MUST trigger automatic re-execution until `max` attempts are exhausted.

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

### Composite Nodes

- A `parallel` Node MUST contain named child Nodes.
- A `parallel` Node MUST produce a map keyed by branch id.
- A `parallel` Node MAY declare `join` as `all` or `race`.
- A `parallel` Node with `join: race` MUST produce a single-key map containing only the first branch to complete; losing branches are not cancelled.
- A `fanout` Node MUST declare `over` as an array or a CEL expression string.
- A `fanout` Node MAY declare `key` as a template string (supports `${{ }}` interpolation).
- A `fanout` Node SHOULD declare `key` when items have stable identity.
- A `fanout` Node MAY declare `max_concurrency`.
- A `fanout` Node MAY declare `join` as `all`, `race`, or `quorum`.
- A `fanout` Node MUST declare `quorum` when `join: quorum` is used.
- A `fanout` Node MAY declare `success_criteria.min_success` as a positive integer.
- Node `join` MUST define the wait strategy, not the overall success criteria.
- A failed `fanout` lane MUST be captured as a lane result rather than aborting the Node; operator pause/cancel MUST still propagate.
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

### Approval Gates

- An Approval Gate MUST declare `approval`.
- An Approval Gate MUST declare `prompt`.
- An Approval Gate MUST declare `timeout`.
- An Approval Gate MUST declare `on_timeout`.
- An Approval Gate MUST produce a JSON object that includes `approved`, `decision`, and `at`.
- The `decision` field MUST be one of `approved`, `rejected`, or `timeout`, and `at` MUST be the deterministic workflow clock value.
- An Approval Gate with `on_timeout: fail` or `on_timeout: escalate` MUST fail the Node on timeout; full `escalate` semantics are deferred.
- Approval Gates MUST be distinct from operator pause.

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
- Compiler tests MUST cover include expansion and include cycle diagnostics.
- Compiler tests MUST cover expression collection and validation.
- Compiler tests MUST cover output schema validation.
- Compiler tests MUST cover Agent Step output declarations that use the Acpus Schema DSL.
- Runtime tests MUST cover Agent Steps through acpx.
- Runtime tests MUST cover Program Steps as local subprocesses.
- Runtime tests MUST cover deterministic replay.
